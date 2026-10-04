import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHarness, TestHarness } from './support/harness.js';
import {
  ensureLedgerAccount,
  executeLedgerTransfer,
  getAccountBalance,
  getUserAccountId
} from '../src/server/services/ledger.js';

describe('Transactional ledger: atomicity, idempotency & concurrent race protection', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness();
  }, 120000);

  afterAll(async () => {
    await h.close();
  });

  it('enforces idempotency so duplicate idempotencyKeys never double-transfer', async () => {
    const senderAcc = getUserAccountId('usr-nyx-zero');
    const receiverAcc = getUserAccountId('usr-kestrel-9');

    const beforeSender = await getAccountBalance(h.db, senderAcc);
    const beforeReceiver = await getAccountBalance(h.db, receiverAcc);

    const key = `test-idempotent-key-${Date.now()}`;
    const tx1 = await executeLedgerTransfer(h.db, {
      idempotencyKey: key,
      fromAccountId: senderAcc,
      toAccountId: receiverAcc,
      amount: 300,
      txType: 'player_transfer',
      memo: 'Idempotency test'
    });
    expect(tx1.idempotentReplay).toBe(false);

    const tx2 = await executeLedgerTransfer(h.db, {
      idempotencyKey: key,
      fromAccountId: senderAcc,
      toAccountId: receiverAcc,
      amount: 300,
      txType: 'player_transfer',
      memo: 'Idempotency test replay'
    });
    expect(tx2.idempotentReplay).toBe(true);
    expect(tx2.id).toBe(tx1.id);

    expect(await getAccountBalance(h.db, senderAcc)).toBe(beforeSender - 300);
    expect(await getAccountBalance(h.db, receiverAcc)).toBe(beforeReceiver + 300);
  }, 60000);

  it('prevents overdrafts and race conditions under concurrent parallel transfers', async () => {
    const raceSenderId = 'acct-user-race-sender';
    const raceReceiverId = 'acct-user-race-receiver';
    await ensureLedgerAccount(h.db, raceSenderId, 'user', 'race-sender', 1000);
    await ensureLedgerAccount(h.db, raceReceiverId, 'user', 'race-receiver', 0);

    // 15 concurrent transfers of 200 RWC from an account holding 1,000 RWC:
    // exactly 5 must succeed and 10 must fail with INSUFFICIENT_FUNDS.
    const attempts = Array.from({ length: 15 }, (_, i) =>
      executeLedgerTransfer(h.db, {
        idempotencyKey: `race-tx-${Date.now()}-${i}`,
        fromAccountId: raceSenderId,
        toAccountId: raceReceiverId,
        amount: 200,
        txType: 'player_transfer',
        memo: `Concurrent transfer #${i}`
      })
    );

    const results = await Promise.allSettled(attempts);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(5);
    expect(results.filter((r) => r.status === 'rejected').length).toBe(10);

    expect(await getAccountBalance(h.db, raceSenderId)).toBe(0);
    expect(await getAccountBalance(h.db, raceReceiverId)).toBe(1000);
  }, 60000);

  it('never lets an account balance go negative', async () => {
    const accountId = 'acct-user-floor-check';
    await ensureLedgerAccount(h.db, accountId, 'user', 'floor-check', 50);

    await expect(
      executeLedgerTransfer(h.db, {
        idempotencyKey: `floor-${Date.now()}`,
        fromAccountId: accountId,
        toAccountId: getUserAccountId('usr-kestrel-9'),
        amount: 100,
        txType: 'player_transfer'
      })
    ).rejects.toThrow(/Insufficient funds/);

    expect(await getAccountBalance(h.db, accountId)).toBe(50);
  }, 60000);
});

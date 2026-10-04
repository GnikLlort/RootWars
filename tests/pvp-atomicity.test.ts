import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { createHarness, registerOperator, TestHarness } from './support/harness.js';
import { executePvpOperation } from '../src/server/services/pvp.js';

/**
 * Atomicity / concurrency regression tests for Open PvP.
 *
 * These exercise the real transactional code path with concurrent promises. The
 * default test backend is in-process PGlite (serialized transactions); point
 * `TEST_DATABASE_URL` at PostgreSQL to run the exact same assertions with true
 * parallel transactions.
 */
describe('Atomic PvP operations', () => {
  let h: TestHarness;
  let extraAttackers: string[] = [];

  async function resetTargetNode(opts: { balance: number; security?: number }) {
    await h.db.query(
      `UPDATE network_nodes
       SET security_level = $1, patch_level = 10,
           defense_config = '{"monitoring":1,"patching":1,"segmentation":1,"decoys":0,"incident_response":1,"recovery":1}'::jsonb,
           status = 'online', outage_until = NULL, contested_by_group_id = NULL, last_attacked_at = NULL
       WHERE id = 'node-pvp-cipher'`,
      [opts.security ?? 10]
    );
    await h.db.query(`UPDATE ledger_accounts SET balance = $1 WHERE id = 'acct-user-usr-cipher-wolf'`, [
      opts.balance
    ]);
    // Clear all incident history so cooldown checks start from a known state
    // (the demo fixtures include a seed incident).
    await h.db.query(`DELETE FROM pvp_incidents`);
    await h.db.query(`UPDATE ledger_accounts SET frozen = FALSE WHERE id LIKE 'acct-user-%'`);
  }

  beforeAll(async () => {
    h = await createHarness();
    // Six distinct attackers so each can attack once without hitting the attacker cooldown.
    extraAttackers = [];
    for (let i = 0; i < 4; i++) {
      const session = await registerOperator(h.app, `atomic_attacker_${i}`, 'AtomicAttacker!2026');
      extraAttackers.push(session.userId);
    }
  }, 120000);

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await resetTargetNode({ balance: 2000 });
  });

  it('never exceeds the per-attack or 24h loss caps under simultaneous attacks', async () => {
    const attackers = ['usr-nyx-zero', 'usr-vortex-prime', ...extraAttackers];
    expect(attackers.length).toBeGreaterThanOrEqual(6);

    const results = await Promise.allSettled(
      attackers.map((userId, index) =>
        executePvpOperation(h.db, {
          attackerUserId: userId,
          targetNodeIdentifier: 'node-pvp-cipher',
          method: 'heist',
          requestId: `concurrent-heist-${index}-${crypto.randomUUID()}`,
          bypassCooldownForTest: true
        })
      )
    );

    const stolen = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value.rwcStolen);

    // Per-attack cap: 10% of the 2,000 RWC balance => 200 RWC.
    for (const amount of stolen) {
      expect(amount).toBeLessThanOrEqual(200);
    }

    // 24h cumulative cap: 20% of the reference balance => 400 RWC total.
    const totalStolen = stolen.reduce((a, b) => a + b, 0);
    expect(totalStolen).toBeLessThanOrEqual(400);

    const balanceRes = await h.db.query<any>(
      `SELECT balance FROM ledger_accounts WHERE id = 'acct-user-usr-cipher-wolf'`
    );
    expect(Number(balanceRes.rows[0].balance)).toBeGreaterThanOrEqual(1600);

    // Every currency seizure must have a matching incident record.
    const seizures = await h.db.query<any>(
      `SELECT COUNT(*)::int AS count FROM ledger_transactions WHERE tx_type = 'pvp_seizure'`
    );
    const incidents = await h.db.query<any>(
      `SELECT COUNT(*)::int AS count FROM pvp_incidents WHERE rwc_stolen > 0`
    );
    expect(seizures.rows[0].count).toBe(incidents.rows[0].count);
  }, 120000);

  it('applies exactly one success when the same attacker fires simultaneous attacks (cooldown)', async () => {
    const results = await Promise.allSettled([
      executePvpOperation(h.db, {
        attackerUserId: 'usr-nyx-zero',
        targetNodeIdentifier: 'node-pvp-cipher',
        method: 'heist',
        requestId: `cooldown-a-${crypto.randomUUID()}`
      }),
      executePvpOperation(h.db, {
        attackerUserId: 'usr-nyx-zero',
        targetNodeIdentifier: 'node-pvp-cipher',
        method: 'heist',
        requestId: `cooldown-b-${crypto.randomUUID()}`
      })
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String(rejected[0].reason?.code ?? rejected[0].reason?.message)).toMatch(/COOLDOWN|cooldown/);
  }, 60000);

  it('lets only one concurrent attacker claim an open bounty', async () => {
    await h.db.query(`DELETE FROM bounties WHERE id = 'bty-atomic-test'`);
    await h.db.query(
      `INSERT INTO bounties (id, issuer_user_id, target_node_id, target_user_id, reward_rwc, reason, status)
       VALUES ('bty-atomic-test', 'usr-kestrel-9', 'node-pvp-cipher', 'usr-cipher-wolf', 1000, 'Atomicity test bounty', 'open')`
    );

    const attackers = ['usr-nyx-zero', 'usr-vortex-prime', ...extraAttackers];
    const results = await Promise.allSettled(
      attackers.map((userId, index) =>
        executePvpOperation(h.db, {
          attackerUserId: userId,
          targetNodeIdentifier: 'node-pvp-cipher',
          method: 'heist',
          requestId: `bounty-race-${index}-${crypto.randomUUID()}`,
          bypassCooldownForTest: true
        })
      )
    );

    const claimed = results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .filter((r) => r.value.bountyClaimedRwc > 0);
    expect(claimed.length).toBe(1);

    const bountyRes = await h.db.query<any>(`SELECT status, claimed_by_user_id FROM bounties WHERE id = 'bty-atomic-test'`);
    expect(bountyRes.rows[0].status).toBe('claimed');

    const payouts = await h.db.query<any>(
      `SELECT COUNT(*)::int AS count FROM ledger_transactions WHERE tx_type = 'bounty_payout' AND reference_id = 'bty-atomic-test'`
    );
    expect(payouts.rows[0].count).toBe(1);
  }, 120000);

  it('returns the original incident for a replayed request id (sequential and concurrent)', async () => {
    const requestId = `idempotent-pvp-${crypto.randomUUID()}`;

    const first = await executePvpOperation(h.db, {
      attackerUserId: 'usr-vortex-prime',
      targetNodeIdentifier: 'node-pvp-cipher',
      method: 'heist',
      requestId,
      bypassCooldownForTest: true
    });
    expect(first.idempotentReplay).toBe(false);

    const replay = await executePvpOperation(h.db, {
      attackerUserId: 'usr-vortex-prime',
      targetNodeIdentifier: 'node-pvp-cipher',
      method: 'heist',
      requestId,
      bypassCooldownForTest: true
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.incidentId).toBe(first.incidentId);

    const [c1, c2] = await Promise.all([
      executePvpOperation(h.db, {
        attackerUserId: 'usr-nyx-zero',
        targetNodeIdentifier: 'node-pvp-cipher',
        method: 'heist',
        requestId: `concurrent-idem-${requestId}`,
        bypassCooldownForTest: true
      }),
      executePvpOperation(h.db, {
        attackerUserId: 'usr-nyx-zero',
        targetNodeIdentifier: 'node-pvp-cipher',
        method: 'heist',
        requestId: `concurrent-idem-${requestId}`,
        bypassCooldownForTest: true
      })
    ]);
    expect(c1.incidentId).toBe(c2.incidentId);
    expect([c1.idempotentReplay, c2.idempotentReplay].filter(Boolean).length).toBe(1);

    const incidents = await h.db.query<any>(
      `SELECT COUNT(*)::int AS count FROM pvp_incidents WHERE idempotency_key = $1`,
      [requestId]
    );
    expect(incidents.rows[0].count).toBe(1);
  }, 60000);

  it('rolls back node changes, ledger movement, heat and the incident when an operation fails halfway', async () => {
    // Freeze the attacker's ledger account so the heist transfer fails after the
    // operation has already started applying its node bookkeeping.
    await h.db.query(`UPDATE ledger_accounts SET frozen = TRUE WHERE id = 'acct-user-usr-nyx-zero'`);

    const nodeBefore = await h.db.query<any>(
      `SELECT last_attacked_at, status FROM network_nodes WHERE id = 'node-pvp-cipher'`
    );
    const userBefore = await h.db.query<any>(`SELECT heat, xp FROM users WHERE id = 'usr-nyx-zero'`);
    const incidentsBefore = await h.db.query<any>(
      `SELECT COUNT(*)::int AS count FROM pvp_incidents WHERE attacker_user_id = 'usr-nyx-zero'`
    );

    await expect(
      executePvpOperation(h.db, {
        attackerUserId: 'usr-nyx-zero',
        targetNodeIdentifier: 'node-pvp-cipher',
        method: 'heist',
        requestId: `frozen-failure-${crypto.randomUUID()}`,
        bypassCooldownForTest: true
      })
    ).rejects.toThrow(/freeze/i);

    const nodeAfter = await h.db.query<any>(
      `SELECT last_attacked_at, status FROM network_nodes WHERE id = 'node-pvp-cipher'`
    );
    const userAfter = await h.db.query<any>(`SELECT heat, xp FROM users WHERE id = 'usr-nyx-zero'`);
    const incidentsAfter = await h.db.query<any>(
      `SELECT COUNT(*)::int AS count FROM pvp_incidents WHERE attacker_user_id = 'usr-nyx-zero'`
    );
    const failedLedger = await h.db.query<any>(
      `SELECT COUNT(*)::int AS count FROM ledger_transactions WHERE metadata->>'requestId' LIKE 'frozen-failure-%'`
    );

    expect(nodeAfter.rows[0].last_attacked_at).toEqual(nodeBefore.rows[0].last_attacked_at);
    expect(Number(userAfter.rows[0].heat)).toBe(Number(userBefore.rows[0].heat));
    expect(Number(userAfter.rows[0].xp)).toBe(Number(userBefore.rows[0].xp));
    expect(incidentsAfter.rows[0].count).toBe(incidentsBefore.rows[0].count);
    expect(failedLedger.rows[0].count).toBe(0);

    await h.db.query(`UPDATE ledger_accounts SET frozen = FALSE WHERE id = 'acct-user-usr-nyx-zero'`);
  }, 60000);

  it('keeps the protected floor intact even for the largest allowed seizure', async () => {
    await resetTargetNode({ balance: 520 });

    const result = await executePvpOperation(h.db, {
      attackerUserId: 'usr-vortex-prime',
      targetNodeIdentifier: 'node-pvp-cipher',
      method: 'heist',
      requestId: `floor-${crypto.randomUUID()}`,
      bypassCooldownForTest: true
    });

    expect(result.rwcStolen).toBeLessThanOrEqual(20);
    const balance = await h.db.query<any>(`SELECT balance FROM ledger_accounts WHERE id = 'acct-user-usr-cipher-wolf'`);
    expect(Number(balance.rows[0].balance)).toBeGreaterThanOrEqual(500);
  }, 60000);
});

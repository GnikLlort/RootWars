import { DatabaseAdapter, DbClient } from '../../db/index.js';
import { generateId } from '../security.js';

export class LedgerError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface TransferParams {
  idempotencyKey: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  txType:
    | 'initial_grant'
    | 'mission_reward'
    | 'player_transfer'
    | 'market_purchase'
    | 'pvp_seizure'
    | 'bounty_escrow'
    | 'bounty_payout'
    | 'group_deposit'
    | 'compliance_fine'
    | 'recovery_cost';
  referenceId?: string;
  memo?: string;
  metadata?: Record<string, any>;
  bypassFreeze?: boolean;
}

export interface LedgerTransactionRecord {
  id: string;
  idempotency_key: string;
  from_account_id: string;
  to_account_id: string;
  amount: number;
  tx_type: string;
  reference_id: string | null;
  memo: string;
  metadata: Record<string, any>;
  created_at: string;
  idempotentReplay?: boolean;
}

export const SYSTEM_MINT_ACCOUNT_ID = 'acct-system-mint';

export function getUserAccountId(userId: string): string {
  return `acct-user-${userId}`;
}

export function getGroupAccountId(groupId: string): string {
  return `acct-group-${groupId}`;
}

export function getFactionAccountId(factionId: string): string {
  return `acct-faction-${factionId}`;
}

export async function ensureLedgerAccount(
  db: DbClient,
  accountId: string,
  ownerType: 'system' | 'user' | 'group' | 'faction',
  ownerId: string,
  initialBalance = 0
): Promise<void> {
  await db.query(
    `INSERT INTO ledger_accounts (id, owner_type, owner_id, currency, balance)
     VALUES ($1, $2, $3, 'RWC', $4)
     ON CONFLICT (id) DO NOTHING`,
    [accountId, ownerType, ownerId, Math.floor(initialBalance)]
  );
}

export async function getAccountBalance(db: DbClient, accountId: string): Promise<number> {
  const res = await db.query<{ balance: string | number }>(
    `SELECT balance FROM ledger_accounts WHERE id = $1`,
    [accountId]
  );
  if (res.rows.length === 0) {
    return 0;
  }
  return Number(res.rows[0].balance);
}

export async function executeLedgerTransfer(
  db: DatabaseAdapter,
  params: TransferParams
): Promise<LedgerTransactionRecord> {
  const amount = Math.floor(Number(params.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new LedgerError('INVALID_AMOUNT', 'Transfer amount must be a positive integer.');
  }
  if (!params.idempotencyKey || params.idempotencyKey.trim().length < 4) {
    throw new LedgerError('INVALID_IDEMPOTENCY_KEY', 'A valid idempotencyKey is required.');
  }
  if (params.fromAccountId === params.toAccountId) {
    throw new LedgerError('SELF_TRANSFER', 'Cannot transfer to the same ledger account.');
  }

  return await db.transaction(async (tx) => {
    const existing = await tx.query<any>(
      `SELECT * FROM ledger_transactions WHERE idempotency_key = $1`,
      [params.idempotencyKey]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return {
        ...row,
        amount: Number(row.amount),
        idempotentReplay: true
      };
    }

    // Lock accounts in deterministic lexicographical order to prevent deadlocks
    const orderedIds = [params.fromAccountId, params.toAccountId].sort();
    const accountsRes = await tx.query<{
      id: string;
      balance: string | number;
      frozen: boolean;
    }>(
      `SELECT id, balance, frozen
       FROM ledger_accounts
       WHERE id IN ($1, $2)
       ORDER BY id
       FOR UPDATE`,
      [orderedIds[0], orderedIds[1]]
    );

    const fromAcc = accountsRes.rows.find((a) => a.id === params.fromAccountId);
    const toAcc = accountsRes.rows.find((a) => a.id === params.toAccountId);

    if (!fromAcc) {
      throw new LedgerError('SOURCE_NOT_FOUND', `Source account ${params.fromAccountId} not found.`);
    }
    if (!toAcc) {
      throw new LedgerError('DEST_NOT_FOUND', `Destination account ${params.toAccountId} not found.`);
    }

    if (!params.bypassFreeze && (fromAcc.frozen || toAcc.frozen)) {
      throw new LedgerError('ACCOUNT_FROZEN', 'One of the ledger accounts is currently under a compliance freeze.');
    }

    const fromBalance = Number(fromAcc.balance);
    if (fromBalance < amount) {
      throw new LedgerError(
        'INSUFFICIENT_FUNDS',
        `Insufficient funds: available ${fromBalance} RWC, required ${amount} RWC.`
      );
    }

    await tx.query(
      `UPDATE ledger_accounts
       SET balance = balance - $1, updated_at = NOW()
       WHERE id = $2 AND balance >= $1`,
      [amount, params.fromAccountId]
    );

    await tx.query(
      `UPDATE ledger_accounts
       SET balance = balance + $1, updated_at = NOW()
       WHERE id = $2`,
      [amount, params.toAccountId]
    );

    const txId = generateId('tx');
    const inserted = await tx.query<any>(
      `INSERT INTO ledger_transactions (
        id, idempotency_key, from_account_id, to_account_id,
        amount, tx_type, reference_id, memo, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      RETURNING *`,
      [
        txId,
        params.idempotencyKey,
        params.fromAccountId,
        params.toAccountId,
        amount,
        params.txType,
        params.referenceId ?? null,
        params.memo ?? '',
        JSON.stringify(params.metadata ?? {})
      ]
    );

    const row = inserted.rows[0];
    return {
      ...row,
      amount: Number(row.amount),
      idempotentReplay: false
    };
  });
}

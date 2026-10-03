import { Pool, PoolClient } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';

export interface QueryResult<T = Record<string, any>> {
  rows: T[];
  rowCount: number;
}

export interface DbClient {
  query<T = Record<string, any>>(sql: string, params?: any[]): Promise<QueryResult<T>>;
}

export interface DatabaseAdapter extends DbClient {
  backendType: 'pg' | 'pglite';
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  execSql(sql: string): Promise<void>;
  close(): Promise<void>;
}

class PgPoolAdapter implements DatabaseAdapter {
  public readonly backendType = 'pg' as const;
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 25,
      idleTimeoutMillis: 30000
    });
  }

  async query<T = Record<string, any>>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(sql, params);
    return {
      rows: res.rows as T[],
      rowCount: res.rowCount ?? res.rows.length
    };
  }

  async execSql(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const txClient: DbClient = {
        query: async <R = Record<string, any>>(sql: string, params: any[] = []) => {
          const res = await client.query(sql, params);
          return {
            rows: res.rows as R[],
            rowCount: res.rowCount ?? res.rows.length
          };
        }
      };
      const result = await fn(txClient);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PGliteAdapter implements DatabaseAdapter {
  public readonly backendType = 'pglite' as const;
  private pg: PGlite;
  private txQueue: Promise<any> = Promise.resolve();

  constructor(dataDir?: string) {
    if (!dataDir || dataDir === 'memory://') {
      this.pg = new PGlite();
    } else {
      fs.mkdirSync(path.dirname(dataDir), { recursive: true });
      this.pg = new PGlite(dataDir);
    }
  }

  async query<T = Record<string, any>>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
    const res = await this.pg.query<T>(sql, params);
    return {
      rows: res.rows,
      rowCount: res.affectedRows ?? res.rows.length
    };
  }

  async execSql(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
    const runTx = async (): Promise<T> => {
      return await this.pg.transaction(async (tx) => {
        const txClient: DbClient = {
          query: async <R = Record<string, any>>(sql: string, params: any[] = []) => {
            const res = await tx.query<R>(sql, params);
            return {
              rows: res.rows,
              rowCount: res.affectedRows ?? res.rows.length
            };
          }
        };
        return await fn(txClient);
      });
    };

    const next = this.txQueue.then(runTx, runTx);
    this.txQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

let activeDb: DatabaseAdapter | null = null;

export async function createDatabase(options?: {
  databaseUrl?: string;
  pgliteDataDir?: string;
}): Promise<DatabaseAdapter> {
  const dbUrl = options?.databaseUrl ?? process.env.DATABASE_URL;
  const pgliteDir = options?.pgliteDataDir ?? process.env.PGLITE_DATA_DIR ?? './.data/pgdata';

  if (dbUrl && dbUrl.startsWith('postgres') && process.env.FORCE_PGLITE !== 'true') {
    try {
      const adapter = new PgPoolAdapter(dbUrl);
      await adapter.query('SELECT 1');
      return adapter;
    } catch {
      // Fallback to persistent PGlite (embedded PostgreSQL 16 engine) when external postgres daemon is not running
    }
  }

  const adapter = new PGliteAdapter(pgliteDir);
  await adapter.query('SELECT 1');
  return adapter;
}

export async function getDb(): Promise<DatabaseAdapter> {
  if (!activeDb) {
    activeDb = await createDatabase();
  }
  return activeDb;
}

export function setDb(db: DatabaseAdapter | null): void {
  activeDb = db;
}

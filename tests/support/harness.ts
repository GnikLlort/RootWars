import crypto from 'node:crypto';
import { DatabaseAdapter, createDatabase, setDb } from '../../src/db/index.js';
import { RedisClients, createRedisClients, setRedis } from '../../src/db/redis.js';
import { seedDatabase } from '../../src/db/seed.js';
import { buildApp } from '../../src/server/app.js';
import { loadConfig, RootWarsConfig } from '../../src/server/config.js';
import { FastifyInstance } from 'fastify';
import { startOutboxLoop } from '../../src/workers/outbox-worker.js';

/**
 * Test fixtures are isolated from production seeds: the database is in-memory, the
 * demo fixture password is generated per harness instance and never matches any
 * documented/shared credential.
 */
export interface TestHarness {
  db: DatabaseAdapter;
  redis: RedisClients;
  app: FastifyInstance;
  config: RootWarsConfig;
  demoPassword: string;
  stopWorker(): Promise<void>;
  close(): Promise<void>;
}

export function testConfig(overrides: Record<string, string | undefined> = {}): RootWarsConfig {
  return loadConfig({
    NODE_ENV: 'test',
    SESSION_SECRET: `test-secret-${crypto.randomBytes(8).toString('hex')}-0123456789`,
    ...overrides
  } as NodeJS.ProcessEnv);
}

export async function createHarness(options?: {
  startWorker?: boolean;
  config?: RootWarsConfig;
  seedDemo?: boolean;
}): Promise<TestHarness> {
  const db = await createDatabase({ pgliteDataDir: 'memory://' });
  const redis = await createRedisClients();
  setDb(db);
  setRedis(redis);

  const demoPassword = crypto.randomBytes(15).toString('base64url');
  if (options?.seedDemo !== false) {
    await seedDatabase(db, { demo: { password: demoPassword } });
  } else {
    await seedDatabase(db);
  }

  const config = options?.config ?? testConfig();
  const app = await buildApp({ db, redis, config });
  await app.ready();

  let stopWorker = async () => {};
  if (options?.startWorker !== false) {
    stopWorker = await startOutboxLoop(db, {
      workerId: `test-worker-${crypto.randomBytes(4).toString('hex')}`,
      role: 'worker',
      tickMs: 25
    });
  }

  return {
    db,
    redis,
    app,
    config,
    demoPassword,
    async stopWorker() {
      await stopWorker();
    },
    async close() {
      await stopWorker().catch(() => {});
      await app.close().catch(() => {});
      await redis.close().catch(() => {});
      await db.close().catch(() => {});
    }
  };
}

export interface AuthSession {
  userId: string;
  username: string;
  cookie: string;
  setCookie: string[];
  operator: any;
}

function extractCookie(setCookieHeader: string | string[] | undefined): string {
  const header = Array.isArray(setCookieHeader) ? setCookieHeader[0] : setCookieHeader ?? '';
  return header.split(';')[0];
}

export async function registerOperator(
  app: FastifyInstance,
  username: string,
  password: string,
  extra: Record<string, any> = {}
): Promise<AuthSession> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password, ...extra }
  });
  if (res.statusCode !== 201) {
    throw new Error(`register failed (${res.statusCode}): ${res.body}`);
  }
  const body = res.json();
  const setCookie = res.headers['set-cookie'];
  return {
    userId: body.operator.id,
    username,
    cookie: extractCookie(setCookie as any),
    setCookie: (Array.isArray(setCookie) ? setCookie : [String(setCookie ?? '')]) as string[],
    operator: body.operator
  };
}

export async function loginOperator(
  app: FastifyInstance,
  username: string,
  password: string
): Promise<AuthSession | null> {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
  if (res.statusCode !== 200) return null;
  const body = res.json();
  const setCookie = res.headers['set-cookie'];
  return {
    userId: body.operator?.id,
    username,
    cookie: extractCookie(setCookie as any),
    setCookie: (Array.isArray(setCookie) ? setCookie : [String(setCookie ?? '')]) as string[],
    operator: body.operator
  };
}

export function authed(session: { cookie: string }): { cookie: string } {
  return { cookie: session.cookie };
}

/** Runs a terminal command through the real HTTP route. */
export async function runCommand(
  app: FastifyInstance,
  session: { cookie: string },
  command: string
): Promise<any> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/terminal/exec',
    headers: { cookie: session.cookie },
    payload: { command }
  });
  return { statusCode: res.statusCode, body: res.json() };
}

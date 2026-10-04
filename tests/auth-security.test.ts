import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import { createHarness, loginOperator, registerOperator, testConfig, TestHarness } from './support/harness.js';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { createDatabase, setDb } from '../src/db/index.js';
import { createRedisClients, setRedis } from '../src/db/redis.js';
import { runMigrations } from '../src/db/migrate.js';
import { seedDatabase } from '../src/db/seed.js';

async function wsProbe(
  url: string,
  options: { cookie?: string; origin?: string; query?: string }
): Promise<{ opened: boolean; closeCode?: number; firstMessage?: any }> {
  return new Promise((resolve) => {
    const wsUrl = options.query ? `${url}?${options.query}` : url;
    const ws = new WebSocket(wsUrl, {
      headers: {
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(options.origin ? { origin: options.origin } : {})
      }
    });
    const timer = setTimeout(() => {
      resolve({ opened: false, closeCode: -1 });
      try {
        ws.terminate();
      } catch {}
    }, 4000);
    ws.on('message', (data) => {
      clearTimeout(timer);
      try {
        resolve({ opened: true, firstMessage: JSON.parse(data.toString()) });
      } catch {
        resolve({ opened: true });
      }
      ws.close();
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve({ opened: false, closeCode: code });
    });
    ws.on('error', () => {
      clearTimeout(timer);
      resolve({ opened: false });
    });
  });
}

describe('Session tokens, cookies and WebSocket authentication', () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = await createHarness();
  }, 60000);

  afterAll(async () => {
    await h.close();
  });

  it('never returns a session token in JSON and sets an HttpOnly, SameSite cookie', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'cookie_operator', password: 'CookiePassword!2026' }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.token).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/"token"/);

    const setCookie = String((res.headers['set-cookie'] as any) ?? '');
    expect(setCookie).toContain('rw_session=');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    // Local/test HTTP does not set Secure; production configuration does (see below).
    expect(setCookie).not.toMatch(/Secure/);

    const login = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'cookie_operator', password: 'CookiePassword!2026' }
    });
    expect(login.json().token).toBeUndefined();
  }, 30000);

  it('marks the session cookie Secure when the server runs in production mode', () => {
    const prodConfig = loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: 'p'.repeat(48),
      REDIS_URL: 'redis://redis:6379',
      ALLOWED_ORIGINS: 'https://rootwars.example',
      DATABASE_URL: 'postgresql://rootwars:strong-password@postgres:5432/rootwars'
    } as NodeJS.ProcessEnv);
    expect(prodConfig.cookieSecure).toBe(true);
  });

  it('rejects session tokens supplied via query strings', async () => {
    const s = await registerOperator(h.app, 'query_token_user', 'QueryToken!2026');
    const rawToken = s.cookie.split('=')[1];

    const viaQuery = await h.app.inject({ method: 'GET', url: `/api/auth/me?token=${rawToken}` });
    expect(viaQuery.statusCode).toBe(401);

    const viaCookie = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: s.cookie } });
    expect(viaCookie.statusCode).toBe(200);
  }, 30000);

  it('authenticates WebSockets from the cookie handshake and rejects untrusted origins', async () => {
    // Dedicated instance so the listening server can be closed without disturbing
    // the shared harness app.
    const wsDb = await createDatabase({ pgliteDataDir: 'memory://' });
    const wsRedis = await createRedisClients();
    setDb(wsDb);
    setRedis(wsRedis);
    await runMigrations(wsDb);
    await seedDatabase(wsDb);
    const wsConfig = testConfig();
    const wsApp = await buildApp({ db: wsDb, redis: wsRedis, config: wsConfig });
    await wsApp.ready();

    try {
      const s = await registerOperator(wsApp, 'ws_operator', 'WsOperator!2026');
      const address = await wsApp.listen({ port: 0, host: '127.0.0.1' });
      const wsUrl = address.replace(/^http/, 'ws') + '/ws';

      const good = await wsProbe(wsUrl, { cookie: s.cookie, origin: 'http://127.0.0.1' });
      expect(good.opened).toBe(true);
      expect(good.firstMessage?.type).toBe('connected');

      const badOrigin = await wsProbe(wsUrl, { cookie: s.cookie, origin: 'https://evil.example' });
      expect(badOrigin.opened).toBe(false);
      expect(badOrigin.closeCode).toBe(4003);

      const noCookie = await wsProbe(wsUrl, { origin: 'http://127.0.0.1' });
      expect(noCookie.opened).toBe(false);
      expect(noCookie.closeCode).toBe(4001);

      // Query-string tokens must not authenticate WebSockets any more.
      const rawToken = s.cookie.split('=')[1];
      const queryToken = await wsProbe(wsUrl, { query: `token=${rawToken}`, origin: 'http://127.0.0.1' });
      expect(queryToken.opened).toBe(false);
    } finally {
      await wsApp.close();
      await wsRedis.close();
      await wsDb.close();
    }
  }, 60000);

  it('uses an explicit CORS allowlist instead of reflecting arbitrary origins', async () => {
    const allowed = await h.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:5173' }
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const blocked = await h.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'https://evil.example' }
    });
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('only lets admins trigger global world events', async () => {
    const player = await registerOperator(h.app, 'world_event_player', 'WorldEvent!2026');
    const forbidden = await h.app.inject({
      method: 'POST',
      url: '/api/intel/world-event',
      headers: { cookie: player.cookie }
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe('FORBIDDEN');
  }, 30000);

  it('fails closed (HTTP 503) for authentication when the rate-limit backend is down', async () => {
    const failingRedis = await createRedisClients();
    const originalIncr = (failingRedis.client as any).incr.bind(failingRedis.client);
    (failingRedis.client as any).incr = () => {
      throw new Error('redis unavailable');
    };

    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    await runMigrations(db);
    const app = await buildApp({ db, redis: failingRedis, config: testConfig({ RATE_LIMIT_FAIL_MODE: 'closed' }) });
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'nobody', password: 'nothing-at-all' }
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('RATE_LIMIT_BACKEND_UNAVAILABLE');

      const sessions = await db.query('SELECT COUNT(*) as count FROM sessions');
      expect(Number(sessions.rows[0].count)).toBe(0);
    } finally {
      (failingRedis.client as any).incr = originalIncr;
      await app.close();
      await failingRedis.close();
      await db.close();
    }
  }, 60000);

  it('does not trust client-supplied forwarding headers unless a proxy is explicitly trusted', async () => {
    const db = await createDatabase({ pgliteDataDir: 'memory://' });
    await runMigrations(db);

    // Untrusted: X-Forwarded-For must be ignored, so all requests share one bucket.
    const untrustedRedis = await createRedisClients();
    const untrustedApp = await buildApp({
      db,
      redis: untrustedRedis,
      config: testConfig({ RATE_LIMIT_MAX_PER_MINUTE: '2', TRUST_PROXY: '' })
    });
    await untrustedApp.ready();
    try {
      const attempt = (xff: string) =>
        untrustedApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': xff },
          payload: { username: 'ghost', password: 'irrelevant-password' }
        });
      await attempt('203.0.113.1');
      await attempt('203.0.113.2');
      const third = await attempt('203.0.113.3');
      expect(third.statusCode).toBe(429);
    } finally {
      await untrustedApp.close();
      await untrustedRedis.close();
    }

    // Explicitly trusted proxy: the forwarded client IP is honored per real client.
    const trustedRedis = await createRedisClients();
    const trustedApp = await buildApp({
      db,
      redis: trustedRedis,
      config: testConfig({ RATE_LIMIT_MAX_PER_MINUTE: '2', TRUST_PROXY: '127.0.0.1' })
    });
    await trustedApp.ready();
    try {
      const attempt = (xff: string) =>
        trustedApp.inject({
          method: 'POST',
          url: '/api/auth/login',
          headers: { 'x-forwarded-for': xff },
          payload: { username: 'ghost', password: 'irrelevant-password' }
        });
      for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
        const res = await attempt(ip);
        expect(res.statusCode).not.toBe(429);
      }
    } finally {
      await trustedApp.close();
      await trustedRedis.close();
      await db.close();
    }
  }, 60000);
});

describe('Logout revocation', () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = await createHarness();
  }, 60000);
  afterAll(async () => {
    await h.close();
  });

  it('revokes the session cookie on logout', async () => {
    const password = crypto.randomBytes(12).toString('base64url');
    await registerOperator(h.app, 'logout_operator', password);
    const session = await loginOperator(h.app, 'logout_operator', password);
    expect(session).not.toBeNull();

    const out = await h.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: session!.cookie }
    });
    expect(out.statusCode).toBe(200);

    const after = await h.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: session!.cookie } });
    expect(after.statusCode).toBe(401);
  }, 30000);
});


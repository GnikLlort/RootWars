import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import { createDatabase, setDb, DatabaseAdapter } from '../src/db/index.js';
import { createRedisClients, setRedis, RedisClients } from '../src/db/redis.js';
import { seedDatabase } from '../src/db/seed.js';
import { buildApp } from '../src/server/app.js';
import { testConfig } from './support/harness.js';
import { FastifyInstance } from 'fastify';

/**
 * Two simulated gateway instances share one Redis and one database, exactly like a
 * horizontally scaled deployment. Tests prove that:
 *   - an event published on instance A reaches a client connected to instance B;
 *   - private (group / alliance) events only reach authorized members;
 *   - a client that leaves a group stops receiving that group's events even though
 *     its WebSocket connection stays open;
 *   - events are delivered exactly once per client (no republish loop).
 */

interface ConnectedClient {
  ws: WebSocket;
  received: any[];
  ready: Promise<void>;
}

function connect(wsUrl: string, cookie: string): ConnectedClient {
  const ws = new WebSocket(wsUrl, { headers: { cookie } });
  const received: any[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'connected') {
        resolve();
        return;
      }
      received.push(msg);
    });
    ws.on('error', reject);
  });
  return { ws, received, ready };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('Realtime delivery across API instances', () => {
  let db: DatabaseAdapter;
  let redis: RedisClients;
  let appA: FastifyInstance;
  let appB: FastifyInstance;
  let urlA: string;
  let urlB: string;

  const password = 'RealtimePass!2026';
  let alphaCookie = '';
  let betaCookie = '';
  let gammaCookie = '';
  let groupId = '';
  let allianceId = '';

  async function register(app: FastifyInstance, username: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password }
    });
    if (res.statusCode !== 201) throw new Error(`register ${username} failed: ${res.body}`);
    return String(res.headers['set-cookie']).split(';')[0];
  }

  beforeAll(async () => {
    // Always re-resolve membership from the database so membership changes are
    // enforced immediately after a WebSocket connection is opened.
    process.env.WS_MEMBERSHIP_CACHE_MS = '0';

    db = await createDatabase({ pgliteDataDir: 'memory://' });
    redis = await createRedisClients();
    setDb(db);
    setRedis(redis);
    await seedDatabase(db, { demo: { password: crypto.randomBytes(12).toString('base64url') } });

    const config = testConfig();
    appA = await buildApp({ db, redis, config });
    appB = await buildApp({ db, redis, config });
    await appA.ready();
    await appB.ready();
    urlA = (await appA.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';
    urlB = (await appB.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws') + '/ws';

    alphaCookie = await register(appA, 'rt_alpha');
    betaCookie = await register(appB, 'rt_beta');
    gammaCookie = await register(appB, 'rt_gamma');

    const group = await appA.inject({
      method: 'POST',
      url: '/api/social/groups',
      headers: { cookie: alphaCookie },
      payload: { name: 'Realtime Test Group', tag: 'RTG', description: 'realtime tests' }
    });
    groupId = group.json().groupId;

    await appB.inject({
      method: 'POST',
      url: `/api/social/groups/${groupId}/join`,
      headers: { cookie: betaCookie }
    });

    const alliance = await appA.inject({
      method: 'POST',
      url: '/api/social/alliances',
      headers: { cookie: alphaCookie },
      payload: { name: 'Realtime Test Pact', tag: 'RTP', description: 'realtime tests' }
    });
    allianceId = alliance.json().allianceId;
  }, 120000);

  afterAll(async () => {
    await appA.close();
    await appB.close();
    await redis.close();
    await db.close();
    delete process.env.WS_MEMBERSHIP_CACHE_MS;
  }, 60000);

  it('delivers a group event across instances and withholds it from non-members', async () => {
    const alpha = connect(urlA, alphaCookie); // member, instance A
    const beta = connect(urlB, betaCookie); // member, instance B (publisher)
    const gamma = connect(urlB, gammaCookie); // non-member, instance B
    await Promise.all([alpha.ready, beta.ready, gamma.ready]);

    const message = `cross-instance-${crypto.randomUUID()}`;
    const post = await appB.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: betaCookie },
      payload: { channelType: 'group', message }
    });
    expect(post.statusCode).toBe(200);

    await waitFor(() => alpha.received.length > 0 && beta.received.length > 0);

    expect(alpha.received.filter((m) => m.payload?.message === message)).toHaveLength(1);
    expect(beta.received.filter((m) => m.payload?.message === message)).toHaveLength(1);
    expect(gamma.received.filter((m) => m.payload?.message === message)).toHaveLength(0);

    alpha.ws.close();
    beta.ws.close();
    gamma.ws.close();
  }, 60000);

  it('delivers alliance events only to members of the alliance', async () => {
    const alpha = connect(urlA, alphaCookie); // group is in the alliance
    const gamma = connect(urlB, gammaCookie); // no group / no alliance
    await Promise.all([alpha.ready, gamma.ready]);

    const message = `alliance-${crypto.randomUUID()}`;
    await appA.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: alphaCookie },
      payload: { channelType: 'alliance', message }
    });

    await waitFor(() => alpha.received.length > 0);
    expect(alpha.received.filter((m) => m.payload?.message === message)).toHaveLength(1);
    expect(gamma.received.filter((m) => m.payload?.message === message)).toHaveLength(0);

    alpha.ws.close();
    gamma.ws.close();
  }, 60000);

  it('stops delivering group events after membership changes on an open connection', async () => {
    const beta = connect(urlB, betaCookie);
    const alpha = connect(urlA, alphaCookie);
    await Promise.all([beta.ready, alpha.ready]);

    const before = `member-before-${crypto.randomUUID()}`;
    await appB.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: alphaCookie },
      payload: { channelType: 'group', message: before }
    });
    await waitFor(() => beta.received.some((m) => m.payload?.message === before));
    expect(beta.received.filter((m) => m.payload?.message === before)).toHaveLength(1);

    // beta leaves the group while its WebSocket stays open.
    await db.query(`DELETE FROM group_members WHERE user_id = (SELECT id FROM users WHERE username = 'rt_beta')`);

    const after = `member-after-${crypto.randomUUID()}`;
    await appB.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: alphaCookie },
      payload: { channelType: 'group', message: after }
    });
    await new Promise((r) => setTimeout(r, 400));

    expect(beta.received.some((m) => m.payload?.message === after)).toBe(false);
    expect(alpha.received.some((m) => m.payload?.message === after)).toBe(true);

    beta.ws.close();
    alpha.ws.close();
  }, 60000);

  it('delivers each event exactly once per client (no republish loops)', async () => {
    const alpha = connect(urlA, alphaCookie);
    await alpha.ready;

    const message = `once-${crypto.randomUUID()}`;
    await appA.inject({
      method: 'POST',
      url: '/api/chat',
      headers: { cookie: alphaCookie },
      payload: { channelType: 'global', message }
    });
    await new Promise((r) => setTimeout(r, 500));

    expect(alpha.received.filter((m) => m.payload?.message === message)).toHaveLength(1);
    alpha.ws.close();
  }, 60000);

  it('keeps private events scoped to the correct user channel', async () => {
    const alpha = connect(urlA, alphaCookie);
    const gamma = connect(urlB, gammaCookie);
    await Promise.all([alpha.ready, gamma.ready]);

    // Publish a user-targeted event through instance B's gateway via a direct chat
    // message to the global channel plus an explicitly user-scoped event.
    const betaSession = await db.query<any>(`SELECT id FROM users WHERE username = 'rt_beta'`);
    const alphaSession = await db.query<any>(`SELECT id FROM users WHERE username = 'rt_alpha'`);
    const { RealtimeGateway } = await import('../src/server/realtime.js');
    const gatewayB = new RealtimeGateway(db, redis, { membershipCacheMs: 0 });
    await gatewayB.start();
    gatewayB.publish({
      type: 'direct_alert',
      channelType: 'user',
      channelId: alphaSession.rows[0].id,
      payload: { note: 'alpha only' }
    });
    await new Promise((r) => setTimeout(r, 400));

    expect(alpha.received.some((m) => m.type === 'direct_alert')).toBe(true);
    expect(gamma.received.some((m) => m.type === 'direct_alert')).toBe(false);
    void betaSession;

    await gatewayB.stop();
    alpha.ws.close();
    gamma.ws.close();
  }, 60000);
});

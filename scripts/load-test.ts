/**
 * RootWars load test (repeatable, self-describing).
 *
 * By default it starts one or more in-process API instances against embedded
 * PGlite + in-memory Redis and ramps concurrent operator sessions gradually.
 * Point it at a real deployment stack for a meaningful measurement:
 *
 *   LOADTEST_DATABASE_URL=postgresql://rootwars:<pw>@localhost:5432/rootwars \
 *   LOADTEST_REDIS_URL=redis://localhost:6379 \
 *   LOADTEST_INSTANCES=3 \
 *   LOADTEST_MAX_SESSIONS=120 \
 *   npm run loadtest
 *
 * Everything the test measures is recorded in LOAD_TEST_RESULTS.json, including
 * which claims the run does and does not support. The report never extrapolates
 * to concurrency levels that were not actually exercised.
 */

import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { createDatabase, DatabaseAdapter } from '../src/db/index.js';
import { createRedisClients, RedisClients } from '../src/db/redis.js';
import { seedDatabase } from '../src/db/seed.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildApp } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';

type Category = 'terminal_cmd' | 'map_read' | 'mission_read' | 'chat_send';

interface LatencyRecord {
  category: Category;
  label: string;
  status: number;
  ms: number;
  ok: boolean;
  error?: string;
}

interface SocketProbe {
  socket: WebSocket;
  instanceIndex: number;
  connectedAt: number;
  received: number;
  errors: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Number(sorted[Math.max(0, idx)].toFixed(2));
}

function summarize(records: LatencyRecord[]) {
  const latencies = records.map((r) => r.ms).sort((a, b) => a - b);
  const ok = records.filter((r) => r.ok).length;
  const byStatus: Record<string, number> = {};
  for (const r of records) {
    const key = String(r.status);
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  const firstErrors = records
    .filter((r) => !r.ok)
    .slice(0, 8)
    .map((r) => `${r.category}:${r.label} -> HTTP ${r.status}${r.error ? ` (${r.error})` : ''}`);
  return {
    count: records.length,
    successful: ok,
    failed: records.length - ok,
    errorRatePercent: Number((((records.length - ok) / Math.max(1, records.length)) * 100).toFixed(2)),
    responsesByStatus: byStatus,
    latencyMs: {
      mean: Number(
        (latencies.reduce((acc, v) => acc + v, 0) / Math.max(1, latencies.length)).toFixed(2)
      ),
      p50: percentile(latencies, 50),
      p90: percentile(latencies, 90),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: percentile(latencies, 100)
    },
    firstErrors
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // The benchmark intentionally raises request-rate limits so the API, not the
  // limiter, is the measured component. This is recorded in the report.
  const config = loadConfig({
    ...process.env,
    RATE_LIMIT_MAX_PER_MINUTE: '1000000',
    COMMAND_RATE_LIMIT_PER_MINUTE: '1000000',
    CHAT_RATE_LIMIT_PER_MINUTE: '1000000'
  });

  const maxSessions = Number(process.env.LOADTEST_MAX_SESSIONS ?? 120);
  const rampSteps = Math.max(1, Number(process.env.LOADTEST_RAMP_STEPS ?? 4));
  const roundsPerWorker = Number(process.env.LOADTEST_ROUNDS ?? 12);
  const idleWsRatio = 0.4;
  const externalDbUrl = process.env.LOADTEST_DATABASE_URL?.trim() || '';
  const externalRedisUrl = process.env.LOADTEST_REDIS_URL?.trim() || '';
  const externalBackends = Boolean(externalDbUrl);

  const instanceCount = Math.max(
    1,
    Number(process.env.LOADTEST_INSTANCES ?? (externalBackends ? 3 : 1))
  );

  const db: DatabaseAdapter = await createDatabase({
    databaseUrl: externalDbUrl || undefined,
    pgliteDataDir: 'memory://'
  });
  const redis: RedisClients = await createRedisClients(externalRedisUrl || undefined);

  const warnings: string[] = [];
  if (!externalBackends) {
    warnings.push(
      'Database backend is embedded PGlite (single in-process, single-connection PostgreSQL). ' +
        'Throughput and tail latency here are NOT representative of a PostgreSQL-backed deployment.'
    );
  }
  if (!externalRedisUrl) {
    warnings.push('Redis backend is the in-process ioredis-mock; multi-instance pub/sub is simulated in-process.');
  }
  if (instanceCount === 1 && externalBackends) {
    warnings.push('Only one API instance was started (LOADTEST_INSTANCES=1).');
  }

  await runMigrations(db);

  // Seed only when the target database has no users yet, so repeated runs against
  // a real PostgreSQL instance do not pile up benchmark operators.
  const userCount = await db.query<{ count: string }>('SELECT COUNT(*) AS count FROM users');
  if (Number(userCount.rows[0].count) === 0) {
    await seedDatabase(db);
  }

  console.log(`[RootWars LoadTest] db=${db.backendType} redis=${redis.backendType} instances=${instanceCount}`);

  // One shared outbox worker loop so queue lag reflects async job processing.
  const { startOutboxLoop } = await import('../src/workers/outbox-worker.js');
  const stopWorker = await startOutboxLoop(db, { workerId: 'loadtest-worker', role: 'worker', tickMs: 100 });

  const apps = [] as Awaited<ReturnType<typeof buildApp>>[];
  const addresses: string[] = [];
  for (let i = 0; i < instanceCount; i++) {
    const app = await buildApp({ db, redis, config });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    apps.push(app);
    addresses.push(address);
  }
  const wsBases = addresses.map((a) => a.replace(/^http/, 'ws'));

  const sockets: SocketProbe[] = [];
  const records: LatencyRecord[] = [];
  const chatSendTimes: number[] = [];
  let provisioningErrors = 0;

  async function registerOperator(index: number): Promise<string | null> {
    const address = addresses[index % addresses.length];
    const res = await fetch(`${address}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: `lt_${Date.now().toString(36)}_${index}`, password: 'LoadTestPassword!2026' })
    });
    if (res.status !== 201) {
      provisioningErrors++;
      return null;
    }
    const cookie = res.headers.get('set-cookie');
    return cookie ? cookie.split(';')[0] : null;
  }

  async function openSocket(cookie: string, instanceIndex: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${wsBases[instanceIndex % wsBases.length]}/ws`, {
        headers: { cookie }
      });
      const probe: SocketProbe = { socket: ws, instanceIndex, connectedAt: performance.now(), received: 0, errors: 0 };
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type !== 'connected') probe.received++;
        } catch {
          /* ignore malformed frames */
        }
      });
      ws.on('error', () => {
        probe.errors++;
        resolve();
      });
      ws.on('open', () => {
        sockets.push(probe);
        resolve();
      });
    });
  }

  async function request(
    category: Category,
    instanceIndex: number,
    cookie: string,
    init: { method?: string; body?: unknown; path: string; label?: string }
  ): Promise<void> {
    const address = addresses[instanceIndex % addresses.length];
    const t0 = performance.now();
    let status = 0;
    let error: string | undefined;
    try {
      const res = await fetch(`${address}${init.path}`, {
        method: init.method ?? 'GET',
        headers: {
          cookie,
          ...(init.body ? { 'Content-Type': 'application/json' } : {})
        },
        body: init.body ? JSON.stringify(init.body) : undefined
      });
      status = res.status;
      const bodyText = await res.text();
      if (!res.ok) error = bodyText.slice(0, 160);
    } catch (err: any) {
      error = String(err?.message ?? err).slice(0, 120);
    }
    records.push({
      category,
      label: init.label ?? init.path,
      status,
      ms: performance.now() - t0,
      ok: status >= 200 && status < 300,
      error
    });
  }

  const cmdPool = [
    'status',
    'map --region neo-cascadia',
    'connect --target node-infra-ixp',
    'inspect --target node-infra-ixp',
    'jobs'
  ];

  async function runWorker(cookie: string, workerIndex: number): Promise<void> {
    const instanceIndex = workerIndex % addresses.length;
    for (let r = 0; r < roundsPerWorker; r++) {
      const roll = (workerIndex + r) % 10;
      if (roll < 4) {
        const command = cmdPool[(workerIndex + r) % cmdPool.length];
        await request('terminal_cmd', instanceIndex, cookie, {
          method: 'POST',
          path: '/api/terminal/exec',
          body: { command },
          label: command
        });
      } else if (roll < 7) {
        await request('map_read', instanceIndex, cookie, { path: '/api/world/map?region=neo-cascadia' });
      } else if (roll < 9) {
        await request('mission_read', instanceIndex, cookie, { path: '/api/missions' });
      } else {
        await request('chat_send', instanceIndex, cookie, {
          method: 'POST',
          path: '/api/chat',
          body: { channelType: 'global', message: `telemetry ${workerIndex}-${r}` }
        });
        chatSendTimes.push(performance.now());
      }
    }
  }

  // Sample queue lag (outbox backlog) and DB pool saturation throughout the run.
  let maxQueueDepth = 0;
  const maxQueueLagSeconds: number[] = [];
  const maxPoolWaiting: number[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const lag = await db.query<{ depth: string; lag: string }>(
          `SELECT COUNT(*) AS depth,
                  COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - created_at))), 0) AS lag
           FROM outbox_jobs WHERE status IN ('pending', 'processing')`
        );
        maxQueueDepth = Math.max(maxQueueDepth, Number(lag.rows[0].depth));
        maxQueueLagSeconds.push(Number(lag.rows[0].lag));
        maxPoolWaiting.push(db.poolStats().waiting);
      } catch {
        /* sampler must never affect the benchmark */
      }
      await sleep(250);
    }
  })();

  const sessionCount = Math.max(1, maxSessions);
  const idleCount = Math.floor(sessionCount * idleWsRatio);
  const cohortSize = Math.max(1, Math.ceil(sessionCount / rampSteps));

  console.log(
    `[RootWars LoadTest] Ramping ${sessionCount} sessions in ${rampSteps} steps ` +
      `(${idleCount} idle WS / ${sessionCount - idleCount} active), ${roundsPerWorker} rounds each...`
  );

  const startWall = performance.now();
  const cohorts: Promise<void>[] = [];
  let provisioned = 0;

  for (let step = 0; step < rampSteps && provisioned < sessionCount; step++) {
    const size = Math.min(cohortSize, sessionCount - provisioned);
    const cookies: string[] = [];
    for (let i = 0; i < size; i++) {
      const cookie = await registerOperator(provisioned + i);
      if (cookie) cookies.push(cookie);
    }
    provisioned += size;

    for (let i = 0; i < cookies.length; i++) {
      await openSocket(cookies[i], provisioned - cookies.length + i);
    }

    const activeCookies = cookies.slice(idleCount > 0 && step === 0 ? idleCount : 0);
    cohorts.push(
      Promise.all(activeCookies.map((cookie, i) => runWorker(cookie, provisioned - cookies.length + i)))
        .then(() => undefined)
    );
    if (step < rampSteps - 1) await sleep(Number(process.env.LOADTEST_RAMP_DELAY_MS ?? 750));
  }

  await Promise.all(cohorts);
  const durationSec = (performance.now() - startWall) / 1000;
  sampling = false;
  await sampler;

  // WebSocket delivery check: every global chat message sent while a socket was
  // connected must arrive exactly once at that socket.
  const expectedDeliveries = sockets.reduce((acc, probe) => {
    return acc + chatSendTimes.filter((t) => t > probe.connectedAt).length;
  }, 0);
  const actualDeliveries = sockets.reduce((acc, probe) => acc + probe.received, 0);

  for (const probe of sockets) {
    try {
      probe.socket.close();
    } catch {
      /* ignore */
    }
  }
  await stopWorker();
  for (const app of apps) await app.close();

  const pool = db.poolStats();
  const finalQueue = await db
    .query<{ status: string; count: string }>(`SELECT status, COUNT(*) AS count FROM outbox_jobs GROUP BY status`)
    .catch(() => ({ rows: [] as any[] }));
  const outboxBacklog = Object.fromEntries(finalQueue.rows.map((r) => [r.status, Number(r.count)]));

  await redis.close();
  await db.close();

  const summary = summarize(records);
  const byCategory = (cat: Category) => summarize(records.filter((r) => r.category === cat));

  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    /* not a git checkout */
  }

  const report = {
    timestamp: new Date().toISOString(),
    gitCommit,
    command: 'npm run loadtest',
    environment: {
      platform: `${os.type()} ${os.release()} (${os.arch()})`,
      nodeVersion: process.version,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      cpuCores: os.cpus().length,
      totalMemoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
      databaseBackend: db.backendType,
      redisBackend: redis.backendType,
      apiInstances: addresses.length,
      rateLimitsRaisedForBenchmark: true
    },
    workload: {
      rampSteps,
      targetSessions: sessionCount,
      provisionedSessions: sockets.length,
      provisioningFailures: provisioningErrors,
      idleWebSocketSessions: Math.min(idleCount, sockets.length),
      activeWorkerSessions: sockets.length - Math.min(idleCount, sockets.length),
      roundsPerWorker,
      totalRequests: summary.count,
      durationSeconds: Number(durationSec.toFixed(2)),
      requestsPerSecond: Number((summary.count / durationSec).toFixed(2))
    },
    http: {
      ...summary,
      byCategory: {
        terminal_cmd: byCategory('terminal_cmd'),
        map_read: byCategory('map_read'),
        mission_read: byCategory('mission_read'),
        chat_send: byCategory('chat_send')
      }
    },
    websocketDelivery: {
      connectedSockets: sockets.length,
      chatMessagesSent: chatSendTimes.length,
      expectedDeliveries,
      actualDeliveries,
      deliveryRatio:
        expectedDeliveries === 0 ? null : Number((actualDeliveries / expectedDeliveries).toFixed(4)),
      socketErrors: sockets.reduce((acc, p) => acc + p.errors, 0)
    },
    database: {
      poolStats: pool,
      maxWaitingRequestsObserved: maxPoolWaiting.length ? Math.max(...maxPoolWaiting) : 0,
      notes: pool.serialized
        ? 'PGlite: every query funnels through one connection; latency under load is serialization-bound, not PostgreSQL-bound.'
        : 'pg.Pool: waiting>0 indicates pool saturation.'
    },
    outboxQueue: {
      maxDepthObserved: maxQueueDepth,
      maxLagSecondsObserved: maxQueueLagSeconds.length
        ? Number(Math.max(...maxQueueLagSeconds).toFixed(2))
        : 0,
      finalCountsByStatus: outboxBacklog
    },
    claimsSupportedByThisRun: [
      `${sockets.length} concurrent authenticated WebSocket sessions with ${summary.count} HTTP requests` +
        ` (p50 ${summary.latencyMs.p50}ms / p95 ${summary.latencyMs.p95}ms / p99 ${summary.latencyMs.p99}ms,` +
        ` ${summary.failed} errors) against ${addresses.length} API instance(s) using ${db.backendType} + ${redis.backendType}.`,
      `WebSocket fan-out delivery ratio ${expectedDeliveries === 0 ? 'n/a' : actualDeliveries / expectedDeliveries} for global chat across ${addresses.length} instance(s).`
    ],
    claimsNotSupportedByThisRun: [
      'This run does NOT demonstrate thousands of concurrent players.',
      ...warnings
    ]
  };

  fs.writeFileSync('LOAD_TEST_RESULTS.json', JSON.stringify(report, null, 2));
  console.log('\n=== ROOTWARS LOAD TEST REPORT ===');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('[RootWars LoadTest] Error:', err);
  process.exit(1);
});

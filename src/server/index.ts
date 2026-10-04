import { getConfig, ConfigError } from './config.js';
import { runMigrations } from '../db/migrate.js';
import { getDb } from '../db/index.js';
import { getRedis } from '../db/redis.js';
import { startOutboxLoop } from '../workers/outbox-worker.js';
import { buildApp } from './app.js';

async function main() {
  const config = getConfig();

  const db = await getDb();
  const redis = await getRedis();

  // Schema is applied automatically; world/demo data is seeded only by the
  // explicit `npm run db:seed` / `npm run db:demo-seed` commands.
  await runMigrations(db);

  const app = await buildApp({ db, redis });

  // API instances must not run duplicate world/outbox workers. The worker loop is
  // started deliberately: in a dedicated worker process (ROLE=worker) or in the
  // documented single-process development mode (ROLE=all). Production API
  // instances run with ROLE=api and no embedded worker.
  let stopWorker: (() => Promise<void>) | null = null;
  if (config.role !== 'api') {
    stopWorker = await startOutboxLoop(db, {
      workerId: `${config.role}-${process.pid}`,
      role: config.role
    });
  }

  const shutdown = async () => {
    if (stopWorker) await stopWorker().catch(() => {});
    await app.close().catch(() => {});
    await db.close().catch(() => {});
    await redis.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: config.host });
  console.log(
    `[RootWars Server] Listening on http://${config.host}:${config.port} ` +
      `(role: ${config.role}, DB: ${db.backendType}, Redis: ${redis.backendType}, env: ${config.nodeEnv})`
  );
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error('[RootWars Server] Startup refused due to unsafe configuration:');
    for (const problem of err.problems) {
      console.error(`  - ${problem}`);
    }
  } else {
    console.error('[RootWars Server] Fatal startup error:', err);
  }
  process.exit(1);
});

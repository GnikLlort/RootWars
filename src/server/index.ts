import { getDb } from '../db/index.js';
import { getRedis } from '../db/redis.js';
import { seedDatabase } from '../db/seed.js';
import { processPendingOutboxJobs } from '../workers/outbox-worker.js';
import { buildApp } from './app.js';

async function main() {
  const db = await getDb();
  const redis = await getRedis();

  await seedDatabase(db);

  const app = await buildApp({ db, redis });

  // Background outbox worker poll
  const workerInterval = setInterval(async () => {
    try {
      await processPendingOutboxJobs(db, 'api-embedded-worker', 10);
    } catch {}
  }, 3000);
  workerInterval.unref();

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';

  await app.listen({ port, host });
  console.log(
    `[RootWars Server] Listening on http://${host}:${port} (DB: ${db.backendType}, Redis: ${redis.backendType})`
  );
}

main().catch((err) => {
  console.error('[RootWars Server] Fatal startup error:', err);
  process.exit(1);
});

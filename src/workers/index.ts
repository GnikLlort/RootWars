import { getConfig } from '../server/config.js';
import { getDb } from '../db/index.js';
import { getLabAvailability } from './lab-runner.js';
import { startOutboxLoop } from './outbox-worker.js';

/**
 * Dedicated RootWars worker process.
 *
 * Roles are explicit: this process owns outbox/world work and lab scan execution
 * (including the Docker lab endpoint), while API instances run with ROLE=api and
 * never start their own copy of the world/outbox loop.
 */
async function startWorkerLoop(): Promise<void> {
  const config = getConfig();
  const db = await getDb();
  const workerId = `worker-${process.pid}`;
  console.log(`[RootWars Worker] Started (${workerId}) using DB backend: ${db.backendType}`);

  // Report lab availability once at startup so operators immediately see whether
  // lab missions will execute or fail closed in this environment.
  const lab = await getLabAvailability();
  console.log(`[RootWars Worker] ${lab.summary}`);

  const stop = await startOutboxLoop(db, { workerId, role: 'worker', keepAlive: true });

  const shutdown = async () => {
    await stop().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Keep the process alive; the loop itself uses an unref'd interval.
  void config;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorkerLoop().catch((err) => {
    console.error('[RootWars Worker] Fatal startup error:', err);
    process.exit(1);
  });
}

export { startWorkerLoop };

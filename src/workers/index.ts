import { getDb } from '../db/index.js';
import { enqueueOutboxJob, processPendingOutboxJobs } from './outbox-worker.js';

async function startWorkerLoop(): Promise<void> {
  const db = await getDb();
  const workerId = `worker-${process.pid}`;
  console.log(`[RootWars Worker] Started (${workerId}) using DB backend: ${db.backendType}`);

  let tickCounter = 0;

  const timer = setInterval(async () => {
    try {
      tickCounter++;
      await processPendingOutboxJobs(db, workerId, 15);

      if (tickCounter % 15 === 0) {
        await enqueueOutboxJob(db, 'mission_timer', {});
        await enqueueOutboxJob(db, 'node_recovery', {});
      }
      if (tickCounter % 60 === 0) {
        await enqueueOutboxJob(db, 'world_event_tick', {});
      }
    } catch (err) {
      console.error('[RootWars Worker] Tick error:', err);
    }
  }, 2000);

  process.on('SIGTERM', async () => {
    clearInterval(timer);
    await db.close();
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorkerLoop();
}

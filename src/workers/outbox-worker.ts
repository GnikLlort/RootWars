import { DatabaseAdapter, DbClient } from '../db/index.js';
import { getRedis } from '../db/redis.js';
import { generateId } from '../server/security.js';
import {
  generateDynamicWorldEvent,
  triggerFactionReaction,
  FactionReactionType
} from '../server/services/world-factions.js';
import { executeIsolatedLabScan } from './lab-runner.js';

export type OutboxJobType =
  | 'lab_scan'
  | 'faction_reaction'
  | 'world_event_tick'
  | 'mission_timer'
  | 'node_recovery'
  | 'realtime_broadcast';

export const STALE_JOB_LOCK_MS = 5 * 60 * 1000;

export async function enqueueOutboxJob(
  db: DbClient,
  jobType: OutboxJobType,
  payload: Record<string, any>,
  delaySeconds = 0
): Promise<string> {
  const id = generateId('job');
  await db.query(
    `INSERT INTO outbox_jobs (id, job_type, payload, status, run_after)
     VALUES ($1, $2, $3::jsonb, 'pending', NOW() + ($4 || ' seconds')::interval)`,
    [id, jobType, JSON.stringify(payload), String(delaySeconds)]
  );
  return id;
}

async function heartbeat(role: string): Promise<void> {
  try {
    const redis = await getRedis();
    await redis.client.set(`worker:heartbeat:${role}`, String(Date.now()), 'EX', 20);
  } catch {
    // Heartbeats are advisory; job processing continues without Redis.
  }
}

export async function processPendingOutboxJobs(
  db: DatabaseAdapter,
  workerId = 'worker-main',
  limit = 10
): Promise<number> {
  // Reclaim jobs abandoned by a worker that died mid-processing.
  await db.query(
    `UPDATE outbox_jobs
     SET status = 'pending', locked_by = NULL, locked_at = NULL
     WHERE status = 'processing' AND locked_at < NOW() - ($1 || ' milliseconds')::interval`,
    [String(STALE_JOB_LOCK_MS)]
  );

  const pendingRes = await db.query<any>(
    `SELECT * FROM outbox_jobs
     WHERE status = 'pending' AND run_after <= NOW()
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );

  let processedCount = 0;

  for (const job of pendingRes.rows) {
    const claimRes = await db.query<any>(
      `UPDATE outbox_jobs
       SET status = 'processing', locked_by = $1, locked_at = NOW(), attempts = attempts + 1
       WHERE id = $2 AND status = 'pending'
       RETURNING *`,
      [workerId, job.id]
    );
    if (claimRes.rows.length === 0) continue;

    try {
      const payload = job.payload ?? {};
      let result: any = { ok: true };

      switch (job.job_type as OutboxJobType) {
        case 'faction_reaction': {
          result = await triggerFactionReaction(db, {
            factionId: payload.factionId,
            triggerUserId: payload.triggerUserId,
            triggerReason: payload.triggerReason ?? 'operator reconnaissance activity',
            preferredReaction: payload.preferredReaction as FactionReactionType | undefined
          });
          break;
        }
        case 'world_event_tick': {
          result = await generateDynamicWorldEvent(db);
          break;
        }
        case 'mission_timer': {
          const expRes = await db.query(
            `UPDATE lab_sessions
             SET status = 'expired', closed_at = NOW()
             WHERE status = 'active' AND expires_at <= NOW()`
          );
          result = { expiredLabSessions: expRes.rowCount };
          break;
        }
        case 'node_recovery': {
          const recRes = await db.query(
            `UPDATE network_nodes
             SET status = 'online', outage_until = NULL
             WHERE status = 'degraded' AND outage_until IS NOT NULL AND outage_until <= NOW()`
          );
          result = { recoveredNodes: recRes.rowCount };
          break;
        }
        case 'lab_scan': {
          // Real isolated execution happens here: the API only enqueues the job and
          // polls it, so the API process never needs a Docker endpoint.
          result = await executeIsolatedLabScan(payload.scanRequest);
          break;
        }
        case 'realtime_broadcast': {
          result = { broadcasted: true };
          break;
        }
      }

      await db.query(
        `UPDATE outbox_jobs
         SET status = 'completed', result_json = $1::jsonb, completed_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(result ?? {}), job.id]
      );
      processedCount++;
    } catch (err: any) {
      const nextStatus = Number(job.attempts) + 1 >= Number(job.max_attempts) ? 'failed' : 'pending';
      await db.query(
        `UPDATE outbox_jobs
         SET status = $1, error_message = $2, locked_by = NULL, locked_at = NULL
         WHERE id = $3`,
        [nextStatus, err?.message ?? String(err), job.id]
      );
    }
  }

  return processedCount;
}

export interface OutboxLoopOptions {
  workerId: string;
  role: 'api' | 'worker' | 'all';
  tickMs?: number;
  /** When true the loop's timer keeps the process alive (dedicated worker process). */
  keepAlive?: boolean;
}

/**
 * Starts the durable worker loop.
 *
 * Only processes started with an explicit worker role run this loop, so multiple
 * stateless API instances never start duplicate world/outbox workers.
 */
export async function startOutboxLoop(db: DatabaseAdapter, options: OutboxLoopOptions): Promise<() => Promise<void>> {
  const tickMs = options.tickMs ?? 2000;
  let tickCounter = 0;
  let stopped = false;

  const timer = setInterval(async () => {
    if (stopped) return;
    try {
      tickCounter++;
      await processPendingOutboxJobs(db, options.workerId, 15);
      await heartbeat(options.role === 'all' ? 'all' : 'worker');

      if (tickCounter % 15 === 0) {
        await enqueueOutboxJob(db, 'mission_timer', {});
        await enqueueOutboxJob(db, 'node_recovery', {});
      }
      if (tickCounter % 60 === 0) {
        await enqueueOutboxJob(db, 'world_event_tick', {});
      }
    } catch (err) {
      console.error(`[RootWars Worker ${options.workerId}] Tick error:`, err);
    }
  }, tickMs);
  if (!options.keepAlive) {
    timer.unref?.();
  }

  return async () => {
    stopped = true;
    clearInterval(timer);
  };
}

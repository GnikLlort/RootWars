-- ROOTWARS Migration 002
-- Atomic, idempotent PvP operations.
--
-- `pvp_incidents.idempotency_key` carries the client supplied request id. A unique
-- index makes replayed attacks return the original incident instead of executing a
-- second attack, and guarantees that a ledger seizure can never exist without its
-- matching incident record (both are written in the same transaction).

ALTER TABLE pvp_incidents ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE pvp_incidents ADD COLUMN IF NOT EXISTS bounty_claimed_rwc BIGINT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pvp_incidents_idempotency_key
  ON pvp_incidents(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Worker heartbeat/ownership visibility for multi-instance deployments.
CREATE INDEX IF NOT EXISTS idx_outbox_jobs_locked_by ON outbox_jobs(locked_by, status);

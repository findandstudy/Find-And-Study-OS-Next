-- Adapter auto-graduation: per-adapter success counting needs the adapter key
-- stamped on every portal submission at enqueue time. Hand-written idempotent
-- migration (journal not maintained past 0017 — apply manually / via boot DDL).

ALTER TABLE portal_submissions ADD COLUMN IF NOT EXISTS adapter_key TEXT;

CREATE INDEX IF NOT EXISTS portal_submissions_adapter_key_status_idx
  ON portal_submissions USING btree (adapter_key, status);

-- One-off backfill: map historical rows via portal_universities
-- (university_key -> adapter_key). Idempotent: only fills NULLs.
UPDATE portal_submissions ps
SET adapter_key = pu.adapter_key
FROM portal_universities pu
WHERE ps.adapter_key IS NULL
  AND pu.university_key = ps.university_key
  AND pu.deleted_at IS NULL;

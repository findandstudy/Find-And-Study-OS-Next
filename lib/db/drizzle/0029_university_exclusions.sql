-- 0029_university_exclusions.sql
-- University-based nationality exclusions ("exclusive region") — Phase 1 backend core.
-- When a student's nationality is on the exclusive list for a portal university,
-- the worker skips the portal entirely and marks status='exclusive_region'.
-- Additive + idempotent (hand-written; not journaled — see migrations 0018+).
CREATE TABLE IF NOT EXISTS portal_university_exclusions (
  id SERIAL PRIMARY KEY,
  university_key TEXT NOT NULL,
  nationality TEXT NOT NULL,
  agency_name TEXT,
  note TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Partial unique: only one ACTIVE rule per (university_key, nationality), so a
-- soft-deleted rule can be recreated.
CREATE UNIQUE INDEX IF NOT EXISTS portal_uni_exclusion_key_nat_uniq
  ON portal_university_exclusions (university_key, nationality)
  WHERE deleted_at IS NULL;

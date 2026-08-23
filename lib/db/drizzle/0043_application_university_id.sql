-- Canonical university-assigned identifier shown on the application record.
-- Historical per-run references remain in portal_submissions.external_ref.
-- This additive migration performs no backfill and changes no existing data.
ALTER TABLE "applications"
  ADD COLUMN IF NOT EXISTS "university_application_id" text;

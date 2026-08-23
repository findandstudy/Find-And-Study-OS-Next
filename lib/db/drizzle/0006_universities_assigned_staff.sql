-- Task #112: per-university assigned staff for university-contract expiry warnings.
ALTER TABLE universities
  ADD COLUMN IF NOT EXISTS assigned_staff_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

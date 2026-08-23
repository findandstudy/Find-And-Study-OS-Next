-- Task #112: per-contract assigned staff for expiry warning recipients.
ALTER TABLE university_contracts
  ADD COLUMN IF NOT EXISTS assigned_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

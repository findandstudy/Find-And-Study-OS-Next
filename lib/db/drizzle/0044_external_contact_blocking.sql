ALTER TABLE "external_contacts"
  ADD COLUMN IF NOT EXISTS "is_blocked" boolean DEFAULT false NOT NULL;

ALTER TABLE "external_contacts"
  ADD COLUMN IF NOT EXISTS "blocked_at" timestamp with time zone;

-- Versioned DB-backed declarative adapter SPECs (opt-in parallel system to
-- portal_adapters). One row per (key, version); `enabled` marks the active
-- version per key that the loader resolves. `source` distinguishes trusted
-- builtin specs from uploaded ones; jsHook steps only execute when approved.
DO $$ BEGIN
  CREATE TYPE "portal_adapter_spec_source" AS ENUM ('builtin', 'uploaded');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "portal_adapter_specs" (
  "id" serial PRIMARY KEY,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "spec" jsonb NOT NULL,
  "version" integer NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  "source" "portal_adapter_spec_source" NOT NULL DEFAULT 'uploaded',
  "js_hook_approved" boolean NOT NULL DEFAULT false,
  "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "portal_adapter_specs_key_version_uniq" ON "portal_adapter_specs" ("key", "version");
CREATE INDEX IF NOT EXISTS "portal_adapter_specs_key_idx" ON "portal_adapter_specs" ("key");
CREATE INDEX IF NOT EXISTS "portal_adapter_specs_enabled_idx" ON "portal_adapter_specs" ("enabled");
-- Invariant: at most one enabled version per key.
CREATE UNIQUE INDEX IF NOT EXISTS "portal_adapter_specs_one_enabled_per_key" ON "portal_adapter_specs" ("key") WHERE "enabled";

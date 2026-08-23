-- Panel-managed Topkapı matching data → portal_program_mapping (single source).
-- Additive + idempotent. The matcher reads these MERGED OVER the adapter's
-- built-in code defaults (DB wins); empty columns = no behaviour change.
-- Mirrors the boot-DDL ALTERs in artifacts/api-server/src/index.ts (prod path).

ALTER TABLE "portal_program_mapping" ADD COLUMN IF NOT EXISTS "program_overrides" jsonb NOT NULL DEFAULT '{}';
ALTER TABLE "portal_program_mapping" ADD COLUMN IF NOT EXISTS "synonyms" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE "portal_program_mapping" ADD COLUMN IF NOT EXISTS "country_overrides" jsonb NOT NULL DEFAULT '{}';

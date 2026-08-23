-- Phase 3 multi-portal membership.
-- Junction: a multi-portal account (portal_key) ↔ FAS-OS catalog universities.
CREATE TABLE IF NOT EXISTS "portal_account_universities" (
  "id" serial PRIMARY KEY NOT NULL,
  "portal_key" text NOT NULL,
  "catalog_university_id" integer NOT NULL REFERENCES "universities"("id") ON DELETE CASCADE,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
-- A catalog university belongs to at most one portal account.
CREATE UNIQUE INDEX IF NOT EXISTS "portal_acct_uni_catalog_uniq" ON "portal_account_universities" ("catalog_university_id");
CREATE INDEX IF NOT EXISTS "portal_acct_uni_portal_key_idx" ON "portal_account_universities" ("portal_key");

-- Member-level program overrides: add the member dimension.
ALTER TABLE "portal_program_mapping" ADD COLUMN IF NOT EXISTS "member_university_id" integer REFERENCES "universities"("id") ON DELETE CASCADE;

-- Replace the single UNIQUE(university_key) with two partial uniques so that a
-- universityKey can have one 1:1 row (member NULL) plus N member-scoped rows.
DROP INDEX IF EXISTS "portal_prog_map_key_uniq";
CREATE UNIQUE INDEX IF NOT EXISTS "portal_prog_map_key_nomem_uniq" ON "portal_program_mapping" ("university_key") WHERE "member_university_id" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "portal_prog_map_key_mem_uniq" ON "portal_program_mapping" ("university_key", "member_university_id") WHERE "member_university_id" IS NOT NULL;

-- Migrate Phase 2 routes_via members → junction (idempotent). Only members that
-- have a catalog id (crm_university_id) can be expressed in the catalog-keyed
-- junction; others keep their routes_via fallback.
INSERT INTO "portal_account_universities" ("portal_key", "catalog_university_id", "enabled")
SELECT "routes_via", "crm_university_id", true
  FROM "portal_universities"
 WHERE "routes_via" IS NOT NULL
   AND "crm_university_id" IS NOT NULL
   AND "deleted_at" IS NULL
ON CONFLICT ("catalog_university_id") DO NOTHING;

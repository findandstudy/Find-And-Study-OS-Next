-- Automatic backup-programme (supersession) data model.
-- Generated migration — NOT auto-pushed. Apply via the project's migration path.

-- 1) Fallback rules: a full/source CRM programme → ordered fallback programme ids,
--    scoped to a portal university (university_key ~ portal_universities.university_key).
CREATE TABLE IF NOT EXISTS "portal_program_fallbacks" (
  "id" serial PRIMARY KEY NOT NULL,
  "university_key" text NOT NULL,
  "source_program_id" integer NOT NULL,
  "fallback_program_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "auto_submit" boolean NOT NULL DEFAULT true,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone
);
-- One fallback rule per (portal university, source programme).
CREATE UNIQUE INDEX IF NOT EXISTS "portal_prog_fallback_key_source_uniq"
  ON "portal_program_fallbacks" ("university_key", "source_program_id");

-- 2) Supersession links on applications (self-referencing, ON DELETE SET NULL).
ALTER TABLE "applications"
  ADD COLUMN IF NOT EXISTS "superseded_by_application_id" integer;
ALTER TABLE "applications"
  ADD COLUMN IF NOT EXISTS "superseded_from_application_id" integer;
ALTER TABLE "applications"
  ADD COLUMN IF NOT EXISTS "supersede_reason" text;

DO $$ BEGIN
  ALTER TABLE "applications"
    ADD CONSTRAINT "applications_superseded_by_application_id_fk"
    FOREIGN KEY ("superseded_by_application_id")
    REFERENCES "applications"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "applications"
    ADD CONSTRAINT "applications_superseded_from_application_id_fk"
    FOREIGN KEY ("superseded_from_application_id")
    REFERENCES "applications"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) Free-form metadata on portal_submissions (supersession context / fallback chain).
ALTER TABLE "portal_submissions"
  ADD COLUMN IF NOT EXISTS "meta" jsonb;

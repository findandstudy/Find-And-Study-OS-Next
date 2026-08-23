-- Migration 0019: portal_schema_align
--
-- Aligns portal_credentials and portal_submissions with multi-tenant spec:
--   portal_credentials  — adds organizationId, label, createdBy;
--                         replaces single-key unique index with (org, key).
--   portal_submissions  — adds organizationId; makes studentId nullable (set null);
--                         adds universityKey and (organizationId, status) indexes.
--
-- SAFE TO RUN: all changes are additive (ADD COLUMN) or index-only, except
-- the studentId NOT NULL drop and FK behavior change which are backward-compatible.
-- No existing data is modified or deleted.
-- AUTO-PUSH: NO — apply manually after review.

-- ---------------------------------------------------------------------------
-- portal_credentials: new columns
-- ---------------------------------------------------------------------------

ALTER TABLE "portal_credentials"
  ADD COLUMN IF NOT EXISTS "organization_id" integer;
--> statement-breakpoint

ALTER TABLE "portal_credentials"
  ADD COLUMN IF NOT EXISTS "label" text NOT NULL DEFAULT '';
--> statement-breakpoint

ALTER TABLE "portal_credentials"
  ADD COLUMN IF NOT EXISTS "created_by" integer
    REFERENCES "users"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- portal_credentials: replace single-key unique index with org-scoped index
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "portal_creds_portal_key_uniq";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "portal_creds_org_key_uniq"
  ON "portal_credentials" ("organization_id", "portal_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "portal_creds_org_idx"
  ON "portal_credentials" ("organization_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "portal_creds_active_idx"
  ON "portal_credentials" ("is_active");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- portal_submissions: new column
-- ---------------------------------------------------------------------------

ALTER TABLE "portal_submissions"
  ADD COLUMN IF NOT EXISTS "organization_id" integer;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- portal_submissions: studentId — drop NOT NULL + change FK to SET NULL
-- ---------------------------------------------------------------------------

ALTER TABLE "portal_submissions"
  ALTER COLUMN "student_id" DROP NOT NULL;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "portal_submissions"
    DROP CONSTRAINT IF EXISTS "portal_submissions_student_id_students_id_fk";
EXCEPTION WHEN undefined_object THEN NULL;
END $$;
--> statement-breakpoint

ALTER TABLE "portal_submissions"
  ADD CONSTRAINT "portal_submissions_student_id_students_id_fk"
  FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- portal_submissions: new indexes
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "portal_submissions_university_key_idx"
  ON "portal_submissions" ("university_key");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "portal_submissions_org_status_idx"
  ON "portal_submissions" ("organization_id", "status");

-- Root/main application link for automatic fallback chains.
-- Hand-written idempotent migration (0018+ are NOT auto-generated / journaled).
--
-- Set on portal-automation fan-out children AND supersession children so any hop
-- can recover the originally-applied programme + language + level and detect
-- same-university (X) vs different-university (Y). Nullable & additive.

ALTER TABLE "applications"
  ADD COLUMN IF NOT EXISTS "main_application_id" integer;

DO $$ BEGIN
  ALTER TABLE "applications"
    ADD CONSTRAINT "applications_main_application_id_fk"
    FOREIGN KEY ("main_application_id")
    REFERENCES "applications"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "applications_main_application_id_idx"
  ON "applications" ("main_application_id");

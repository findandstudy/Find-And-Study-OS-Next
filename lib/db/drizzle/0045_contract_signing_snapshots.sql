ALTER TABLE "signing_sessions" ADD COLUMN "template_version_snapshot" integer;
ALTER TABLE "signing_sessions" ADD COLUMN "template_name_snapshot" text;
ALTER TABLE "signing_sessions" ADD COLUMN "template_language_snapshot" text;
ALTER TABLE "signing_sessions" ADD COLUMN "template_entity_type_snapshot" text;
ALTER TABLE "signing_sessions" ADD COLUMN "template_body_html_snapshot" text;
ALTER TABLE "signing_sessions" ADD COLUMN "template_intake_schema_snapshot" jsonb;
ALTER TABLE "signing_sessions" ADD COLUMN "template_signing_page_config_snapshot" jsonb;

-- Freeze pre-existing, still-open signing links at the template revision that
-- exists when this migration is applied. New sessions write these snapshots at
-- creation time. Signed/revoked rows are also populated so PDF regeneration is
-- deterministic and does not silently adopt a later template or brand.
UPDATE "signing_sessions" AS "session"
SET
  "template_version_snapshot" = "template"."version",
  "template_name_snapshot" = "template"."name",
  "template_language_snapshot" = "template"."language",
  "template_entity_type_snapshot" = "template"."entity_type",
  "template_body_html_snapshot" = "template"."body_html",
  "template_intake_schema_snapshot" = "template"."intake_schema",
  "template_signing_page_config_snapshot" = "template"."signing_page_config"
FROM "contract_templates" AS "template"
WHERE "session"."template_id" = "template"."id"
  AND "session"."template_version_snapshot" IS NULL;

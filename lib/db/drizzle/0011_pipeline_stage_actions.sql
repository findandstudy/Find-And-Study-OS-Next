-- Task #167: admin-configurable per-stage action buttons (max 2 per stage).
-- Adds a jsonb `actions` column to pipeline_stages storing an array of
-- StageAction objects: { type, label?, color?, targetStageKey, requiredDocTypes? }.
-- Only application-entity stages render these buttons in the UI.

ALTER TABLE "pipeline_stages"
  ADD COLUMN IF NOT EXISTS "actions" jsonb NOT NULL DEFAULT '[]'::jsonb;

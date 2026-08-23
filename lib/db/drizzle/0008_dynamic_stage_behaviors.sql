-- Task #134: make pipeline stage behaviors fully dynamic.

ALTER TABLE "pipeline_stages" ADD COLUMN IF NOT EXISTS "upload_permission_level" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN IF NOT EXISTS "tracks_offer_expiry" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN IF NOT EXISTS "requires_valid_until" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN IF NOT EXISTS "commission_finance_status" text;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN IF NOT EXISTS "service_fee_finance_status" text;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN IF NOT EXISTS "auto_cancel_siblings_on_won" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Backfill known application-pipeline stage behaviors so existing
-- tenants keep current behavior after the hardcoded constants are
-- removed. Only updates application-entity rows.

-- Upload permission: 'everyone'
UPDATE "pipeline_stages" SET "upload_permission_level" = 'everyone'
  WHERE "entity_type" = 'application'
    AND "key" IN ('app_fee_paid','missing_docs','upload_payment','deposit_paid','visa_approved','student_card','visa_reject');
--> statement-breakpoint

-- Upload permission: 'admin_only' + offer expiry tracking
UPDATE "pipeline_stages" SET
  "upload_permission_level" = 'admin_only',
  "tracks_offer_expiry" = true
  WHERE "entity_type" = 'application'
    AND "key" IN ('offer_received','acceptance_letter','final_acceptance');
--> statement-breakpoint

-- valid_until is mandatory only for offer_received
UPDATE "pipeline_stages" SET "requires_valid_until" = true
  WHERE "entity_type" = 'application' AND "key" = 'offer_received';
--> statement-breakpoint

-- DOC_REQUIRED_STAGES: enforce file upload before transitioning into
-- these stages by reusing the existing `is_file_upload_mandatory`
-- column (also flip canAttachFile so the stage editor reflects it).
UPDATE "pipeline_stages" SET
  "is_file_upload_mandatory" = true,
  "can_attach_file" = true
  WHERE "entity_type" = 'application'
    AND "key" IN ('app_fee_paid','offer_received','acceptance_letter','final_acceptance','upload_payment','deposit_paid','visa_approved','student_card');
--> statement-breakpoint

-- Finance impact backfills
UPDATE "pipeline_stages" SET
  "commission_finance_status" = 'confirmed',
  "service_fee_finance_status" = 'confirmed',
  "auto_cancel_siblings_on_won" = true
  WHERE "entity_type" = 'application' AND "key" = 'enrolled';
--> statement-breakpoint

UPDATE "pipeline_stages" SET
  "commission_finance_status" = 'excluded',
  "service_fee_finance_status" = 'confirmed'
  WHERE "entity_type" = 'application' AND "key" IN ('100scholar','visa_reject');
--> statement-breakpoint

UPDATE "pipeline_stages" SET
  "commission_finance_status" = 'excluded',
  "service_fee_finance_status" = 'excluded'
  WHERE "entity_type" = 'application' AND "key" IN ('rejected','all_registered','cancelled','refound');
--> statement-breakpoint

-- Default any other won-variant application stages (custom tenant
-- stages) to also auto-cancel siblings, mirroring previous behavior.
UPDATE "pipeline_stages" SET "auto_cancel_siblings_on_won" = true
  WHERE "entity_type" = 'application'
    AND "variant" = 'won'
    AND "auto_cancel_siblings_on_won" = false;

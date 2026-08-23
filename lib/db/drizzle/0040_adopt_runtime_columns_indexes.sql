-- Adopt schema columns and indexes formerly created by legacy boot-time DDL.
-- Additive and idempotent: existing columns, values, indexes and constraints are preserved.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agency_assigned_staff'
      AND column_name = 'created_at'
      AND data_type <> 'timestamp with time zone'
  ) THEN
    ALTER TABLE "agency_assigned_staff"
      ALTER COLUMN "created_at" SET DATA TYPE timestamp with time zone
      USING "created_at" AT TIME ZONE 'UTC';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "agency_assigned_staff" ALTER COLUMN "created_at" SET DEFAULT now();
--> statement-breakpoint
ALTER TABLE "api_tokens" ALTER COLUMN "scopes" SET DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "email_verification_codes" ADD COLUMN IF NOT EXISTS "token" text;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "pdf_accent_color" text;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "offer_expiry_warning_days" text DEFAULT '30,14,7,1';
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "contract_expiry_reminder_days" text DEFAULT '30,14,7,1';
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "default_signing_deadline_days" integer DEFAULT 14 NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "auto_convert_lead_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "auto_convert_student_stage_key" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "agent_can_change_lead_stage" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "agent_can_change_student_app_stage" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "direct_student_enrollment_bonus_rate" text DEFAULT '0' NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "suppress_automation_app_notifications" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "date_format" text DEFAULT 'DD.MM.YYYY' NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "public_catalog_allowed_countries" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "public_catalog_allowed_university_types" jsonb DEFAULT '["Private"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "public_catalog_country_rules" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "auto_assign_stuck_conversations_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "stuck_assign_consider_working_hours" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "stuck_assign_consider_country_match" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "stuck_assign_off_hours_behavior" text DEFAULT 'assign_anyway' NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_queue" ADD COLUMN IF NOT EXISTS "retry_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_queue" ADD COLUMN IF NOT EXISTS "max_retries" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "email_queue" ADD COLUMN IF NOT EXISTS "next_retry_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_stage_document_id" integer;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source" text;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_conversation_id" integer;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_message_id" integer;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_attachment_id" text;
--> statement-breakpoint
ALTER TABLE "countries" ADD COLUMN IF NOT EXISTS "dial_code" text;
--> statement-breakpoint
ALTER TABLE "conversation_participants" ADD COLUMN IF NOT EXISTS "is_starred" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "application_stage_documents" ADD COLUMN IF NOT EXISTS "note" text;
--> statement-breakpoint
ALTER TABLE "application_stage_documents" ADD COLUMN IF NOT EXISTS "is_custom" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "application_stage_documents" ADD COLUMN IF NOT EXISTS "fulfilled_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "application_stage_documents" ADD COLUMN IF NOT EXISTS "responded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "application_stage_documents" ADD COLUMN IF NOT EXISTS "responded_document_id" integer;
--> statement-breakpoint
ALTER TABLE "application_stage_documents" ADD COLUMN IF NOT EXISTS "action_target_stage_key" text;
--> statement-breakpoint
ALTER TABLE "application_stage_documents" ADD COLUMN IF NOT EXISTS "valid_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "application_stage_documents" ADD COLUMN IF NOT EXISTS "expiry_notified_thresholds" text;
--> statement-breakpoint
ALTER TABLE "embed_widgets" ADD COLUMN IF NOT EXISTS "embed_api_key" text;
--> statement-breakpoint
ALTER TABLE "website_collections_offices" ADD COLUMN IF NOT EXISTS "translations_json" jsonb DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "website_collections_team_members" ADD COLUMN IF NOT EXISTS "translations_json" jsonb DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "entity_type" text DEFAULT 'company' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "tax_number" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "preferred_contract_language" text DEFAULT 'en' NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "assigned_contract_template_id" integer;
--> statement-breakpoint
ALTER TABLE "message_templates" ADD COLUMN IF NOT EXISTS "approval_status" text;
--> statement-breakpoint
ALTER TABLE "follow_ups" ADD COLUMN IF NOT EXISTS "notified_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "interested_university" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "interested_level" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "preferred_language" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "mother_name" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "father_name" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "education_data" jsonb;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "branch_id" integer;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source_page_url" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_source" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_medium" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_campaign" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_term" text;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "utm_content" text;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "academy_access" boolean;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "permission_overrides" jsonb;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "branch_id" integer;
--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN IF NOT EXISTS "mapped_student_stage_key" text;
--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN IF NOT EXISTS "missing_docs_fulfilled_target_stage_id" integer;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "read_receipts_enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "bot_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "needs_human" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "bot_last_handled_message_id" integer;
--> statement-breakpoint
ALTER TABLE "portal_universities" ADD COLUMN IF NOT EXISTS "auto_process" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "portal_universities" ADD COLUMN IF NOT EXISTS "fan_out_mode" text;
--> statement-breakpoint
ALTER TABLE "portal_automation_settings" ADD COLUMN IF NOT EXISTS "auto_process_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "portal_automation_settings" ADD COLUMN IF NOT EXISTS "auto_process_interval_minutes" integer DEFAULT 20 NOT NULL;
--> statement-breakpoint
ALTER TABLE "portal_automation_settings" ADD COLUMN IF NOT EXISTS "last_auto_drain_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "portal_automation_settings" ADD COLUMN IF NOT EXISTS "fan_out_mode" text DEFAULT 'off' NOT NULL;
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "branch_id" integer;
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "created_source" text;
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "gender" text;
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "branch_id" integer;
--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "has_photo" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD COLUMN IF NOT EXISTS "provider" text DEFAULT 'direct' NOT NULL;
--> statement-breakpoint
ALTER TABLE "catalog_options" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_verification_codes_token_idx" ON "email_verification_codes" USING btree ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_queue_retry_idx" ON "email_queue" USING btree ("status","next_retry_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_id_idx" ON "notifications" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agency_assigned_staff_agent_user_idx" ON "agency_assigned_staff" USING btree ("agent_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agency_assigned_staff_agent_idx" ON "agency_assigned_staff" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agency_assigned_staff_user_idx" ON "agency_assigned_staff" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_campaign_recipients_campaign_key_uidx" ON "message_campaign_recipients" USING btree ("campaign_id","recipient_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_campaigns_created_by_idx" ON "message_campaigns" USING btree ("created_by_id","created_at");

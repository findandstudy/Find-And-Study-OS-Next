-- Migration 0038: adopt runtime schema previously created outside the reviewed migration chain.
-- Idempotent and additive: existing production tables, rows, indexes and constraints are preserved.
-- This migration contains no DROP, TRUNCATE, DELETE, UPDATE, INSERT, seed or backfill.
-- Adopted tables (30): agent_branches, ai_action_queue, ai_persona_messages, ai_persona_runs, ai_personas, branches, company_contracts, contract_templates, conversation_quality_scores, degree_document_requirements, education_records, entity_view_events, knowledge_chunks, knowledge_sources, lead_assignment_rules, message_reactions, object_owners, object_owners_backfill, pg_rate_limits, pipeline_migrations, popup_dismissals, popups, portal_program_cache, portal_program_mapping, program_document_requirements, signed_contracts, signing_sessions, staff_countries, system_flags, system_kv
-- Adopted enums (7): ai_action_queue_status, ai_persona_message_role, ai_persona_provider, ai_persona_run_status, ai_persona_run_triggered_by, ai_persona_trigger_mode, ai_persona_type

DO $$ BEGIN
  CREATE TYPE "public"."ai_action_queue_status" AS ENUM('pending_approval', 'approved', 'rejected', 'executed', 'failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_message_role" AS ENUM('user', 'assistant', 'tool');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_provider" AS ENUM('anthropic', 'openai');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_run_status" AS ENUM('success', 'error', 'rate_limited', 'blocked_by_cap');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_run_triggered_by" AS ENUM('manual', 'cron', 'event');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_trigger_mode" AS ENUM('manual', 'scheduled', 'event_driven');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."ai_persona_type" AS ENUM('advisor', 'operator');
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_personas" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"persona_type" "ai_persona_type" DEFAULT 'advisor' NOT NULL,
	"description" text,
	"avatar_url" text,
	"provider" "ai_persona_provider" DEFAULT 'anthropic' NOT NULL,
	"model" text NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"guidelines" text DEFAULT '' NOT NULL,
	"negative_prompt" text DEFAULT '' NOT NULL,
	"temperature" numeric(4, 2) DEFAULT '0.70' NOT NULL,
	"max_tokens" integer DEFAULT 2048 NOT NULL,
	"allowed_data_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_enabled" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"trigger_mode" "ai_persona_trigger_mode" DEFAULT 'manual' NOT NULL,
	"schedule_cron" text,
	"event_subscriptions" jsonb,
	"output_targets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"monthly_cost_cap_usd" numeric(10, 2),
	"is_active" boolean DEFAULT false NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_personas_slug_key" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_action_queue" (
	"id" serial PRIMARY KEY NOT NULL,
	"persona_id" integer NOT NULL,
	"run_id" integer,
	"action_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preview" text,
	"status" "ai_action_queue_status" DEFAULT 'pending_approval' NOT NULL,
	"reviewed_by" integer,
	"reviewed_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contract_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"entity_type" text DEFAULT 'company' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"body_html" text DEFAULT '' NOT NULL,
	"intake_schema" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signing_page_config" jsonb,
	"title" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_persona_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"persona_id" integer NOT NULL,
	"conversation_id" text NOT NULL,
	"role" "ai_persona_message_role" NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_persona_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"persona_id" integer NOT NULL,
	"triggered_by" "ai_persona_run_triggered_by" DEFAULT 'manual' NOT NULL,
	"trigger_actor" integer,
	"input_payload" jsonb,
	"output_payload" jsonb,
	"model" text,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"cost_usd" numeric(10, 6),
	"latency_ms" integer,
	"status" "ai_persona_run_status" NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "branches" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country" text,
	"city" text,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"logo_url" text,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"contact_user_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "degree_document_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"catalog_option_id" integer NOT NULL,
	"document_type" text NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "lead_assignment_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"countries" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"university_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phone_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"staff_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"strategy" text DEFAULT 'first' NOT NULL,
	"last_assigned_index" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "object_owners_backfill" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pg_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"reset_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "popups" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"image_url" text,
	"link_url" text,
	"link_text" text,
	"target_audience" text DEFAULT 'all_agents' NOT NULL,
	"target_agent_ids" integer[] DEFAULT '{}' NOT NULL,
	"frequency" text DEFAULT 'every_session' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "popup_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"popup_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"permanent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_program_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"university_key" text NOT NULL,
	"level" text DEFAULT '' NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "program_document_requirements" (
	"id" serial PRIMARY KEY NOT NULL,
	"program_id" integer NOT NULL,
	"document_type" text NOT NULL,
	"mandatory" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signed_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"signing_session_id" integer NOT NULL,
	"agent_id" integer,
	"template_id" integer NOT NULL,
	"pdf_object_key" text,
	"signature_image_object_key" text,
	"evidence_hash" text,
	"signer_email" text NOT NULL,
	"signer_name" text,
	"signer_ip" text,
	"signer_user_agent" text,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivery_claimed_at" timestamp with time zone,
	"signature_image_base64" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_program_mapping" (
	"id" serial PRIMARY KEY NOT NULL,
	"university_key" text NOT NULL,
	"mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"program_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"synonyms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"country_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"member_university_id" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_view_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_id" integer,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "object_owners" (
	"object_key" text PRIMARY KEY NOT NULL,
	"uploaded_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_priority" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signing_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"agent_id" integer,
	"token_hash" text NOT NULL,
	"mode" text DEFAULT 'admin_driven' NOT NULL,
	"status" text DEFAULT 'review_pending' NOT NULL,
	"intake_data" jsonb,
	"signer_email" text NOT NULL,
	"signer_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by_user_id" integer,
	"opened_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_primary_onboarding" boolean DEFAULT false NOT NULL,
	"verified_email" text,
	"expected_email" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "staff_countries" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"country" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_id" integer NOT NULL,
	"content" text NOT NULL,
	"embedding" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "company_contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_name" text NOT NULL,
	"country" text,
	"year" integer,
	"effective_date" timestamp with time zone,
	"expiry_date" timestamp with time zone,
	"file_object_key" text,
	"file_name" text,
	"file_mime" text,
	"file_size" integer,
	"notes" text,
	"last_warning_30_sent_at" timestamp with time zone,
	"last_warning_14_sent_at" timestamp with time zone,
	"last_warning_7_sent_at" timestamp with time zone,
	"last_warning_1_sent_at" timestamp with time zone,
	"expiry_notice_sent_at" timestamp with time zone,
	"uploaded_by_user_id" integer,
	"assigned_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_reactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"emoji" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "conversation_quality_scores" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"accuracy" integer NOT NULL,
	"completeness" integer NOT NULL,
	"speed" integer NOT NULL,
	"tone" integer NOT NULL,
	"outcome" integer NOT NULL,
	"overall" integer NOT NULL,
	"rationales" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"topic" text,
	"language" text,
	"staff_message_count" integer DEFAULT 0 NOT NULL,
	"avg_reply_seconds" integer,
	"content_hash" text NOT NULL,
	"model" text,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "education_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"student_id" integer NOT NULL,
	"level" text NOT NULL,
	"school_name" text,
	"country" text,
	"field_of_study" text,
	"start_month" text,
	"start_year" integer,
	"end_month" text,
	"end_year" integer,
	"gpa" text,
	"gpa_type" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"city" text,
	"language_score" text,
	CONSTRAINT "education_records_student_id_level_key" UNIQUE("student_id","level"),
	CONSTRAINT "education_records_level_check" CHECK (level = ANY (ARRAY['high_school'::text, 'bachelor'::text, 'master'::text])),
	CONSTRAINT "education_records_source_check" CHECK (source = ANY (ARRAY['manual'::text, 'ai_extracted'::text, 'migrated'::text]))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"status" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_branches" (
	"agent_id" integer NOT NULL,
	"branch_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_branches_agent_id_branch_id_pk" PRIMARY KEY("agent_id","branch_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_personas" ADD CONSTRAINT "ai_personas_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_action_queue" ADD CONSTRAINT "ai_action_queue_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."ai_persona_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_action_queue" ADD CONSTRAINT "ai_action_queue_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "public"."ai_personas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_action_queue" ADD CONSTRAINT "ai_action_queue_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_persona_messages" ADD CONSTRAINT "ai_persona_messages_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "public"."ai_personas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_persona_runs" ADD CONSTRAINT "ai_persona_runs_persona_id_fkey" FOREIGN KEY ("persona_id") REFERENCES "public"."ai_personas"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "ai_persona_runs" ADD CONSTRAINT "ai_persona_runs_trigger_actor_fkey" FOREIGN KEY ("trigger_actor") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "branches" ADD CONSTRAINT "branches_contact_user_id_fkey" FOREIGN KEY ("contact_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "degree_document_requirements" ADD CONSTRAINT "degree_document_requirements_catalog_option_id_catalog_options_" FOREIGN KEY ("catalog_option_id") REFERENCES "public"."catalog_options"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "popups" ADD CONSTRAINT "popups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "popup_dismissals" ADD CONSTRAINT "popup_dismissals_popup_id_popups_id_fk" FOREIGN KEY ("popup_id") REFERENCES "public"."popups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "popup_dismissals" ADD CONSTRAINT "popup_dismissals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "program_document_requirements" ADD CONSTRAINT "program_document_requirements_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "portal_program_mapping" ADD CONSTRAINT "portal_program_mapping_member_university_id_fkey" FOREIGN KEY ("member_university_id") REFERENCES "public"."universities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "entity_view_events" ADD CONSTRAINT "entity_view_events_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "entity_view_events" ADD CONSTRAINT "entity_view_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "object_owners" ADD CONSTRAINT "object_owners_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "signing_sessions" ADD CONSTRAINT "signing_sessions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "staff_countries" ADD CONSTRAINT "staff_countries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_contracts" ADD CONSTRAINT "company_contracts_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "conversation_quality_scores" ADD CONSTRAINT "conversation_quality_scores_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "conversation_quality_scores" ADD CONSTRAINT "conversation_quality_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "education_records" ADD CONSTRAINT "education_records_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_branches" ADD CONSTRAINT "agent_branches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_branches" ADD CONSTRAINT "agent_branches_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_personas_active_idx" ON "ai_personas" USING btree ("is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_personas_type_idx" ON "ai_personas" USING btree ("persona_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_action_queue_persona_idx" ON "ai_action_queue" USING btree ("persona_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_action_queue_status_idx" ON "ai_action_queue" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_templates_active_idx" ON "contract_templates" USING btree ("is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_templates_entity_type_idx" ON "contract_templates" USING btree ("entity_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contract_templates_language_idx" ON "contract_templates" USING btree ("language");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_persona_messages_conv_idx" ON "ai_persona_messages" USING btree ("conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_persona_messages_persona_idx" ON "ai_persona_messages" USING btree ("persona_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_persona_runs_created_idx" ON "ai_persona_runs" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_persona_runs_persona_idx" ON "ai_persona_runs" USING btree ("persona_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_persona_runs_status_idx" ON "ai_persona_runs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branches_archived_idx" ON "branches" USING btree ("archived_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "branches_name_idx" ON "branches" USING btree ("name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "degree_doc_req_option_doctype_uniq" ON "degree_document_requirements" USING btree ("catalog_option_id","document_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "degree_doc_req_option_id_idx" ON "degree_document_requirements" USING btree ("catalog_option_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "popups_status_idx" ON "popups" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "popups_target_idx" ON "popups" USING btree ("target_audience");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "popup_dismissals_popup_user_idx" ON "popup_dismissals" USING btree ("popup_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_prog_cache_key_level_uniq" ON "portal_program_cache" USING btree ("university_key","level");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "program_doc_req_program_doctype_uniq" ON "program_document_requirements" USING btree ("program_id","document_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "program_doc_req_program_id_idx" ON "program_document_requirements" USING btree ("program_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signed_contracts_agent_id_idx" ON "signed_contracts" USING btree ("agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signed_contracts_session_id_unique" ON "signed_contracts" USING btree ("signing_session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signed_contracts_template_id_idx" ON "signed_contracts" USING btree ("template_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_prog_map_key_mem_uniq" ON "portal_program_mapping" USING btree ("university_key","member_university_id") WHERE (member_university_id IS NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_prog_map_key_nomem_uniq" ON "portal_program_mapping" USING btree ("university_key") WHERE (member_university_id IS NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_prog_map_key_uniq" ON "portal_program_mapping" USING btree ("university_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_view_events_entity_type_viewed_at_idx" ON "entity_view_events" USING btree ("entity_type","viewed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_view_events_user_viewed_at_idx" ON "entity_view_events" USING btree ("user_id","viewed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signing_sessions_agent_id_idx" ON "signing_sessions" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signing_sessions_status_idx" ON "signing_sessions" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signing_sessions_template_id_idx" ON "signing_sessions" USING btree ("template_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signing_sessions_token_hash_idx" ON "signing_sessions" USING btree ("token_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_countries_user_country_idx" ON "staff_countries" USING btree ("user_id","country");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_countries_user_idx" ON "staff_countries" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_chunks_source_id_idx" ON "knowledge_chunks" USING btree ("source_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_contracts_company_name_idx" ON "company_contracts" USING btree ("company_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_contracts_country_idx" ON "company_contracts" USING btree ("country");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_contracts_deleted_at_idx" ON "company_contracts" USING btree ("deleted_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_contracts_expiry_date_idx" ON "company_contracts" USING btree ("expiry_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_reactions_message_id_idx" ON "message_reactions" USING btree ("message_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "message_reactions_msg_user_emoji_idx" ON "message_reactions" USING btree ("message_id","user_id","emoji");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "conv_quality_conv_user_idx" ON "conversation_quality_scores" USING btree ("conversation_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conv_quality_scored_at_idx" ON "conversation_quality_scores" USING btree ("scored_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conv_quality_user_id_idx" ON "conversation_quality_scores" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "education_records_student_id_idx" ON "education_records" USING btree ("student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "education_records_student_level_uniq" ON "education_records" USING btree ("student_id","level");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_branches_branch_id_idx" ON "agent_branches" USING btree ("branch_id");

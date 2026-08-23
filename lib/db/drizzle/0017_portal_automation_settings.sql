CREATE TYPE "public"."portal_automation_mode" AS ENUM('dry', 'real');
--> statement-breakpoint
CREATE TYPE "public"."portal_automation_scope" AS ENUM('only_applied', 'selected', 'all');
--> statement-breakpoint
CREATE TYPE "public"."portal_adapter_kind" AS ENUM('code', 'declarative');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_automation_settings" (
"id" serial PRIMARY KEY NOT NULL,
"is_enabled" boolean DEFAULT false NOT NULL,
"trigger_stages" jsonb DEFAULT '[]' NOT NULL,
"mode" "portal_automation_mode" DEFAULT 'dry' NOT NULL,
"scope" "portal_automation_scope" DEFAULT 'only_applied' NOT NULL,
"selected_university_keys" jsonb DEFAULT '[]' NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_universities" (
"id" serial PRIMARY KEY NOT NULL,
"university_key" text NOT NULL,
"university_name" text NOT NULL,
"adapter_key" text NOT NULL,
"is_active" boolean DEFAULT true NOT NULL,
"crm_university_id" integer,
"defaults" jsonb,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_adapters" (
"id" serial PRIMARY KEY NOT NULL,
"key" text NOT NULL,
"label" text NOT NULL,
"base_url" text NOT NULL,
"match_names" text NOT NULL,
"kind" "portal_adapter_kind" DEFAULT 'code' NOT NULL,
"config_json" jsonb,
"is_active" boolean DEFAULT true NOT NULL,
"created_at" timestamp with time zone DEFAULT now() NOT NULL,
"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_uni_university_key_uniq" ON "portal_universities" USING btree ("university_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_uni_adapter_key_idx" ON "portal_universities" USING btree ("adapter_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_uni_is_active_idx" ON "portal_universities" USING btree ("is_active");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_adp_key_uniq" ON "portal_adapters" USING btree ("key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_adp_is_active_idx" ON "portal_adapters" USING btree ("is_active");

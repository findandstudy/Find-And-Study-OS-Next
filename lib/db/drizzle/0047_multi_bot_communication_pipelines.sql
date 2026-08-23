CREATE TABLE IF NOT EXISTS "ai_bots" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "config_encrypted" text,
  "is_default" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_bots_slug_unique" ON "ai_bots" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_bots_one_default_unique" ON "ai_bots" USING btree ("is_default") WHERE "is_default" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_bots_active_idx" ON "ai_bots" USING btree ("is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_bots_default_idx" ON "ai_bots" USING btree ("is_default");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_bots" ADD CONSTRAINT "ai_bots_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "communication_pipelines" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "ai_bot_id" integer NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "communication_pipelines_slug_unique" ON "communication_pipelines" USING btree ("slug");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "communication_pipelines_one_default_unique" ON "communication_pipelines" USING btree ("is_default") WHERE "is_default" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communication_pipelines_ai_bot_idx" ON "communication_pipelines" USING btree ("ai_bot_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communication_pipelines_active_idx" ON "communication_pipelines" USING btree ("is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communication_pipelines_default_idx" ON "communication_pipelines" USING btree ("is_default");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communication_pipelines" ADD CONSTRAINT "communication_pipelines_ai_bot_id_ai_bots_id_fk" FOREIGN KEY ("ai_bot_id") REFERENCES "public"."ai_bots"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communication_pipelines" ADD CONSTRAINT "communication_pipelines_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "communication_pipeline_accounts" (
  "id" serial PRIMARY KEY NOT NULL,
  "pipeline_id" integer NOT NULL,
  "channel_account_id" integer NOT NULL,
  "can_send" boolean DEFAULT true NOT NULL,
  "can_receive" boolean DEFAULT true NOT NULL,
  "priority" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "communication_pipeline_accounts_priority_check" CHECK ("priority" IS NULL OR "priority" IN (1, 2))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "communication_pipeline_accounts_unique" ON "communication_pipeline_accounts" USING btree ("pipeline_id", "channel_account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "communication_pipeline_accounts_send_priority_unique" ON "communication_pipeline_accounts" USING btree ("pipeline_id", "priority") WHERE "can_send" = true AND "priority" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "communication_pipeline_accounts_receive_owner_unique" ON "communication_pipeline_accounts" USING btree ("channel_account_id") WHERE "can_receive" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communication_pipeline_accounts_pipeline_idx" ON "communication_pipeline_accounts" USING btree ("pipeline_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "communication_pipeline_accounts_account_idx" ON "communication_pipeline_accounts" USING btree ("channel_account_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communication_pipeline_accounts" ADD CONSTRAINT "communication_pipeline_accounts_pipeline_id_communication_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."communication_pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "communication_pipeline_accounts" ADD CONSTRAINT "communication_pipeline_accounts_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "embed_widgets" ADD COLUMN IF NOT EXISTS "ai_bot_id" integer;
--> statement-breakpoint
ALTER TABLE "embed_widgets" ADD COLUMN IF NOT EXISTS "communication_pipeline_id" integer;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "ai_bot_id" integer;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "communication_pipeline_id" integer;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "embed_widgets" ADD CONSTRAINT "embed_widgets_ai_bot_id_ai_bots_id_fk" FOREIGN KEY ("ai_bot_id") REFERENCES "public"."ai_bots"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "embed_widgets" ADD CONSTRAINT "embed_widgets_communication_pipeline_id_communication_pipelines_id_fk" FOREIGN KEY ("communication_pipeline_id") REFERENCES "public"."communication_pipelines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_ai_bot_id_ai_bots_id_fk" FOREIGN KEY ("ai_bot_id") REFERENCES "public"."ai_bots"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "conversations" ADD CONSTRAINT "conversations_communication_pipeline_id_communication_pipelines_id_fk" FOREIGN KEY ("communication_pipeline_id") REFERENCES "public"."communication_pipelines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embed_widgets_ai_bot_idx" ON "embed_widgets" USING btree ("ai_bot_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embed_widgets_communication_pipeline_idx" ON "embed_widgets" USING btree ("communication_pipeline_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_ai_bot_idx" ON "conversations" USING btree ("ai_bot_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_communication_pipeline_idx" ON "conversations" USING btree ("communication_pipeline_id");
--> statement-breakpoint
INSERT INTO "ai_bots" ("name", "slug", "description", "is_default", "is_active")
SELECT 'Default AI Bot', 'default', 'Legacy-compatible default inbox and widget bot', true, true
WHERE NOT EXISTS (SELECT 1 FROM "ai_bots" WHERE "is_default" = true);
--> statement-breakpoint
INSERT INTO "communication_pipelines" ("name", "slug", "description", "ai_bot_id", "is_default", "is_active")
SELECT 'Default Pipeline', 'default', 'Legacy-compatible default communication pipeline', b."id", true, true
FROM "ai_bots" b
WHERE b."is_default" = true
  AND NOT EXISTS (SELECT 1 FROM "communication_pipelines" WHERE "is_default" = true)
ORDER BY b."id"
LIMIT 1;
--> statement-breakpoint
UPDATE "embed_widgets"
SET "ai_bot_id" = (
  SELECT "id" FROM "ai_bots" WHERE "is_default" = true ORDER BY "id" LIMIT 1
)
WHERE "ai_bot_id" IS NULL;
--> statement-breakpoint
UPDATE "embed_widgets"
SET "communication_pipeline_id" = (
  SELECT "id" FROM "communication_pipelines" WHERE "is_default" = true ORDER BY "id" LIMIT 1
)
WHERE "communication_pipeline_id" IS NULL;
--> statement-breakpoint
UPDATE "conversations"
SET "ai_bot_id" = (
  SELECT "id" FROM "ai_bots" WHERE "is_default" = true ORDER BY "id" LIMIT 1
)
WHERE "ai_bot_id" IS NULL;
--> statement-breakpoint
UPDATE "conversations"
SET "communication_pipeline_id" = (
  SELECT "id" FROM "communication_pipelines" WHERE "is_default" = true ORDER BY "id" LIMIT 1
)
WHERE "communication_pipeline_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ADD COLUMN IF NOT EXISTS "ai_bot_id" integer;
--> statement-breakpoint
UPDATE "knowledge_sources"
SET "ai_bot_id" = (
  SELECT "id" FROM "ai_bots" WHERE "is_default" = true ORDER BY "id" LIMIT 1
)
WHERE "ai_bot_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "knowledge_sources" ALTER COLUMN "ai_bot_id" SET NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_ai_bot_id_ai_bots_id_fk" FOREIGN KEY ("ai_bot_id") REFERENCES "public"."ai_bots"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_ai_bot_idx" ON "knowledge_sources" USING btree ("ai_bot_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_sources_ai_bot_type_idx" ON "knowledge_sources" USING btree ("ai_bot_id", "type");

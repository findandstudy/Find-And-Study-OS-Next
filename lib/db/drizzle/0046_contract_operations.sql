CREATE TABLE IF NOT EXISTS "contract_brand_profiles" (
  "id" serial PRIMARY KEY NOT NULL,
  "key" text NOT NULL,
  "name" text NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by_user_id" integer,
  "updated_by_user_id" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contract_brand_profiles_key_unique" UNIQUE("key"),
  CONSTRAINT "contract_brand_profiles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null,
  CONSTRAINT "contract_brand_profiles_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null
);

ALTER TABLE "contract_templates" ADD COLUMN IF NOT EXISTS "brand_profile_id" integer;
ALTER TABLE "contract_templates" ADD COLUMN IF NOT EXISTS "publication_status" text DEFAULT 'published' NOT NULL;
ALTER TABLE "contract_templates" ADD COLUMN IF NOT EXISTS "supersedes_template_id" integer;
ALTER TABLE "contract_templates" ADD COLUMN IF NOT EXISTS "reviewed_at" timestamp with time zone;
ALTER TABLE "contract_templates" ADD COLUMN IF NOT EXISTS "reviewed_by_user_id" integer;
ALTER TABLE "contract_templates" ADD COLUMN IF NOT EXISTS "published_at" timestamp with time zone;
ALTER TABLE "contract_templates" ADD COLUMN IF NOT EXISTS "published_by_user_id" integer;

ALTER TABLE "signing_sessions" ADD COLUMN IF NOT EXISTS "subject_type" text;
ALTER TABLE "signing_sessions" ADD COLUMN IF NOT EXISTS "subject_id" integer;
ALTER TABLE "signing_sessions" ADD COLUMN IF NOT EXISTS "subject_label" text;
ALTER TABLE "signing_sessions" ADD COLUMN IF NOT EXISTS "last_sent_at" timestamp with time zone;
ALTER TABLE "signing_sessions" ADD COLUMN IF NOT EXISTS "last_reminder_at" timestamp with time zone;
ALTER TABLE "signing_sessions" ADD COLUMN IF NOT EXISTS "send_count" integer DEFAULT 0 NOT NULL;

ALTER TABLE "signed_contracts" ADD COLUMN IF NOT EXISTS "subject_type" text;
ALTER TABLE "signed_contracts" ADD COLUMN IF NOT EXISTS "subject_id" integer;
ALTER TABLE "signed_contracts" ADD COLUMN IF NOT EXISTS "subject_label" text;

DO $$ BEGIN
  ALTER TABLE "contract_templates" ADD CONSTRAINT "contract_templates_brand_profile_id_contract_brand_profiles_id_fk" FOREIGN KEY ("brand_profile_id") REFERENCES "public"."contract_brand_profiles"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "contract_templates" ADD CONSTRAINT "contract_templates_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "contract_templates" ADD CONSTRAINT "contract_templates_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE "contract_templates"
SET "published_at" = COALESCE("published_at", "created_at")
WHERE "publication_status" = 'published' AND "published_at" IS NULL;

CREATE INDEX IF NOT EXISTS "contract_brand_profiles_active_idx" ON "contract_brand_profiles" ("is_active");
CREATE INDEX IF NOT EXISTS "contract_templates_publication_status_idx" ON "contract_templates" ("publication_status");
CREATE INDEX IF NOT EXISTS "contract_templates_brand_profile_idx" ON "contract_templates" ("brand_profile_id");
CREATE INDEX IF NOT EXISTS "signing_sessions_subject_idx" ON "signing_sessions" ("subject_type", "subject_id");
CREATE INDEX IF NOT EXISTS "signed_contracts_subject_idx" ON "signed_contracts" ("subject_type", "subject_id");

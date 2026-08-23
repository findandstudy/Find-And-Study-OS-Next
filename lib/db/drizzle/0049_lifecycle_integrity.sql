CREATE TABLE IF NOT EXISTS "lifecycle_cascade_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" integer NOT NULL,
	"previous_status" text NOT NULL,
	"cascaded_status" text NOT NULL,
	"source_application_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "lifecycle_cascade_state_entity_idx" ON "lifecycle_cascade_state" USING btree ("entity_type","entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "lifecycle_cascade_state_source_app_idx" ON "lifecycle_cascade_state" USING btree ("source_application_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "lifecycle_cascade_state" ADD CONSTRAINT "lifecycle_cascade_state_source_app_fk" FOREIGN KEY ("source_application_id") REFERENCES "public"."applications"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- NOT VALID keeps the rollout lock short. Production preflight has already
-- verified that no current origin_lead_id is orphaned. Validation is a
-- separately observable deploy step and must not be hidden in application boot.
DO $$ BEGIN
 ALTER TABLE "students" ADD CONSTRAINT "students_origin_lead_id_leads_id_fk" FOREIGN KEY ("origin_lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action NOT VALID;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "students_origin_lead_id_idx" ON "students" USING btree ("origin_lead_id");

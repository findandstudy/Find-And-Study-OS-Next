CREATE TYPE "public"."portal_submission_mode" AS ENUM('dry', 'real');
--> statement-breakpoint
CREATE TYPE "public"."portal_submission_status" AS ENUM('queued', 'running', 'submitted', 'already_exists', 'program_missing', 'failed', 'canceled', 'dry_run');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "portal_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"student_id" integer NOT NULL,
	"university_key" text NOT NULL,
	"university_name" text NOT NULL,
	"mode" "portal_submission_mode" DEFAULT 'dry' NOT NULL,
	"status" "portal_submission_status" DEFAULT 'queued' NOT NULL,
	"external_ref" text,
	"result_json" jsonb,
	"screenshot_urls" jsonb,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"enqueued_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_submissions" ADD CONSTRAINT "portal_submissions_application_id_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."applications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_submissions" ADD CONSTRAINT "portal_submissions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "portal_submissions" ADD CONSTRAINT "portal_submissions_enqueued_by_users_id_fk" FOREIGN KEY ("enqueued_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_submissions_application_id_idx" ON "portal_submissions" USING btree ("application_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_submissions_status_idx" ON "portal_submissions" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "portal_submissions_locked_at_idx" ON "portal_submissions" USING btree ("locked_at");

-- Task #164: Admin Staff Card module — work schedules, languages,
-- documents (private staff-documents/{userId} prefix), salary payments,
-- commissions; users.location_country/location_city/timezone columns.
-- Schema sync is performed via `drizzle-kit push`; this file documents
-- the change for replay parity.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "location_country" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "location_city" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "timezone" text;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "staff_work_schedules" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "weekday" integer NOT NULL,
  "start_minutes" integer NOT NULL,
  "end_minutes" integer NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_work_schedules_user_weekday_start_idx" ON "staff_work_schedules" ("user_id", "weekday", "start_minutes");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_work_schedules_user_idx" ON "staff_work_schedules" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_work_schedules_user_weekday_idx" ON "staff_work_schedules" ("user_id", "weekday");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "staff_languages" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "language" text NOT NULL,
  "proficiency" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_languages_user_lang_idx" ON "staff_languages" ("user_id", "language");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_languages_user_idx" ON "staff_languages" ("user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "staff_documents" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "doc_type" text NOT NULL,
  "filename" text NOT NULL,
  "object_path" text NOT NULL,
  "size_bytes" integer NOT NULL DEFAULT 0,
  "mime_type" text NOT NULL DEFAULT 'application/octet-stream',
  "uploaded_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "uploaded_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_documents_user_idx" ON "staff_documents" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_documents_doc_type_idx" ON "staff_documents" ("doc_type");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "staff_salary_payments" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "amount" numeric(12,2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "period" text NOT NULL DEFAULT 'monthly',
  "pay_date" timestamptz,
  "status" text NOT NULL DEFAULT 'pending',
  "notes" text,
  "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_salary_payments_user_idx" ON "staff_salary_payments" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_salary_payments_status_idx" ON "staff_salary_payments" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_salary_payments_pay_date_idx" ON "staff_salary_payments" ("pay_date");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "staff_commissions" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "amount" numeric(12,2) NOT NULL,
  "currency" text NOT NULL DEFAULT 'USD',
  "student_id" integer REFERENCES "students"("id") ON DELETE SET NULL,
  "agent_id" integer REFERENCES "agents"("id") ON DELETE SET NULL,
  "application_id" integer REFERENCES "applications"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "pay_date" timestamptz,
  "notes" text,
  "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_commissions_user_idx" ON "staff_commissions" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_commissions_status_idx" ON "staff_commissions" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_commissions_student_idx" ON "staff_commissions" ("student_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_commissions_agent_idx" ON "staff_commissions" ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_commissions_application_idx" ON "staff_commissions" ("application_id");

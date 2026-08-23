-- Task #142: soft-delete consistency for applications/students/leads/users.
-- Adds `deleted_by` audit column to all four tables. `deleted_at` already
-- exists on each. Schema sync is performed via `drizzle-kit push`; this file
-- documents the change for replay parity.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_by" integer;--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "deleted_by" integer REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "deleted_by" integer REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "deleted_by" integer REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "users_deleted_at_idx" ON "users" ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_deleted_at_idx" ON "applications" ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "students_deleted_at_idx" ON "students" ("deleted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_deleted_at_idx" ON "leads" ("deleted_at");

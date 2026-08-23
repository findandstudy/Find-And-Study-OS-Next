-- Supports branch/assignment-scoped staff list queries without changing data.
-- Production execution remains a separate reviewed migration operation; the
-- deploy process must not apply this file implicitly.
CREATE INDEX IF NOT EXISTS "leads_staff_scope_idx"
  ON "leads" USING btree ("branch_id", "assigned_to_id", "created_at")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "students_staff_scope_idx"
  ON "students" USING btree ("branch_id", "assigned_to_id", "created_at")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_staff_scope_idx"
  ON "applications" USING btree ("branch_id", "assigned_to_id", "created_at")
  WHERE "deleted_at" IS NULL;

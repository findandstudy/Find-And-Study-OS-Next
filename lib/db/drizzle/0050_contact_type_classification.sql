ALTER TABLE "external_contacts" ADD COLUMN IF NOT EXISTS "contact_type" text DEFAULT 'student' NOT NULL;
--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "contact_type" text DEFAULT 'student' NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_contacts_contact_type_idx" ON "external_contacts" USING btree ("contact_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_contact_type_idx" ON "leads" USING btree ("contact_type");

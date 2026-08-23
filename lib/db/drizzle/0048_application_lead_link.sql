ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "lead_id" integer;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "applications" ADD CONSTRAINT "applications_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "applications_lead_id_idx" ON "applications" USING btree ("lead_id");

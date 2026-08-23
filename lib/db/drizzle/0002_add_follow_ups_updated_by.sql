ALTER TABLE "follow_ups" ADD COLUMN IF NOT EXISTS "updated_by_id" integer;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'follow_ups_updated_by_id_users_id_fk') THEN
    ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "follow_ups_updated_by_id_idx" ON "follow_ups" USING btree ("updated_by_id");

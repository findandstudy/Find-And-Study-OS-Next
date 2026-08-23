CREATE TABLE IF NOT EXISTS "agency_assigned_staff" (
  "id" serial PRIMARY KEY NOT NULL,
  "agent_id" integer NOT NULL,
  "user_id" integer NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agency_assigned_staff" ADD CONSTRAINT "agency_assigned_staff_agent_id_agents_id_fk"
   FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agency_assigned_staff" ADD CONSTRAINT "agency_assigned_staff_user_id_users_id_fk"
   FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agency_assigned_staff_agent_user_uniq"
  ON "agency_assigned_staff" ("agent_id","user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agency_assigned_staff_one_primary_per_agent"
  ON "agency_assigned_staff" ("agent_id") WHERE "is_primary" = true;
--> statement-breakpoint
INSERT INTO "agency_assigned_staff" ("agent_id","user_id","is_primary")
  SELECT "id","assigned_staff_id", true FROM "agents"
  WHERE "assigned_staff_id" IS NOT NULL
  ON CONFLICT DO NOTHING;

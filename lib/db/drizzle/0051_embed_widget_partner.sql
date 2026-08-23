ALTER TABLE "embed_widgets" ADD COLUMN IF NOT EXISTS "agent_id" integer;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "embed_widgets" ADD CONSTRAINT "embed_widgets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embed_widgets_agent_idx" ON "embed_widgets" USING btree ("agent_id");

ALTER TABLE "embed_widgets"
  ADD COLUMN IF NOT EXISTS "ai_connection_key" text DEFAULT 'claude' NOT NULL;
--> statement-breakpoint
ALTER TABLE "embed_widgets"
  ADD COLUMN IF NOT EXISTS "ai_extractor_id" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'embed_widgets_ai_extractor_id_ai_extractors_id_fk'
  ) THEN
    ALTER TABLE "embed_widgets"
      ADD CONSTRAINT "embed_widgets_ai_extractor_id_ai_extractors_id_fk"
      FOREIGN KEY ("ai_extractor_id") REFERENCES "public"."ai_extractors"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "embed_widgets_ai_extractor_idx"
  ON "embed_widgets" USING btree ("ai_extractor_id");

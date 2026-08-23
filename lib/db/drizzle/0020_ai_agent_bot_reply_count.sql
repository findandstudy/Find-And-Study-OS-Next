ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "bot_reply_count" integer DEFAULT 0 NOT NULL;

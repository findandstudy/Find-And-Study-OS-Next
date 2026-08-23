ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "language" text;

UPDATE "conversations"
SET "language" = "metadata"->>'botLanguage'
WHERE "language" IS NULL
  AND "metadata"->>'botLanguage' IN ('tr', 'en', 'ar', 'fa', 'fr', 'es', 'ru', 'zh', 'hi', 'id');

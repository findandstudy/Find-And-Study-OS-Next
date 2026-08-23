CREATE TABLE IF NOT EXISTS "ai_extractors" (
  "id" SERIAL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'anthropic',
  "model" TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  "system_prompt" TEXT NOT NULL DEFAULT '',
  "system_prompt_by_lang" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "fields" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "rules" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "scopes" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "document_types" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "temperature" NUMERIC(4,2) NOT NULL DEFAULT 0.20,
  "max_tokens" INTEGER NOT NULL DEFAULT 4096,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "is_default" BOOLEAN NOT NULL DEFAULT false,
  "created_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "ai_extractors_active_idx" ON "ai_extractors"("is_active");
CREATE INDEX IF NOT EXISTS "ai_extractors_default_idx" ON "ai_extractors"("is_default");

CREATE TABLE IF NOT EXISTS "ai_extractor_runs" (
  "id" SERIAL PRIMARY KEY,
  "extractor_id" INTEGER NOT NULL REFERENCES "ai_extractors"("id") ON DELETE CASCADE,
  "scope" TEXT,
  "document_count" INTEGER NOT NULL DEFAULT 0,
  "document_types" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "model" TEXT,
  "prompt_tokens" INTEGER,
  "completion_tokens" INTEGER,
  "cost_usd" NUMERIC(10,6),
  "latency_ms" INTEGER,
  "status" TEXT NOT NULL,
  "error_message" TEXT,
  "extracted_payload" JSONB,
  "triggered_by" INTEGER REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "ai_extractor_runs_extractor_idx" ON "ai_extractor_runs"("extractor_id");
CREATE INDEX IF NOT EXISTS "ai_extractor_runs_created_idx" ON "ai_extractor_runs"("created_at");

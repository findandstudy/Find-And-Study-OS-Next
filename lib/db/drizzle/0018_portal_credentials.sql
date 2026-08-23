-- Migration 0018: portal_credentials — encrypted per-portal username/password storage.
-- Credentials are encrypted with AES-256-GCM (enc::v1:: prefix) before insert.
-- Plain-text values are NEVER stored or returned via API.

CREATE TABLE IF NOT EXISTS "portal_credentials" (
  "id" serial PRIMARY KEY NOT NULL,
  "portal_key" text NOT NULL,
  "username_enc" text NOT NULL,
  "password_enc" text NOT NULL,
  "extra_enc" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "portal_creds_portal_key_uniq" ON "portal_credentials" ("portal_key");

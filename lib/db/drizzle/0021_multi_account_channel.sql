-- Migration 0021: multi-account-per-channel for channel_accounts.
-- Adds per-account active/default flags so admins can connect more than one
-- account on the same channel (e.g. two WhatsApp numbers), each independently
-- toggleable, with exactly one default per channel.
--
-- Data migration: copy the existing single-config credentials from the
-- integrations table (whatsapp / facebook_messenger / instagram) into
-- channel_accounts as the FIRST account per channel, preserving the encrypted
-- config blob so no credentials are lost. The legacy integrations rows are left
-- in place to keep the null-channelAccountId fallback working.

ALTER TABLE "channel_accounts" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD COLUMN IF NOT EXISTS "is_default" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- Seed channel_accounts from the legacy integrations rows. The integrations
-- table stores the per-channel config as an already-encrypted JSON object
-- (enc::v1:: per secret field); channel_accounts.config_encrypted is a text
-- column, so we store the JSON object as text. external_account_id is derived
-- from the channel-specific identifier inside the config.
INSERT INTO "channel_accounts" ("channel", "display_name", "external_account_id", "config_encrypted", "status", "is_active", "is_default", "created_at", "updated_at")
SELECT
  'whatsapp',
  COALESCE(NULLIF(i."name", ''), 'WhatsApp Business'),
  NULLIF(i."config"->>'phoneNumberId', ''),
  i."config"::text,
  CASE WHEN i."is_enabled" THEN 'active' ELSE 'inactive' END,
  COALESCE(i."is_enabled", false),
  true,
  now(),
  now()
FROM "integrations" i
WHERE i."key" = 'whatsapp'
  AND NOT EXISTS (SELECT 1 FROM "channel_accounts" ca WHERE ca."channel" = 'whatsapp');--> statement-breakpoint

INSERT INTO "channel_accounts" ("channel", "display_name", "external_account_id", "config_encrypted", "status", "is_active", "is_default", "created_at", "updated_at")
SELECT
  'messenger',
  COALESCE(NULLIF(i."name", ''), 'Facebook Messenger'),
  NULLIF(i."config"->>'pageId', ''),
  i."config"::text,
  CASE WHEN i."is_enabled" THEN 'active' ELSE 'inactive' END,
  COALESCE(i."is_enabled", false),
  true,
  now(),
  now()
FROM "integrations" i
WHERE i."key" = 'facebook_messenger'
  AND NOT EXISTS (SELECT 1 FROM "channel_accounts" ca WHERE ca."channel" = 'messenger');--> statement-breakpoint

INSERT INTO "channel_accounts" ("channel", "display_name", "external_account_id", "config_encrypted", "status", "is_active", "is_default", "created_at", "updated_at")
SELECT
  'instagram',
  COALESCE(NULLIF(i."name", ''), 'Instagram'),
  COALESCE(NULLIF(i."config"->>'igBusinessAccountId', ''), NULLIF(i."config"->>'pageId', '')),
  i."config"::text,
  CASE WHEN i."is_enabled" THEN 'active' ELSE 'inactive' END,
  COALESCE(i."is_enabled", false),
  true,
  now(),
  now()
FROM "integrations" i
WHERE i."key" = 'instagram'
  AND NOT EXISTS (SELECT 1 FROM "channel_accounts" ca WHERE ca."channel" = 'instagram');

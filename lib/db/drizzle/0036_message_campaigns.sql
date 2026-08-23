-- 0036: Auditable CRM message campaigns.
-- Internal announcements remain in `broadcasts`; these tables snapshot CRM
-- recipients and record one independent delivery result per target.

CREATE TABLE IF NOT EXISTS message_campaigns (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  source_entity_type TEXT NOT NULL,
  template_id INTEGER NOT NULL REFERENCES message_templates(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'queued',
  created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  total_count INTEGER NOT NULL DEFAULT 0,
  queued_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT message_campaigns_entity_type_chk CHECK (source_entity_type IN ('lead', 'student', 'application')),
  CONSTRAINT message_campaigns_channel_chk CHECK (channel IN ('whatsapp')),
  CONSTRAINT message_campaigns_status_chk CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS message_campaign_recipients (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES message_campaigns(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  recipient_key TEXT NOT NULL,
  lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
  application_id INTEGER REFERENCES applications(id) ON DELETE SET NULL,
  display_name TEXT,
  phone_e164 TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  channel_account_id INTEGER REFERENCES channel_accounts(id) ON DELETE SET NULL,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  rendered_content TEXT,
  external_message_id TEXT,
  provider_broadcast_id TEXT,
  error_code TEXT,
  error_detail TEXT,
  variables_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT message_campaign_recipients_entity_type_chk CHECK (entity_type IN ('lead', 'student', 'application')),
  CONSTRAINT message_campaign_recipients_status_chk CHECK (status IN ('queued', 'processing', 'retrying', 'sent', 'failed', 'skipped', 'cancelled')),
  CONSTRAINT message_campaign_recipients_campaign_key_uidx UNIQUE (campaign_id, recipient_key)
);

CREATE INDEX IF NOT EXISTS message_campaigns_status_scheduled_idx
  ON message_campaigns(status, scheduled_at);
CREATE INDEX IF NOT EXISTS message_campaigns_created_by_idx
  ON message_campaigns(created_by_id, created_at DESC);
CREATE INDEX IF NOT EXISTS message_campaign_recipients_claim_idx
  ON message_campaign_recipients(status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS message_campaign_recipients_campaign_status_idx
  ON message_campaign_recipients(campaign_id, status);

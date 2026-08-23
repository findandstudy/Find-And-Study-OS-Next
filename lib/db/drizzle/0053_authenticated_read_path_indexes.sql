-- Read-heavy authenticated pages filter out soft-deleted users and sort by
-- role/creation time. Keep those list and count queries on a small partial
-- index instead of scanning student and deleted user rows.
CREATE INDEX IF NOT EXISTS users_active_role_created_idx
  ON users (role, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- The AI action queue reads the newest 100 actions. This index avoids sorting
-- the full queue before applying the limit.
CREATE INDEX IF NOT EXISTS ai_action_queue_created_at_desc_idx
  ON ai_action_queue (created_at DESC);

-- Guardian noise is intentionally excluded and counted separately. Index the
-- exact legacy failure signature used by the read endpoint.
CREATE INDEX IF NOT EXISTS ai_action_queue_guardian_noise_idx
  ON ai_action_queue ((payload->'specDraft'->>'draftReason'))
  WHERE action_type = 'portal_fix_proposal'
    AND status = 'failed';

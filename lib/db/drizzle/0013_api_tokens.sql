-- API tokens: long-lived bearer tokens for programmatic API access.
-- The plain token (format: fas_live_<32 base62>) is displayed once at creation;
-- only token_hash = SHA-256(plain) is stored. token_prefix is a non-secret
-- leading slice for identification in the UI. scopes are resource:action strings.
CREATE TABLE IF NOT EXISTS api_tokens (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_token_hash_unique ON api_tokens(token_hash);
CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens(user_id);
CREATE INDEX IF NOT EXISTS api_tokens_token_prefix_idx ON api_tokens(token_prefix);

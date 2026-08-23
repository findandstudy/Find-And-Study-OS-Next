-- Dashboard FAZ 1: Entity view events table
-- Tracks per-user entity view events for activity summary metrics.
-- Indexes: (user_id, viewed_at) for user activity queries,
--          (entity_type, viewed_at) for entity-type aggregations.

CREATE TABLE IF NOT EXISTS entity_view_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  viewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS entity_view_events_user_viewed_at_idx
  ON entity_view_events(user_id, viewed_at);

CREATE INDEX IF NOT EXISTS entity_view_events_entity_type_viewed_at_idx
  ON entity_view_events(entity_type, viewed_at);

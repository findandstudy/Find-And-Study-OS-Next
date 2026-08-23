-- 0035: Stable task completion timestamps for staff performance metrics.
-- Existing completed tasks use their last update as the best available
-- historical completion timestamp. New transitions are recorded exactly.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

UPDATE tasks
SET completed_at = updated_at
WHERE status = 'done'
  AND completed_at IS NULL;

CREATE INDEX IF NOT EXISTS tasks_completed_at_idx ON tasks (completed_at);

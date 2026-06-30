-- Run on existing databases that do not yet have workout session columns.
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS session_id TEXT;
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS session_label TEXT;

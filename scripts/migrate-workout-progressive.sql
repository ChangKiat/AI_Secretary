-- Progressive set weights + superset pairing on workouts.
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS weights_kg TEXT;
ALTER TABLE workouts ADD COLUMN IF NOT EXISTS superset_group INTEGER;

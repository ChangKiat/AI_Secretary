-- Allow fractional workout durations (e.g. 0.5 min = 30 sec plank)
ALTER TABLE workouts
    ALTER COLUMN duration_min TYPE NUMERIC(8, 2)
    USING duration_min::numeric;

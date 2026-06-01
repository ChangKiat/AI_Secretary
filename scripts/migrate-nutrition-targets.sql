-- Run on existing databases that already have user_settings without macro target columns.
ALTER TABLE user_settings
    ADD COLUMN IF NOT EXISTS daily_calorie_target NUMERIC(8, 2) NOT NULL DEFAULT 2200,
    ADD COLUMN IF NOT EXISTS daily_carbs_target_g NUMERIC(8, 2) NOT NULL DEFAULT 250,
    ADD COLUMN IF NOT EXISTS daily_fat_target_g NUMERIC(8, 2) NOT NULL DEFAULT 70;

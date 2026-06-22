-- Run on existing databases that already have user_settings without salary_after_tax.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS salary_after_tax NUMERIC(12, 2) NOT NULL DEFAULT 0;

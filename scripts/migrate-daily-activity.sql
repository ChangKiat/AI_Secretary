ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS height_cm numeric(6, 2),
  ADD COLUMN IF NOT EXISTS age integer,
  ADD COLUMN IF NOT EXISTS sex text;

CREATE TABLE IF NOT EXISTS daily_activity_logs (
  id serial PRIMARY KEY,
  telegram_user_id bigint NOT NULL,
  date text NOT NULL,
  steps integer NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT daily_activity_logs_user_date UNIQUE (telegram_user_id, date)
);

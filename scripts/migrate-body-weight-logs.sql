CREATE TABLE IF NOT EXISTS body_weight_logs (
  id serial PRIMARY KEY,
  telegram_user_id bigint NOT NULL,
  date text NOT NULL,
  weight_kg numeric(6, 2) NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT body_weight_logs_user_date UNIQUE (telegram_user_id, date)
);

INSERT INTO body_weight_logs (telegram_user_id, date, weight_kg)
SELECT
  telegram_user_id,
  to_char((now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD'),
  body_weight_kg
FROM user_settings
WHERE body_weight_kg IS NOT NULL
ON CONFLICT (telegram_user_id, date) DO NOTHING;

-- Accounts for multi-user support. Additive only: code that predates it ignores the table.
-- A row is created the first time someone signs in to the Dashboard with Google.
-- telegram_user_id is filled in when they send the bot /link <code> from their profile page.
CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  telegram_user_id bigint UNIQUE,
  telegram_link_code text UNIQUE,
  telegram_link_code_expires_at timestamptz,
  created_at timestamp DEFAULT now() NOT NULL
);

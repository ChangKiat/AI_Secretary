-- Recurring bills that repeat every N days (e.g. a 30-day transport pass) instead of on a day of
-- the month. Both columns are NULL for the usual monthly bills. Safe to run more than once.
ALTER TABLE fixed_expenses
  ADD COLUMN IF NOT EXISTS interval_days integer,
  ADD COLUMN IF NOT EXISTS interval_start_date text;

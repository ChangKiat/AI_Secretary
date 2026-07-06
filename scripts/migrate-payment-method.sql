-- Run on existing databases that do not yet have payment_method on expenses.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method TEXT;

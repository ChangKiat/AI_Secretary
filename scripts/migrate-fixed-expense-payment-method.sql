-- Run on existing databases that do not yet have payment_method on fixed_expenses.
ALTER TABLE fixed_expenses ADD COLUMN IF NOT EXISTS payment_method TEXT;

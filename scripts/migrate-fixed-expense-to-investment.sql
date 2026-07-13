-- Run on existing databases that do not yet have to_investment_account on fixed_expenses.
ALTER TABLE fixed_expenses ADD COLUMN IF NOT EXISTS to_investment_account TEXT;

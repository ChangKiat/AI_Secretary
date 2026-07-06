-- Run on existing databases that do not yet have payment accounts on incomes.
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE incomes ADD COLUMN IF NOT EXISTS from_payment_method TEXT;

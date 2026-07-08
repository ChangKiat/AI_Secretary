-- Add opening balance and credit limit to payment accounts.
ALTER TABLE payment_accounts
    ADD COLUMN IF NOT EXISTS initial_balance NUMERIC(12, 2) NOT NULL DEFAULT 0;

ALTER TABLE payment_accounts
    ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(12, 2);

ALTER TABLE payment_accounts
    ADD COLUMN IF NOT EXISTS balance_baseline_date TEXT;

UPDATE payment_accounts
SET balance_baseline_date = TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
WHERE balance_baseline_date IS NULL OR TRIM(balance_baseline_date) = '';

ALTER TABLE payment_accounts
    ALTER COLUMN balance_baseline_date SET NOT NULL;

-- Credit card statement cycle day (1–31). NULL = calendar month grouping.
ALTER TABLE payment_accounts
    ADD COLUMN IF NOT EXISTS statement_day INTEGER;

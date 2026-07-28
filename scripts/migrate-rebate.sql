-- Credit card cashback config (JSON) and income rebate link columns.
ALTER TABLE payment_accounts
    ADD COLUMN IF NOT EXISTS rebate_config JSONB;

ALTER TABLE incomes
    ADD COLUMN IF NOT EXISTS rebate_account_id INTEGER REFERENCES payment_accounts(id);

ALTER TABLE incomes
    ADD COLUMN IF NOT EXISTS rebate_period_month TEXT;

ALTER TABLE incomes
    ADD COLUMN IF NOT EXISTS rebate_category TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS incomes_rebate_unique
    ON incomes (rebate_account_id, rebate_period_month, rebate_category)
    WHERE rebate_account_id IS NOT NULL;

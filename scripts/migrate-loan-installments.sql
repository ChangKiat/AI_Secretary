-- Run on existing databases that do not yet have loan installment columns.
ALTER TABLE fixed_expenses
    ADD COLUMN IF NOT EXISTS loan_method TEXT,
    ADD COLUMN IF NOT EXISTS original_principal NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS remaining_principal NUMERIC(12, 2),
    ADD COLUMN IF NOT EXISTS annual_rate_pct NUMERIC(8, 4),
    ADD COLUMN IF NOT EXISTS tenure_months INTEGER,
    ADD COLUMN IF NOT EXISTS loan_start_date TEXT;

CREATE TABLE IF NOT EXISTS loan_payments (
    id SERIAL PRIMARY KEY,
    fixed_expense_id INTEGER NOT NULL REFERENCES fixed_expenses(id),
    expense_id INTEGER REFERENCES expenses(id),
    date TEXT NOT NULL,
    installment NUMERIC(12, 2) NOT NULL,
    interest_amount NUMERIC(12, 2) NOT NULL,
    principal_amount NUMERIC(12, 2) NOT NULL,
    remaining_after NUMERIC(12, 2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS loan_payments_fixed_expense_date
    ON loan_payments (fixed_expense_id, date);

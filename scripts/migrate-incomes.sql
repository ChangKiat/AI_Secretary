-- Run on existing databases that do not yet have incomes.
CREATE TABLE IF NOT EXISTS incomes (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    category TEXT NOT NULL DEFAULT 'Other',
    description TEXT NOT NULL,
    source TEXT,
    expense_id INTEGER REFERENCES expenses(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

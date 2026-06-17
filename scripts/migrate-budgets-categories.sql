-- Replace legacy budgets table (month/amount) with per-category monthly budgets.
-- Safe to run once on an existing Supabase database.
-- Default rows match DEFAULT_EXPENSE_CATEGORIES in src/config/expenseCategories.ts

DROP TABLE IF EXISTS budgets;

CREATE TABLE budgets (
    id SERIAL PRIMARY KEY,
    category TEXT NOT NULL UNIQUE,
    monthly_budget NUMERIC(12, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR'
);

INSERT INTO budgets (category, monthly_budget) VALUES
    ('Drink', 200),
    ('Entertainment', 300),
    ('Food', 800),
    ('Shopping', 500),
    ('Transport', 370),
    ('Loan', 1000),
    ('Investment', 1000),
    ('Insurance', 1000),
    ('Utility', 1000),
    ('Other', 1000);

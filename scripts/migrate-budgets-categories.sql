-- LEGACY / DESTRUCTIVE - only for DBs whose budgets table still has month/amount columns.
--
-- Replaces the legacy budgets table (month/amount) with per-category monthly budgets.
-- It DROPS the budgets table, so every budget amount (including Travel and Bank charges)
-- is reset to the defaults below. A current database never needs it.
--
-- Guarded: the body only runs when budgets still has a "month" column; on any other
-- database it does nothing. Run it before migrate-trips.sql and migrate-transfer-fee.sql.
-- A database with no budgets table at all should use init-db.sql instead.
-- Default rows match DEFAULT_EXPENSE_CATEGORIES in src/config/expenseCategories.ts

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'budgets'
          AND column_name = 'month'
    ) THEN
        DROP TABLE budgets;

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
            ('Travel', 1000),
            ('Bank charges', 50),
            ('Other', 1000);
    ELSE
        RAISE NOTICE 'budgets has no legacy month column; nothing to do.';
    END IF;
END $$;

ALTER TABLE incomes ADD COLUMN IF NOT EXISTS transfer_fee numeric(12,2);

INSERT INTO budgets (category, monthly_budget, currency)
SELECT 'Bank charges', 50, 'MYR'
WHERE NOT EXISTS (SELECT 1 FROM budgets WHERE lower(category) = 'bank charges');

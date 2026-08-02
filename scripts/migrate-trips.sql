-- Trips + FX fields on expenses
CREATE TABLE IF NOT EXISTS trips (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    trip_currency TEXT NOT NULL DEFAULT 'USD',
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS trip_id INTEGER REFERENCES trips(id);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS trip_leg TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS fx_amount NUMERIC(12, 2);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS fx_currency TEXT;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(12, 6);

INSERT INTO budgets (category, monthly_budget) VALUES
    ('Travel', 1000)
ON CONFLICT (category) DO NOTHING;

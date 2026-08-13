-- Run on existing databases that do not yet have interest_schedules.
CREATE TABLE IF NOT EXISTS interest_schedules (
    id SERIAL PRIMARY KEY,
    payment_method TEXT NOT NULL,
    frequency TEXT NOT NULL,
    day_of_month INTEGER,
    annual_rate_pct NUMERIC(8, 4),
    fixed_amount NUMERIC(12, 2),
    currency TEXT NOT NULL DEFAULT 'MYR',
    description TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

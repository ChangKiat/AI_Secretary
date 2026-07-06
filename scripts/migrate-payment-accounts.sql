-- Run on existing databases that do not yet have payment_accounts.
CREATE TABLE IF NOT EXISTS payment_accounts (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    account_type TEXT NOT NULL DEFAULT 'account',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Optional seed for first-time setup (skip rows that already exist)
INSERT INTO payment_accounts (name, account_type) VALUES
    ('TnG', 'account'),
    ('CIMB', 'account'),
    ('GrabPay', 'account'),
    ('ShopeePay', 'account'),
    ('Cash', 'account'),
    ('Maybank', 'account'),
    ('Public Bank', 'account'),
    ('UOB', 'account'),
    ('Credit Card', 'credit')
ON CONFLICT (name) DO NOTHING;

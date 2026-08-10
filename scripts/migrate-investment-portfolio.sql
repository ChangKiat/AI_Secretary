-- Investment portfolio: instruments, lots, and events (buy/sell/dividend/interest/price marks).
-- Run on existing databases that do not yet have these tables.

CREATE TABLE IF NOT EXISTS investment_instruments (
    id SERIAL PRIMARY KEY,
    payment_account_id INTEGER NOT NULL REFERENCES payment_accounts(id),
    kind TEXT NOT NULL,
    symbol TEXT,
    name TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    last_price NUMERIC(12, 6),
    last_price_at TEXT,
    principal NUMERIC(12, 2),
    annual_rate_pct NUMERIC(8, 4),
    start_date TEXT,
    maturity_date TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS investment_events (
    id SERIAL PRIMARY KEY,
    instrument_id INTEGER NOT NULL REFERENCES investment_instruments(id),
    event_type TEXT NOT NULL,
    date TEXT NOT NULL,
    quantity NUMERIC(18, 8),
    unit_price NUMERIC(12, 6),
    amount NUMERIC(12, 2),
    realized_gain NUMERIC(12, 2),
    notes TEXT,
    linked_income_id INTEGER REFERENCES incomes(id),
    linked_expense_id INTEGER REFERENCES expenses(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS investment_lots (
    id SERIAL PRIMARY KEY,
    instrument_id INTEGER NOT NULL REFERENCES investment_instruments(id),
    opened_at TEXT NOT NULL,
    quantity NUMERIC(18, 8) NOT NULL,
    remaining_qty NUMERIC(18, 8) NOT NULL,
    unit_cost NUMERIC(12, 6) NOT NULL,
    buy_event_id INTEGER REFERENCES investment_events(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investment_instruments_account
    ON investment_instruments(payment_account_id);
CREATE INDEX IF NOT EXISTS idx_investment_events_instrument
    ON investment_events(instrument_id);
CREATE INDEX IF NOT EXISTS idx_investment_lots_instrument
    ON investment_lots(instrument_id);

CREATE TABLE IF NOT EXISTS trips (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    start_date TEXT,
    end_date TEXT,
    trip_currency TEXT NOT NULL DEFAULT 'USD',
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Expenses table (clean)
CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    category TEXT NOT NULL DEFAULT 'Other',
    description TEXT NOT NULL,
    payment_method TEXT,
    trip_id INTEGER REFERENCES trips(id),
    trip_leg TEXT,
    fx_amount NUMERIC(12, 2),
    fx_currency TEXT,
    fx_rate NUMERIC(12, 6),
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Per-category monthly budgets (keep seed in sync with DEFAULT_EXPENSE_CATEGORIES in src/config/expenseCategories.ts)
CREATE TABLE IF NOT EXISTS budgets (
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
    ('Other', 1000)
ON CONFLICT (category) DO NOTHING;

CREATE TABLE IF NOT EXISTS incomes (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    category TEXT NOT NULL DEFAULT 'Other',
    description TEXT NOT NULL,
    source TEXT,
    expense_id INTEGER REFERENCES expenses(id),
    payment_method TEXT,
    from_payment_method TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fixed_expenses (
    id SERIAL PRIMARY KEY,
    day_of_month INTEGER NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    frequency_months INTEGER NOT NULL DEFAULT 1,
    currency TEXT NOT NULL DEFAULT 'MYR',
    category TEXT NOT NULL DEFAULT 'Other',
    description TEXT NOT NULL,
    start_month INTEGER NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    payment_method TEXT,
    to_investment_account TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS payment_accounts (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    account_type TEXT NOT NULL DEFAULT 'account',
    initial_balance NUMERIC(12, 2) NOT NULL DEFAULT 0,
    balance_baseline_date TEXT NOT NULL DEFAULT TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD'),
    credit_limit NUMERIC(12, 2),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

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

CREATE TABLE IF NOT EXISTS workouts (
    id SERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    date TEXT NOT NULL,
    exercise TEXT NOT NULL,
    sets INTEGER,
    reps INTEGER,
    weight_kg NUMERIC(8, 2),
    weights_kg TEXT,
    duration_min NUMERIC(8, 2),
    notes TEXT,
    calories_burned NUMERIC(8, 2),
    fat_burned_g NUMERIC(8, 2),
    session_id TEXT,
    session_label TEXT,
    superset_group INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meals (
    id SERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    date TEXT NOT NULL,
    meal_type TEXT,
    description TEXT NOT NULL,
    protein_g NUMERIC(8, 2) NOT NULL,
    carbs_g NUMERIC(8, 2),
    fat_g NUMERIC(8, 2),
    calories NUMERIC(8, 2),
    photo_path TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_settings (
    telegram_user_id BIGINT PRIMARY KEY,
    daily_protein_target_g NUMERIC(8, 2) NOT NULL DEFAULT 150,
    daily_calorie_target NUMERIC(8, 2) NOT NULL DEFAULT 2200,
    daily_carbs_target_g NUMERIC(8, 2) NOT NULL DEFAULT 250,
    daily_fat_target_g NUMERIC(8, 2) NOT NULL DEFAULT 70,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
    salary_after_tax NUMERIC(12, 2) NOT NULL DEFAULT 0,
    body_weight_kg NUMERIC(6, 2)
);

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

-- Expenses table (clean)
CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    category TEXT NOT NULL DEFAULT 'Other',
    description TEXT NOT NULL,
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
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workouts (
    id SERIAL PRIMARY KEY,
    telegram_user_id BIGINT NOT NULL,
    date TEXT NOT NULL,
    exercise TEXT NOT NULL,
    sets INTEGER,
    reps INTEGER,
    weight_kg NUMERIC(8, 2),
    duration_min NUMERIC(8, 2),
    notes TEXT,
    calories_burned NUMERIC(8, 2),
    fat_burned_g NUMERIC(8, 2),
    session_id TEXT,
    session_label TEXT,
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

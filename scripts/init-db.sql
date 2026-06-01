-- Expenses table (clean)
CREATE TABLE IF NOT EXISTS expenses (
    id SERIAL PRIMARY KEY,
    date TEXT NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR',
    category TEXT NOT NULL DEFAULT 'General',
    description TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Budgets table (optional, avoids repeating budget on every row)
CREATE TABLE IF NOT EXISTS budgets (
    id SERIAL PRIMARY KEY,
    month TEXT NOT NULL UNIQUE,  -- e.g. "2024-01"
    amount NUMERIC(12, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'MYR'
);

CREATE TABLE IF NOT EXISTS fixed_expenses (
    id SERIAL PRIMARY KEY,
    day_of_month INTEGER NOT NULL,
    amount NUMERIC(12, 2) NOT NULL,
    frequency_months INTEGER NOT NULL DEFAULT 1,
    currency TEXT NOT NULL DEFAULT 'MYR',
    category TEXT NOT NULL DEFAULT 'Fixed Expense',
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
    duration_min INTEGER,
    notes TEXT,
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
    timezone TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur'
);

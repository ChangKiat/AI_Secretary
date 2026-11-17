-- Phase 1 only: keep the owner-only access gates until all reads/writes are scoped.
-- Run migrate-users.sql first. On the SAME connection, explicitly identify the
-- existing owner: SELECT set_config('app.legacy_owner_email', 'owner@example.com', false);
-- The owner must already have signed in and linked Telegram. No owner is guessed.
BEGIN;

DO $$
DECLARE
    owner_id integer;
    owner_email text := lower(trim(current_setting('app.legacy_owner_email', true)));
    table_name text;
BEGIN
    SELECT id INTO owner_id FROM users
    WHERE email = owner_email AND telegram_user_id IS NOT NULL;
    IF owner_id IS NULL THEN
        RAISE EXCEPTION 'Set app.legacy_owner_email to an existing, Telegram-linked owner before migrating';
    END IF;

    FOREACH table_name IN ARRAY ARRAY[
        'trips', 'expenses', 'incomes', 'budgets', 'fixed_expenses',
        'loan_payments', 'interest_schedules', 'payment_accounts',
        'investment_instruments', 'investment_events', 'investment_lots',
        'car_service_visits', 'car_service_items', 'workouts', 'meals',
        'user_settings', 'body_weight_logs', 'daily_activity_logs',
        'tax_relief_claims', 'tax_relief_receipts', 'tax_relief_documents'
    ] LOOP
        -- Tax tables are Dashboard-only and may not be installed yet.
        IF to_regclass(table_name) IS NULL THEN
            IF table_name LIKE 'tax_relief_%' THEN CONTINUE; END IF;
            RAISE EXCEPTION 'Required table % is missing; apply earlier migrations first', table_name;
        END IF;
        EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS user_id integer REFERENCES users(id)', table_name);
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (user_id)', table_name || '_user_id_idx', table_name);

        IF table_name = ANY(ARRAY['workouts', 'meals', 'user_settings', 'body_weight_logs', 'daily_activity_logs']) THEN
            -- Never attribute another Telegram account''s health data to the owner.
            EXECUTE format('UPDATE %I d SET user_id = u.id FROM users u WHERE d.user_id IS NULL AND d.telegram_user_id = u.telegram_user_id', table_name);
        ELSIF table_name = 'tax_relief_documents' THEN
            EXECUTE format('UPDATE %I d SET user_id = u.id FROM users u WHERE d.user_id IS NULL AND lower(d.owner_email) = u.email', table_name);
        ELSE
            EXECUTE format('UPDATE %I SET user_id = $1 WHERE user_id IS NULL', table_name) USING owner_id;
        END IF;
    END LOOP;
END $$;

COMMIT;

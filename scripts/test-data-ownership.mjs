import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

// Deliberately fixed to local development: never use DATABASE_URL for this test.
const sql = postgres('postgresql://postgres:devpassword@localhost:5433/tracking_dev', {
    max: 1, connect_timeout: 3, onnotice: () => {},
});
const schema = `ownership_test_${process.pid}_${Date.now()}`;
const migration = await readFile(new URL('./migrate-data-ownership.sql', import.meta.url), 'utf8');
const finance = ['trips', 'expenses', 'incomes', 'budgets', 'fixed_expenses',
    'loan_payments', 'interest_schedules', 'payment_accounts', 'investment_instruments',
    'investment_events', 'investment_lots', 'car_service_visits', 'car_service_items',
    'tax_relief_claims', 'tax_relief_receipts'];
const health = ['workouts', 'meals', 'user_settings', 'body_weight_logs', 'daily_activity_logs'];
try {
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    await sql.unsafe(await readFile(new URL('./migrate-users.sql', import.meta.url), 'utf8'));
    await sql`INSERT INTO users (email, telegram_user_id) VALUES ('owner@example.com', 111), ('second@example.com', 222)`;
    for (const table of finance) {
        await sql.unsafe(`CREATE TABLE ${table} (id serial PRIMARY KEY)`);
        await sql.unsafe(`INSERT INTO ${table} DEFAULT VALUES`);
    }
    for (const table of health) {
        await sql.unsafe(`CREATE TABLE ${table} (id serial PRIMARY KEY, telegram_user_id bigint)`);
        await sql.unsafe(`INSERT INTO ${table} (telegram_user_id) VALUES (111), (222), (333)`);
    }
    await sql.unsafe('CREATE TABLE tax_relief_documents (id serial PRIMARY KEY, owner_email text)');
    await sql`INSERT INTO tax_relief_documents (owner_email) VALUES ('SECOND@example.com'), ('unknown@example.com')`;
    await assert.rejects(sql.unsafe(migration), /legacy_owner_email/);
    await sql.unsafe('ROLLBACK');
    await sql`SELECT set_config('app.legacy_owner_email', 'owner@example.com', false)`;
    await sql.unsafe(migration);
    for (const table of finance) {
        assert.equal((await sql.unsafe(`SELECT user_id FROM ${table}`))[0].user_id, 1);
    }
    for (const table of health) {
        assert.deepEqual((await sql.unsafe(`SELECT user_id FROM ${table} ORDER BY id`)).map(r => r.user_id), [1, 2, null]);
    }
    assert.deepEqual((await sql`SELECT user_id FROM tax_relief_documents ORDER BY id`).map(r => r.user_id), [2, null]);
    await sql`UPDATE expenses SET user_id = 2`;
    await sql.unsafe(migration);
    assert.equal((await sql`SELECT user_id FROM expenses`)[0].user_id, 2);
    await assert.rejects(sql`UPDATE expenses SET user_id = 999`, e => e.code === '23503');
    // A missing required table must roll back preceding changes in the same migration.
    await sql`UPDATE trips SET user_id = NULL`;
    await sql.unsafe('DROP TABLE expenses');
    await assert.rejects(sql.unsafe(migration), /Required table expenses is missing/);
    await sql.unsafe('ROLLBACK');
    assert.equal((await sql`SELECT user_id FROM trips`)[0].user_id, null);
    console.log('PASS: owner validation, backfill, identity matching, repeat runs, FK enforcement and rollback');
} finally {
    await sql.unsafe('ROLLBACK').catch(() => {});
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await sql.end();
}

/**
 * One-time migration: Google Sheets → Supabase Postgres
 * Requires SPREADSHEET_ID + Google credentials + DATABASE_URL
 *
 * Run: npx tsx scripts/migrate-sheets-to-db.ts
 */
import 'dotenv/config';
import { google } from 'googleapis';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { expenses, fixedExpenses } from '../src/db/schema';

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SPREADSHEET_ID || !DATABASE_URL) {
    console.error('Set SPREADSHEET_ID and DATABASE_URL before running migration.');
    process.exit(1);
}

const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
let auth;
if (process.env.GOOGLE_CREDENTIALS_JSON) {
    auth = new google.auth.GoogleAuth({
        credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
        scopes,
    });
} else {
    auth = new google.auth.GoogleAuth({
        keyFile: './google-credentials.json',
        scopes,
    });
}

const sheets = google.sheets({ version: 'v4', auth });
const sql = postgres(DATABASE_URL);
const db = drizzle(sql);

function parseSheetDate(dateString: string): string {
    try {
        const datePart = dateString.split(',')[0].trim();
        const [day, month, year] = datePart.split('/');
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    } catch {
        return dateString;
    }
}

async function migrateExpenses() {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Expenses!A:E',
    });
    const rows = res.data.values?.slice(1) || [];
    if (rows.length === 0) {
        console.log('No expense rows to migrate.');
        return;
    }
    await db.insert(expenses).values(
        rows.map((row) => ({
            date: row[0]?.includes('/') ? parseSheetDate(row[0]) : row[0],
            amount: String(parseFloat(row[1]?.replace(/[^0-9.-]/g, '')) || 0), // strips $, commas, etc.
            currency: row[2] || 'MYR',
            category: row[3] || 'General',
            description: row[4] || 'Migrated',
        }))
    );
    console.log(`Migrated ${rows.length} expenses.`);
}

async function migrateFixedExpenses() {
    const res = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'FixedExpenses!A:G',
    });
    const rows = res.data.values?.slice(1) || [];
    const activeRows = rows.filter((r) => r.length > 0 && r[0]);
    if (activeRows.length === 0) {
        console.log('No fixed expense rows to migrate.');
        return;
    }
    await db.insert(fixedExpenses).values(
        activeRows.map((row) => ({
            dayOfMonth: parseInt(row[0]),
            amount: String(parseFloat(row[1]) || 0),
            currency: row[2] || 'MYR',
            category: row[3] || 'Fixed Expense',
            description: row[4] || 'Migrated',
            frequencyMonths: parseInt(row[5]) || 1,
            startMonth: parseInt(row[6]) || 1,
            active: true,
        }))
    );
    console.log(`Migrated ${activeRows.length} fixed expenses.`);
}

async function main() {
    console.log('Starting Sheets → DB migration...');
   await migrateExpenses();
    await migrateFixedExpenses();
    await sql.end();
    console.log('Migration complete.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});

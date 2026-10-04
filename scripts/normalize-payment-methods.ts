/**
 * SYNC_TODO 1.6: audit stored data that the code sync cannot fix.
 *
 * Dry run (default, read-only):
 *   npx tsx scripts/normalize-payment-methods.ts
 *   Prints every distinct stored payment-method value with its row count and how it resolves
 *   against the active payment_accounts (exact / alias / fuzzy, or inactive / ambiguous / unknown),
 *   the values you must map by hand, whether an active Cash account exists, and the other 1.6
 *   audits (stale transfer fees, stale holding links, missed day 29-31 bills and interest).
 *
 * Apply (only after SYNC_TODO 2.3 has shipped in BOTH the bot and the Dashboard):
 *   npx tsx scripts/normalize-payment-methods.ts --apply --confirm-2.3-shipped [--approve-fuzzy=<stored value> ...]
 *   Rewrites a stored value to its active account name only when it resolves by exact name
 *   (different case or spacing), by alias, or by a fuzzy match approved with --approve-fuzzy
 *   (repeat the flag per value; quote values with spaces). Inactive, ambiguous and unknown
 *   values are never touched. One transaction per table. Never writes NULL
 *   (interest_schedules.payment_method is NOT NULL). The other audits are report-only.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import {
    loadPaymentAccounts,
    resolvePaymentMethodMatch,
    type PaymentMethodResolution,
} from '../src/config/paymentMethods';
import { closeDb, requireDb } from '../src/db/client';

type Db = ReturnType<typeof requireDb>;

/** Hard-coded identifiers only (used with sql.identifier). */
const COLUMNS = [
    { table: 'expenses', column: 'payment_method' },
    { table: 'incomes', column: 'payment_method' },
    { table: 'incomes', column: 'from_payment_method' },
    { table: 'fixed_expenses', column: 'payment_method' },
    { table: 'fixed_expenses', column: 'to_investment_account' },
    { table: 'interest_schedules', column: 'payment_method' },
] as const;

type ColumnRef = (typeof COLUMNS)[number];

interface StoredValue {
    col: ColumnRef;
    /** null = SQL NULL */
    value: string | null;
    rows: number;
    resolution: PaymentMethodResolution | null;
}

interface Rewrite {
    col: ColumnRef;
    from: string;
    to: string;
    rows: number;
    reason: string;
}

const USAGE =
    'Usage: npx tsx scripts/normalize-payment-methods.ts ' +
    '[--apply --confirm-2.3-shipped [--approve-fuzzy=<stored value> ...]]';

const APPROVE_PREFIX = '--approve-fuzzy=';

function parseArgs(argv: string[]) {
    const approvedFuzzy = new Set(
        argv.filter((a) => a.startsWith(APPROVE_PREFIX)).map((a) => a.slice(APPROVE_PREFIX.length))
    );
    const unknownArgs = argv.filter(
        (a) => a !== '--apply' && a !== '--confirm-2.3-shipped' && !a.startsWith(APPROVE_PREFIX)
    );
    return {
        apply: argv.includes('--apply'),
        confirmed: argv.includes('--confirm-2.3-shipped'),
        approvedFuzzy,
        unknownArgs,
    };
}

const q = (value: string) => JSON.stringify(value);
const label = (col: ColumnRef) => `${col.table}.${col.column}`;

function todayInKL(): string {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kuala_Lumpur',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(new Date());
}

/** Target name for an automatic rewrite, or null when the value must stay as stored. */
function rewriteTarget(v: StoredValue, approvedFuzzy: Set<string>): string | null {
    const r = v.resolution;
    if (v.value == null || !r?.name || r.name === v.value) return null;
    if (r.match === 'exact' || r.match === 'alias') return r.name;
    if (r.match === 'fuzzy' && approvedFuzzy.has(v.value)) return r.name;
    return null;
}

async function readStoredValues(db: Db): Promise<StoredValue[]> {
    const out: StoredValue[] = [];
    for (const col of COLUMNS) {
        const rows = await db.execute<{ value: string | null; n: number }>(
            sql`SELECT ${sql.identifier(col.column)} AS value, count(*)::int AS n
                FROM ${sql.identifier(col.table)}
                GROUP BY 1
                ORDER BY 2 DESC, 1`
        );
        for (const r of rows) {
            out.push({
                col,
                value: r.value,
                rows: Number(r.n),
                resolution: r.value == null ? null : resolvePaymentMethodMatch(r.value),
            });
        }
    }
    return out;
}

function describe(v: StoredValue, approvedFuzzy: Set<string>): string {
    const count = `x${v.rows}`;
    if (v.value == null) return `  NULL       ${count}`;
    const r = v.resolution!;
    const target = rewriteTarget(v, approvedFuzzy);
    switch (r.match) {
        case 'exact':
            return target
                ? `  REWRITE    ${q(v.value)} ${count} -> ${q(target)} (exact name, different case/spacing)`
                : `  OK         ${q(v.value)} ${count}`;
        case 'alias':
            return `  REWRITE    ${q(v.value)} ${count} -> ${q(r.name!)} (alias)`;
        case 'fuzzy':
            return target
                ? `  REWRITE    ${q(v.value)} ${count} -> ${q(target)} (fuzzy, approved)`
                : `  FUZZY?     ${q(v.value)} ${count} -> ${q(r.name!)} (add ${APPROVE_PREFIX}${q(v.value)} to rewrite)`;
        case 'inactive':
            return `  INACTIVE   ${q(v.value)} ${count} (deactivated account ${q(r.candidates?.[0] ?? '?')})`;
        case 'ambiguous':
            return `  AMBIGUOUS  ${q(v.value)} ${count} (matches ${(r.candidates ?? []).map(q).join(', ')})`;
        default:
            return `  UNKNOWN    ${q(v.value)} ${count} (no such account)`;
    }
}

function printStoredValues(values: StoredValue[], approvedFuzzy: Set<string>): void {
    for (const col of COLUMNS) {
        console.log(`\n${label(col)}`);
        const forCol = values.filter((v) => v.col === col);
        if (forCol.length === 0) console.log('  (no rows)');
        for (const v of forCol) console.log(describe(v, approvedFuzzy));
    }
}

function printUnresolved(values: StoredValue[]): void {
    const byValue = new Map<string, { reason: string; places: string[] }>();
    for (const v of values) {
        const r = v.resolution;
        if (v.value == null || !r || r.name) continue;
        const entry = byValue.get(v.value) ?? {
            reason:
                r.match === 'inactive'
                    ? `deactivated account ${q(r.candidates?.[0] ?? '?')}`
                    : r.match === 'ambiguous'
                      ? `ambiguous: ${(r.candidates ?? []).join(' | ')}`
                      : 'no such account',
            places: [],
        };
        entry.places.push(`${label(v.col)} x${v.rows}`);
        byValue.set(v.value, entry);
    }

    console.log('\nUnresolved values (never rewritten; map by hand if they should count toward an account):');
    if (byValue.size === 0) {
        console.log('  none');
        return;
    }
    for (const [value, entry] of [...byValue.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        console.log(`  ${q(value)}: ${entry.reason}; ${entry.places.join(', ')}`);
    }
}

function planRewrites(values: StoredValue[], approvedFuzzy: Set<string>): Rewrite[] {
    const rewrites: Rewrite[] = [];
    for (const v of values) {
        const to = rewriteTarget(v, approvedFuzzy);
        if (to == null || v.value == null) continue;
        rewrites.push({ col: v.col, from: v.value, to, rows: v.rows, reason: v.resolution!.match });
    }
    return rewrites;
}

function lastDayOfMonth(year: number, month: number): number {
    return new Date(year, month, 0).getDate();
}

function isFrequencyDue(startMonth: number, frequencyMonths: number, month: number): boolean {
    const freq = frequencyMonths || 1;
    return (((month - startMonth) % freq) + freq) % freq === 0;
}

/** Months (YYYY-MM) whose last day is before `dayOfMonth`, with that last day in [fromDate, today). */
function shortMonthsSince(fromDate: string, today: string, dayOfMonth: number): { ym: string; month: number }[] {
    const out: { ym: string; month: number }[] = [];
    let year = Number(fromDate.slice(0, 4));
    let month = Number(fromDate.slice(5, 7));
    const endYm = today.slice(0, 7);
    for (;;) {
        const ym = `${year}-${String(month).padStart(2, '0')}`;
        if (ym > endYm) break;
        const last = lastDayOfMonth(year, month);
        const dueDate = `${ym}-${String(last).padStart(2, '0')}`;
        if (last < dayOfMonth && dueDate >= fromDate && dueDate < today) out.push({ ym, month });
        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
    }
    return out;
}

async function printOtherAudits(db: Db): Promise<void> {
    console.log('\n--- Other 1.6 audits (read-only) ---');

    const staleFees = await db.execute<{ id: number; category: string; transfer_fee: string }>(
        sql`SELECT id, category, transfer_fee FROM incomes
            WHERE category <> 'Account transfer' AND transfer_fee IS NOT NULL
            ORDER BY id`
    );
    console.log(`\nStale transfer fees (incomes not 'Account transfer' with transfer_fee): ${staleFees.length}`);
    for (const r of staleFees) console.log(`  income #${r.id} ${q(r.category)} fee ${r.transfer_fee}`);
    if (staleFees.length > 0) {
        console.log(
            "  Fix by hand: UPDATE incomes SET transfer_fee = NULL WHERE category <> 'Account transfer' AND transfer_fee IS NOT NULL;"
        );
    }

    const staleLinks = await db.execute<{ id: number; category: string; instrument_id: number; description: string }>(
        sql`SELECT id, category, instrument_id, description FROM fixed_expenses
            WHERE instrument_id IS NOT NULL AND lower(category) <> 'investment'
            ORDER BY id`
    );
    console.log(`\nStale holding links (non-Investment fixed expenses with instrument_id): ${staleLinks.length}`);
    for (const r of staleLinks) {
        console.log(`  fixed #${r.id} ${q(r.description)} ${q(r.category)} instrument #${r.instrument_id}`);
    }

    const today = todayInKL();
    console.log(`\nDay 29-31 audit (short months up to ${today}; "missing" = no row in that month, check before backfilling):`);

    const fixed = await db.execute<{
        id: number;
        description: string;
        day_of_month: number;
        start_month: number;
        frequency_months: number;
        payment_method: string | null;
        created: string;
    }>(
        sql`SELECT id, description, day_of_month, start_month, frequency_months, payment_method,
                   to_char(created_at, 'YYYY-MM-DD') AS created
            FROM fixed_expenses
            WHERE active AND day_of_month > 28
            ORDER BY id`
    );
    if (fixed.length === 0) console.log('  Fixed expenses: none with day_of_month > 28');
    for (const f of fixed) {
        const logged = await db.execute<{ ym: string }>(
            sql`SELECT DISTINCT substr(date, 1, 7) AS ym FROM expenses WHERE description = ${f.description}`
        );
        const loggedMonths = new Set(logged.map((r) => r.ym));
        const due = shortMonthsSince(f.created, today, f.day_of_month).filter((m) =>
            isFrequencyDue(f.start_month, f.frequency_months, m.month)
        );
        const missing = due.filter((m) => !loggedMonths.has(m.ym)).map((m) => m.ym);
        console.log(
            `  fixed #${f.id} ${q(f.description)} day ${f.day_of_month} via ${q(f.payment_method ?? '(none)')} ` +
                `created ${f.created}: short months due ${due.length}, missing ${missing.length}` +
                (missing.length > 0 ? ` [${missing.join(', ')}]` : '')
        );
    }

    const interest = await db.execute<{
        id: number;
        description: string;
        payment_method: string;
        day_of_month: number;
        fixed_amount: string | null;
        created: string;
    }>(
        sql`SELECT id, description, payment_method, day_of_month, fixed_amount,
                   to_char(created_at, 'YYYY-MM-DD') AS created
            FROM interest_schedules
            WHERE active AND frequency = 'monthly' AND day_of_month > 28
            ORDER BY id`
    );
    if (interest.length === 0) console.log('  Interest schedules: none monthly with day_of_month > 28');
    for (const s of interest) {
        const logged = await db.execute<{ ym: string }>(
            sql`SELECT DISTINCT substr(date, 1, 7) AS ym FROM incomes
                WHERE category = 'Interest' AND description = ${s.description}`
        );
        const loggedMonths = new Set(logged.map((r) => r.ym));
        const due = shortMonthsSince(s.created, today, s.day_of_month);
        const missing = due.filter((m) => !loggedMonths.has(m.ym)).map((m) => m.ym);
        const kind =
            s.fixed_amount != null
                ? `fixed ${s.fixed_amount}`
                : 'rate-based (the next accrual counts the days since the last Interest row)';
        console.log(
            `  interest #${s.id} ${q(s.description)} on ${q(s.payment_method)} day ${s.day_of_month}, ${kind}, ` +
                `created ${s.created}: short months ${due.length}, missing ${missing.length}` +
                (missing.length > 0 ? ` [${missing.join(', ')}]` : '')
        );
    }
}

async function applyRewrites(db: Db, rewrites: Rewrite[]): Promise<void> {
    const tables = [...new Set(rewrites.map((r) => r.col.table))];
    for (const table of tables) {
        const forTable = rewrites.filter((r) => r.col.table === table);
        await db.transaction(async (tx) => {
            for (const r of forTable) {
                const column = sql.identifier(r.col.column);
                const result = await tx.execute(
                    sql`UPDATE ${sql.identifier(table)} SET ${column} = ${r.to} WHERE ${column} = ${r.from}`
                );
                console.log(`  ${label(r.col)}: ${q(r.from)} -> ${q(r.to)} (${r.reason}) updated ${result.count} row(s)`);
            }
        });
        console.log(`Committed ${table}.`);
    }
}

async function main(): Promise<void> {
    const { apply, confirmed, approvedFuzzy, unknownArgs } = parseArgs(process.argv.slice(2));
    if (unknownArgs.length > 0) {
        console.error(`Unknown argument(s): ${unknownArgs.join(' ')}\n${USAGE}`);
        process.exitCode = 1;
        return;
    }
    if (apply && !confirmed) {
        console.error(
            '--apply rewrites stored values. Run it only after SYNC_TODO 2.3 has shipped in the bot AND the Dashboard,\n' +
                'then re-run with: --apply --confirm-2.3-shipped'
        );
        process.exitCode = 1;
        return;
    }

    const db = requireDb();

    // loadPaymentAccounts() seeds default accounts into an empty table; this audit never writes.
    const [{ n: accountCount }] = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM payment_accounts`
    );
    if (Number(accountCount) === 0) {
        console.error('payment_accounts is empty; nothing to compare against. Aborting without loading defaults.');
        process.exitCode = 1;
        return;
    }

    const active = await loadPaymentAccounts();
    const inactive = await db.execute<{ name: string }>(
        sql`SELECT name FROM payment_accounts WHERE NOT active ORDER BY name`
    );
    const cash = await db.execute<{ name: string }>(
        sql`SELECT name FROM payment_accounts WHERE active AND lower(name) = 'cash'`
    );
    console.log(`Mode: ${apply ? 'APPLY' : 'dry run (read-only)'}`);
    console.log(`Active payment accounts (${active.length}): ${active.map((a) => a.name).join(', ')}`);
    console.log(`Inactive payment accounts (${inactive.length}): ${inactive.map((r) => r.name).join(', ')}`);
    console.log(
        cash.length > 0
            ? `Active Cash account: yes (${cash.map((r) => q(r.name)).join(', ')})`
            : 'Active Cash account: NO (rows stored as "Cash" stay unresolved)'
    );

    const values = await readStoredValues(db);
    printStoredValues(values, approvedFuzzy);
    printUnresolved(values);

    const unknownApprovals = [...approvedFuzzy].filter(
        (a) => !values.some((v) => v.value === a && v.resolution?.match === 'fuzzy')
    );
    if (unknownApprovals.length > 0) {
        console.log(`\nIgnored --approve-fuzzy values (not a stored fuzzy match): ${unknownApprovals.map(q).join(', ')}`);
    }

    const rewrites = planRewrites(values, approvedFuzzy);
    const rewriteRows = rewrites.reduce((sum, r) => sum + r.rows, 0);

    await printOtherAudits(db);

    console.log(`\nPlanned rewrites: ${rewrites.length} value(s), ${rewriteRows} row(s).`);
    if (!apply) {
        console.log('Dry run: nothing was written.');
        return;
    }
    if (rewrites.length === 0) {
        console.log('Nothing to apply.');
        return;
    }
    await applyRewrites(db, rewrites);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => closeDb());

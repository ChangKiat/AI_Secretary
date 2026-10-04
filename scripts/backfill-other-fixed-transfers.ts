/**
 * SYNC_TODO 3.14 backfill: "Other" fixed bills with a destination account that the 9am cron
 * logged as a plain expense, with no linked Account-transfer row (so the destination was never
 * credited and the source was debited through the expense instead of a transfer).
 *
 * Dry run (default, read-only):
 *   npx tsx scripts/backfill-other-fixed-transfers.ts
 *   Runs the plan's SELECT and prints every candidate expense with the accounts its transfer
 *   would use, and whether it can be written (OK) or why not (SKIP).
 *
 * Apply (writes; only after checking the dry run):
 *   npx tsx scripts/backfill-other-fixed-transfers.ts --apply --ids=<expenseId>,<expenseId>,...
 *   Calls upsertInvestmentFundingTransfer for each listed expense id that is still an OK
 *   candidate in this run. Ids not in the list are never touched. Each row is written on its
 *   own; a failure is printed and the rest continue.
 *
 * Accounts used for the transfer: from = the expense's stored payment_method (the account the
 * expense debited), falling back to the bill's payment_method when the expense has none;
 * to = the bill's to_investment_account. Both must resolve to active accounts and differ.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { loadPaymentAccounts, resolvePaymentMethod } from '../src/config/paymentMethods';
import { closeDb, requireDb } from '../src/db/client';
import { upsertInvestmentFundingTransfer } from '../src/services/incomeService';

type CandidateRow = {
    expense_id: number;
    date: string;
    amount: string;
    category: string;
    description: string;
    expense_payment_method: string | null;
    trip_leg: string | null;
    fixed_id: number;
    fixed_active: boolean;
    payment_method: string;
    to_investment_account: string;
};

type Candidate = {
    expenseId: number;
    date: string;
    amount: number;
    description: string;
    fixedIds: number[];
    rawFrom: string;
    rawTo: string;
    from: string | null;
    to: string | null;
    skip: string | null;
};

const USAGE = 'Usage: npx tsx scripts/backfill-other-fixed-transfers.ts [--apply --ids=<expenseId>,...]';
const IDS_PREFIX = '--ids=';

const q = (value: string | null) => (value == null ? 'NULL' : JSON.stringify(value));

function parseArgs(argv: string[]) {
    const idsArg = argv.find((a) => a.startsWith(IDS_PREFIX));
    const ids = idsArg
        ? idsArg
              .slice(IDS_PREFIX.length)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
              .map(Number)
        : [];
    const unknownArgs = argv.filter((a) => a !== '--apply' && !a.startsWith(IDS_PREFIX));
    return {
        apply: argv.includes('--apply'),
        ids,
        badIds: ids.some((n) => !Number.isInteger(n) || n <= 0),
        unknownArgs,
    };
}

/** The plan's SELECT (SYNC_TODO 3.14), with extra columns for the report. Read-only. */
async function readCandidateRows(): Promise<CandidateRow[]> {
    const db = requireDb();
    const rows = await db.execute<CandidateRow>(
        sql`SELECT e.id AS expense_id, e.date, e.amount, e.category, e.description,
                   e.payment_method AS expense_payment_method, e.trip_leg,
                   f.id AS fixed_id, f.active AS fixed_active,
                   f.payment_method, f.to_investment_account
            FROM fixed_expenses f
            JOIN expenses e ON e.description=f.description AND e.category=f.category AND e.amount=f.amount
            WHERE lower(f.category)='other' AND f.payment_method IS NOT NULL AND f.to_investment_account IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM incomes i WHERE i.expense_id=e.id AND i.category='Account transfer')
            ORDER BY e.date, e.id, f.id`
    );
    return [...rows];
}

/** One candidate per expense; an expense matching bills with different accounts is skipped. */
function buildCandidates(rows: CandidateRow[]): Candidate[] {
    const byExpense = new Map<number, CandidateRow[]>();
    for (const row of rows) {
        const list = byExpense.get(row.expense_id) ?? [];
        list.push(row);
        byExpense.set(row.expense_id, list);
    }

    const out: Candidate[] = [];
    for (const [expenseId, matches] of byExpense) {
        const first = matches[0];
        const rawFrom = first.expense_payment_method?.trim() || first.payment_method;
        const rawTo = first.to_investment_account;
        const from = resolvePaymentMethod(rawFrom);
        const to = resolvePaymentMethod(rawTo);
        const accountPairs = new Set(
            matches.map((m) => `${m.payment_method.trim().toLowerCase()}→${m.to_investment_account.trim().toLowerCase()}`)
        );

        let skip: string | null = null;
        if (first.trip_leg) skip = `trip expense (leg ${q(first.trip_leg)})`;
        else if (accountPairs.size > 1) skip = 'matches several bills with different accounts; fix by hand';
        else if (!from) skip = `from account ${q(rawFrom)} is not an active account`;
        else if (!to) skip = `to account ${q(rawTo)} is not an active account`;
        else if (from.toLowerCase() === to.toLowerCase()) skip = 'from and to are the same account';

        out.push({
            expenseId,
            date: first.date,
            amount: parseFloat(first.amount),
            description: first.description,
            fixedIds: matches.map((m) => m.fixed_id),
            rawFrom,
            rawTo,
            from,
            to,
            skip,
        });
    }
    return out;
}

function describe(c: Candidate, rows: CandidateRow[]): string {
    const bills = rows
        .filter((r) => r.expense_id === c.expenseId)
        .map((r) => `#${r.fixed_id}${r.fixed_active ? '' : ' (inactive)'} ${q(r.payment_method)}→${q(r.to_investment_account)}`)
        .join('; ');
    const head =
        `expense #${c.expenseId} ${c.date} ${c.amount.toFixed(2)} ${q(c.description)} ` +
        `(expense account ${q(rows.find((r) => r.expense_id === c.expenseId)?.expense_payment_method ?? null)}; bill ${bills})`;
    return c.skip
        ? `  SKIP  ${head}\n        ${c.skip}`
        : `  OK    ${head}\n        transfer ${q(c.from)} → ${q(c.to)}`;
}

async function main(): Promise<void> {
    const { apply, ids, badIds, unknownArgs } = parseArgs(process.argv.slice(2));
    if (unknownArgs.length > 0 || badIds) {
        console.error(`Bad argument(s): ${[...unknownArgs, ...(badIds ? ['--ids'] : [])].join(' ')}\n${USAGE}`);
        process.exitCode = 1;
        return;
    }
    if (apply && ids.length === 0) {
        console.error(`--apply needs the expense ids to write, from a dry run: --ids=<id>,<id>\n${USAGE}`);
        process.exitCode = 1;
        return;
    }
    if (!apply && ids.length > 0) {
        console.log('(--ids without --apply: dry run only)');
    }

    const db = requireDb();
    // loadPaymentAccounts() seeds default accounts into an empty table; never let a dry run write.
    const [{ n: accountCount }] = await db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM payment_accounts`
    );
    if (Number(accountCount) === 0) {
        console.error('payment_accounts is empty; nothing to resolve against. Aborting.');
        process.exitCode = 1;
        return;
    }
    await loadPaymentAccounts();

    const rows = await readCandidateRows();
    const candidates = buildCandidates(rows);
    console.log(`Mode: ${apply ? 'APPLY' : 'dry run (read-only)'}`);
    console.log(
        `"Other" fixed-bill expenses with no linked Account transfer: ${candidates.length} expense(s) ` +
            `from ${rows.length} bill match(es).`
    );
    for (const c of candidates) console.log(describe(c, rows));

    const ok = candidates.filter((c) => !c.skip);
    console.log(`\nWritable: ${ok.length}${ok.length > 0 ? ` (ids: ${ok.map((c) => c.expenseId).join(',')})` : ''}`);
    if (!apply) {
        console.log('Dry run: nothing was written.');
        return;
    }

    const okById = new Map(ok.map((c) => [c.expenseId, c]));
    const notWritable = ids.filter((id) => !okById.has(id));
    if (notWritable.length > 0) {
        console.log(`Ignored ids (not an OK candidate in this run): ${notWritable.join(',')}`);
    }
    let written = 0;
    for (const id of ids) {
        const c = okById.get(id);
        if (!c || !c.from || !c.to) continue;
        try {
            const incomeId = await upsertInvestmentFundingTransfer({
                expenseId: c.expenseId,
                date: c.date,
                amount: c.amount,
                description: c.description,
                fromPaymentMethod: c.from,
                toInvestmentAccount: c.to,
            });
            written += 1;
            console.log(`  expense #${c.expenseId}: Account transfer income #${incomeId} ${c.from} → ${c.to}`);
        } catch (error) {
            console.error(`  expense #${c.expenseId}: FAILED ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
        }
    }
    console.log(`Wrote ${written} transfer(s).`);
}

main()
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    })
    .finally(() => closeDb());

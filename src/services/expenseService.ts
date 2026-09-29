import { and, eq, isNotNull } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { expenses, fixedExpenses, investmentEvents } from '../db/schema';
import { getExpenseCategories, resolveCategory } from '../config/expenseCategories';
import {
    paymentMethodBucket,
    paymentMethodsMatch,
    resolvePaymentMethod,
} from '../config/paymentMethods';
import { getReimbursementsByExpenseIds, getUnlinkedIncomeTotal, deleteIncomesByExpenseId } from './incomeService';
import {
    computeInstallmentSplit,
    getPaidLoanIdsOnDate,
    loanColumnsForCategory,
    loanFieldsFromRow,
    parseLoanMethod,
    reverseLoanPayment,
    type FixedExpenseLoanFields,
    type InstallmentSplit,
    type LoanMethod,
} from './loanService';

function todayInKL(): Date {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' }));
}

function formatDateForDb(date?: string): string {
    if (date) return date;
    const t = todayInKL();
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function resolveBudgetPeriod(startDate?: string, endDate?: string): {
    periodStart: string;
    periodEnd: string;
    singleMonth: boolean;
    budgetNote?: string;
} {
    const today = formatDateForDb();

    if (!startDate && !endDate) {
        const monthStart = `${today.slice(0, 7)}-01`;
        return { periodStart: monthStart, periodEnd: today, singleMonth: true };
    }

    const effectiveStart = startDate || endDate!;
    const effectiveEnd = endDate || startDate!;
    const startMonth = effectiveStart.slice(0, 7);
    const endMonth = effectiveEnd.slice(0, 7);

    if (startMonth !== endMonth) {
        return {
            periodStart: effectiveStart,
            periodEnd: effectiveEnd,
            singleMonth: false,
            budgetNote:
                'Budgets are monthly; use a single-month range for budget comparison.',
        };
    }

    return {
        periodStart: effectiveStart,
        periodEnd: effectiveEnd,
        singleMonth: true,
    };
}

function rowMatchesFilters(
    row: { category: string; description: string; date: string; paymentMethod?: string | null },
    filters: {
        resolvedCategory?: string;
        description?: string;
        paymentMethod?: string;
        startDate: string;
        endDate: string;
    }
): boolean {
    const canonicalCategory = resolveCategory(row.category);
    if (filters.resolvedCategory && canonicalCategory !== filters.resolvedCategory) {
        return false;
    }
    if (
        filters.description &&
        !row.description.toLowerCase().includes(filters.description.toLowerCase())
    ) {
        return false;
    }
    if (filters.paymentMethod && !paymentMethodsMatch(row.paymentMethod, filters.paymentMethod)) {
        return false;
    }
    if (row.date < filters.startDate || row.date > filters.endDate) {
        return false;
    }
    return true;
}

export type TripLeg = 'exchange' | 'fund' | 'card';

export type ExpenseTripFields = {
    tripId?: number | null;
    tripLeg?: TripLeg | null;
    fxAmount?: number | null;
    fxCurrency?: string | null;
    fxRate?: number | null;
};

export function isTripFundSpend(row: { tripLeg?: string | null }): boolean {
    return row.tripLeg === 'fund';
}

export async function appendExpense(
    date: string | undefined,
    amount: number,
    currency: string,
    category: string,
    description: string,
    paymentMethod?: string | null,
    trip?: ExpenseTripFields
): Promise<number> {
    const db = requireDb();
    const [row] = await db
        .insert(expenses)
        .values({
            date: formatDateForDb(date),
            amount: String(amount),
            currency: currency || 'MYR',
            category: resolveCategory(category),
            description,
            paymentMethod: resolvePaymentMethod(paymentMethod),
            tripId: trip?.tripId ?? null,
            tripLeg: trip?.tripLeg ?? null,
            fxAmount: trip?.fxAmount != null ? String(trip.fxAmount) : null,
            fxCurrency: trip?.fxCurrency ?? null,
            fxRate: trip?.fxRate != null ? String(trip.fxRate) : null,
        })
        .returning({ id: expenses.id });
    return row.id;
}

/** Trip-board details shown on an expense confirmation. */
export interface ExpenseTripReplyInfo {
    tripName?: string;
    tripLeg?: TripLeg | null;
    fxAmount?: number | null;
    fxCurrency?: string | null;
    duplicateOfIds?: number[];
    note?: string;
}

const TRIP_LEG_LABEL: Record<TripLeg, string> = {
    exchange: 'currency exchange',
    fund: 'paid from trip cash',
    card: 'card, MYR estimated at trip rate',
};

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function formatFx(amount: number, currency: string): string {
    return `${currency} ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

/** "VND 32,000 ≈ MYR 5.12" for trip-currency rows, "MYR 20" otherwise. */
function formatEntryAmount(
    e: { amount: number; currency: string } & Pick<ExpenseTripReplyInfo, 'fxAmount' | 'fxCurrency'>
): string {
    const home = `${e.currency || 'MYR'} ${e.amount}`;
    return e.fxAmount != null && e.fxCurrency ? `${formatFx(e.fxAmount, e.fxCurrency)} ≈ ${home}` : home;
}

function formatDuplicateHint(ids: number[] | undefined): string {
    return ids?.length ? `possible duplicate of ${ids.map((id) => `#${id}`).join(', ')}` : '';
}

export function formatExpenseLogReply(
    date: string,
    amount: number,
    currency: string,
    category: string,
    description?: string,
    expenseId?: number,
    paymentMethod?: string | null,
    headerPrefix = '✅ Logged',
    trip?: ExpenseTripReplyInfo
): string {
    const header = expenseId != null ? `${headerPrefix} #${expenseId}` : headerPrefix;
    const lines = [
        header,
        `📅 Date: ${date}`,
        `💵 Amount: ${formatEntryAmount({ amount, currency, ...trip })}`,
        `📁 Category: ${resolveCategory(category)}`,
    ];
    if (description) lines.push(`📝 Description: ${description}`);
    if (paymentMethod) lines.push(`💳 Paid via: ${paymentMethod}`);
    if (trip?.tripName) {
        const leg = trip.tripLeg ? ` (${TRIP_LEG_LABEL[trip.tripLeg]})` : '';
        lines.push(`🧳 Trip: ${trip.tripName}${leg}`);
    }
    const dup = formatDuplicateHint(trip?.duplicateOfIds);
    if (dup) lines.push(`⚠️ ${dup[0].toUpperCase()}${dup.slice(1)}`);
    if (trip?.note) lines.push(`ℹ️ ${trip.note[0].toUpperCase()}${trip.note.slice(1)}`);
    return lines.join('\n');
}

export interface ExpenseBatchEntry extends ExpenseTripReplyInfo {
    date: string;
    amount: number;
    currency: string;
    category: string;
    description?: string;
    expenseId: number;
    paymentMethod?: string | null;
    fxRate?: number | null;
    reimbursements?: { source: string; amount: number }[];
}

/** An item from a list the bot deliberately did not log, with the reason shown to the user. */
export interface SkippedExpense {
    date: string;
    description: string;
    amount: number;
    currency: string;
    reason: string;
}

function formatTotals(entries: ExpenseBatchEntry[]): string {
    const byCurrency = new Map<string, number>();
    for (const e of entries) {
        const cur = e.currency || 'MYR';
        byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + e.amount);
    }
    return [...byCurrency].map(([cur, sum]) => `${cur} ${round2(sum)}`).join(' + ');
}

export function formatSkippedExpense(s: SkippedExpense): string {
    return `• ${s.date} ${s.description} · ${formatFx(s.amount, s.currency)} — ${s.reason}`;
}

export function formatBulkExpenseLogReply(
    entries: ExpenseBatchEntry[],
    skipped: SkippedExpense[] = []
): string {
    if (entries.length === 0) {
        return ['⚠️ Not logged:', ...skipped.map(formatSkippedExpense)].join('\n');
    }
    const plural = entries.length === 1 ? '' : 's';
    const lines = [`✅ Logged ${entries.length} expense${plural}`];

    const tripNames = [...new Set(entries.map((e) => e.tripName).filter(Boolean))];
    const singleTrip = tripNames.length === 1 ? tripNames[0] : undefined;
    if (singleTrip) lines.push(`🧳 Trip: ${singleTrip}`);

    const bullet = (e: ExpenseBatchEntry): string => {
        const cat = resolveCategory(e.category);
        const desc = e.description ? ` — ${e.description}` : '';
        let text = `• #${e.expenseId} ${cat} · ${formatEntryAmount(e)}${desc}`;
        if (e.reimbursements?.length) {
            const reimbursed = e.reimbursements.reduce((s, r) => s + r.amount, 0);
            text += ` · your share ${e.currency || 'MYR'} ${e.amount - reimbursed}`;
        }
        if (tripNames.length > 1 && e.tripName) text += ` · 🧳 ${e.tripName}`;
        if (singleTrip && !e.tripName) text += ' · not on trip';
        const flags = [e.note, formatDuplicateHint(e.duplicateOfIds)].filter(Boolean);
        if (flags.length) text += ` ⚠️ ${flags.join('; ')}`;
        return text;
    };

    const dates = [...new Set(entries.map((e) => e.date))].sort();
    if (dates.length <= 1) {
        if (dates[0]) lines.push(`📅 Date: ${dates[0]}`);
        lines.push('', ...entries.map(bullet));
    } else {
        for (const date of dates) {
            const day = entries.filter((e) => e.date === date);
            lines.push('', `📅 ${date}`, ...day.map(bullet), `   Day total: ${formatTotals(day)}`);
        }
    }

    lines.push('', `💵 Total: ${formatTotals(entries)}`);

    const cashByCurrency = new Map<string, number>();
    for (const e of entries) {
        if (e.tripLeg !== 'fund' || e.fxAmount == null || !e.fxCurrency) continue;
        cashByCurrency.set(e.fxCurrency, (cashByCurrency.get(e.fxCurrency) ?? 0) + e.fxAmount);
    }
    if (cashByCurrency.size > 0) {
        const cash = [...cashByCurrency].map(([cur, sum]) => formatFx(sum, cur)).join(' + ');
        lines.push(`💴 From trip cash: ${cash}`);
    }

    if (skipped.length > 0) {
        lines.push('', `⚠️ Not logged (${skipped.length}):`, ...skipped.map(formatSkippedExpense));
    }
    return lines.join('\n');
}

export async function getSpendingSummary(
    category?: string,
    description?: string,
    startDate?: string,
    endDate?: string,
    paymentMethod?: string
) {
    const db = requireDb();
    const rows = await db.select().from(expenses);
    const budgetPeriod = resolveBudgetPeriod(startDate, endDate);

    const effectiveStart = startDate ?? budgetPeriod.periodStart;
    const effectiveEnd = endDate ?? budgetPeriod.periodEnd;
    const resolvedFilterCategory = category ? resolveCategory(category) : undefined;

    const expenseIds = rows.map((r) => r.id);
    const reimbursedByExpenseId = await getReimbursementsByExpenseIds(expenseIds);

    let totalGross = 0;
    let totalSpent = 0;
    let totalReimbursed = 0;
    const breakdown: Record<string, number> = {};
    const breakdownByPaymentMethod: Record<string, number> = {};
    const budgetSpent: Record<string, number> = {};

    for (const row of rows) {
        if (isTripFundSpend(row)) continue;

        const canonicalCategory = resolveCategory(row.category);
        const gross = parseFloat(row.amount);
        const reimbursed = reimbursedByExpenseId.get(row.id) || 0;
        const net = Math.max(0, gross - reimbursed);
        const summaryFilters = {
            resolvedCategory: resolvedFilterCategory,
            description,
            paymentMethod,
            startDate: effectiveStart,
            endDate: effectiveEnd,
        };

        if (rowMatchesFilters(row, summaryFilters)) {
            totalGross += gross;
            totalReimbursed += reimbursed;
            totalSpent += net;
            breakdown[canonicalCategory] = (breakdown[canonicalCategory] || 0) + net;
            const methodKey = paymentMethodBucket(row.paymentMethod);
            breakdownByPaymentMethod[methodKey] =
                (breakdownByPaymentMethod[methodKey] || 0) + net;
        }

        if (budgetPeriod.singleMonth) {
            const budgetFilters = {
                resolvedCategory: resolvedFilterCategory,
                description,
                paymentMethod,
                startDate: budgetPeriod.periodStart,
                endDate: budgetPeriod.periodEnd,
            };
            if (rowMatchesFilters(row, budgetFilters)) {
                budgetSpent[canonicalCategory] = (budgetSpent[canonicalCategory] || 0) + net;
            }
        }
    }

    const totalIncome = await getUnlinkedIncomeTotal(effectiveStart, effectiveEnd);

    const budgetStatus = budgetPeriod.singleMonth
        ? getExpenseCategories().map(({ category: cat, monthlyBudget }) => {
              const spent = budgetSpent[cat] || 0;
              return {
                  category: cat,
                  spent,
                  budget: monthlyBudget,
                  remaining: monthlyBudget - spent,
                  percentUsed: Math.round((spent / monthlyBudget) * 100),
              };
          })
        : [];

    return {
        total: totalSpent,
        totalGross,
        totalReimbursed,
        totalIncome,
        netCashflow: totalIncome - totalSpent,
        breakdown,
        breakdownByPaymentMethod,
        budgetStatus,
        period: { startDate: budgetPeriod.periodStart, endDate: budgetPeriod.periodEnd },
        ...(budgetPeriod.budgetNote ? { budgetNote: budgetPeriod.budgetNote } : {}),
    };
}

export async function addFixedExpense(
    dayOfMonth: number,
    amount: number,
    currency: string,
    category: string,
    description: string,
    frequency: number,
    startMonth: number,
    paymentMethod?: string | null,
    toInvestmentAccount?: string | null,
    loan?: FixedExpenseLoanFields | null
) {
    const db = requireDb();
    const resolvedCategory = resolveCategory(category);
    const keepDestination = (() => {
        const c = resolvedCategory.toLowerCase();
        return c === 'investment' || c === 'other';
    })();
    await db.insert(fixedExpenses).values({
        dayOfMonth,
        amount: String(amount),
        currency: currency || 'MYR',
        category: resolvedCategory,
        description,
        frequencyMonths: frequency,
        startMonth,
        active: true,
        paymentMethod: resolvePaymentMethod(paymentMethod),
        toInvestmentAccount: keepDestination
            ? resolvePaymentMethod(toInvestmentAccount)
            : null,
        ...loanColumnsForCategory(resolvedCategory, loan),
    });
    return true;
}

export type DueFixedExpense = {
    id: number;
    date: string;
    amount: number;
    currency: string;
    category: string;
    description: string;
    paymentMethod: string | null;
    toInvestmentAccount: string | null;
    instrumentId: number | null;
    loan: (InstallmentSplit & { method: LoanMethod }) | null;
};

/**
 * True when the dashboard already recorded this holding-linked bill as a unit trust
 * contribution (buy + its own expense) on `date`, so the cron must not log it again.
 * The cron otherwise owns the bill's expense; the dashboard attaches its buy to it.
 */
export async function isFixedContributionRecorded(
    exp: Pick<DueFixedExpense, 'instrumentId' | 'date' | 'amount'>
): Promise<boolean> {
    if (exp.instrumentId == null) return false;
    const db = requireDb();
    const rows = await db
        .select({ amount: investmentEvents.amount })
        .from(investmentEvents)
        .where(
            and(
                eq(investmentEvents.instrumentId, exp.instrumentId),
                eq(investmentEvents.eventType, 'buy'),
                eq(investmentEvents.date, exp.date),
                isNotNull(investmentEvents.linkedExpenseId)
            )
        );
    const cents = (n: number) => Math.round(n * 100);
    return rows.some((row) => cents(parseFloat(row.amount ?? '0')) === cents(exp.amount));
}

export async function getFixedExpensesForToday(): Promise<DueFixedExpense[]> {
    const db = requireDb();
    const today = todayInKL();
    const todayDay = today.getDate();
    const currentMonth = today.getMonth() + 1;
    const dateStr = formatDateForDb();

    const rows = await db
        .select()
        .from(fixedExpenses)
        .where(eq(fixedExpenses.active, true));

    const due = rows.filter((row) => {
        if (row.dayOfMonth !== todayDay) return false;
        const monthDiff = currentMonth - row.startMonth;
        const freq = row.frequencyMonths || 1;
        return ((monthDiff % freq) + freq) % freq === 0;
    });

    const loanIds = due.filter((row) => parseLoanMethod(row.loanMethod)).map((row) => row.id);
    const paidLoanIds = await getPaidLoanIdsOnDate(loanIds, dateStr);

    return due.flatMap((row): DueFixedExpense[] => {
        const base = {
            id: row.id,
            date: dateStr,
            currency: row.currency,
            category: resolveCategory(row.category),
            description: row.description,
            paymentMethod: row.paymentMethod ? resolvePaymentMethod(row.paymentMethod) : null,
            toInvestmentAccount: row.toInvestmentAccount
                ? resolvePaymentMethod(row.toInvestmentAccount)
                : null,
            instrumentId: row.instrumentId ?? null,
        };
        const loan = loanFieldsFromRow(row);
        if (!loan.loanMethod) {
            return [{ ...base, amount: parseFloat(row.amount), loan: null }];
        }
        if ((loan.remainingPrincipal ?? 0) <= 0 || paidLoanIds.has(row.id)) {
            return [];
        }
        const split = computeInstallmentSplit({
            method: loan.loanMethod,
            installment: parseFloat(row.amount),
            remaining: loan.remainingPrincipal ?? 0,
            originalPrincipal: loan.originalPrincipal ?? 0,
            annualRatePct: loan.annualRatePct ?? 0,
            tenureMonths: loan.tenureMonths ?? 0,
        });
        if (!split) return [];
        return [
            {
                ...base,
                amount: split.installment,
                loan: { method: loan.loanMethod, ...split },
            },
        ];
    });
}

export async function updateFixedExpensePrice(
    searchDescription: string,
    newAmount: number
): Promise<boolean | string> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(fixedExpenses)
        .where(eq(fixedExpenses.active, true));

    const match = rows.find((r) =>
        r.description.toLowerCase().includes(searchDescription.toLowerCase())
    );

    if (!match) return 'not_found';

    await db
        .update(fixedExpenses)
        .set({ amount: String(newAmount) })
        .where(eq(fixedExpenses.id, match.id));

    return true;
}

export async function getAllFixedExpenses() {
    const db = requireDb();
    const rows = await db
        .select()
        .from(fixedExpenses)
        .where(eq(fixedExpenses.active, true));

    return rows.map((row) => ({
        day: row.dayOfMonth,
        amount: parseFloat(row.amount),
        currency: row.currency,
        description: row.description,
        frequency: row.frequencyMonths,
        paymentMethod: row.paymentMethod ? resolvePaymentMethod(row.paymentMethod) : null,
    }));
}

export async function deleteFixedExpense(
    searchDescription: string
): Promise<boolean | string> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(fixedExpenses)
        .where(eq(fixedExpenses.active, true));

    const match = rows.find((r) =>
        r.description.toLowerCase().includes(searchDescription.toLowerCase())
    );

    if (!match) return 'not_found';

    await db
        .update(fixedExpenses)
        .set({ active: false })
        .where(eq(fixedExpenses.id, match.id));

    return true;
}

export async function updateExpense(
    id: number,
    fields: {
        date?: string;
        amount?: number;
        currency?: string;
        category?: string;
        description?: string;
        paymentMethod?: string | null;
        tripId?: number | null;
        tripLeg?: TripLeg | null;
        fxAmount?: number | null;
        fxCurrency?: string | null;
        fxRate?: number | null;
    }
): Promise<boolean> {
    const db = requireDb();
    const set: Record<string, string | number | null> = {};

    if (fields.date != null) set.date = fields.date;
    if (fields.amount != null) set.amount = String(fields.amount);
    if (fields.currency != null) set.currency = fields.currency;
    if (fields.category != null) set.category = resolveCategory(fields.category);
    if (fields.description != null) set.description = fields.description;
    if (fields.paymentMethod !== undefined) {
        set.paymentMethod = resolvePaymentMethod(fields.paymentMethod);
    }
    if (fields.tripId !== undefined) set.tripId = fields.tripId;
    if (fields.tripLeg !== undefined) set.tripLeg = fields.tripLeg;
    if (fields.fxAmount !== undefined) {
        set.fxAmount = fields.fxAmount != null ? String(fields.fxAmount) : null;
    }
    if (fields.fxCurrency !== undefined) set.fxCurrency = fields.fxCurrency;
    if (fields.fxRate !== undefined) {
        set.fxRate = fields.fxRate != null ? String(fields.fxRate) : null;
    }

    if (Object.keys(set).length === 0) return false;

    const result = await db.update(expenses).set(set).where(eq(expenses.id, id));
    return (result.count ?? 0) > 0;
}

export async function getExpenseById(id: number) {
    const db = requireDb();
    const rows = await db.select().from(expenses).where(eq(expenses.id, id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
        id: row.id,
        date: row.date,
        amount: parseFloat(row.amount),
        currency: row.currency,
        category: resolveCategory(row.category),
        description: row.description,
        paymentMethod: row.paymentMethod ? resolvePaymentMethod(row.paymentMethod) : null,
        tripId: row.tripId ?? null,
        tripLeg: (row.tripLeg as TripLeg | null) ?? null,
        fxAmount: row.fxAmount != null ? parseFloat(row.fxAmount) : null,
        fxCurrency: row.fxCurrency ?? null,
        fxRate: row.fxRate != null ? parseFloat(row.fxRate) : null,
    };
}

export async function deleteExpense(id: number): Promise<boolean> {
    const db = requireDb();
    await reverseLoanPayment(id);
    // Portfolio buy cash-sync FKs block expense delete unless unlinked first.
    await db
        .update(investmentEvents)
        .set({ linkedExpenseId: null })
        .where(eq(investmentEvents.linkedExpenseId, id));
    await deleteIncomesByExpenseId(id);
    const result = await db.delete(expenses).where(eq(expenses.id, id));
    return (result.count ?? 0) > 0;
}

export async function getActiveFixedExpenses() {
    const db = requireDb();
    const rows = await db
        .select()
        .from(fixedExpenses)
        .where(eq(fixedExpenses.active, true));

    return rows.map((row) => ({
        id: row.id,
        description: row.description,
        category: resolveCategory(row.category),
        amount: parseFloat(row.amount),
        dayOfMonth: row.dayOfMonth,
        frequencyMonths: row.frequencyMonths,
        startMonth: row.startMonth,
        currency: row.currency,
        paymentMethod: row.paymentMethod ? resolvePaymentMethod(row.paymentMethod) : null,
        toInvestmentAccount: row.toInvestmentAccount
            ? resolvePaymentMethod(row.toInvestmentAccount)
            : null,
        ...loanFieldsFromRow(row),
    }));
}

export async function updateFixedExpenseById(
    id: number,
    fields: {
        description?: string;
        category?: string;
        amount?: number;
        dayOfMonth?: number;
        frequencyMonths?: number;
        paymentMethod?: string | null;
        toInvestmentAccount?: string | null;
        loan?: FixedExpenseLoanFields | null;
    }
): Promise<boolean> {
    const db = requireDb();
    const set: Record<string, string | number | null> = {};

    if (fields.description != null) set.description = fields.description;
    if (fields.category != null) set.category = resolveCategory(fields.category);
    if (fields.amount != null) set.amount = String(fields.amount);
    if (fields.dayOfMonth != null) set.dayOfMonth = fields.dayOfMonth;
    if (fields.frequencyMonths != null) set.frequencyMonths = fields.frequencyMonths;
    if (fields.paymentMethod !== undefined) {
        set.paymentMethod = resolvePaymentMethod(fields.paymentMethod);
    }
    if (fields.toInvestmentAccount !== undefined) {
        set.toInvestmentAccount = resolvePaymentMethod(fields.toInvestmentAccount);
    }

    if (fields.category != null) {
        const c = resolveCategory(fields.category).toLowerCase();
        if (c !== 'investment' && c !== 'other') {
            set.toInvestmentAccount = null;
        }
    }

    const nextCategory =
        fields.category != null ? resolveCategory(fields.category) : undefined;
    if (nextCategory && nextCategory.toLowerCase() !== 'loan') {
        Object.assign(set, loanColumnsForCategory(nextCategory, null));
    } else if (fields.loan !== undefined) {
        Object.assign(set, loanColumnsForCategory(nextCategory ?? 'Loan', fields.loan));
    }

    if (Object.keys(set).length === 0) return false;

    const result = await db
        .update(fixedExpenses)
        .set(set)
        .where(and(eq(fixedExpenses.id, id), eq(fixedExpenses.active, true)));

    return (result.count ?? 0) > 0;
}

export async function deactivateFixedExpenseById(id: number): Promise<boolean> {
    const db = requireDb();
    const result = await db
        .update(fixedExpenses)
        .set({ active: false })
        .where(and(eq(fixedExpenses.id, id), eq(fixedExpenses.active, true)));

    return (result.count ?? 0) > 0;
}

// ponytail self-check: bulk expense reply format without DB
if (require.main === module) {
    const bulk = formatBulkExpenseLogReply([
        {
            date: '2026-07-25',
            amount: 12.5,
            currency: 'MYR',
            category: 'Food',
            description: 'Coffee',
            expenseId: 88,
        },
        {
            date: '2026-07-25',
            amount: 57,
            currency: 'MYR',
            category: 'Food',
            description: 'Dinner',
            expenseId: 89,
            reimbursements: [
                { source: 'A', amount: 20 },
                { source: 'B', amount: 20 },
            ],
        },
    ]);
    if (!bulk.includes('Logged 2 expenses') || !bulk.includes('#88 Other · MYR 12.5 — Coffee')) {
        throw new Error(`bulk expense format failed:\n${bulk}`);
    }
    if (!bulk.includes('your share MYR 17') || !bulk.includes('Total: MYR 69.5')) {
        throw new Error(`bulk expense totals/shared failed:\n${bulk}`);
    }

    const trip = formatBulkExpenseLogReply(
        [
            {
                date: '2026-09-26',
                amount: 5.12,
                currency: 'MYR',
                category: 'Drink',
                description: 'Black coffee',
                expenseId: 1200,
                tripName: 'Danang',
                tripLeg: 'fund',
                fxAmount: 32_000,
                fxCurrency: 'VND',
            },
            {
                date: '2026-09-26',
                amount: 20,
                currency: 'MYR',
                category: 'Drink',
                description: 'Beer with Justin',
                expenseId: 1201,
                paymentMethod: 'Cash',
                tripName: 'Danang',
                duplicateOfIds: [1174],
            },
            {
                date: '2026-09-27',
                amount: 40,
                currency: 'MYR',
                category: 'Entertainment',
                description: 'Alpine coasters',
                expenseId: 1202,
                tripName: 'Danang',
                tripLeg: 'fund',
                fxAmount: 250_000,
                fxCurrency: 'VND',
            },
        ],
        [{ date: '2026-09-30', description: 'Coffee', amount: 35_000, currency: 'VND', reason: 'no VND trip covers 2026-09-30' }]
    );
    for (const expected of [
        'Logged 3 expenses',
        '🧳 Trip: Danang',
        '📅 2026-09-26',
        '#1200 Other · VND 32,000 ≈ MYR 5.12 — Black coffee',
        'possible duplicate of #1174',
        'Day total: MYR 25.12',
        'Total: MYR 65.12',
        'From trip cash: VND 282,000',
        'Not logged (1)',
    ]) {
        if (!trip.includes(expected)) throw new Error(`trip bulk format missing "${expected}":\n${trip}`);
    }
    console.log('expenseService self-check ok');
}

import { and, eq } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { expenses, fixedExpenses, investmentEvents } from '../db/schema';
import { getExpenseCategories, resolveCategory } from '../config/expenseCategories';
import {
    displayPaymentMethod,
    paymentMethodBucket,
    paymentMethodsMatch,
    resolvePaymentMethod,
    setPaymentAccountsCache,
} from '../config/paymentMethods';
import { getReimbursementsByExpenseIds, getUnlinkedIncomeTotal, deleteIncomesByExpenseId, getTransferFeesForSpendingSummary } from './incomeService';
import { isFrequencyDue, lastDayOfMonth } from './fixedSchedule';
import type { PaymentAccount } from './paymentAccountService';
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

function resolveBudgetPeriod(
    startDate?: string,
    endDate?: string,
    today = formatDateForDb()
): {
    periodStart: string;
    periodEnd: string;
    singleMonth: boolean;
    budgetNote?: string;
} {
    if (!startDate && !endDate) {
        // The whole current KL month (1st to month end), like the Dashboard's parseMonth(),
        // so post-dated rows (e.g. cashback dated at the statement end) count in both apps.
        const month = today.slice(0, 7);
        const lastDay = lastDayOfMonth(parseInt(today.slice(0, 4), 10), parseInt(today.slice(5, 7), 10));
        return {
            periodStart: `${month}-01`,
            periodEnd: `${month}-${String(lastDay).padStart(2, '0')}`,
            singleMonth: true,
        };
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

/** Trimmed, case-insensitive; null and empty are the same. */
function sameAccountText(a?: string | null, b?: string | null): boolean {
    return (a?.trim() ?? '').toLowerCase() === (b?.trim() ?? '').toLowerCase();
}

/**
 * Write guard for one stored account column (same rule as updateIncome in incomeService):
 * - the same text as stored: keep the stored raw value, even if it no longer resolves;
 * - empty: clear it;
 * - anything else must resolve to an active account, or this throws "Unknown payment account: …".
 */
function guardAccountWrite(incoming: string | null | undefined, stored: string | null): string | null {
    if (sameAccountText(incoming, stored)) return stored;
    const trimmed = incoming?.trim();
    if (!trimmed) return null;
    const resolved = resolvePaymentMethod(trimmed);
    if (!resolved) throw new Error(`Unknown payment account: ${trimmed}`);
    return resolved;
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

export type AppendExpenseOptions = {
    /**
     * Store an account that does not resolve as its trimmed raw text instead of null
     * (`resolvePaymentMethod(x) ?? x.trim()`), so a fixed bill stored as "Cash" or under a
     * renamed account keeps it. Only for the 9am fixed-bill cron; user input must resolve.
     */
    keepRaw?: boolean;
};

/** payment_method stored for a new expense row: the active account name, or null (raw text with keepRaw). */
function paymentMethodForInsert(paymentMethod: string | null | undefined, keepRaw?: boolean): string | null {
    return keepRaw ? displayPaymentMethod(paymentMethod) : resolvePaymentMethod(paymentMethod);
}

export async function appendExpense(
    date: string | undefined,
    amount: number,
    currency: string,
    category: string,
    description: string,
    paymentMethod?: string | null,
    trip?: ExpenseTripFields,
    options?: AppendExpenseOptions
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
            paymentMethod: paymentMethodForInsert(paymentMethod, options?.keepRaw),
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

    // Account-transfer fees count as Bank charges spending, over the same period as the rows above.
    const transferFeeSummary = await getTransferFeesForSpendingSummary(
        effectiveStart,
        effectiveEnd,
        {
            category: resolvedFilterCategory,
            description,
            paymentMethod,
        }
    );
    if (transferFeeSummary.total > 0) {
        totalGross += transferFeeSummary.total;
        totalSpent += transferFeeSummary.total;
        for (const [cat, amount] of Object.entries(transferFeeSummary.breakdown)) {
            breakdown[cat] = (breakdown[cat] || 0) + amount;
        }
        for (const [method, amount] of Object.entries(transferFeeSummary.byPaymentMethod)) {
            const methodKey = paymentMethodBucket(method);
            breakdownByPaymentMethod[methodKey] =
                (breakdownByPaymentMethod[methodKey] || 0) + amount;
        }
        if (budgetPeriod.singleMonth) {
            for (const [cat, amount] of Object.entries(transferFeeSummary.breakdown)) {
                budgetSpent[cat] = (budgetSpent[cat] || 0) + amount;
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
    loan?: FixedExpenseLoanFields | null,
    instrumentId?: number | null
) {
    const db = requireDb();
    const resolvedCategory = resolveCategory(category);
    const keepDestination = (() => {
        const c = resolvedCategory.toLowerCase();
        return c === 'investment' || c === 'other';
    })();
    const keepInstrument = resolvedCategory.toLowerCase() === 'investment';
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
        instrumentId: keepInstrument ? instrumentId ?? null : null,
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

/** A holding "buy" plus the category / description of the expense that paid it (null when none). */
export type BillContributionBuy = {
    amount: string | null;
    linkedExpenseId: number | null;
    expenseCategory: string | null;
    expenseDescription: string | null;
};

/** The holding-linked bill a buy is checked against; `category` is already resolved. */
export type ContributionBill = { amount: number; category: string; description: string };

/** Trimmed, case-insensitive; a missing value never matches. */
function sameBillText(stored: string | null, bill: string): boolean {
    return stored != null && stored.trim().toLowerCase() === bill.trim().toLowerCase();
}

/**
 * Whether a holding "buy" dated on a holding-linked bill's due date is that bill's contribution.
 * Shared by the cron (isFixedContributionRecorded) and the Dashboard (fixedContributionService)
 * so both apps agree on whether the bill was contributed.
 * - A buy paid by this bill's expense (same category and description, trimmed, case-insensitive)
 *   counts whatever its amount, so editing the bill's amount after that month's buy does not
 *   record a second contribution.
 * - Any other buy (unlinked because its expense was deleted, another bill on the same holding and
 *   day, or a one-off Invest top-up) counts only at the bill's amount, as before.
 */
export function isBillContributionBuy(buy: BillContributionBuy, bill: ContributionBill): boolean {
    if (
        buy.linkedExpenseId != null &&
        sameBillText(buy.expenseCategory, bill.category) &&
        sameBillText(buy.expenseDescription, bill.description)
    ) {
        return true;
    }
    const cents = (n: number) => Math.round(n * 100);
    return cents(parseFloat(buy.amount ?? '0')) === cents(bill.amount);
}

/**
 * True when this holding-linked bill's unit trust contribution is already recorded on `date`
 * (see isBillContributionBuy), so the cron must not log the bill again.
 * The 9am cron records the buy (with the bill's expense and funding transfer); the Dashboard's
 * contribution run is the fallback, and whichever runs second skips or attaches to the first.
 */
export async function isFixedContributionRecorded(
    exp: Pick<DueFixedExpense, 'instrumentId' | 'date' | 'amount' | 'category' | 'description'>
): Promise<boolean> {
    if (exp.instrumentId == null) return false;
    const db = requireDb();
    const rows = await db
        .select({
            amount: investmentEvents.amount,
            linkedExpenseId: investmentEvents.linkedExpenseId,
            expenseCategory: expenses.category,
            expenseDescription: expenses.description,
        })
        .from(investmentEvents)
        .leftJoin(expenses, eq(expenses.id, investmentEvents.linkedExpenseId))
        .where(
            and(
                eq(investmentEvents.instrumentId, exp.instrumentId),
                eq(investmentEvents.eventType, 'buy'),
                eq(investmentEvents.date, exp.date)
            )
        );
    return rows.some((row) => isBillContributionBuy(row, exp));
}

/** Due on this date: a day 29-31 bill falls on the last day of a shorter month. Month is 1-based. */
function isFixedExpenseDueOn(
    row: { dayOfMonth: number; startMonth: number; frequencyMonths: number },
    year: number,
    month: number,
    day: number
): boolean {
    if (day !== Math.min(row.dayOfMonth, lastDayOfMonth(year, month))) return false;
    return isFrequencyDue(row.startMonth, row.frequencyMonths, month);
}

export async function getFixedExpensesForToday(): Promise<DueFixedExpense[]> {
    const db = requireDb();
    const today = todayInKL();
    const dateStr = formatDateForDb();

    const rows = await db
        .select()
        .from(fixedExpenses)
        .where(eq(fixedExpenses.active, true));

    const due = rows.filter((row) =>
        isFixedExpenseDueOn(row, today.getFullYear(), today.getMonth() + 1, today.getDate())
    );

    const loanIds = due.filter((row) => parseLoanMethod(row.loanMethod)).map((row) => row.id);
    const paidLoanIds = await getPaidLoanIdsOnDate(loanIds, dateStr);

    return due.flatMap((row): DueFixedExpense[] => {
        const base = {
            id: row.id,
            date: dateStr,
            currency: row.currency,
            category: resolveCategory(row.category),
            description: row.description,
            paymentMethod: displayPaymentMethod(row.paymentMethod),
            toInvestmentAccount: displayPaymentMethod(row.toInvestmentAccount),
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
        paymentMethod: displayPaymentMethod(row.paymentMethod),
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
        const [current] = await db
            .select({ paymentMethod: expenses.paymentMethod })
            .from(expenses)
            .where(eq(expenses.id, id))
            .limit(1);
        if (!current) return false;
        // Throws "Unknown payment account: …" before anything is written.
        set.paymentMethod = guardAccountWrite(fields.paymentMethod, current.paymentMethod);
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
        paymentMethod: displayPaymentMethod(row.paymentMethod),
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
        paymentMethod: displayPaymentMethod(row.paymentMethod),
        toInvestmentAccount: displayPaymentMethod(row.toInvestmentAccount),
        instrumentId: row.instrumentId ?? null,
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
        instrumentId?: number | null;
        loan?: FixedExpenseLoanFields | null;
    }
): Promise<boolean> {
    const db = requireDb();
    const set: Record<string, string | number | null> = {};

    const nextCategory =
        fields.category != null ? resolveCategory(fields.category) : undefined;
    const nextCategoryLower = nextCategory?.toLowerCase();
    // Leaving Investment / Other drops the destination; leaving Investment drops the holding.
    const dropsDestination =
        nextCategoryLower != null && nextCategoryLower !== 'investment' && nextCategoryLower !== 'other';
    const dropsInstrument = nextCategoryLower != null && nextCategoryLower !== 'investment';

    if (fields.description != null) set.description = fields.description;
    if (nextCategory != null) set.category = nextCategory;
    if (fields.amount != null) set.amount = String(fields.amount);
    if (fields.dayOfMonth != null) set.dayOfMonth = fields.dayOfMonth;
    if (fields.frequencyMonths != null) set.frequencyMonths = fields.frequencyMonths;

    const guardsPayment = fields.paymentMethod !== undefined;
    const guardsDestination = fields.toInvestmentAccount !== undefined && !dropsDestination;
    if (guardsPayment || guardsDestination) {
        const [current] = await db
            .select({
                paymentMethod: fixedExpenses.paymentMethod,
                toInvestmentAccount: fixedExpenses.toInvestmentAccount,
            })
            .from(fixedExpenses)
            .where(and(eq(fixedExpenses.id, id), eq(fixedExpenses.active, true)))
            .limit(1);
        if (!current) return false;
        // Throws "Unknown payment account: …" before anything is written.
        if (guardsPayment) {
            set.paymentMethod = guardAccountWrite(fields.paymentMethod, current.paymentMethod);
        }
        if (guardsDestination) {
            set.toInvestmentAccount = guardAccountWrite(
                fields.toInvestmentAccount,
                current.toInvestmentAccount
            );
        }
    }
    if (dropsDestination) set.toInvestmentAccount = null;

    if (fields.instrumentId !== undefined) set.instrumentId = fields.instrumentId;
    if (dropsInstrument) set.instrumentId = null;

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

    const expectEq = (actual: unknown, expected: unknown, label: string) => {
        if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
    };

    // Default period is the whole current month (post-dated rows count), like the Dashboard's parseMonth().
    const oct = resolveBudgetPeriod(undefined, undefined, '2026-10-04');
    expectEq(`${oct.periodStart}..${oct.periodEnd}`, '2026-10-01..2026-10-31', 'default period Oct');
    expectEq(oct.singleMonth, true, 'default period is single month');
    expectEq(resolveBudgetPeriod(undefined, undefined, '2026-02-10').periodEnd, '2026-02-28', 'default period Feb');
    expectEq(resolveBudgetPeriod(undefined, undefined, '2028-02-29').periodEnd, '2028-02-29', 'default period leap Feb');
    expectEq(resolveBudgetPeriod('2026-09-15', undefined, '2026-10-04').periodEnd, '2026-09-15', 'start only = one day');
    expectEq(resolveBudgetPeriod('2026-09-01', '2026-10-15').singleMonth, false, 'cross-month range');

    // Due day: 29-31 clamps to the month's last day; frequency still applies.
    const bill = (dayOfMonth: number, startMonth = 1, frequencyMonths = 1) => ({ dayOfMonth, startMonth, frequencyMonths });
    expectEq(isFixedExpenseDueOn(bill(31), 2026, 9, 30), true, 'day 31 due on 30 Sep');
    expectEq(isFixedExpenseDueOn(bill(31), 2026, 9, 29), false, 'day 31 not due on 29 Sep');
    expectEq(isFixedExpenseDueOn(bill(31), 2026, 10, 30), false, 'day 31 not due on 30 Oct');
    expectEq(isFixedExpenseDueOn(bill(31), 2026, 10, 31), true, 'day 31 due on 31 Oct');
    expectEq(isFixedExpenseDueOn(bill(30), 2026, 2, 28), true, 'day 30 due on 28 Feb');
    expectEq(isFixedExpenseDueOn(bill(29), 2028, 2, 29), true, 'day 29 due on 29 Feb (leap)');
    expectEq(isFixedExpenseDueOn(bill(15), 2026, 2, 28), false, 'day 15 not due on 28 Feb');
    expectEq(isFixedExpenseDueOn(bill(31, 1, 3), 2026, 4, 30), true, 'quarterly day 31 due on 30 Apr');
    expectEq(isFixedExpenseDueOn(bill(31, 1, 3), 2026, 6, 30), false, 'quarterly day 31 not due in Jun');

    // Write guard: unchanged values are kept even when they no longer resolve; new values must resolve.
    const account = (id: number, name: string, active = true): PaymentAccount => ({
        id,
        name,
        accountType: 'account',
        initialBalance: 0,
        balanceBaselineDate: '2020-01-01',
        creditLimit: null,
        statementDay: null,
        rebateConfig: null,
        active,
    });
    setPaymentAccountsCache([account(1, 'Cash'), account(2, 'Maybank Savings'), account(3, 'GrabPay', false)]);
    const expectUnknown = (fn: () => unknown, name: string) => {
        try {
            fn();
        } catch (err) {
            if (err instanceof Error && err.message === `Unknown payment account: ${name}`) return;
            throw new Error(`expected Unknown payment account: ${name}, got ${err}`);
        }
        throw new Error(`expected Unknown payment account: ${name}, got no error`);
    };
    expectEq(guardAccountWrite(' grabpay ', 'GrabPay'), 'GrabPay', 'unchanged inactive account kept');
    expectEq(guardAccountWrite('Old Bank', 'Old Bank'), 'Old Bank', 'unchanged unknown account kept');
    expectEq(guardAccountWrite('maybank savings', 'Cash'), 'Maybank Savings', 'new account stored resolved');
    expectEq(guardAccountWrite('', 'Cash'), null, 'empty clears');
    expectEq(guardAccountWrite(null, 'Cash'), null, 'null clears');
    expectEq(guardAccountWrite(null, null), null, 'null stays null');
    expectUnknown(() => guardAccountWrite('Boost Wallet', 'Cash'), 'Boost Wallet');
    expectUnknown(() => guardAccountWrite('GrabPay', 'Cash'), 'GrabPay');
    expectUnknown(() => guardAccountWrite(' Boost Wallet ', null), 'Boost Wallet');

    // keepRaw (cron): an account that no longer resolves is stored as its raw text, not null.
    setPaymentAccountsCache([account(2, 'Maybank Savings')]);
    expectEq(paymentMethodForInsert(' Cash ', true), 'Cash', 'keepRaw keeps unresolved raw text');
    expectEq(paymentMethodForInsert('Cash'), null, 'default append drops unresolved account');
    expectEq(paymentMethodForInsert('maybank savings', true), 'Maybank Savings', 'keepRaw still resolves known accounts');
    expectEq(paymentMethodForInsert('  ', true), null, 'keepRaw stores empty as null');
    expectEq(paymentMethodForInsert(null, true), null, 'keepRaw stores null as null');
    setPaymentAccountsCache([]);

    console.log('expenseService self-check ok');
}

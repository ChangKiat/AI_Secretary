import { and, eq } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { expenses, fixedExpenses } from '../db/schema';
import { getExpenseCategories, resolveCategory } from '../config/expenseCategories';
import {
    paymentMethodBucket,
    paymentMethodsMatch,
    resolvePaymentMethod,
} from '../config/paymentMethods';
import { getReimbursementsByExpenseIds, getUnlinkedIncomeTotal, deleteIncomesByExpenseId } from './incomeService';

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

export async function appendExpense(
    date: string | undefined,
    amount: number,
    currency: string,
    category: string,
    description: string,
    paymentMethod?: string | null
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
        })
        .returning({ id: expenses.id });
    return row.id;
}

export function formatExpenseLogReply(
    date: string,
    amount: number,
    currency: string,
    category: string,
    description?: string,
    expenseId?: number,
    paymentMethod?: string | null,
    headerPrefix = '✅ Logged'
): string {
    const header = expenseId != null ? `${headerPrefix} #${expenseId}` : headerPrefix;
    const lines = [
        header,
        `📅 Date: ${date}`,
        `💵 Amount: ${currency || 'MYR'} ${amount}`,
        `📁 Category: ${resolveCategory(category)}`,
    ];
    if (description) lines.push(`📝 Description: ${description}`);
    if (paymentMethod) lines.push(`💳 Paid via: ${paymentMethod}`);
    return lines.join('\n');
}

export interface ExpenseBatchEntry {
    date: string;
    amount: number;
    currency: string;
    category: string;
    description?: string;
    expenseId: number;
    paymentMethod?: string | null;
    reimbursements?: { source: string; amount: number }[];
}

export function formatBulkExpenseLogReply(date: string, entries: ExpenseBatchEntry[]): string {
    const lines = [
        `✅ Logged ${entries.length} expenses`,
        `📅 Date: ${date}`,
        '',
    ];
    let total = 0;
    const currency = entries[0]?.currency || 'MYR';
    for (const e of entries) {
        total += e.amount;
        const cur = e.currency || 'MYR';
        const cat = resolveCategory(e.category);
        const desc = e.description ? ` — ${e.description}` : '';
        let bullet = `• #${e.expenseId} ${cat} · ${cur} ${e.amount}${desc}`;
        if (e.reimbursements?.length) {
            const reimbursed = e.reimbursements.reduce((s, r) => s + r.amount, 0);
            const net = e.amount - reimbursed;
            bullet += ` · your share ${cur} ${net}`;
        }
        lines.push(bullet);
    }
    lines.push('', `💵 Total: ${currency} ${Math.round(total * 100) / 100}`);
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
    toInvestmentAccount?: string | null
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
    });
    return true;
}

export async function getFixedExpensesForToday(): Promise<
    {
        date: string;
        amount: number;
        currency: string;
        category: string;
        description: string;
        paymentMethod: string | null;
        toInvestmentAccount: string | null;
    }[]
> {
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

    return due.map((row) => ({
        date: dateStr,
        amount: parseFloat(row.amount),
        currency: row.currency,
        category: resolveCategory(row.category),
        description: row.description,
        paymentMethod: row.paymentMethod ? resolvePaymentMethod(row.paymentMethod) : null,
        toInvestmentAccount: row.toInvestmentAccount
            ? resolvePaymentMethod(row.toInvestmentAccount)
            : null,
    }));
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
    }
): Promise<boolean> {
    const db = requireDb();
    const set: Record<string, string | null> = {};

    if (fields.date != null) set.date = fields.date;
    if (fields.amount != null) set.amount = String(fields.amount);
    if (fields.currency != null) set.currency = fields.currency;
    if (fields.category != null) set.category = resolveCategory(fields.category);
    if (fields.description != null) set.description = fields.description;
    if (fields.paymentMethod !== undefined) {
        set.paymentMethod = resolvePaymentMethod(fields.paymentMethod);
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
    };
}

export async function deleteExpense(id: number): Promise<boolean> {
    const db = requireDb();
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

export async function logBulkExpenses(expenseList: {
    date?: string;
    amount: number;
    currency?: string;
    category?: string;
    description: string;
    paymentMethod?: string | null;
}[]) {
    const db = requireDb();
    await db.insert(expenses).values(
        expenseList.map((exp) => ({
            date: formatDateForDb(exp.date),
            amount: String(exp.amount),
            currency: exp.currency || 'MYR',
            category: resolveCategory(exp.category),
            description: exp.description,
            paymentMethod: resolvePaymentMethod(exp.paymentMethod),
        }))
    );
}

// ponytail self-check: bulk expense reply format without DB
if (require.main === module) {
    const bulk = formatBulkExpenseLogReply('2026-07-25', [
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
    console.log('expenseService self-check ok');
}

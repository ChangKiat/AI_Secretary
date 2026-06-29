import { and, eq } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { expenses, fixedExpenses } from '../db/schema';
import { getExpenseCategories, resolveCategory } from '../config/expenseCategories';
import { getReimbursementsByExpenseIds, getUnlinkedIncomeTotal } from './incomeService';

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
    row: { category: string; description: string; date: string },
    filters: {
        resolvedCategory?: string;
        description?: string;
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
    description: string
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
    expenseId?: number
): string {
    const header = expenseId != null ? `✅ Logged #${expenseId}` : '✅ Logged';
    const lines = [
        header,
        `📅 Date: ${date}`,
        `💵 Amount: ${currency || 'MYR'} ${amount}`,
        `📁 Category: ${resolveCategory(category)}`,
    ];
    if (description) lines.push(`📝 Description: ${description}`);
    return lines.join('\n');
}

export async function getSpendingSummary(
    category?: string,
    description?: string,
    startDate?: string,
    endDate?: string
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
    const budgetSpent: Record<string, number> = {};

    for (const row of rows) {
        const canonicalCategory = resolveCategory(row.category);
        const gross = parseFloat(row.amount);
        const reimbursed = reimbursedByExpenseId.get(row.id) || 0;
        const net = Math.max(0, gross - reimbursed);
        const summaryFilters = {
            resolvedCategory: resolvedFilterCategory,
            description,
            startDate: effectiveStart,
            endDate: effectiveEnd,
        };

        if (rowMatchesFilters(row, summaryFilters)) {
            totalGross += gross;
            totalReimbursed += reimbursed;
            totalSpent += net;
            breakdown[canonicalCategory] = (breakdown[canonicalCategory] || 0) + net;
        }

        if (budgetPeriod.singleMonth) {
            const budgetFilters = {
                resolvedCategory: resolvedFilterCategory,
                description,
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
    startMonth: number
) {
    const db = requireDb();
    await db.insert(fixedExpenses).values({
        dayOfMonth,
        amount: String(amount),
        currency: currency || 'MYR',
        category: resolveCategory(category),
        description,
        frequencyMonths: frequency,
        startMonth,
        active: true,
    });
    return true;
}

export async function getFixedExpensesForToday(): Promise<
    { date: string; amount: number; currency: string; category: string; description: string }[]
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
    }
): Promise<boolean> {
    const db = requireDb();
    const set: Record<string, string> = {};

    if (fields.date != null) set.date = fields.date;
    if (fields.amount != null) set.amount = String(fields.amount);
    if (fields.currency != null) set.currency = fields.currency;
    if (fields.category != null) set.category = resolveCategory(fields.category);
    if (fields.description != null) set.description = fields.description;

    if (Object.keys(set).length === 0) return false;

    const result = await db.update(expenses).set(set).where(eq(expenses.id, id));
    return (result.count ?? 0) > 0;
}

export async function deleteExpense(id: number): Promise<boolean> {
    const db = requireDb();
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
    }
): Promise<boolean> {
    const db = requireDb();
    const set: Record<string, string | number> = {};

    if (fields.description != null) set.description = fields.description;
    if (fields.category != null) set.category = resolveCategory(fields.category);
    if (fields.amount != null) set.amount = String(fields.amount);
    if (fields.dayOfMonth != null) set.dayOfMonth = fields.dayOfMonth;
    if (fields.frequencyMonths != null) set.frequencyMonths = fields.frequencyMonths;

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
}[]) {
    const db = requireDb();
    await db.insert(expenses).values(
        expenseList.map((exp) => ({
            date: formatDateForDb(exp.date),
            amount: String(exp.amount),
            currency: exp.currency || 'MYR',
            category: resolveCategory(exp.category),
            description: exp.description,
        }))
    );
}

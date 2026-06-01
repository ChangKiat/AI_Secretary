import { eq, sql } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { expenses, fixedExpenses } from '../db/schema';

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

export async function appendExpense(
    date: string | undefined,
    amount: number,
    currency: string,
    category: string,
    description: string
) {
    const db = requireDb();
    await db.insert(expenses).values({
        date: formatDateForDb(date),
        amount: String(amount),
        currency: currency || 'MYR',
        category: category || 'General',
        description,
    });
    return true;
}

export async function getSpendingSummary(
    category?: string,
    description?: string,
    startDate?: string,
    endDate?: string
) {
    const db = requireDb();
    const rows = await db.select().from(expenses);

    let totalSpent = 0;
    const breakdown: Record<string, number> = {};

    for (const row of rows) {
        const rowCategory = row.category.toLowerCase();
        const rowDescription = row.description.toLowerCase();
        let match = true;

        if (category && rowCategory !== category.toLowerCase()) match = false;
        if (description && !rowDescription.includes(description.toLowerCase())) match = false;
        if (startDate && row.date < startDate) match = false;
        if (endDate && row.date > endDate) match = false;

        if (match) {
            const amount = parseFloat(row.amount);
            totalSpent += amount;
            breakdown[rowCategory] = (breakdown[rowCategory] || 0) + amount;
        }
    }

    return { total: totalSpent, breakdown };
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
        category: category || 'Fixed Expense',
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
        category: row.category,
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
            category: exp.category || 'General',
            description: exp.description,
        }))
    );
}

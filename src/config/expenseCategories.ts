import { asc } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { budgets } from '../db/schema';

export interface ExpenseCategory {
    category: string;
    monthlyBudget: number;
}

/** Default seed — keep in sync with scripts/init-db.sql */
export const DEFAULT_EXPENSE_CATEGORIES: ExpenseCategory[] = [
    { category: 'Drink', monthlyBudget: 200 },
    { category: 'Entertainment', monthlyBudget: 300 },
    { category: 'Food', monthlyBudget: 800 },
    { category: 'Shopping', monthlyBudget: 500 },
    { category: 'Transport', monthlyBudget: 370 },
    { category: 'Loan', monthlyBudget: 1000 },
    { category: 'Investment', monthlyBudget: 1000 },
    { category: 'Insurance', monthlyBudget: 1000 },
    { category: 'Utility', monthlyBudget: 1000 },
    { category: 'Other', monthlyBudget: 1000 },
];

const ALIAS_MAP: Record<string, string> = {
    general: 'Other',
    others: 'Other',
    'fixed expense': 'Other',
    housing: 'Utility',
    rent: 'Utility',
    utilities: 'Utility',
    subscription: 'Entertainment',
    subscriptions: 'Entertainment',
};

let cachedCategories: ExpenseCategory[] = [];
let categoryByLower = new Map<string, string>();
let categoryDescription = '';

function applyCache(categories: ExpenseCategory[]): ExpenseCategory[] {
    cachedCategories = categories;
    categoryByLower = new Map(
        cachedCategories.map((c) => [c.category.toLowerCase(), c.category])
    );
    categoryDescription = `Must be one of: ${cachedCategories.map((c) => c.category).join(', ')}. Default to Other if unclear.`;
    return cachedCategories;
}

export async function loadExpenseCategories(): Promise<ExpenseCategory[]> {
    const db = requireDb();
    let rows = await db.select().from(budgets).orderBy(asc(budgets.category));

    if (rows.length === 0) {
        await db.insert(budgets).values(
            DEFAULT_EXPENSE_CATEGORIES.map((c) => ({
                category: c.category,
                monthlyBudget: String(c.monthlyBudget),
                currency: 'MYR',
            }))
        );
        rows = await db.select().from(budgets).orderBy(asc(budgets.category));
    }

    return applyCache(
        rows.map((row) => ({
            category: row.category,
            monthlyBudget: parseFloat(row.monthlyBudget),
        }))
    );
}

export function getExpenseCategories(): ExpenseCategory[] {
    return cachedCategories;
}

export function getExpenseCategoryNames(): string[] {
    return cachedCategories.map((c) => c.category);
}

export function getExpenseCategoryDescription(): string {
    return categoryDescription || 'Use a valid expense category.';
}

export function resolveCategory(input?: string): string {
    const fallback = categoryByLower.get('other') ?? 'Other';
    const trimmed = input?.trim();
    if (!trimmed) return fallback;

    const lower = trimmed.toLowerCase();
    const alias = ALIAS_MAP[lower];
    if (alias) return categoryByLower.get(alias.toLowerCase()) ?? alias;

    return categoryByLower.get(lower) ?? fallback;
}

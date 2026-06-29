import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { expenses, incomes } from '../db/schema';

const INCOME_CATEGORIES = ['Claim', 'Transfer', 'Salary', 'Other'] as const;
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];

function todayInKL(): string {
    const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' }));
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatDateForDb(date?: string): string {
    return date || todayInKL();
}

export function resolveIncomeCategory(category: string): IncomeCategory {
    const normalized = category.trim();
    const match = INCOME_CATEGORIES.find((c) => c.toLowerCase() === normalized.toLowerCase());
    return match ?? 'Other';
}

export async function appendIncome(
    date: string | undefined,
    amount: number,
    currency: string,
    category: string,
    description: string,
    source?: string,
    expenseId?: number
): Promise<number> {
    const db = requireDb();
    const [row] = await db
        .insert(incomes)
        .values({
            date: formatDateForDb(date),
            amount: String(amount),
            currency: currency || 'MYR',
            category: resolveIncomeCategory(category),
            description,
            source: source || null,
            expenseId: expenseId ?? null,
        })
        .returning({ id: incomes.id });
    return row.id;
}

export async function appendReimbursements(
    expenseId: number,
    items: { source: string; amount: number }[],
    date?: string
): Promise<number[]> {
    const db = requireDb();
    const resolvedDate = formatDateForDb(date);
    const rows = await db
        .insert(incomes)
        .values(
            items.map((item) => ({
                date: resolvedDate,
                amount: String(item.amount),
                currency: 'MYR',
                category: 'Transfer' as const,
                description: `Reimbursement from ${item.source}`,
                source: item.source,
                expenseId,
            }))
        )
        .returning({ id: incomes.id });
    return rows.map((r) => r.id);
}

// ponytail: most recent expense whose description contains keyword; upgrade path = explicit expense id
export async function findRecentExpenseByDescription(keyword: string): Promise<number | null> {
    const db = requireDb();
    const rows = await db.select().from(expenses);
    const lower = keyword.toLowerCase();
    const matches = rows
        .filter((r) => r.description.toLowerCase().includes(lower))
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
    return matches[0]?.id ?? null;
}

export function parseExpenseIdFromBotReply(text: string): number | null {
    const match = text.match(/#(\d+)/);
    if (!match) return null;
    const id = parseInt(match[1], 10);
    return id > 0 ? id : null;
}

export async function expenseExists(id: number): Promise<boolean> {
    const db = requireDb();
    const rows = await db.select({ id: expenses.id }).from(expenses).where(eq(expenses.id, id));
    return rows.length > 0;
}

export async function resolveReplyToExpenseId(text: string): Promise<number | undefined> {
    const parsed = parseExpenseIdFromBotReply(text);
    if (parsed == null) return undefined;
    return (await expenseExists(parsed)) ? parsed : undefined;
}

export async function getReimbursementsByExpenseIds(
    expenseIds: number[]
): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    if (expenseIds.length === 0) return map;

    const db = requireDb();
    const rows = await db
        .select()
        .from(incomes)
        .where(inArray(incomes.expenseId, expenseIds));

    for (const row of rows) {
        if (row.expenseId == null) continue;
        const amount = parseFloat(row.amount);
        map.set(row.expenseId, (map.get(row.expenseId) || 0) + amount);
    }
    return map;
}

export async function listIncomes(startDate: string, endDate: string) {
    const db = requireDb();
    return db
        .select()
        .from(incomes)
        .where(and(gte(incomes.date, startDate), lte(incomes.date, endDate)))
        .orderBy(desc(incomes.date), desc(incomes.id));
}

export async function getIncomesByExpenseId(expenseId: number) {
    const db = requireDb();
    return db.select().from(incomes).where(eq(incomes.expenseId, expenseId));
}

export async function getIncomesByExpenseIds(expenseIds: number[]) {
    if (expenseIds.length === 0) return [];
    const db = requireDb();
    return db.select().from(incomes).where(inArray(incomes.expenseId, expenseIds));
}

export async function updateIncome(
    id: number,
    fields: {
        date?: string;
        amount?: number;
        currency?: string;
        category?: string;
        description?: string;
        source?: string | null;
        expenseId?: number | null;
    }
): Promise<boolean> {
    const db = requireDb();
    const set: Record<string, string | number | null> = {};

    if (fields.date != null) set.date = fields.date;
    if (fields.amount != null) set.amount = String(fields.amount);
    if (fields.currency != null) set.currency = fields.currency;
    if (fields.category != null) set.category = resolveIncomeCategory(fields.category);
    if (fields.description != null) set.description = fields.description;
    if (fields.source !== undefined) set.source = fields.source;
    if (fields.expenseId !== undefined) set.expenseId = fields.expenseId;

    if (Object.keys(set).length === 0) return false;

    const result = await db.update(incomes).set(set).where(eq(incomes.id, id));
    return (result.count ?? 0) > 0;
}

export async function deleteIncome(id: number): Promise<boolean> {
    const db = requireDb();
    const result = await db.delete(incomes).where(eq(incomes.id, id));
    return (result.count ?? 0) > 0;
}

export async function getUnlinkedIncomeTotal(startDate: string, endDate: string): Promise<number> {
    const db = requireDb();
    const rows = await db.select().from(incomes);

    let total = 0;
    for (const row of rows) {
        if (row.expenseId != null) continue;
        if (row.date < startDate || row.date > endDate) continue;
        total += parseFloat(row.amount);
    }
    return total;
}

export function formatIncomeLogReply(
    date: string,
    amount: number,
    currency: string,
    category: string,
    description: string,
    source?: string,
    linkedExpense?: boolean
): string {
    const lines = [
        '✅ Logged income',
        `📅 Date: ${date}`,
        `💵 Amount: ${currency || 'MYR'} ${amount}`,
        `📁 Category: ${resolveIncomeCategory(category)}`,
        `📝 Description: ${description}`,
    ];
    if (source) lines.push(`👤 From: ${source}`);
    if (linkedExpense) lines.push('🔗 Linked to expense (reduces your net cost)');
    return lines.join('\n');
}

export function formatSharedExpenseReply(
    date: string,
    gross: number,
    currency: string,
    category: string,
    description: string,
    reimbursements: { source: string; amount: number }[],
    expenseId?: number
): string {
    const reimbursed = reimbursements.reduce((s, r) => s + r.amount, 0);
    const net = gross - reimbursed;
    const reimbLine = reimbursements.map((r) => `${r.source} ${currency} ${r.amount}`).join(', ');
    const header = expenseId != null ? `✅ Logged expense #${expenseId}` : '✅ Logged expense';
    return [
        header,
        `📅 ${date} | 💵 ${currency} ${gross} | ${category} | ${description}`,
        `👥 Reimbursed: ${reimbLine} (${currency} ${reimbursed} total)`,
        `💰 Your share: ${currency} ${net}`,
    ].join('\n');
}

// ponytail self-check: net math for shared bill
if (require.main === module) {
    const gross = 57;
    const reimb = [{ source: 'A', amount: 20 }, { source: 'B', amount: 20 }];
    const totalReimb = reimb.reduce((s, r) => s + r.amount, 0);
    const net = gross - totalReimb;
    if (net !== 17) throw new Error(`expected net 17, got ${net}`);
    const reply = formatSharedExpenseReply('2026-06-29', gross, 'MYR', 'Food', 'Dinner', reimb, 57);
    if (!reply.includes('Your share: MYR 17')) throw new Error('shared expense reply missing net');
    if (!reply.includes('#57')) throw new Error('shared expense reply missing id');
    const parsed = parseExpenseIdFromBotReply('✅ Logged #57\n📅 Date: 2026-06-29');
    if (parsed !== 57) throw new Error(`expected parsed id 57, got ${parsed}`);
    console.log('incomeService self-check ok');
}

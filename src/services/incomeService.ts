import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { resolvePaymentMethod } from '../config/paymentMethods';
import { requireDb } from '../db/client';
import { expenses, incomes, investmentEvents } from '../db/schema';

const INCOME_CATEGORIES = ['Claim', 'Transfer', 'Salary', 'Account transfer', 'Cashback', 'Interest', 'Other'] as const;
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

export function isAccountTransferCategory(category: string): boolean {
    return resolveIncomeCategory(category) === 'Account transfer';
}

export function validateIncomePaymentAccounts(
    category: string,
    paymentMethod?: string | null,
    fromPaymentMethod?: string | null
): string | null {
    if (!isAccountTransferCategory(category)) return null;

    const to = paymentMethod ? resolvePaymentMethod(paymentMethod) : null;
    const from = fromPaymentMethod ? resolvePaymentMethod(fromPaymentMethod) : null;
    if (!to || !from) {
        return 'Account transfer requires from and to accounts';
    }
    if (to === from) {
        return 'From and to accounts must be different';
    }
    return null;
}

function normalizeIncomePaymentFields(
    category: string,
    paymentMethod?: string | null,
    fromPaymentMethod?: string | null
): { paymentMethod: string | null; fromPaymentMethod: string | null } {
    const to = paymentMethod != null ? resolvePaymentMethod(paymentMethod) : null;
    if (isAccountTransferCategory(category)) {
        return {
            paymentMethod: to,
            fromPaymentMethod:
                fromPaymentMethod != null ? resolvePaymentMethod(fromPaymentMethod) : null,
        };
    }
    return {
        paymentMethod: to,
        fromPaymentMethod: null,
    };
}

export async function appendIncome(
    date: string | undefined,
    amount: number,
    currency: string,
    category: string,
    description: string,
    source?: string,
    expenseId?: number,
    paymentMethod?: string | null,
    fromPaymentMethod?: string | null
): Promise<number> {
    const resolvedCategory = resolveIncomeCategory(category);
    const validationError = validateIncomePaymentAccounts(
        resolvedCategory,
        paymentMethod,
        fromPaymentMethod
    );
    if (validationError) throw new Error(validationError);

    const accounts = normalizeIncomePaymentFields(resolvedCategory, paymentMethod, fromPaymentMethod);
    const db = requireDb();
    const [row] = await db
        .insert(incomes)
        .values({
            date: formatDateForDb(date),
            amount: String(amount),
            currency: currency || 'MYR',
            category: resolvedCategory,
            description,
            source: source || null,
            expenseId: expenseId ?? null,
            paymentMethod: accounts.paymentMethod,
            fromPaymentMethod: accounts.fromPaymentMethod,
        })
        .returning({ id: incomes.id });
    return row.id;
}

export async function appendReimbursements(
    expenseId: number,
    items: { source: string; amount: number; paymentMethod?: string | null }[],
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
                paymentMethod: item.paymentMethod?.trim() || null,
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

export type ReplyRecordType = 'expense' | 'income' | 'meal';

export interface ReplyRecordTarget {
    type: ReplyRecordType;
    id: number;
}

/** Parse confirmation text shape; order matters so income ≠ expense. */
export function parseReplyRecordFromBotReply(text: string): ReplyRecordTarget | null {
    const incomeMatch = text.match(/(?:Logged|Updated) income #(\d+)/i);
    if (incomeMatch) {
        const id = parseInt(incomeMatch[1], 10);
        return id > 0 ? { type: 'income', id } : null;
    }
    const expenseMatch = text.match(/(?:Logged|Updated)(?: expense)? #(\d+)/i);
    if (expenseMatch) {
        const id = parseInt(expenseMatch[1], 10);
        return id > 0 ? { type: 'expense', id } : null;
    }
    const mealMatch = text.match(/#️⃣ ID:\s*(\d+)/);
    if (mealMatch) {
        const id = parseInt(mealMatch[1], 10);
        return id > 0 ? { type: 'meal', id } : null;
    }
    return null;
}

export function parseExpenseIdFromBotReply(text: string): number | null {
    const parsed = parseReplyRecordFromBotReply(text);
    return parsed?.type === 'expense' ? parsed.id : null;
}

export async function expenseExists(id: number): Promise<boolean> {
    const db = requireDb();
    const rows = await db.select({ id: expenses.id }).from(expenses).where(eq(expenses.id, id));
    return rows.length > 0;
}

export async function incomeExists(id: number): Promise<boolean> {
    const db = requireDb();
    const rows = await db.select({ id: incomes.id }).from(incomes).where(eq(incomes.id, id));
    return rows.length > 0;
}

export async function getIncomeById(id: number) {
    const db = requireDb();
    const rows = await db.select().from(incomes).where(eq(incomes.id, id)).limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
        id: row.id,
        date: row.date,
        amount: parseFloat(row.amount),
        currency: row.currency,
        category: resolveIncomeCategory(row.category),
        description: row.description,
        source: row.source,
        expenseId: row.expenseId,
        paymentMethod: row.paymentMethod ? resolvePaymentMethod(row.paymentMethod) : null,
        fromPaymentMethod: row.fromPaymentMethod
            ? resolvePaymentMethod(row.fromPaymentMethod)
            : null,
    };
}

export async function resolveReplyToExpenseId(text: string): Promise<number | undefined> {
    const parsed = parseExpenseIdFromBotReply(text);
    if (parsed == null) return undefined;
    return (await expenseExists(parsed)) ? parsed : undefined;
}

export async function resolveReplyRecord(
    text: string,
    mealExists?: (id: number) => Promise<boolean>
): Promise<ReplyRecordTarget | undefined> {
    const parsed = parseReplyRecordFromBotReply(text);
    if (!parsed) return undefined;
    if (parsed.type === 'expense') {
        return (await expenseExists(parsed.id)) ? parsed : undefined;
    }
    if (parsed.type === 'income') {
        return (await incomeExists(parsed.id)) ? parsed : undefined;
    }
    if (mealExists && !(await mealExists(parsed.id))) return undefined;
    return parsed;
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
        if (isAccountTransferCategory(row.category)) continue;
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
        paymentMethod?: string | null;
        fromPaymentMethod?: string | null;
    }
): Promise<boolean> {
    const db = requireDb();
    const existing = await db.select().from(incomes).where(eq(incomes.id, id));
    const current = existing[0];
    if (!current) return false;

    const nextCategory =
        fields.category != null ? resolveIncomeCategory(fields.category) : current.category;
    const nextPaymentMethod =
        fields.paymentMethod !== undefined
            ? fields.paymentMethod != null
                ? resolvePaymentMethod(fields.paymentMethod)
                : null
            : current.paymentMethod;
    const nextFromPaymentMethod =
        fields.fromPaymentMethod !== undefined
            ? fields.fromPaymentMethod != null
                ? resolvePaymentMethod(fields.fromPaymentMethod)
                : null
            : current.fromPaymentMethod;

    const validationError = validateIncomePaymentAccounts(
        nextCategory,
        nextPaymentMethod,
        isAccountTransferCategory(nextCategory) ? nextFromPaymentMethod : null
    );
    if (validationError) throw new Error(validationError);

    const set: Record<string, string | number | null> = {};

    if (fields.date != null) set.date = fields.date;
    if (fields.amount != null) set.amount = String(fields.amount);
    if (fields.currency != null) set.currency = fields.currency;
    if (fields.category != null) set.category = nextCategory;
    if (fields.description != null) set.description = fields.description;
    if (fields.source !== undefined) set.source = fields.source;

    if (fields.expenseId !== undefined) {
        set.expenseId = fields.expenseId;
    } else if (fields.category != null && !isAccountTransferCategory(nextCategory)) {
        // category changed away from transfer — leave expenseId as-is unless cleared above
    }

    if (fields.paymentMethod !== undefined || fields.category != null) {
        set.paymentMethod = nextPaymentMethod;
    }
    if (fields.fromPaymentMethod !== undefined || fields.category != null) {
        set.fromPaymentMethod = isAccountTransferCategory(nextCategory)
            ? nextFromPaymentMethod
            : null;
    }

    if (Object.keys(set).length === 0) return false;

    const result = await db.update(incomes).set(set).where(eq(incomes.id, id));
    return (result.count ?? 0) > 0;
}

export async function deleteIncome(id: number): Promise<boolean> {
    const db = requireDb();
    await db
        .update(investmentEvents)
        .set({ linkedIncomeId: null })
        .where(eq(investmentEvents.linkedIncomeId, id));
    const result = await db.delete(incomes).where(eq(incomes.id, id));
    return (result.count ?? 0) > 0;
}

function formatRebatePeriodLabel(periodMonth: string): string {
    const [yearStr, monthStr] = periodMonth.split('-');
    const date = new Date(parseInt(yearStr, 10), parseInt(monthStr, 10) - 1, 1);
    return date.toLocaleDateString('en-MY', { month: 'short', year: 'numeric' });
}

export async function upsertRebateIncomes(
    accountId: number,
    accountName: string,
    periodMonth: string,
    periodEndDate: string,
    categories: { category: string; earned: number }[]
): Promise<void> {
    const db = requireDb();
    const existing = await db
        .select()
        .from(incomes)
        .where(
            and(
                eq(incomes.rebateAccountId, accountId),
                eq(incomes.rebatePeriodMonth, periodMonth)
            )
        );

    const earnedByCategory = new Map(categories.map((c) => [c.category, c.earned]));
    const allCategories = new Set<string>([
        ...categories.map((c) => c.category),
        ...existing
            .map((row) => row.rebateCategory)
            .filter((c): c is string => typeof c === 'string' && c.length > 0),
    ]);

    const periodLabel = formatRebatePeriodLabel(periodMonth);

    for (const category of allCategories) {
        const earned = earnedByCategory.get(category) ?? 0;
        const match = existing.find((row) => row.rebateCategory === category);
        const rounded = Math.round(earned * 100) / 100;

        if (rounded <= 0) {
            if (match) await db.delete(incomes).where(eq(incomes.id, match.id));
            continue;
        }

        const description = `${category} cashback · ${periodLabel}`;
        const paymentMethod = resolvePaymentMethod(accountName) ?? accountName;

        if (match) {
            await db
                .update(incomes)
                .set({
                    amount: String(rounded),
                    date: periodEndDate,
                    description,
                    paymentMethod,
                    category: 'Cashback',
                })
                .where(eq(incomes.id, match.id));
        } else {
            await db.insert(incomes).values({
                date: periodEndDate,
                amount: String(rounded),
                currency: 'MYR',
                category: 'Cashback',
                description,
                paymentMethod,
                rebateAccountId: accountId,
                rebatePeriodMonth: periodMonth,
                rebateCategory: category,
            });
        }
    }
}

export async function deleteIncomesByExpenseId(expenseId: number): Promise<number> {
    const db = requireDb();
    const linked = await db
        .select({ id: incomes.id })
        .from(incomes)
        .where(eq(incomes.expenseId, expenseId));
    const ids = linked.map((row) => row.id);
    if (ids.length > 0) {
        await db
            .update(investmentEvents)
            .set({ linkedIncomeId: null })
            .where(inArray(investmentEvents.linkedIncomeId, ids));
    }
    const result = await db.delete(incomes).where(eq(incomes.expenseId, expenseId));
    return result.count ?? 0;
}

/** Linked Account transfer that funds an investment from an Investment expense. */
export async function upsertInvestmentFundingTransfer(fields: {
    expenseId: number;
    date: string;
    amount: number;
    description: string;
    fromPaymentMethod: string;
    toInvestmentAccount: string;
}): Promise<number> {
    const existing = await getIncomesByExpenseId(fields.expenseId);
    const transfer = existing.find((row) => isAccountTransferCategory(row.category));
    if (transfer) {
        await updateIncome(transfer.id, {
            date: fields.date,
            amount: fields.amount,
            description: fields.description,
            category: 'Account transfer',
            expenseId: fields.expenseId,
            paymentMethod: fields.toInvestmentAccount,
            fromPaymentMethod: fields.fromPaymentMethod,
        });
        return transfer.id;
    }
    return appendIncome(
        fields.date,
        fields.amount,
        'MYR',
        'Account transfer',
        fields.description,
        undefined,
        fields.expenseId,
        fields.toInvestmentAccount,
        fields.fromPaymentMethod
    );
}

export async function deleteInvestmentFundingTransfer(expenseId: number): Promise<void> {
    const existing = await getIncomesByExpenseId(expenseId);
    for (const row of existing) {
        if (isAccountTransferCategory(row.category)) {
            await deleteIncome(row.id);
        }
    }
}

export async function getUnlinkedIncomeTotal(startDate: string, endDate: string): Promise<number> {
    const db = requireDb();
    const rows = await db.select().from(incomes);

    let total = 0;
    for (const row of rows) {
        if (row.expenseId != null) continue;
        if (row.category === 'Account transfer') continue;
        if (row.date < startDate || row.date > endDate) continue;
        total += parseFloat(row.amount);
    }
    return total;
}

export function formatIncomeAccountFlow(
    paymentMethod?: string | null,
    fromPaymentMethod?: string | null
): string | null {
    if (fromPaymentMethod && paymentMethod) {
        return `${fromPaymentMethod} → ${paymentMethod}`;
    }
    if (paymentMethod) return `→ ${paymentMethod}`;
    if (fromPaymentMethod) return `${fromPaymentMethod} →`;
    return null;
}

export function formatIncomeLogReply(
    date: string,
    amount: number,
    currency: string,
    category: string,
    description: string,
    incomeId?: number,
    source?: string,
    linkedExpense?: boolean,
    paymentMethod?: string | null,
    fromPaymentMethod?: string | null,
    headerPrefix = '✅ Logged income'
): string {
    const header =
        incomeId != null ? `${headerPrefix} #${incomeId}` : headerPrefix;
    const lines = [
        header,
        `📅 Date: ${date}`,
        `💵 Amount: ${currency || 'MYR'} ${amount}`,
        `📁 Category: ${resolveIncomeCategory(category)}`,
        `📝 Description: ${description}`,
    ];
    if (source) lines.push(`👤 From: ${source}`);
    const accountFlow = formatIncomeAccountFlow(paymentMethod, fromPaymentMethod);
    if (accountFlow) lines.push(`💳 Accounts: ${accountFlow}`);
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
    expenseId?: number,
    paymentMethod?: string | null
): string {
    const reimbursed = reimbursements.reduce((s, r) => s + r.amount, 0);
    const net = gross - reimbursed;
    const reimbLine = reimbursements.map((r) => `${r.source} ${currency} ${r.amount}`).join(', ');
    const header = expenseId != null ? `✅ Logged expense #${expenseId}` : '✅ Logged expense';
    const lines = [
        header,
        `📅 ${date} | 💵 ${currency} ${gross} | ${category} | ${description}`,
    ];
    if (paymentMethod) lines.push(`💳 Paid via: ${paymentMethod}`);
    lines.push(
        `👥 Reimbursed: ${reimbLine} (${currency} ${reimbursed} total)`,
        `💰 Your share: ${currency} ${net}`
    );
    return lines.join('\n');
}

// ponytail self-check: net math for shared bill + reply parse
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
    if (!validateIncomePaymentAccounts('Account transfer', 'TnG', null)) {
        throw new Error('account transfer validation should fail without from');
    }

    const incomeFmt = formatIncomeLogReply(
        '2026-06-29',
        100,
        'MYR',
        'Salary',
        'June pay',
        42
    );
    if (!incomeFmt.includes('Logged income #42')) {
        throw new Error(`income format missing #id: ${incomeFmt}`);
    }

    const expenseTarget = parseReplyRecordFromBotReply('✅ Logged #57\n📅 Date: 2026-06-29');
    if (expenseTarget?.type !== 'expense' || expenseTarget.id !== 57) {
        throw new Error(`expected expense #57, got ${JSON.stringify(expenseTarget)}`);
    }
    const sharedTarget = parseReplyRecordFromBotReply(reply);
    if (sharedTarget?.type !== 'expense' || sharedTarget.id !== 57) {
        throw new Error(`expected shared expense #57, got ${JSON.stringify(sharedTarget)}`);
    }
    const incomeTarget = parseReplyRecordFromBotReply(incomeFmt);
    if (incomeTarget?.type !== 'income' || incomeTarget.id !== 42) {
        throw new Error(`expected income #42, got ${JSON.stringify(incomeTarget)}`);
    }
    const mealTarget = parseReplyRecordFromBotReply(
        '✅ Logged\n📅 Date: 2026-06-29\n#️⃣ ID: 9\n📝 Description: chicken rice'
    );
    if (mealTarget?.type !== 'meal' || mealTarget.id !== 9) {
        throw new Error(`expected meal #9, got ${JSON.stringify(mealTarget)}`);
    }
    const updatedIncome = parseReplyRecordFromBotReply('✅ Updated income #42\n📅 Date: 2026-06-29');
    if (updatedIncome?.type !== 'income' || updatedIncome.id !== 42) {
        throw new Error(`expected updated income #42, got ${JSON.stringify(updatedIncome)}`);
    }

    console.log('incomeService self-check ok');
}

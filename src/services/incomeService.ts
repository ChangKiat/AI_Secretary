import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { resolveCategory } from '../config/expenseCategories';
import {
    displayPaymentMethod,
    paymentMethodsMatch,
    resolvePaymentMethod,
    setPaymentAccountsCache,
} from '../config/paymentMethods';
import { requireDb } from '../db/client';
import { expenses, incomes, investmentEvents } from '../db/schema';
import type { PaymentAccount } from './paymentAccountService';

/**
 * requireDb() or the `tx` of requireDb().transaction(...): functions that take one run their
 * queries on it, so a caller can make several writes atomic (see fixedContributionService).
 */
export type DbExecutor = Pick<ReturnType<typeof requireDb>, 'select' | 'insert' | 'update'>;

const INCOME_CATEGORIES = ['Claim', 'Transfer', 'Salary', 'Account transfer', 'Cashback', 'Interest', 'Other'] as const;
export type IncomeCategory = (typeof INCOME_CATEGORIES)[number];

export const TRANSFER_FEE_EXPENSE_CATEGORY = 'Bank charges';

function roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
}

function parseTransferFeeValue(fee: number | null | undefined, category: string): number {
    if (!isAccountTransferCategory(category)) {
        if (fee != null && fee > 0) {
            throw new Error('Transfer fee is only allowed for Account transfer');
        }
        return 0;
    }
    if (fee == null) return 0;
    if (!Number.isFinite(fee) || fee < 0) {
        throw new Error('Transfer fee must be a non-negative number');
    }
    return roundMoney(fee);
}

export function parseStoredTransferFee(value: string | null | undefined): number {
    if (!value) return 0;
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

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

/** Presence and distinctness check on account names that are already resolved (or kept as stored). */
function transferAccountsError(
    category: string,
    to: string | null,
    from: string | null
): string | null {
    if (!isAccountTransferCategory(category)) return null;
    if (!to || !from) {
        return 'Account transfer requires from and to accounts';
    }
    if (to.toLowerCase() === from.toLowerCase()) {
        return 'From and to accounts must be different';
    }
    return null;
}

export function validateIncomePaymentAccounts(
    category: string,
    paymentMethod?: string | null,
    fromPaymentMethod?: string | null
): string | null {
    return transferAccountsError(
        category,
        paymentMethod ? resolvePaymentMethod(paymentMethod) : null,
        fromPaymentMethod ? resolvePaymentMethod(fromPaymentMethod) : null
    );
}

/**
 * Errors appendIncome / updateIncome throw for bad input (unknown or missing accounts, bad
 * transfer fee). Routes map these to HTTP 400.
 */
export function isIncomeInputError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : '';
    return (
        message.startsWith('Unknown payment account') ||
        message.startsWith('Account transfer requires') ||
        message.startsWith('From and to accounts') ||
        message.startsWith('Transfer fee')
    );
}

/** Trimmed, case-insensitive; null and empty are the same. */
function sameAccountText(a?: string | null, b?: string | null): boolean {
    return (a?.trim() ?? '').toLowerCase() === (b?.trim() ?? '').toLowerCase();
}

/**
 * Write guard for one stored account column.
 * - Not sent, or the same text as stored: keep the stored raw value, even if it no longer resolves.
 * - Empty: clear it.
 * - Anything else must resolve to an active account, or this throws "Unknown payment account: …".
 */
function nextAccountValue(
    incoming: string | null | undefined,
    stored: string | null
): { value: string | null; changed: boolean } {
    if (incoming === undefined || sameAccountText(incoming, stored)) {
        return { value: stored, changed: false };
    }
    const trimmed = incoming?.trim();
    if (!trimmed) return { value: null, changed: true };
    const resolved = resolvePaymentMethod(trimmed);
    if (!resolved) throw new Error(`Unknown payment account: ${trimmed}`);
    return { value: resolved, changed: true };
}

/**
 * Category and account columns for updateIncome (pure, so the self-check can run it).
 * paymentMethod / fromPaymentMethod are undefined when that column is left alone.
 * Accounts are validated only when an account or the category actually changes; an unchanged
 * account only has to be present, so an old transfer from a deactivated account stays editable.
 */
export function planIncomeAccountUpdate(
    current: { category: string; paymentMethod: string | null; fromPaymentMethod: string | null },
    fields: { category?: string; paymentMethod?: string | null; fromPaymentMethod?: string | null }
): { category: IncomeCategory; paymentMethod?: string | null; fromPaymentMethod?: string | null } {
    const currentCategory = resolveIncomeCategory(current.category);
    const category =
        fields.category != null ? resolveIncomeCategory(fields.category) : currentCategory;
    const isTransfer = isAccountTransferCategory(category);

    const to = nextAccountValue(fields.paymentMethod, current.paymentMethod);
    // Non-transfers store no from-account, so an incoming one is ignored, not validated.
    const from = isTransfer
        ? nextAccountValue(fields.fromPaymentMethod, current.fromPaymentMethod)
        : { value: null, changed: false };

    if (to.changed || from.changed || category !== currentCategory) {
        const validationError = transferAccountsError(
            category,
            displayPaymentMethod(to.value),
            displayPaymentMethod(from.value)
        );
        if (validationError) throw new Error(validationError);
    }

    return {
        category,
        paymentMethod:
            fields.paymentMethod !== undefined || fields.category != null ? to.value : undefined,
        fromPaymentMethod:
            fields.fromPaymentMethod !== undefined || fields.category != null
                ? from.value
                : undefined,
    };
}

/** Investment always requires from→to; Other may optionally create a linked transfer. */
export function isInvestmentCategory(category: string): boolean {
    return category.trim().toLowerCase() === 'investment';
}

export function isOtherCategory(category: string): boolean {
    return category.trim().toLowerCase() === 'other';
}

/** To-only Other → treat destination as payment method (no transfer). */
export function normalizeOtherAccounts(
    paymentMethod: string | null,
    toInvestmentAccount: string | null
): { paymentMethod: string | null; toInvestmentAccount: string | null } {
    if (paymentMethod && toInvestmentAccount) {
        return { paymentMethod, toInvestmentAccount };
    }
    if (paymentMethod) {
        return { paymentMethod, toInvestmentAccount: null };
    }
    if (toInvestmentAccount) {
        return { paymentMethod: toInvestmentAccount, toInvestmentAccount: null };
    }
    return { paymentMethod: null, toInvestmentAccount: null };
}

/** Validate from/to for Investment (required) or Other (optional pair). Returns error message or null. */
export function validateFundingAccounts(
    category: string,
    paymentMethod: string | null,
    toInvestmentAccount: string | null,
    kind: 'expense' | 'fixed' = 'expense'
): string | null {
    const label = kind === 'fixed' ? 'fixed expense' : 'expense';
    if (isInvestmentCategory(category)) {
        if (!paymentMethod) {
            return `This ${label} requires a payment method (from account)`;
        }
        if (!toInvestmentAccount) {
            return `This ${label} requires a destination investment account`;
        }
        if (paymentMethod === toInvestmentAccount) {
            return 'From and to accounts must be different';
        }
        return null;
    }
    if (isOtherCategory(category)) {
        if (paymentMethod && toInvestmentAccount && paymentMethod === toInvestmentAccount) {
            return 'From and to accounts must be different';
        }
    }
    return null;
}

/** Account the linked funding transfer goes to, or null when the expense needs no transfer. */
export function fundingDestination(
    category: string,
    paymentMethod: string | null,
    toInvestmentAccount: string | null
): string | null {
    if (isInvestmentCategory(category)) return toInvestmentAccount;
    if (isOtherCategory(category) && paymentMethod && toInvestmentAccount) {
        return toInvestmentAccount;
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
    fromPaymentMethod?: string | null,
    transferFee?: number | null,
    executor?: DbExecutor
): Promise<number> {
    const resolvedCategory = resolveIncomeCategory(category);
    const validationError = validateIncomePaymentAccounts(
        resolvedCategory,
        paymentMethod,
        fromPaymentMethod
    );
    if (validationError) throw new Error(validationError);

    const fee = parseTransferFeeValue(transferFee, resolvedCategory);
    const accounts = normalizeIncomePaymentFields(resolvedCategory, paymentMethod, fromPaymentMethod);
    const db = executor ?? requireDb();
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
            transferFee: fee > 0 ? String(fee) : null,
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

export type ReplyRecordType = 'expense' | 'income' | 'meal' | 'workout';

export interface ReplyRecordTarget {
    type: ReplyRecordType;
    id: number;
}

/** Parse confirmation text shape; order matters so income ≠ expense. */
export function parseReplyRecordFromBotReply(text: string): ReplyRecordTarget | null {
    const workoutMatch = text.match(/Workout ID:\s*(\d+)/);
    if (workoutMatch) {
        const id = parseInt(workoutMatch[1], 10);
        return id > 0 ? { type: 'workout', id } : null;
    }
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
        paymentMethod: displayPaymentMethod(row.paymentMethod),
        fromPaymentMethod: displayPaymentMethod(row.fromPaymentMethod),
        transferFee: parseStoredTransferFee(row.transferFee),
    };
}

export async function resolveReplyRecord(
    text: string,
    /** Per-user ownership check for meal/workout rows (expense/income are checked here). */
    userRecordExists?: (target: ReplyRecordTarget) => Promise<boolean>
): Promise<ReplyRecordTarget | undefined> {
    const parsed = parseReplyRecordFromBotReply(text);
    if (!parsed) return undefined;
    if (parsed.type === 'expense') {
        return (await expenseExists(parsed.id)) ? parsed : undefined;
    }
    if (parsed.type === 'income') {
        return (await incomeExists(parsed.id)) ? parsed : undefined;
    }
    if (userRecordExists && !(await userRecordExists(parsed))) return undefined;
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

export async function getIncomesByExpenseId(expenseId: number, executor?: DbExecutor) {
    const db = executor ?? requireDb();
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
        transferFee?: number | null;
    },
    executor?: DbExecutor
): Promise<boolean> {
    const db = executor ?? requireDb();
    const existing = await db.select().from(incomes).where(eq(incomes.id, id));
    const current = existing[0];
    if (!current) return false;

    // Throws "Unknown payment account: …" or an Account transfer error before anything is written.
    const accounts = planIncomeAccountUpdate(current, fields);
    const nextCategory = accounts.category;

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

    if (accounts.paymentMethod !== undefined) {
        set.paymentMethod = accounts.paymentMethod;
    }
    if (accounts.fromPaymentMethod !== undefined) {
        set.fromPaymentMethod = accounts.fromPaymentMethod;
    }

    if (fields.transferFee !== undefined) {
        const fee = parseTransferFeeValue(fields.transferFee, nextCategory);
        set.transferFee = fee > 0 ? String(fee) : null;
    } else if (fields.category != null && !isAccountTransferCategory(nextCategory)) {
        set.transferFee = null;
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

/**
 * Linked Account transfer that funds an investment from an Investment expense.
 * Re-upserting passes the bill's stored accounts. When they match the transfer's stored text
 * (trimmed, case-insensitive) they are kept as they are, even if the account was deactivated
 * since, so editing an old bill's amount or date still works (see planIncomeAccountUpdate).
 * Pass `executor` (a transaction) to write the transfer together with the expense it funds.
 */
export async function upsertInvestmentFundingTransfer(
    fields: {
        expenseId: number;
        date: string;
        amount: number;
        description: string;
        fromPaymentMethod: string;
        toInvestmentAccount: string;
    },
    executor?: DbExecutor
): Promise<number> {
    const existing = await getIncomesByExpenseId(fields.expenseId, executor);
    const transfer = existing.find((row) => isAccountTransferCategory(row.category));
    if (transfer) {
        await updateIncome(
            transfer.id,
            {
                date: fields.date,
                amount: fields.amount,
                description: fields.description,
                category: 'Account transfer',
                expenseId: fields.expenseId,
                paymentMethod: fields.toInvestmentAccount,
                fromPaymentMethod: fields.fromPaymentMethod,
                transferFee: 0,
            },
            executor
        );
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
        fields.fromPaymentMethod,
        undefined,
        executor
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

export async function getTransferFeesForSpendingSummary(
    startDate: string,
    endDate: string,
    filters?: {
        category?: string;
        description?: string;
        paymentMethod?: string;
    }
): Promise<{ total: number; breakdown: Record<string, number>; byPaymentMethod: Record<string, number> }> {
    // The budget row may be stored as 'Bank Charges' (Telegram title-cases new budgets), so bucket
    // fees under the canonical budget category, the same way expense rows are bucketed.
    const feeCategory = resolveCategory(TRANSFER_FEE_EXPENSE_CATEGORY);
    const resolvedFilterCategory = filters?.category;
    if (resolvedFilterCategory != null && resolvedFilterCategory !== feeCategory) {
        return { total: 0, breakdown: {}, byPaymentMethod: {} };
    }

    const db = requireDb();
    const rows = await db.select().from(incomes);
    let total = 0;
    const breakdown: Record<string, number> = {};
    const byPaymentMethod: Record<string, number> = {};

    for (const row of rows) {
        if (!isAccountTransferCategory(row.category)) continue;
        const fee = parseStoredTransferFee(row.transferFee);
        if (fee <= 0) continue;
        if (row.date < startDate || row.date > endDate) continue;

        if (filters?.description) {
            if (!row.description.toLowerCase().includes(filters.description.toLowerCase())) {
                continue;
            }
        }
        // Same rule as expense rows: the fee is paid from the from-account.
        if (filters?.paymentMethod && !paymentMethodsMatch(row.fromPaymentMethod, filters.paymentMethod)) {
            continue;
        }

        total += fee;
        breakdown[feeCategory] = (breakdown[feeCategory] || 0) + fee;
        const methodKey = row.fromPaymentMethod
            ? resolvePaymentMethod(row.fromPaymentMethod) ?? row.fromPaymentMethod
            : 'Unspecified';
        byPaymentMethod[methodKey] = (byPaymentMethod[methodKey] || 0) + fee;
    }

    return { total, breakdown, byPaymentMethod };
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
    headerPrefix = '✅ Logged income',
    /** Kept after headerPrefix so existing positional callers don't shift. */
    transferFee?: number | null
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
    if (transferFee != null && transferFee > 0) {
        const feeSource = fromPaymentMethod ? ` (from ${fromPaymentMethod})` : '';
        lines.push(`💸 Fee: ${currency || 'MYR'} ${transferFee}${feeSource}`);
    }
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
    const workoutTarget = parseReplyRecordFromBotReply(
        '✅ Logged\n📅 Date: 2026-09-23\n\n• ISO incline press — 4 sets @ 15/20/20/20kg\n\n#️⃣ Workout ID: 812'
    );
    if (workoutTarget?.type !== 'workout' || workoutTarget.id !== 812) {
        throw new Error(`expected workout #812, got ${JSON.stringify(workoutTarget)}`);
    }

    // Transfer fee: own reply line after the accounts; positional headerPrefix unchanged.
    const feeFmt = formatIncomeLogReply(
        '2026-06-29',
        500,
        'MYR',
        'Account transfer',
        'Top up',
        43,
        undefined,
        false,
        'TnG',
        'Maybank Savings',
        undefined,
        1.5
    );
    if (!feeFmt.startsWith('✅ Logged income #43') || !feeFmt.includes('💸 Fee: MYR 1.5 (from Maybank Savings)')) {
        throw new Error(`fee reply wrong: ${feeFmt}`);
    }
    if (incomeFmt.includes('Fee:')) throw new Error('fee line without a fee');
    if (parseTransferFeeValue(1.234, 'Account transfer') !== 1.23) throw new Error('fee not rounded');
    if (parseTransferFeeValue(null, 'Salary') !== 0) throw new Error('no fee on Salary should be 0');
    if (parseStoredTransferFee('2.50') !== 2.5 || parseStoredTransferFee(null) !== 0) {
        throw new Error('parseStoredTransferFee wrong');
    }

    // Write guard (2.5) and unchanged-account tolerance (2.18). 'Old Bank' is not in the cache.
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
    setPaymentAccountsCache([
        account(1, 'TnG'),
        account(2, 'Maybank Savings'),
        account(3, 'Maybank', false),
    ]);
    const expectInputError = (fn: () => unknown, message: string) => {
        try {
            fn();
        } catch (err) {
            if (err instanceof Error && err.message === message && isIncomeInputError(err)) return;
            throw new Error(`expected "${message}", got ${err}`);
        }
        throw new Error(`expected "${message}", got no error`);
    };
    const oldTransfer = { category: 'Account transfer', paymentMethod: 'TnG', fromPaymentMethod: 'Old Bank' };

    // Amount-only edit of a transfer from an account that no longer resolves.
    const amountOnly = planIncomeAccountUpdate(oldTransfer, {});
    if (amountOnly.paymentMethod !== undefined || amountOnly.fromPaymentMethod !== undefined) {
        throw new Error(`amount-only edit touched accounts: ${JSON.stringify(amountOnly)}`);
    }
    // Re-upsert of a funding transfer with the stored accounts (other case/spacing) keeps the raw text.
    const reUpsert = planIncomeAccountUpdate(oldTransfer, {
        category: 'Account transfer',
        paymentMethod: 'TnG',
        fromPaymentMethod: ' old bank ',
    });
    if (reUpsert.paymentMethod !== 'TnG' || reUpsert.fromPaymentMethod !== 'Old Bank') {
        throw new Error(`re-upsert should keep stored accounts: ${JSON.stringify(reUpsert)}`);
    }
    // Same for a deactivated account.
    const inactiveKept = planIncomeAccountUpdate(
        { category: 'Account transfer', paymentMethod: 'TnG', fromPaymentMethod: 'Maybank' },
        { fromPaymentMethod: 'Maybank' }
    );
    if (inactiveKept.fromPaymentMethod !== 'Maybank') throw new Error('inactive account not kept');
    // New values must resolve; resolved names are stored.
    expectInputError(
        () => planIncomeAccountUpdate(oldTransfer, { fromPaymentMethod: 'Boost Wallet' }),
        'Unknown payment account: Boost Wallet'
    );
    expectInputError(
        () => planIncomeAccountUpdate(oldTransfer, { paymentMethod: 'Maybank' }),
        'Unknown payment account: Maybank'
    );
    if (planIncomeAccountUpdate(oldTransfer, { fromPaymentMethod: 'maybank savings' }).fromPaymentMethod !== 'Maybank Savings') {
        throw new Error('new from-account should be stored resolved');
    }
    expectInputError(
        () => planIncomeAccountUpdate(oldTransfer, { fromPaymentMethod: 'tng' }),
        'From and to accounts must be different'
    );
    expectInputError(
        () => planIncomeAccountUpdate(oldTransfer, { fromPaymentMethod: null }),
        'Account transfer requires from and to accounts'
    );
    // Leaving Account transfer clears the from-account and ignores an incoming one.
    const toSalary = planIncomeAccountUpdate(oldTransfer, { category: 'Salary', fromPaymentMethod: 'Boost Wallet' });
    if (toSalary.category !== 'Salary' || toSalary.paymentMethod !== 'TnG' || toSalary.fromPaymentMethod !== null) {
        throw new Error(`category change wrong: ${JSON.stringify(toSalary)}`);
    }
    expectInputError(
        () => planIncomeAccountUpdate({ category: 'Salary', paymentMethod: null, fromPaymentMethod: null }, { paymentMethod: 'Boost Wallet' }),
        'Unknown payment account: Boost Wallet'
    );

    console.log('incomeService self-check ok');
}

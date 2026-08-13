import { and, desc, eq, lte } from 'drizzle-orm';
import { resolvePaymentMethod } from '../config/paymentMethods';
import { requireDb } from '../db/client';
import { expenses, incomes, interestSchedules } from '../db/schema';
import { appendIncome } from './incomeService';
import {
    listActivePaymentAccounts,
    type PaymentAccount,
} from './paymentAccountService';

export type InterestFrequency = 'daily' | 'monthly';

export interface InterestScheduleRow {
    id: number;
    paymentMethod: string;
    frequency: InterestFrequency;
    dayOfMonth: number | null;
    annualRatePct: number | null;
    fixedAmount: number | null;
    currency: string;
    description: string;
}

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

function parseNum(value: string | null | undefined): number {
    if (value == null) return 0;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

function roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
}

function subtractDays(dateStr: string, days: number): string {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
}

function daysBetween(fromDate: string, toDate: string): number {
    const start = new Date(`${fromDate}T00:00:00Z`);
    const end = new Date(`${toDate}T00:00:00Z`);
    return Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
}

function monthStartDate(dateStr: string): string {
    return `${dateStr.slice(0, 7)}-01`;
}

function mapRow(row: typeof interestSchedules.$inferSelect): InterestScheduleRow {
    return {
        id: row.id,
        paymentMethod: resolvePaymentMethod(row.paymentMethod) ?? row.paymentMethod,
        frequency: row.frequency as InterestFrequency,
        dayOfMonth: row.dayOfMonth,
        annualRatePct: row.annualRatePct != null ? parseNum(row.annualRatePct) : null,
        fixedAmount: row.fixedAmount != null ? parseNum(row.fixedAmount) : null,
        currency: row.currency,
        description: row.description,
    };
}

function isValidFrequency(value: string): value is InterestFrequency {
    return value === 'daily' || value === 'monthly';
}

async function resolveDebitPaymentAccount(paymentMethod: string): Promise<string> {
    const resolved = resolvePaymentMethod(paymentMethod);
    if (!resolved) throw new Error(`Unknown payment account: ${paymentMethod}`);
    const accounts = await listActivePaymentAccounts();
    const account = accounts.find((a) => a.name.toLowerCase() === resolved.toLowerCase());
    if (!account) throw new Error(`Payment account not found: ${resolved}`);
    if (account.accountType !== 'account') {
        throw new Error(`${resolved} must be a debit account (not credit or investment)`);
    }
    return resolved;
}

function validateScheduleFields(fields: {
    frequency: string;
    dayOfMonth?: number | null;
    annualRatePct?: number | null;
    fixedAmount?: number | null;
}): void {
    if (!isValidFrequency(fields.frequency)) {
        throw new Error('Frequency must be daily or monthly');
    }
    if (fields.frequency === 'monthly') {
        if (
            fields.dayOfMonth == null ||
            !Number.isInteger(fields.dayOfMonth) ||
            fields.dayOfMonth < 1 ||
            fields.dayOfMonth > 31
        ) {
            throw new Error('Monthly schedules require day of month (1–31)');
        }
    }
    const hasRate =
        fields.annualRatePct != null &&
        Number.isFinite(fields.annualRatePct) &&
        fields.annualRatePct > 0;
    const hasFixed =
        fields.fixedAmount != null &&
        Number.isFinite(fields.fixedAmount) &&
        fields.fixedAmount > 0;
    if (!hasRate && !hasFixed) {
        throw new Error('Set an annual rate and/or a fixed amount override');
    }
}

function isOnOrAfterBaseline(date: string, account: PaymentAccount): boolean {
    const baseline = account.balanceBaselineDate || '0000-00-00';
    return date >= baseline;
}

async function getAccountBalanceAsOf(accountName: string, asOfDate: string): Promise<number> {
    const accounts = await listActivePaymentAccounts();
    const account = accounts.find((a) => a.name.toLowerCase() === accountName.toLowerCase());
    if (!account || account.accountType !== 'account') return 0;

    const db = requireDb();
    const [expenseRows, incomeRows] = await Promise.all([
        db.select().from(expenses).where(lte(expenses.date, asOfDate)),
        db.select().from(incomes).where(lte(incomes.date, asOfDate)),
    ]);

    const accountByName = new Map(
        accounts.map((a) => [a.name.toLowerCase(), a])
    );

    const fundedExpenseIds = new Set<number>();
    for (const income of incomeRows) {
        if (income.category === 'Account transfer' && income.expenseId != null) {
            fundedExpenseIds.add(income.expenseId);
        }
    }

    function getAccountByStoredName(stored: string | null | undefined): PaymentAccount | undefined {
        if (!stored) return undefined;
        const resolved = resolvePaymentMethod(stored);
        if (!resolved) return undefined;
        return accountByName.get(resolved.toLowerCase());
    }

    let debitDelta = 0;

    for (const expense of expenseRows) {
        if (fundedExpenseIds.has(expense.id)) continue;
        if (expense.tripLeg === 'fund') continue;
        const expAccount = getAccountByStoredName(expense.paymentMethod);
        if (!expAccount || expAccount.id !== account.id) continue;
        if (!isOnOrAfterBaseline(expense.date, account)) continue;
        debitDelta -= parseNum(expense.amount);
    }

    for (const income of incomeRows) {
        const amount = parseNum(income.amount);
        if (income.category === 'Account transfer') {
            const fromAccount = getAccountByStoredName(income.fromPaymentMethod);
            const toAccount = getAccountByStoredName(income.paymentMethod);
            if (fromAccount?.id === account.id && isOnOrAfterBaseline(income.date, account)) {
                debitDelta -= amount;
            }
            if (toAccount?.id === account.id && isOnOrAfterBaseline(income.date, account)) {
                debitDelta += amount;
            }
            continue;
        }

        const incAccount = getAccountByStoredName(income.paymentMethod);
        if (!incAccount || incAccount.id !== account.id) continue;
        if (!isOnOrAfterBaseline(income.date, account)) continue;
        debitDelta += amount;
    }

    return account.initialBalance + debitDelta;
}

async function getLastInterestDate(
    paymentMethod: string,
    description: string
): Promise<string | null> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(incomes)
        .where(
            and(
                eq(incomes.category, 'Interest'),
                eq(incomes.paymentMethod, paymentMethod),
                eq(incomes.description, description)
            )
        )
        .orderBy(desc(incomes.date), desc(incomes.id))
        .limit(1);
    return rows[0]?.date ?? null;
}

export async function addInterestSchedule(fields: {
    paymentMethod: string;
    frequency: InterestFrequency;
    dayOfMonth?: number | null;
    annualRatePct?: number | null;
    fixedAmount?: number | null;
    currency?: string;
    description: string;
}): Promise<boolean> {
    validateScheduleFields(fields);
    const resolvedAccount = await resolveDebitPaymentAccount(fields.paymentMethod);
    const db = requireDb();
    await db.insert(interestSchedules).values({
        paymentMethod: resolvedAccount,
        frequency: fields.frequency,
        dayOfMonth: fields.frequency === 'monthly' ? fields.dayOfMonth! : null,
        annualRatePct:
            fields.annualRatePct != null ? String(fields.annualRatePct) : null,
        fixedAmount: fields.fixedAmount != null ? String(fields.fixedAmount) : null,
        currency: fields.currency || 'MYR',
        description: fields.description.trim(),
        active: true,
    });
    return true;
}

export async function getActiveInterestSchedules(): Promise<InterestScheduleRow[]> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(interestSchedules)
        .where(eq(interestSchedules.active, true));
    return rows.map(mapRow);
}

export async function updateInterestScheduleById(
    id: number,
    fields: {
        paymentMethod?: string;
        frequency?: InterestFrequency;
        dayOfMonth?: number | null;
        annualRatePct?: number | null;
        fixedAmount?: number | null;
        currency?: string;
        description?: string;
    }
): Promise<boolean> {
    const db = requireDb();
    const existing = await db
        .select()
        .from(interestSchedules)
        .where(and(eq(interestSchedules.id, id), eq(interestSchedules.active, true)))
        .limit(1);
    if (!existing[0]) return false;

    const merged = {
        frequency: fields.frequency ?? (existing[0].frequency as InterestFrequency),
        dayOfMonth:
            fields.dayOfMonth !== undefined ? fields.dayOfMonth : existing[0].dayOfMonth,
        annualRatePct:
            fields.annualRatePct !== undefined
                ? fields.annualRatePct
                : existing[0].annualRatePct != null
                  ? parseNum(existing[0].annualRatePct)
                  : null,
        fixedAmount:
            fields.fixedAmount !== undefined
                ? fields.fixedAmount
                : existing[0].fixedAmount != null
                  ? parseNum(existing[0].fixedAmount)
                  : null,
    };
    validateScheduleFields(merged);

    const set: Record<string, string | number | null> = {};
    if (fields.paymentMethod != null) {
        set.paymentMethod = await resolveDebitPaymentAccount(fields.paymentMethod);
    }
    if (fields.frequency != null) set.frequency = fields.frequency;
    if (fields.dayOfMonth !== undefined) set.dayOfMonth = fields.dayOfMonth;
    if (fields.annualRatePct !== undefined) {
        set.annualRatePct =
            fields.annualRatePct != null ? String(fields.annualRatePct) : null;
    }
    if (fields.fixedAmount !== undefined) {
        set.fixedAmount = fields.fixedAmount != null ? String(fields.fixedAmount) : null;
    }
    if (fields.currency != null) set.currency = fields.currency;
    if (fields.description != null) set.description = fields.description.trim();

    if (fields.frequency === 'daily') {
        set.dayOfMonth = null;
    }

    if (Object.keys(set).length === 0) return false;

    const result = await db
        .update(interestSchedules)
        .set(set)
        .where(and(eq(interestSchedules.id, id), eq(interestSchedules.active, true)));
    return (result.count ?? 0) > 0;
}

export async function deactivateInterestScheduleById(id: number): Promise<boolean> {
    const db = requireDb();
    const result = await db
        .update(interestSchedules)
        .set({ active: false })
        .where(and(eq(interestSchedules.id, id), eq(interestSchedules.active, true)));
    return (result.count ?? 0) > 0;
}

export async function deactivateInterestScheduleByDescription(
    searchDescription: string
): Promise<boolean | 'not_found'> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(interestSchedules)
        .where(eq(interestSchedules.active, true));
    const match = rows.find((r) =>
        r.description.toLowerCase().includes(searchDescription.toLowerCase())
    );
    if (!match) return 'not_found';
    await db
        .update(interestSchedules)
        .set({ active: false })
        .where(eq(interestSchedules.id, match.id));
    return true;
}

export async function getInterestSchedulesForToday(): Promise<InterestScheduleRow[]> {
    const today = todayInKL();
    const todayDay = today.getDate();
    const rows = await getActiveInterestSchedules();
    return rows.filter((row) => {
        if (row.frequency === 'daily') return true;
        return row.dayOfMonth === todayDay;
    });
}

export async function computeInterestAmount(
    schedule: InterestScheduleRow,
    accrualDate: string
): Promise<number | null> {
    if (schedule.fixedAmount != null && schedule.fixedAmount > 0) {
        return roundMoney(schedule.fixedAmount);
    }

    if (schedule.annualRatePct == null || schedule.annualRatePct <= 0) {
        return null;
    }

    const balanceDate = subtractDays(accrualDate, 1);
    const balance = await getAccountBalanceAsOf(schedule.paymentMethod, balanceDate);
    if (balance <= 0) return null;

    let days: number;
    if (schedule.frequency === 'daily') {
        days = 1;
    } else {
        const lastDate = await getLastInterestDate(
            schedule.paymentMethod,
            schedule.description
        );
        const fromDate = lastDate ?? monthStartDate(accrualDate);
        days = Math.max(1, daysBetween(fromDate, accrualDate));
    }

    const amount = roundMoney(
        (balance * schedule.annualRatePct * days) / (100 * 365)
    );
    return amount > 0 ? amount : null;
}

export async function accrueInterestForSchedule(
    schedule: InterestScheduleRow,
    date?: string
): Promise<{ incomeId: number; amount: number } | null> {
    const accrualDate = formatDateForDb(date);
    const db = requireDb();

    const existing = await db
        .select()
        .from(incomes)
        .where(
            and(
                eq(incomes.category, 'Interest'),
                eq(incomes.date, accrualDate),
                eq(incomes.paymentMethod, schedule.paymentMethod),
                eq(incomes.description, schedule.description)
            )
        )
        .limit(1);
    if (existing[0]) {
        return {
            incomeId: existing[0].id,
            amount: parseNum(existing[0].amount),
        };
    }

    const amount = await computeInterestAmount(schedule, accrualDate);
    if (amount == null || amount <= 0) return null;

    const incomeId = await appendIncome(
        accrualDate,
        amount,
        schedule.currency,
        'Interest',
        schedule.description,
        undefined,
        undefined,
        schedule.paymentMethod
    );

    return { incomeId, amount };
}

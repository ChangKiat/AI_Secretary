import { and, eq, inArray } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { expenses, investmentEvents, investmentInstruments } from '../db/schema';
import { resolveCategory } from '../config/expenseCategories';
import { resolvePaymentMethod, setPaymentAccountsCache } from '../config/paymentMethods';
import {
    getActiveFixedExpenses,
    isBillContributionBuy,
    isFixedContributionRecorded,
    type BillContributionBuy,
} from './expenseService';
import { dueDateInMonth, isFrequencyDue, lastDayOfMonth } from './fixedSchedule';
import { upsertInvestmentFundingTransfer, validateIncomePaymentAccounts } from './incomeService';
import { getInstrumentById, recordFundInvest } from './investmentPortfolioService';
import { getPaymentAccountById, type PaymentAccount } from './paymentAccountService';

export { dueDateInMonth };

const TIMEZONE = 'Asia/Kuala_Lumpur';

function todayInKL(): Date {
    return new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
}

function roundMoney(n: number): number {
    return Math.round(n * 100) / 100;
}

export async function resolveContributionHolding(
    instrumentId: number
): Promise<{ instrumentId: number; parentName: string } | { error: string }> {
    const instrument = await getInstrumentById(instrumentId);
    if (!instrument || !instrument.active) return { error: 'Holding not found' };
    if (instrument.kind !== 'fund') {
        return { error: 'Recurring contributions are only for unit trusts' };
    }
    const account = await getPaymentAccountById(instrument.paymentAccountId);
    if (!account || !account.active) return { error: 'Investment account not found' };
    if (account.accountType !== 'investment') {
        return { error: 'Holding must belong to an investment account' };
    }
    return { instrumentId: instrument.id, parentName: account.name };
}

/**
 * The expense the 9am fixed-bill job (Dashboard server/dailyJobs.ts) already logged for this bill,
 * when no holding buy has claimed it yet.
 */
async function findUnclaimedBillExpense(
    date: string,
    category: string,
    description: string,
    amount: number
): Promise<number | null> {
    const db = requireDb();
    const rows = await db
        .select({
            id: expenses.id,
            amount: expenses.amount,
            buyEventId: investmentEvents.id,
        })
        .from(expenses)
        .leftJoin(investmentEvents, eq(investmentEvents.linkedExpenseId, expenses.id))
        .where(
            and(
                eq(expenses.date, date),
                eq(expenses.category, category),
                eq(expenses.description, description)
            )
        );
    const target = roundMoney(amount);
    const match = rows.find(
        (row) => row.buyEventId == null && roundMoney(parseFloat(row.amount)) === target
    );
    return match?.id ?? null;
}

/**
 * The bill's from / to accounts as active account names, checked before anything is written.
 * A bill whose account was renamed or deactivated throws "Unknown payment account: …", and
 * from = to throws the transfer error, so its contribution fails cleanly instead of half-writing.
 */
function resolveContributionAccounts(row: {
    paymentMethod: string | null;
    toInvestmentAccount: string | null;
}): { from: string | null; to: string | null } {
    const resolve = (value: string | null): string | null => {
        const trimmed = value?.trim();
        if (!trimmed) return null;
        const resolved = resolvePaymentMethod(trimmed);
        if (!resolved) throw new Error(`Unknown payment account: ${trimmed}`);
        return resolved;
    };
    const from = resolve(row.paymentMethod);
    const to = resolve(row.toInvestmentAccount);
    if (from && to) {
        const transferError = validateIncomePaymentAccounts('Account transfer', to, from);
        if (transferError) throw new Error(transferError);
    }
    return { from, to };
}

export async function contributeFixedExpense(
    id: number,
    date?: string
): Promise<{ ok: true; skipped: boolean }> {
    const row = (await getActiveFixedExpenses()).find((entry) => entry.id === id);
    if (!row) throw new Error('Fixed expense not found');
    if (resolveCategory(row.category).toLowerCase() !== 'investment') {
        throw new Error('Only Investment bills can contribute to a holding');
    }
    if (row.instrumentId == null) {
        throw new Error('Select a unit trust holding for this bill');
    }
    const resolved = await resolveContributionHolding(row.instrumentId);
    if ('error' in resolved) throw new Error(resolved.error);

    const today = todayInKL();
    const contribDate =
        date ?? dueDateInMonth(row.dayOfMonth, today.getFullYear(), today.getMonth() + 1);

    // Same check as the cron (see isBillContributionBuy), so the two apps agree.
    const recorded = await isFixedContributionRecorded({
        instrumentId: resolved.instrumentId,
        date: contribDate,
        amount: row.amount,
        category: row.category,
        description: row.description,
    });
    if (recorded) {
        return { ok: true, skipped: true };
    }
    const accounts = resolveContributionAccounts(row);

    const loggedExpenseId = await findUnclaimedBillExpense(
        contribDate,
        row.category,
        row.description,
        row.amount
    );

    // The expense, the buy, the principal update and the funding transfer commit together, so a
    // failure leaves nothing half-written that the next run would skip as already contributed.
    await requireDb().transaction(async (tx) => {
        const { linkedExpenseId } = await recordFundInvest(
            {
                instrumentId: resolved.instrumentId,
                date: contribDate,
                amount: row.amount,
                notes: row.description,
                fromPaymentMethod: accounts.from,
                linkedExpenseId: loggedExpenseId,
            },
            tx
        );
        if (accounts.from && accounts.to) {
            // The bill's configured transfer, same as the cron logs, whichever path ran first.
            await upsertInvestmentFundingTransfer(
                {
                    expenseId: linkedExpenseId,
                    date: contribDate,
                    amount: row.amount,
                    description: row.description,
                    fromPaymentMethod: accounts.from,
                    toInvestmentAccount: accounts.to,
                },
                tx
            );
        }
    });
    return { ok: true, skipped: false };
}

export type FailedContribution = { id: number; error: string };

/**
 * Contributes every holding-linked bill that is due by today this month. Each bill is tried on
 * its own: one that throws (rolled back) is listed in `failed` and the run carries on.
 */
export async function contributeDueFixedExpenses(): Promise<{
    applied: number;
    skipped: number;
    failed: FailedContribution[];
}> {
    const today = todayInKL();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;
    const todayDay = today.getDate();
    const rows = await getActiveFixedExpenses();
    let applied = 0;
    let skipped = 0;
    const failed: FailedContribution[] = [];

    for (const row of rows) {
        if (row.instrumentId == null) continue;
        if (resolveCategory(row.category).toLowerCase() !== 'investment') continue;
        if (!isFrequencyDue(row.startMonth, row.frequencyMonths, month)) continue;
        const dueDay = Math.min(row.dayOfMonth, lastDayOfMonth(year, month));
        if (todayDay < dueDay) continue;

        try {
            const result = await contributeFixedExpense(
                row.id,
                dueDateInMonth(row.dayOfMonth, year, month)
            );
            if (result.skipped) skipped += 1;
            else applied += 1;
        } catch (err) {
            failed.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
        }
    }
    return { applied, skipped, failed };
}

export async function attachHoldingContributionStatus<
    T extends {
        instrumentId: number | null;
        amount: number;
        dayOfMonth: number;
        category: string;
        description: string;
    },
>(entries: T[]): Promise<(T & { instrumentName: string | null; contributedThisMonth: boolean })[]> {
    const today = todayInKL();
    const year = today.getFullYear();
    const month = today.getMonth() + 1;
    const withIds = entries.filter((entry) => entry.instrumentId != null);
    const ids = [...new Set(withIds.map((entry) => entry.instrumentId!))];
    const nameById = new Map<number, string>();
    const buysByKey = new Map<string, BillContributionBuy[]>();

    if (ids.length > 0) {
        const db = requireDb();
        const instruments = await db
            .select({ id: investmentInstruments.id, name: investmentInstruments.name })
            .from(investmentInstruments)
            .where(inArray(investmentInstruments.id, ids));
        for (const row of instruments) {
            nameById.set(row.id, row.name);
        }

        const dates = [
            ...new Set(withIds.map((entry) => dueDateInMonth(entry.dayOfMonth, year, month))),
        ];
        const events = await db
            .select({
                instrumentId: investmentEvents.instrumentId,
                date: investmentEvents.date,
                amount: investmentEvents.amount,
                linkedExpenseId: investmentEvents.linkedExpenseId,
                expenseCategory: expenses.category,
                expenseDescription: expenses.description,
            })
            .from(investmentEvents)
            .leftJoin(expenses, eq(expenses.id, investmentEvents.linkedExpenseId))
            .where(
                and(
                    inArray(investmentEvents.instrumentId, ids),
                    eq(investmentEvents.eventType, 'buy'),
                    inArray(investmentEvents.date, dates)
                )
            );
        for (const event of events) {
            const key = `${event.instrumentId}:${event.date}`;
            const buys = buysByKey.get(key);
            if (buys) buys.push(event);
            else buysByKey.set(key, [event]);
        }
    }

    return entries.map((entry) => {
        const dueDate = dueDateInMonth(entry.dayOfMonth, year, month);
        // Same rule as contributeFixedExpense and the cron (isFixedContributionRecorded).
        const contributedThisMonth =
            entry.instrumentId != null &&
            (buysByKey.get(`${entry.instrumentId}:${dueDate}`) ?? []).some((buy) =>
                isBillContributionBuy(buy, entry)
            );
        return {
            ...entry,
            instrumentName:
                entry.instrumentId != null ? nameById.get(entry.instrumentId) ?? null : null,
            contributedThisMonth,
        };
    });
}

// ponytail self-check: pure, no DB queries (seeds the in-memory payment-account cache only)
if (require.main === module) {
    const check = (ok: boolean, label: string) => {
        if (!ok) throw new Error(`fixedContributionService self-check failed: ${label}`);
    };
    const expectError = (fn: () => unknown, message: string) => {
        try {
            fn();
        } catch (err) {
            if (err instanceof Error && err.message === message) return;
            throw new Error(`expected "${message}", got ${err}`);
        }
        throw new Error(`expected "${message}", got no error`);
    };

    // 2.13: a buy paid by this bill's expense counts whatever its amount (bill edited after the
    // buy); any other buy counts only at the bill's amount.
    const bill = (amount: number, description: string) => ({
        amount,
        category: 'Investment',
        description,
    });
    const buy = (
        amount: string,
        linkedExpenseId: number | null,
        expenseDescription: string | null = null,
        expenseCategory: string | null = expenseDescription != null ? 'Investment' : null
    ): BillContributionBuy => ({ amount, linkedExpenseId, expenseCategory, expenseDescription });
    const growth = bill(500, 'PM Growth');
    const growthBuy = buy('500.00', 7, 'PM Growth');
    check(isBillContributionBuy(growthBuy, bill(650, 'PM Growth')), 'linked buy, edited amount');
    check(isBillContributionBuy(growthBuy, bill(650, ' pm growth ')), 'description trimmed, any case');
    check(!isBillContributionBuy(buy('500.00', 7, 'PM Growth', 'Other'), bill(650, 'PM Growth')), 'other category');
    check(isBillContributionBuy(buy('500.00', null), growth), 'unlinked buy, same amount');
    check(!isBillContributionBuy(buy('500.00', null), bill(650, 'PM Growth')), 'unlinked buy, other amount');
    check(isBillContributionBuy(buy('0.30', null), bill(0.1 + 0.2, 'PM Growth')), 'amount compared in cents');
    // Two bills on one holding and day: one bill's buy does not hide the other.
    const bond = bill(300, 'PM Bond');
    check(isBillContributionBuy(growthBuy, growth), 'two bills: growth contributed');
    check(!isBillContributionBuy(growthBuy, bond), 'two bills: growth buy does not hide bond');
    check(isBillContributionBuy(buy('300.00', 8, 'PM Bond'), bond), 'two bills: bond contributed');
    // A one-off Invest top-up on the due date (its own linked expense) does not hide the bill,
    // unless it is for exactly the bill's amount (the amount rule, as before 2.13).
    check(!isBillContributionBuy(buy('1000.00', 9, 'Invest Public Mutual Growth'), growth), 'manual top-up');
    check(isBillContributionBuy(buy('500.00', 9, 'Invest Public Mutual Growth'), growth), 'top-up at bill amount');

    // 2.21: the bill's accounts are checked before anything is written.
    const account = (
        id: number,
        name: string,
        accountType: PaymentAccount['accountType'] = 'account',
        active = true
    ): PaymentAccount => ({
        id,
        name,
        accountType,
        initialBalance: 0,
        balanceBaselineDate: '2020-01-01',
        creditLimit: null,
        statementDay: null,
        rebateConfig: null,
        active,
    });
    setPaymentAccountsCache([
        account(1, 'Maybank Savings'),
        account(2, 'Public Mutual', 'investment'),
        account(3, 'Maybank', 'account', false),
    ]);
    const both = resolveContributionAccounts({
        paymentMethod: ' maybank savings ',
        toInvestmentAccount: 'Public Mutual',
    });
    check(both.from === 'Maybank Savings' && both.to === 'Public Mutual', 'resolved account names');
    const noFrom = resolveContributionAccounts({ paymentMethod: null, toInvestmentAccount: 'Public Mutual' });
    check(noFrom.from === null && noFrom.to === 'Public Mutual', 'no from-account means no transfer');
    expectError(
        () => resolveContributionAccounts({ paymentMethod: 'Maybank', toInvestmentAccount: 'Public Mutual' }),
        'Unknown payment account: Maybank'
    );
    expectError(
        () => resolveContributionAccounts({ paymentMethod: 'Maybank Savings', toInvestmentAccount: 'StashAway Retired' }),
        'Unknown payment account: StashAway Retired'
    );
    expectError(
        () => resolveContributionAccounts({ paymentMethod: 'Public Mutual', toInvestmentAccount: 'public mutual' }),
        'From and to accounts must be different'
    );

    console.log('fixedContributionService self-check ok');
}

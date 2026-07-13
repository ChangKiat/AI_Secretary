import { and, asc, eq } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { paymentAccounts } from '../db/schema';

export type PaymentAccountType = 'account' | 'credit' | 'investment';

export interface PaymentAccount {
    id: number;
    name: string;
    accountType: PaymentAccountType;
    initialBalance: number;
    balanceBaselineDate: string;
    creditLimit: number | null;
    active: boolean;
}

/** Default seed — keep in sync with scripts/init-db.sql */
export const DEFAULT_PAYMENT_ACCOUNTS: { name: string; accountType: PaymentAccountType }[] = [
    { name: 'TnG', accountType: 'account' },
    { name: 'CIMB', accountType: 'account' },
    { name: 'GrabPay', accountType: 'account' },
    { name: 'ShopeePay', accountType: 'account' },
    { name: 'Cash', accountType: 'account' },
    { name: 'Maybank', accountType: 'account' },
    { name: 'Public Bank', accountType: 'account' },
    { name: 'UOB', accountType: 'account' },
    { name: 'Credit Card', accountType: 'credit' },
];

function parseAmount(value: string | null | undefined): number {
    if (value == null) return 0;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

function todayDateString(): string {
    return new Date().toISOString().slice(0, 10);
}

function mapAccountType(value: string): PaymentAccountType {
    if (value === 'credit') return 'credit';
    if (value === 'investment') return 'investment';
    return 'account';
}

function mapRow(row: typeof paymentAccounts.$inferSelect): PaymentAccount {
    return {
        id: row.id,
        name: row.name,
        accountType: mapAccountType(row.accountType),
        initialBalance: parseAmount(row.initialBalance),
        balanceBaselineDate: row.balanceBaselineDate,
        creditLimit: row.creditLimit != null ? parseAmount(row.creditLimit) : null,
        active: row.active,
    };
}

export function normalizePaymentAccountName(name: string): string {
    return name.trim();
}

export function isValidPaymentAccountType(value: string): value is PaymentAccountType {
    return value === 'account' || value === 'credit' || value === 'investment';
}

export function isDebitBalanceType(accountType: PaymentAccountType): boolean {
    return accountType === 'account' || accountType === 'investment';
}

async function ensureDefaultPaymentAccounts(): Promise<void> {
    const db = requireDb();
    const rows = await db.select().from(paymentAccounts).limit(1);
    if (rows.length > 0) return;
    
    await db.insert(paymentAccounts).values(
        DEFAULT_PAYMENT_ACCOUNTS.map((account) => ({
            name: account.name,
            accountType: account.accountType,
            active: true,
            initialBalance: '0',
            balanceBaselineDate: todayDateString(),
            creditLimit: account.accountType === 'credit' ? '0' : null,
        }))
    );
}

export async function listActivePaymentAccounts(): Promise<PaymentAccount[]> {
    const db = requireDb();
    await ensureDefaultPaymentAccounts();
    const rows = await db
        .select()
        .from(paymentAccounts)
        .where(eq(paymentAccounts.active, true))
        .orderBy(asc(paymentAccounts.name));

    return rows.map(mapRow);
}

export async function getPaymentAccountById(id: number): Promise<PaymentAccount | null> {
    const db = requireDb();
    const rows = await db.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)).limit(1);
    return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function createPaymentAccount(
    name: string,
    accountType: PaymentAccountType,
    fields?: { initialBalance?: number; creditLimit?: number | null }
): Promise<number> {
    const db = requireDb();
    const normalized = normalizePaymentAccountName(name);
    if (!normalized) throw new Error('Account name is required');
    const initialBalance =
        accountType === 'credit' ? '0' : String(fields?.initialBalance ?? 0);
    const creditLimit =
        accountType === 'credit'
            ? String(fields?.creditLimit ?? 0)
            : null;
    const balanceBaselineDate = todayDateString();

    const [row] = await db
        .insert(paymentAccounts)
        .values({
            name: normalized,
            accountType,
            active: true,
            initialBalance,
            balanceBaselineDate,
            creditLimit,
        })
        .returning({ id: paymentAccounts.id });

    return row.id;
}

export async function updatePaymentAccount(
    id: number,
    fields: {
        name?: string;
        accountType?: PaymentAccountType;
        initialBalance?: number;
        creditLimit?: number | null;
        active?: boolean;
    }
): Promise<boolean> {
    const db = requireDb();
    const set: Record<string, string | boolean | null> = {};

    if (fields.name != null) {
        const normalized = normalizePaymentAccountName(fields.name);
        if (!normalized) throw new Error('Account name is required');
        set.name = normalized;
    }

    if (fields.accountType != null) {
        set.accountType = fields.accountType;

        if (fields.accountType === 'credit') {
            set.initialBalance = '0';
            set.balanceBaselineDate = todayDateString();
        } else if (fields.creditLimit === undefined) {
            set.creditLimit = null;
        }
    }

    if (fields.initialBalance != null) {
        set.initialBalance = String(fields.initialBalance);
        set.balanceBaselineDate = todayDateString();
    }

    if (fields.creditLimit !== undefined) {
        set.creditLimit = fields.creditLimit == null ? null : String(fields.creditLimit);
    }

    if (fields.active != null) set.active = fields.active;

    if (Object.keys(set).length === 0) return false;

    const result = await db
        .update(paymentAccounts)
        .set(set)
        .where(eq(paymentAccounts.id, id));

    return (result.count ?? 0) > 0;
}

export async function deactivatePaymentAccount(id: number): Promise<boolean> {
    const db = requireDb();
    const result = await db
        .update(paymentAccounts)
        .set({ active: false })
        .where(and(eq(paymentAccounts.id, id), eq(paymentAccounts.active, true)));

    return (result.count ?? 0) > 0;
}

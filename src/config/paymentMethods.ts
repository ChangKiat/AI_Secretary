import {
    listActivePaymentAccounts,
    type PaymentAccount,
} from '../services/paymentAccountService';

/** Maps common nicknames → canonical account name (resolved via nameByLower when present). */
const ALIAS_MAP: Record<string, string> = {
    tng: 'TnG',
    'touch n go': 'TnG',
    'touch and go': 'TnG',
    'touch & go': 'TnG',
    'touch-n-go': 'TnG',
    touchngo: 'TnG',
};

let cachedAccounts: PaymentAccount[] = [];
let nameByLower = new Map<string, string>();
let paymentMethodDescription = '';
let expensePaymentMethodDescription = '';

function namesForDescription(accounts: PaymentAccount[]): string {
    return accounts.map((a) => a.name).join(', ');
}

function applyCache(accounts: PaymentAccount[]): PaymentAccount[] {
    cachedAccounts = accounts;
    nameByLower = new Map(accounts.map((account) => [account.name.toLowerCase(), account.name]));
    const spendable = accounts.filter((a) => a.accountType !== 'investment');
    paymentMethodDescription =
        accounts.length > 0
            ? `Optional. Use one of: ${namesForDescription(accounts)}. Omit if unknown.`
            : 'Optional. Configure payment accounts in the dashboard Income tab. Omit if unknown.';
    expensePaymentMethodDescription =
        spendable.length > 0
            ? `Optional. Use one of: ${namesForDescription(spendable)}. Omit if unknown. Do not use investment accounts for expenses.`
            : 'Optional. Configure payment accounts in the dashboard Income tab. Omit if unknown.';
    return cachedAccounts;
}

/** Seed cache for self-check (ponytail: no test framework). */
export function setPaymentAccountsCache(accounts: PaymentAccount[]): void {
    applyCache(accounts);
}

export async function loadPaymentAccounts(): Promise<PaymentAccount[]> {
    const accounts = await listActivePaymentAccounts();
    return applyCache(accounts);
}

export function getPaymentAccounts(): PaymentAccount[] {
    return cachedAccounts;
}

export function getPaymentAccountNames(): string[] {
    return cachedAccounts.map((account) => account.name);
}

/** Names suitable for expense payment methods (excludes investment). */
export function getExpensePaymentAccountNames(): string[] {
    return cachedAccounts
        .filter((account) => account.accountType !== 'investment')
        .map((account) => account.name);
}

export function resolvePaymentMethod(input?: string | null): string | null {
    if (input == null) return null;
    const trimmed = input.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase().replace(/\s+/g, ' ');
    if (nameByLower.has(lower)) return nameByLower.get(lower)!;

    const alias = ALIAS_MAP[lower];
    if (alias) return nameByLower.get(alias.toLowerCase()) ?? alias;

    return trimmed;
}

export function paymentMethodsMatch(
    stored: string | null | undefined,
    filter: string
): boolean {
    const resolvedFilter = resolvePaymentMethod(filter);
    if (!resolvedFilter) return true;
    if (!stored) return false;
    return resolvePaymentMethod(stored) === resolvedFilter;
}

/** Full list including investment (income / transfers). */
export function getPaymentMethodDescription(): string {
    return paymentMethodDescription || 'Optional payment account name. Omit if unknown.';
}

/** Expense-facing list without investment accounts. */
export function getExpensePaymentMethodDescription(): string {
    return (
        expensePaymentMethodDescription ||
        'Optional payment account name. Omit if unknown. Do not use investment accounts for expenses.'
    );
}

export function paymentMethodBucket(stored: string | null | undefined): string {
    return stored ? resolvePaymentMethod(stored) ?? stored : '(none)';
}

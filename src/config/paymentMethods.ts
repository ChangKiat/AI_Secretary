import {
    listActivePaymentAccounts,
    type PaymentAccount,
} from '../services/paymentAccountService';

let cachedAccounts: PaymentAccount[] = [];
let nameByLower = new Map<string, string>();
let paymentMethodDescription = '';

function applyCache(accounts: PaymentAccount[]): PaymentAccount[] {
    cachedAccounts = accounts;
    nameByLower = new Map(accounts.map((account) => [account.name.toLowerCase(), account.name]));
    paymentMethodDescription =
        accounts.length > 0
            ? `Optional. Use one of: ${accounts.map((a) => a.name).join(', ')}. Omit if unknown.`
            : 'Optional. Configure payment accounts in the dashboard Income tab. Omit if unknown.';
    return cachedAccounts;
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

export function resolvePaymentMethod(input?: string | null): string | null {
    if (input == null) return null;
    const trimmed = input.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    if (nameByLower.has(lower)) return nameByLower.get(lower)!;

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

export function getPaymentMethodDescription(): string {
    return paymentMethodDescription || 'Optional payment account name. Omit if unknown.';
}

export function paymentMethodBucket(stored: string | null | undefined): string {
    return stored ? resolvePaymentMethod(stored) ?? stored : '(none)';
}

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
    'hlb infinite': 'HongLeong Infinite',
    infinite: 'HongLeong Infinite',
    'hlb if': 'HongLeong Infinite',
    'hlb gsc': 'HongLeong Platinum',
    'shell card': 'RHB Shell Card',
    'rhb shell': 'RHB Shell Card',
    'world card': 'RHB World Card',
    'rhb world': 'RHB World Card',
};

const NOISE_TOKENS = new Set(['a', 'an', 'the', 'my', 'via', 'with', 'from', 'on', 'using']);

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

function tokenize(lower: string): string[] {
    return lower
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t));
}

/** Every input token must appear as a whole account token or as a prefix of one. */
function accountMatchesTokens(accountLower: string, inputTokens: string[]): boolean {
    const accountTokens = tokenize(accountLower);
    return inputTokens.every((t) =>
        accountTokens.some((at) => at === t || at.startsWith(t))
    );
}

/**
 * Fuzzy match nicknames to existing accounts only (e.g. "shell" → "RHB Shell Card").
 * Score: inputTokenCount * 100 - accountTokenCount; tie → lexicographically first name.
 */
export function fuzzyMatchPaymentAccount(lower: string): string | null {
    const inputTokens = tokenize(lower);
    if (inputTokens.length === 0 || nameByLower.size === 0) return null;

    let bestName: string | null = null;
    let bestScore = -Infinity;

    const entries = [...nameByLower.entries()].sort((a, b) => a[1].localeCompare(b[1]));
    for (const [accountLower, canonical] of entries) {
        if (!accountMatchesTokens(accountLower, inputTokens)) continue;
        const accountTokenCount = tokenize(accountLower).length;
        const score = inputTokens.length * 100 - accountTokenCount;
        if (score > bestScore) {
            bestScore = score;
            bestName = canonical;
        }
    }
    return bestName;
}

export function resolvePaymentMethod(input?: string | null): string | null {
    if (input == null) return null;
    const trimmed = input.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase().replace(/\s+/g, ' ');
    if (nameByLower.has(lower)) return nameByLower.get(lower)!;

    const alias = ALIAS_MAP[lower];
    if (alias) {
        const fromAlias = nameByLower.get(alias.toLowerCase());
        if (fromAlias) return fromAlias;
    }

    return fuzzyMatchPaymentAccount(lower);
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

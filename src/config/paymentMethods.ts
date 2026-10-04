import {
    listAllPaymentAccounts,
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
/** Active accounts only. */
let nameByLower = new Map<string, string>();
/** Deactivated accounts (minus any name an active account also uses). */
let inactiveNameByLower = new Map<string, string>();
let paymentMethodDescription = '';
let expensePaymentMethodDescription = '';
export interface PaymentSignalTerms {
    /** Every account name, active and deactivated. */
    accountNames: readonly string[];
    /** The nicknames resolvePaymentMethod understands ("tng", "world card"). */
    nicknames: readonly string[];
}
/** Replaced (a new object) on each cache load. */
let paymentSignalTerms: PaymentSignalTerms = { accountNames: [], nicknames: Object.keys(ALIAS_MAP) };

function namesForDescription(accounts: PaymentAccount[]): string {
    return accounts.map((a) => a.name).join(', ');
}

/** Takes active and inactive accounts; caches and returns the active ones. */
function applyCache(allAccounts: PaymentAccount[]): PaymentAccount[] {
    const accounts = allAccounts.filter((account) => account.active);
    cachedAccounts = accounts;
    nameByLower = new Map(accounts.map((account) => [account.name.toLowerCase(), account.name]));
    inactiveNameByLower = new Map(
        allAccounts
            .filter((account) => !account.active && !nameByLower.has(account.name.toLowerCase()))
            .map((account) => [account.name.toLowerCase(), account.name])
    );
    paymentSignalTerms = {
        accountNames: allAccounts.map((account) => account.name),
        nicknames: Object.keys(ALIAS_MAP),
    };
    const spendable = accounts.filter((a) => a.accountType !== 'investment');
    paymentMethodDescription =
        accounts.length > 0
            ? `Optional. Use one of: ${namesForDescription(accounts)}. Omit if unknown.`
            : 'Optional. Configure payment accounts in the Dashboard Setup tab. Omit if unknown.';
    expensePaymentMethodDescription =
        spendable.length > 0
            ? `Optional. Use one of: ${namesForDescription(spendable)}. Omit if unknown. Do not use investment accounts for expenses.`
            : 'Optional. Configure payment accounts in the Dashboard Setup tab. Omit if unknown.';
    return cachedAccounts;
}

/**
 * Seed cache for self-check (ponytail: no test framework).
 * Accounts with `active: false` never resolve; they only block exact/alias hits on their name.
 */
export function setPaymentAccountsCache(accounts: PaymentAccount[]): void {
    applyCache(accounts);
}

/** Loads every account; returns the active ones (inactive names are cached for the resolver guard). */
export async function loadPaymentAccounts(): Promise<PaymentAccount[]> {
    const accounts = await listAllPaymentAccounts();
    return applyCache(accounts);
}

function tokenize(lower: string): string[] {
    return lower
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t));
}

/**
 * Every input token must equal an account token, or be a prefix of one when it has 3+ characters
 * (so "r" matches nothing, "plat" matches "Platinum").
 */
function accountMatchesTokens(accountLower: string, inputTokens: string[]): boolean {
    const accountTokens = tokenize(accountLower);
    return inputTokens.every((t) =>
        accountTokens.some((at) => at === t || (t.length >= 3 && at.startsWith(t)))
    );
}

/** Active accounts whose tokens cover every input token, sorted by name. */
function fuzzyCandidates(lower: string): string[] {
    const inputTokens = tokenize(lower);
    if (inputTokens.length === 0 || nameByLower.size === 0) return [];
    return [...nameByLower.entries()]
        .filter(([accountLower]) => accountMatchesTokens(accountLower, inputTokens))
        .map(([, canonical]) => canonical)
        .sort((a, b) => a.localeCompare(b));
}

/**
 * Fuzzy match nicknames to active accounts only (e.g. "shell" → "RHB Shell Card").
 * Returns a name only when exactly one active account matches; ambiguous input
 * ("rhb", "card") or unknown input → null.
 */
export function fuzzyMatchPaymentAccount(lower: string): string | null {
    const matches = fuzzyCandidates(lower);
    return matches.length === 1 ? matches[0] : null;
}

export type PaymentMethodMatch = 'exact' | 'alias' | 'fuzzy' | 'inactive' | 'ambiguous' | 'unknown';

export interface PaymentMethodResolution {
    /** Active account name, or null when the input does not resolve. */
    name: string | null;
    match: PaymentMethodMatch;
    /** 'inactive': the deactivated account that was hit. 'ambiguous': the active accounts that matched. */
    candidates?: string[];
}

/**
 * resolvePaymentMethod with the reason. Order: active exact name → inactive exact name (null) →
 * alias (null when its target is inactive) → unique fuzzy match over active accounts.
 */
export function resolvePaymentMethodMatch(input?: string | null): PaymentMethodResolution {
    const trimmed = input?.trim();
    if (!trimmed) return { name: null, match: 'unknown' };

    const lower = trimmed.toLowerCase().replace(/\s+/g, ' ');
    const exact = nameByLower.get(lower);
    if (exact) return { name: exact, match: 'exact' };
    const inactive = inactiveNameByLower.get(lower);
    if (inactive) return { name: null, match: 'inactive', candidates: [inactive] };

    const alias = ALIAS_MAP[lower];
    if (alias) {
        const aliasLower = alias.toLowerCase();
        const fromAlias = nameByLower.get(aliasLower);
        if (fromAlias) return { name: fromAlias, match: 'alias' };
        const inactiveAlias = inactiveNameByLower.get(aliasLower);
        if (inactiveAlias) return { name: null, match: 'inactive', candidates: [inactiveAlias] };
    }

    const matches = fuzzyCandidates(lower);
    if (matches.length === 1) return { name: matches[0], match: 'fuzzy' };
    if (matches.length > 1) return { name: null, match: 'ambiguous', candidates: matches };
    return { name: null, match: 'unknown' };
}

/** Active account name for the input, or null (unknown, ambiguous or deactivated). */
export function resolvePaymentMethod(input?: string | null): string | null {
    return resolvePaymentMethodMatch(input).name;
}

/** Stored value for display: the active account name when it resolves, otherwise the raw text. */
export function displayPaymentMethod(stored?: string | null): string | null {
    const t = stored?.trim();
    if (!t) return null;
    return resolvePaymentMethod(t) ?? t;
}

/**
 * Empty filter matches everything. Otherwise both sides are resolved (falling back to their raw
 * text) and compared case-insensitively, so an unknown filter matches only rows stored with that text.
 */
export function paymentMethodsMatch(stored: string | null | undefined, filter: string): boolean {
    if (!filter?.trim()) return true;
    const f = resolvePaymentMethod(filter) ?? filter.trim();
    if (!stored?.trim()) return false;
    const s = resolvePaymentMethod(stored) ?? stored.trim();
    return s.toLowerCase() === f.toLowerCase();
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

/** Active account names, sorted (income, transfers, summary filters): the "known" list for an unmatched name. */
export function getPaymentAccountNames(): string[] {
    return cachedAccounts.map((a) => a.name).sort((a, b) => a.localeCompare(b));
}

/**
 * Every account name (active or deactivated) and nickname: the bot's router builds its "names a
 * payment account" signal from these. The same object comes back until the next cache load.
 */
export function getPaymentSignalTerms(): PaymentSignalTerms {
    return paymentSignalTerms;
}

/** Active non-investment account names, sorted: what an expense can be paid from. */
export function getExpensePaymentAccountNames(): string[] {
    return cachedAccounts
        .filter((a) => a.accountType !== 'investment')
        .map((a) => a.name)
        .sort((a, b) => a.localeCompare(b));
}

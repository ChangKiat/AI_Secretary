import {
    getExpensePaymentMethodDescription,
    getPaymentMethodDescription,
    loadPaymentAccounts,
    resolvePaymentMethodMatch,
    setPaymentAccountsCache,
    type PaymentMethodResolution,
} from './paymentMethods';
import { getExpenseCategoryNames, loadExpenseCategories } from './expenseCategories';
import type { PaymentAccount } from '../services/paymentAccountService';

/**
 * Payment accounts and expense categories are edited on the Dashboard while the bot runs.
 * refreshFinanceCaches() reloads them at most this often (it runs on every incoming update), so
 * a card added on the Dashboard resolves without a restart.
 */
export const FINANCE_CACHE_TTL_MS = 60_000;

/**
 * A forced reload (an account name that did not resolve) still waits this long after the last
 * load, so a bulk log with several unknown names costs one reload, not one per row.
 */
const FORCED_RELOAD_MIN_INTERVAL_MS = 5_000;

type FinanceNamesListener = () => void;

const listeners = new Set<FinanceNamesListener>();
let lastAttemptAt = 0;
let inFlight: Promise<boolean> | null = null;
/** Signature of the names the current Gemini models were built from; set by the first refresh. */
let builtSignature: string | undefined;

/**
 * allSettled, not all: a failed loader leaves its own cache untouched (neither loader applies a
 * partial result), and the other loader's result is still kept and compared.
 */
let loadAll = (): Promise<PromiseSettledResult<unknown>[]> =>
    Promise.allSettled([loadPaymentAccounts(), loadExpenseCategories()]);

/**
 * Everything Gemini sees from these caches: the full and spendable account lists (tool
 * parameter descriptions) and the category names (descriptions and domain prompts).
 */
function namesSignature(): string {
    return JSON.stringify([
        getPaymentMethodDescription(),
        getExpensePaymentMethodDescription(),
        getExpenseCategoryNames(),
    ]);
}

/**
 * Compares the cached names with the ones the models were built from and runs the listeners on
 * a change. Comparing against the built names (not the pre-load cache) also catches a reload
 * that happened elsewhere, e.g. upsertBudget reloading the categories after adding one.
 */
function syncNames(): boolean {
    const current = namesSignature();
    if (builtSignature === undefined) {
        builtSignature = current;
        return false;
    }
    if (current === builtSignature) return false;
    builtSignature = current;
    for (const listener of listeners) {
        try {
            listener();
        } catch (error) {
            console.error('Finance names listener failed:', error);
        }
    }
    return true;
}

/**
 * Every update (auth middleware) awaits the shared in-flight reload, so a hung
 * SELECT must not stall them: after this long the reload is abandoned and the cached lists are kept.
 * The loaders apply their own result, so a late one still lands and the next syncNames() reports it.
 */
let reloadTimeoutMs = 10_000;

async function reload(): Promise<boolean> {
    // Not unref'd: it is cleared once the reload settles, and a hung load needs it to fire.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), reloadTimeoutMs);
    });
    try {
        const outcome = await Promise.race([loadAll(), timedOut]);
        if (outcome === 'timeout') {
            console.error(
                `Finance cache reload timed out after ${reloadTimeoutMs / 1000}s; keeping the cached lists`
            );
        } else {
            const [accounts, categories] = outcome;
            if (accounts?.status === 'rejected') {
                console.error('Payment account reload failed; keeping the cached list:', accounts.reason);
            }
            if (categories?.status === 'rejected') {
                console.error('Expense category reload failed; keeping the cached list:', categories.reason);
            }
        }
    } catch (error) {
        console.error('Finance cache reload failed; keeping the cached lists:', error);
    } finally {
        clearTimeout(timer);
    }
    return syncNames();
}

/**
 * Runs `listener` whenever refreshFinanceCaches() sees the account or category names change
 * (index.ts rebuilds its Gemini models and drops cached domain chats). Returns an unsubscribe.
 */
export function onFinanceNamesChanged(listener: FinanceNamesListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * Reloads payment accounts and expense categories when the last load is older than
 * FINANCE_CACHE_TTL_MS, or `force` is set (then only FORCED_RELOAD_MIN_INTERVAL_MS applies).
 * Never throws: a failed load keeps the previous cache and is retried after the same interval.
 * Concurrent callers share one in-flight load. Resolves true when the account or category names
 * changed since the models were built; the onFinanceNamesChanged listeners have run by then.
 */
export function refreshFinanceCaches(options: { force?: boolean } = {}): Promise<boolean> {
    if (inFlight) return inFlight;
    const minAge = options.force ? FORCED_RELOAD_MIN_INTERVAL_MS : FINANCE_CACHE_TTL_MS;
    if (Date.now() - lastAttemptAt < minAge) return Promise.resolve(syncNames());
    lastAttemptAt = Date.now();
    // First refresh: the caches still hold what startup loaded and built the models from.
    if (builtSignature === undefined) builtSignature = namesSignature();
    inFlight = reload().finally(() => {
        inFlight = null;
    });
    return inFlight;
}

/**
 * resolvePaymentMethodMatch, but when non-empty input does not resolve (unknown, ambiguous or
 * deactivated) it forces one cache reload and tries again: the account may have just been added
 * or reactivated on the Dashboard. Use it before rejecting or dropping a user-supplied account.
 */
export async function resolvePaymentMethodMatchFresh(
    input?: string | null
): Promise<PaymentMethodResolution> {
    const first = resolvePaymentMethodMatch(input);
    if (first.name || !input?.trim()) return first;
    await refreshFinanceCaches({ force: true });
    return resolvePaymentMethodMatch(input);
}

/** resolvePaymentMethod with the same forced reload: active account name, or null. */
export async function resolvePaymentMethodFresh(input?: string | null): Promise<string | null> {
    return (await resolvePaymentMethodMatchFresh(input)).name;
}

// ponytail self-check (no DB: the loaders are stubbed): npx tsx src/config/cacheRefresh.ts
if (require.main === module) {
    (async () => {
        const assert = (condition: boolean, message: string) => {
            if (!condition) throw new Error(message);
        };
        const account = (id: number, name: string): PaymentAccount => ({
            id,
            name,
            accountType: 'account',
            initialBalance: 0,
            balanceBaselineDate: '2020-01-01',
            creditLimit: null,
            statementDay: null,
            rebateConfig: null,
            active: true,
        });
        let loads = 0;
        let next: PaymentAccount[] | Error = [account(1, 'Cash')];
        loadAll = async () => {
            loads++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (next instanceof Error) {
                return [
                    { status: 'rejected', reason: next },
                    { status: 'fulfilled', value: [] },
                ];
            }
            setPaymentAccountsCache(next);
            return [
                { status: 'fulfilled', value: next },
                { status: 'fulfilled', value: [] },
            ];
        };
        let notified = 0;
        onFinanceNamesChanged(() => notified++);

        setPaymentAccountsCache([account(1, 'Cash')]);
        assert((await refreshFinanceCaches()) === false, 'first load with the same names is no change');
        assert(loads === 1, 'first call loads');
        assert((await refreshFinanceCaches()) === false && loads === 1, 'within the TTL nothing reloads');
        assert((await refreshFinanceCaches({ force: true })) === false && loads === 1, 'force honours the 5s floor');

        lastAttemptAt = 0;
        next = [account(1, 'Cash'), account(2, 'Maybank Visa')];
        const [a, b] = await Promise.all([refreshFinanceCaches(), refreshFinanceCaches()]);
        assert(a && b && loads === 2 && notified === 1, 'concurrent callers share one load and one notification');

        lastAttemptAt = 0;
        next = new Error('db down');
        assert((await refreshFinanceCaches()) === false && loads === 3, 'failed load reports no change');
        assert(resolvePaymentMethodMatch('Maybank Visa').name === 'Maybank Visa', 'failed load keeps the old cache');

        setPaymentAccountsCache([account(1, 'Cash')]);
        assert((await refreshFinanceCaches()) === true && notified === 2, 'out-of-band cache change is reported');
        assert(loads === 3, 'out-of-band check does not reload');

        lastAttemptAt = Date.now() - FORCED_RELOAD_MIN_INTERVAL_MS - 1;
        next = [account(1, 'Cash'), account(3, 'GX Bank')];
        assert((await resolvePaymentMethodFresh('Cash')) === 'Cash' && loads === 3, 'resolved input does not reload');
        assert((await resolvePaymentMethodFresh('  ')) === null && loads === 3, 'empty input does not reload');
        assert((await resolvePaymentMethodFresh('gx bank')) === 'GX Bank' && loads === 4, 'unknown input forces one reload');
        assert(notified === 3, 'forced reload that adds a name notifies');
        assert((await resolvePaymentMethodFresh('Nope Card')) === null && loads === 4, 'second miss within 5s does not reload');

        // A hung load is abandoned after the timeout: callers resolve, the cache is kept.
        lastAttemptAt = 0;
        reloadTimeoutMs = 30;
        loadAll = () => {
            loads++;
            return new Promise(() => {});
        };
        const hungStart = Date.now();
        assert((await refreshFinanceCaches()) === false && loads === 5, 'a hung load reports no change');
        assert(Date.now() - hungStart < 1_000, 'a hung load is abandoned after the timeout');
        assert(inFlight === null, 'an abandoned load frees the next refresh');
        assert(resolvePaymentMethodMatch('GX Bank').name === 'GX Bank', 'an abandoned load keeps the cache');
        console.log('cacheRefresh self-check ok');
    })().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

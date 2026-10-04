import { eq } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { expenses } from '../db/schema';
import {
    appendExpense,
    type ExpenseBatchEntry,
    type ExpenseTripFields,
    type SkippedExpense,
} from './expenseService';
import { exchangeRateOf, getLatestExchangeRate, listTrips, type Trip, type TripSummary } from './tripService';

const HOME_CURRENCY = 'MYR';
const DAY_MS = 86_400_000;

/** Currency words/symbols the user types next to an amount. */
const CURRENCY_TOKENS: Record<string, string> = {
    rm: 'MYR',
    myr: 'MYR',
    vnd: 'VND',
    'đ': 'VND',
    '₫': 'VND',
    dong: 'VND',
    usd: 'USD',
    sgd: 'SGD',
    thb: 'THB',
    '฿': 'THB',
    baht: 'THB',
    idr: 'IDR',
    jpy: 'JPY',
    yen: 'JPY',
    krw: 'KRW',
    won: 'KRW',
    twd: 'TWD',
    ntd: 'TWD',
    cny: 'CNY',
    rmb: 'CNY',
    hkd: 'HKD',
    eur: 'EUR',
    '€': 'EUR',
    gbp: 'GBP',
    '£': 'GBP',
    aud: 'AUD',
    php: 'PHP',
};

/** Currencies written without decimals, so "35.000" means thirty-five thousand. */
const ZERO_DECIMAL_CURRENCIES = new Set(['VND', 'IDR', 'JPY', 'KRW']);

const MULTIPLIERS: Record<string, number> = {
    k: 1_000,
    m: 1_000_000,
    mil: 1_000_000,
    mn: 1_000_000,
    tr: 1_000_000,
};

const AMOUNT_TEXT =
    /^([a-z₫đ฿€£]{1,4})?\s*(\d[\d.,]*)\s*(k|mil|mn|m|tr)?\s*([a-z₫đ฿€£]{1,4})?$/;

export type ParsedAmount = {
    amount: number;
    /** Only set when the text names a currency ("rm20", "45000 vnd"). */
    currency: string | null;
    hasMultiplier: boolean;
};

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function parseNumber(raw: string, currencyHint: string | null): number | null {
    let s = raw;
    const hasDot = s.includes('.');
    const hasComma = s.includes(',');
    if (hasDot && hasComma) {
        // Whichever separator comes last is the decimal point.
        const decimal = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
        const thousands = decimal === '.' ? ',' : '.';
        s = s.split(thousands).join('').replace(decimal, '.');
    } else if (hasComma) {
        s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    } else if (hasDot) {
        const grouped = /^\d{1,3}(\.\d{3})+$/.test(s);
        const manyDots = (s.match(/\./g) ?? []).length > 1;
        if (grouped && (manyDots || (currencyHint && ZERO_DECIMAL_CURRENCIES.has(currencyHint)))) {
            s = s.replace(/\./g, '');
        }
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/**
 * Deterministic read of the amount as the user typed it ("32k", "rm20", "1.2m vnd").
 * Returns null for anything that isn't clearly a price (e.g. "500g", "2 pcs").
 */
export function parseAmountText(text: string | undefined, currencyHint: string | null = null): ParsedAmount | null {
    if (!text) return null;
    const m = text.trim().toLowerCase().match(AMOUNT_TEXT);
    if (!m) return null;
    const [, pre, num, mult, post] = m;
    if (pre && !CURRENCY_TOKENS[pre]) return null;
    if (post && !CURRENCY_TOKENS[post]) return null;
    if (pre && post && CURRENCY_TOKENS[pre] !== CURRENCY_TOKENS[post]) return null;
    const currency = (pre && CURRENCY_TOKENS[pre]) || (post && CURRENCY_TOKENS[post]) || null;
    const value = parseNumber(num, mult ? null : currency ?? currencyHint);
    if (value == null || value <= 0) return null;
    return {
        amount: round2(value * (mult ? MULTIPLIERS[mult] : 1)),
        currency,
        hasMultiplier: !!mult,
    };
}

/**
 * Final amount/currency for one item. The typed text wins over the model's arithmetic
 * when it carries a signal (k/m suffix or a currency word); bare numbers stay with the model.
 * During a foreign trip, a k/m amount with no currency word is in the trip currency.
 */
export function resolveAmount(
    modelAmount: number,
    modelCurrency: string | undefined,
    amountText: string | undefined,
    tripCurrency: string | null
): { amount: number; currency: string } {
    const fallbackCurrency = modelCurrency?.trim().toUpperCase() || HOME_CURRENCY;
    const parsed = parseAmountText(amountText, tripCurrency ?? fallbackCurrency);
    if (!parsed || (!parsed.currency && !parsed.hasMultiplier)) {
        return { amount: modelAmount, currency: fallbackCurrency };
    }
    const currency =
        parsed.currency ??
        (tripCurrency && tripCurrency !== HOME_CURRENCY ? tripCurrency : fallbackCurrency);
    return { amount: parsed.amount, currency };
}

export type TripExpensePlan =
    | { kind: 'plain'; amount: number; currency: string; paymentMethod: string | null; note?: string }
    | {
          kind: 'trip';
          trip: Trip;
          amount: number;
          paymentMethod: string | null;
          fields: ExpenseTripFields;
      }
    | { kind: 'skip'; reason: string };

function isCash(paymentMethod: string | null): boolean {
    return !paymentMethod || paymentMethod.toLowerCase() === 'cash';
}

/** A log_currency_exchange message to suggest, in the trip's currency. */
function exchangeExample(currency: string): string {
    return currency === 'VND' ? '"exchanged RM500 to 2.7m VND"' : `"exchanged RM500 to <amount> ${currency}"`;
}

function shiftIsoDate(iso: string, days: number): string {
    return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** A real calendar date written YYYY-MM-DD. */
export function isIsoDate(value: string | null | undefined): value is string {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const time = Date.parse(`${value}T00:00:00Z`);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Currency code for a typed code, word or symbol ("vnd", "dong", "₫" → VND); null when unrecognised. */
export function normalizeCurrencyCode(input: string | null | undefined): string | null {
    const text = input?.trim().toLowerCase();
    if (!text) return null;
    const known = CURRENCY_TOKENS[text] ?? (text === 'ringgit' ? HOME_CURRENCY : undefined);
    if (known) return known;
    return /^[a-z]{3}$/.test(text) ? text.toUpperCase() : null;
}

function tripCovers(trip: Trip, date: string): boolean {
    return !!trip.startDate && !!trip.endDate && trip.startDate <= date && date <= trip.endDate;
}

/**
 * How one expense lands on the trip board — mirrors the Dashboard's trip legs:
 * - trip-currency cash → `fund` (spent from exchanged cash; MYR at the trip's exchange rate)
 * - trip-currency on a card/e-wallet → `card` (MYR estimated at the same rate)
 * - MYR marked as trip spending → plain row grouped into the trip
 */
export function planTripExpense(
    item: {
        amount: number;
        currency: string;
        paymentMethod: string | null;
        paymentMethodText?: string | null;
        tripExpense?: boolean;
    },
    trip: Trip | null,
    exchangeRate: number | null
): TripExpensePlan {
    const plain = { kind: 'plain' as const, amount: item.amount, currency: item.currency, paymentMethod: item.paymentMethod };
    if (!trip) return plain;

    if (item.currency === HOME_CURRENCY) {
        if (!item.tripExpense) return plain;
        return {
            kind: 'trip',
            trip,
            amount: item.amount,
            paymentMethod: item.paymentMethod,
            fields: { tripId: trip.id },
        };
    }

    if (item.currency !== trip.tripCurrency) {
        return {
            ...plain,
            note: `not on ${trip.name}: ${item.currency} isn't the trip currency (${trip.tripCurrency})`,
        };
    }

    if (exchangeRate == null || !(exchangeRate > 0)) {
        return {
            kind: 'skip',
            reason: `${trip.name} has no exchange yet — first send the exchange (e.g. ${exchangeExample(trip.tripCurrency)}), then resend this`,
        };
    }
    // An account name that doesn't resolve (e.g. ambiguous "rhb") would otherwise be read as cash.
    const typed = item.paymentMethodText?.trim();
    if (!item.paymentMethod && typed && !isCash(typed)) {
        return {
            kind: 'skip',
            reason: `couldn't match payment account "${typed}" — use the exact account name, then resend`,
        };
    }
    const cash = isCash(item.paymentMethod);
    return {
        kind: 'trip',
        trip,
        amount: round2(item.amount * exchangeRate),
        paymentMethod: cash ? null : item.paymentMethod,
        fields: {
            tripId: trip.id,
            tripLeg: cash ? 'fund' : 'card',
            fxAmount: item.amount,
            fxCurrency: trip.tripCurrency,
            fxRate: exchangeRate,
        },
    };
}

type ExpenseRow = typeof expenses.$inferSelect;

/** Per-turn cache so a 20-line trip list doesn't re-read trips, rates and each day's rows. */
export class TripLookup {
    private tripsPromise: Promise<Trip[]> | null = null;
    private rates = new Map<number, Promise<number | null>>();
    private rowsByDate = new Map<string, Promise<ExpenseRow[]>>();

    trips(): Promise<Trip[]> {
        this.tripsPromise ??= listTrips();
        return this.tripsPromise;
    }

    async tripsCovering(date: string): Promise<Trip[]> {
        return (await this.trips()).filter((t) => tripCovers(t, date));
    }

    /** A trip was created this turn: re-read the trip list on next use. */
    invalidateTrips(): void {
        this.tripsPromise = null;
    }

    rate(tripId: number): Promise<number | null> {
        let rate = this.rates.get(tripId);
        if (!rate) {
            rate = getLatestExchangeRate(tripId);
            this.rates.set(tripId, rate);
        }
        return rate;
    }

    /** An exchange was logged this turn: later spends in the same message use its rate. */
    invalidateRate(tripId: number): void {
        this.rates.delete(tripId);
    }

    /** Rows that existed on `date` before this turn started logging (for duplicate hints). */
    rowsOn(date: string): Promise<ExpenseRow[]> {
        let rows = this.rowsByDate.get(date);
        if (!rows) {
            // execute() runs once; a bare Drizzle builder re-queries on every await and
            // would see rows logged earlier in this same list.
            rows = requireDb().select().from(expenses).where(eq(expenses.date, date)).execute();
            this.rowsByDate.set(date, rows);
        }
        return rows;
    }
}

/** Pick the trip for an item: the only one covering the date, or the one in the item's currency. */
function pickTrip(covering: Trip[], explicitCurrency: string | null): Trip | null {
    if (covering.length <= 1) return covering[0] ?? null;
    const matches = covering.filter((t) => t.tripCurrency === explicitCurrency);
    return matches.length === 1 ? matches[0] : null;
}

function sameMoney(a: string | null, b: number): boolean {
    return a != null && Math.abs(parseFloat(a) - b) < 0.005;
}

function findDuplicates(
    rows: ExpenseRow[],
    stored: { amount: number; currency: string; fxAmount?: number | null; fxCurrency?: string | null }
): number[] {
    return rows
        .filter((row) => {
            // A converted MYR figure (VND 30,000 ≈ MYR 4.80) matching some RM4.80 purchase is chance.
            if (stored.fxAmount == null) {
                return row.currency === stored.currency && sameMoney(row.amount, stored.amount);
            }
            if (row.fxCurrency === stored.fxCurrency && sameMoney(row.fxAmount, stored.fxAmount)) return true;
            // An earlier, unconverted log of the same foreign amount.
            return row.currency === stored.fxCurrency && sameMoney(row.amount, stored.fxAmount);
        })
        .map((row) => row.id);
}

export interface ExpenseLogInput {
    date: string;
    amount: number;
    currency?: string;
    amountText?: string;
    category: string;
    description: string;
    paymentMethod: string | null;
    /** What the user typed for the account, before resolving (null/empty = not given). */
    paymentMethodText?: string | null;
    tripExpense?: boolean;
}

export type ExpenseLogResult =
    | { status: 'logged'; entry: ExpenseBatchEntry }
    | { status: 'skipped'; skipped: SkippedExpense };

/** Log one expense, putting it on the trip board when its date falls inside a trip. */
export async function logExpenseWithTrip(
    input: ExpenseLogInput,
    lookup: TripLookup
): Promise<ExpenseLogResult> {
    const allTrips = await lookup.trips();
    const covering = await lookup.tripsCovering(input.date);
    const explicit = parseAmountText(input.amountText)?.currency ?? input.currency?.trim().toUpperCase() ?? null;
    const trip = pickTrip(covering, explicit);
    const { amount, currency } = resolveAmount(
        input.amount,
        input.currency,
        input.amountText,
        trip?.tripCurrency ?? null
    );

    if (!(amount > 0)) {
        return {
            status: 'skipped',
            skipped: { date: input.date, description: input.description, amount, currency, reason: 'could not read the amount' },
        };
    }

    // A trip-currency amount just outside the trip's dates would otherwise be stored
    // unconverted and counted as MYR in every total.
    if (!trip && currency !== HOME_CURRENCY && allTrips.some((t) => t.tripCurrency === currency)) {
        const reason =
            covering.length > 1
                ? `${covering.length} trips cover ${input.date} — can't tell which one`
                : `no ${currency} trip covers ${input.date} — create a trip for those dates or fix the trip dates in the Dashboard, then resend`;
        return {
            status: 'skipped',
            skipped: { date: input.date, description: input.description, amount, currency, reason },
        };
    }

    const rate = trip && currency === trip.tripCurrency && currency !== HOME_CURRENCY ? await lookup.rate(trip.id) : null;
    const plan = planTripExpense(
        {
            amount,
            currency,
            paymentMethod: input.paymentMethod,
            paymentMethodText: input.paymentMethodText,
            tripExpense: input.tripExpense,
        },
        trip,
        rate
    );
    if (plan.kind === 'skip') {
        return {
            status: 'skipped',
            skipped: { date: input.date, description: input.description, amount, currency, reason: plan.reason },
        };
    }

    const storedCurrency = plan.kind === 'trip' ? HOME_CURRENCY : plan.currency;
    const tripFields = plan.kind === 'trip' ? plan.fields : undefined;
    const duplicateOfIds = findDuplicates(await lookup.rowsOn(input.date), {
        amount: plan.amount,
        currency: storedCurrency,
        fxAmount: tripFields?.fxAmount,
        fxCurrency: tripFields?.fxCurrency,
    });

    const expenseId = await appendExpense(
        input.date,
        plan.amount,
        storedCurrency,
        input.category,
        input.description,
        plan.paymentMethod,
        tripFields
    );

    return {
        status: 'logged',
        entry: {
            date: input.date,
            amount: plan.amount,
            currency: storedCurrency,
            category: input.category,
            description: input.description,
            expenseId,
            paymentMethod: plan.paymentMethod,
            tripName: plan.kind === 'trip' ? plan.trip.name : undefined,
            tripLeg: tripFields?.tripLeg ?? null,
            fxAmount: tripFields?.fxAmount ?? null,
            fxCurrency: tripFields?.fxCurrency ?? null,
            fxRate: tripFields?.fxRate ?? null,
            duplicateOfIds: duplicateOfIds.length > 0 ? duplicateOfIds : undefined,
            note: plan.kind === 'plain' ? plan.note : undefined,
        },
    };
}

/**
 * Correcting the amount on a trip-currency row (fund/card leg). A trip-currency amount is
 * re-converted: fund legs at `tripRate` (the trip's latest exchange rate) when given, card legs
 * at the rate actually charged (MYR amount ÷ foreign amount), which is also the fund fallback.
 * The stored fx_rate is only a last resort, because older rows kept just 6 decimals.
 * An MYR amount keeps the foreign amount and re-derives the rate.
 */
export function recomputeTripLegAmount(
    row: {
        amount: number;
        fxAmount: number | null;
        fxCurrency: string | null;
        fxRate: number | null;
        tripLeg?: string | null;
    },
    newAmount: number,
    newCurrency: string | undefined,
    tripRate?: number | null
): { amount: number; currency: string; fxAmount: number; fxRate: number } | { error: string } {
    const { fxAmount, fxCurrency } = row;
    if (fxAmount == null || !(fxAmount > 0) || !fxCurrency) {
        return { error: 'this trip expense has no foreign amount to correct' };
    }
    if (!(newAmount > 0)) return { error: 'the new amount must be positive' };
    const currency = newCurrency?.trim().toUpperCase() || fxCurrency;
    if (currency === fxCurrency) {
        const useTripRate = row.tripLeg !== 'card' && tripRate != null && tripRate > 0;
        const rate = useTripRate ? tripRate : exchangeRateOf(row);
        if (rate == null || !(rate > 0)) {
            return { error: `this trip expense has no exchange rate — give the amount in ${HOME_CURRENCY}` };
        }
        return { amount: round2(newAmount * rate), currency: HOME_CURRENCY, fxAmount: newAmount, fxRate: rate };
    }
    if (currency === HOME_CURRENCY) {
        return { amount: newAmount, currency: HOME_CURRENCY, fxAmount, fxRate: newAmount / fxAmount };
    }
    return { error: `this is a ${fxCurrency} trip expense — give the amount in ${fxCurrency} or MYR` };
}

function tripNameKey(name: string): string {
    return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Words that don't identify a trip ("my Danang trip" → danang). */
const TRIP_NAME_FILLER = new Set(['my', 'the', 'a', 'to', 'in', 'on', 'at', 'for', 'trip', 'holiday', 'vacation', 'travel']);

function distinctiveWords(key: string): string[] {
    return key.split(' ').filter((w) => w && !TRIP_NAME_FILLER.has(w));
}

/** Trips the user means by `name`: the exact name, else whole-word containment, else a shared word (3+ letters). */
export function findTripsByName<T extends Trip>(trips: T[], name: string): T[] {
    const query = tripNameKey(name);
    if (!query) return [];
    const exact = trips.filter((t) => tripNameKey(t.name) === query);
    if (exact.length > 0) return exact;
    const queryWords = distinctiveWords(query);
    if (queryWords.length === 0) return [];
    const core = ` ${queryWords.join(' ')} `;
    const contained = trips.filter((t) => {
        const words = distinctiveWords(tripNameKey(t.name));
        if (words.length === 0) return false;
        const tripCore = ` ${words.join(' ')} `;
        return tripCore.includes(core) || core.includes(tripCore);
    });
    if (contained.length > 0) return contained;
    const significant = queryWords.filter((w) => w.length >= 3);
    return trips.filter((t) => distinctiveWords(tripNameKey(t.name)).some((w) => significant.includes(w)));
}

function quotedNames(trips: Trip[]): string {
    return trips.map((t) => `"${t.name}"`).join(', ');
}

/** A reason from the helpers below, ending with punctuation for a reply. */
export function asSentence(text: string): string {
    return /[.?!]$/.test(text) ? text : `${text}.`;
}

/** Cash is often bought before leaving, so an exchange also fits a trip starting this soon after it. */
const EXCHANGE_LEAD_DAYS = 30;

export type TripPick<T extends Trip> = { trip: T } | { error: string; ask: boolean };

/**
 * Trip for a currency exchange: the named trip; else the single foreign-currency trip covering
 * `date`; else the single one starting within EXCHANGE_LEAD_DAYS after it. A currency the user
 * named narrows the choice and must be the trip's currency.
 */
export function pickExchangeTrip<T extends Trip>(
    trips: T[],
    opts: { tripName?: string | null; date: string; currency: string | null }
): TripPick<T> {
    const { date, currency } = opts;
    let trip: T | undefined;
    if (opts.tripName?.trim()) {
        const matches = findTripsByName(trips, opts.tripName);
        if (matches.length > 1) {
            return { error: `"${opts.tripName}" matches ${quotedNames(matches)}. Which trip?`, ask: true };
        }
        if (matches.length === 0) {
            const known = trips.length > 0 ? ` Your trips: ${quotedNames(trips)}.` : '';
            return {
                error: `no trip named "${opts.tripName}".${known} To add it, send its name, dates and currency (e.g. "create trip Vietnam 10-15 Oct, VND")`,
                ask: true,
            };
        }
        trip = matches[0];
    } else {
        const foreign = trips.filter(
            (t) => t.tripCurrency !== HOME_CURRENCY && (!currency || t.tripCurrency === currency)
        );
        const latestStart = shiftIsoDate(date, EXCHANGE_LEAD_DAYS);
        const covering = foreign.filter((t) => tripCovers(t, date));
        const upcoming = foreign.filter((t) => !!t.startDate && t.startDate > date && t.startDate <= latestStart);
        for (const group of [covering, upcoming]) {
            if (group.length > 1) return { error: `${quotedNames(group)} all fit ${date}. Which trip?`, ask: true };
            if (group.length === 1) {
                trip = group[0];
                break;
            }
        }
        if (!trip) {
            return {
                error:
                    `no ${currency ?? 'foreign-currency'} trip covers ${date} or starts within ${EXCHANGE_LEAD_DAYS} days after it. ` +
                    'Name the trip, or create it first with its name, dates and currency (e.g. "create trip Vietnam 10-15 Oct, VND")',
                ask: true,
            };
        }
    }
    if (trip.tripCurrency === HOME_CURRENCY) {
        return {
            error: `${trip.name} is a ${HOME_CURRENCY} trip, so there is nothing to exchange — log its RM spending as usual`,
            ask: false,
        };
    }
    if (currency && currency !== trip.tripCurrency) {
        return { error: `${trip.name} is a ${trip.tripCurrency} trip, not ${currency}`, ask: false };
    }
    return { trip };
}

/** "RM1 = 6,250 VND" for currencies worth less than MYR, "1 USD = RM4.21" otherwise. */
export function formatExchangeRate(rate: number, currency: string): string {
    if (rate < 1) return `RM1 = ${(1 / rate).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;
    return `1 ${currency} = RM${rate.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

/** A new rate this far from the trip's last one is a misread amount (2.7 for "2.7m"), not the market. */
const RATE_SANITY_FACTOR = 5;

/**
 * MYR paid and foreign cash received for an exchange leg. fxRate = MYR per 1 foreign unit and is
 * never rounded (VND's ~0.00016 would become 0), as on the Dashboard. Like expenses, the typed text
 * ("2.7m", "2,700,000 vnd") wins over the model's number when it has a k/m suffix or currency word.
 */
export function planCurrencyExchange(
    input: { myrAmount: number; foreignAmount: number; foreignAmountText?: string | null },
    tripCurrency: string,
    previousRate: number | null
): { myrAmount: number; fxAmount: number; fxRate: number } | { error: string } {
    const myrAmount = round2(Number(input.myrAmount));
    if (!(myrAmount > 0)) return { error: 'the MYR amount must be a positive number' };
    const parsed = parseAmountText(input.foreignAmountText ?? undefined, tripCurrency);
    if (parsed?.currency && parsed.currency !== tripCurrency) {
        return { error: `the amount received is in ${parsed.currency}, but the trip currency is ${tripCurrency}` };
    }
    const fxAmount =
        parsed && (parsed.currency || parsed.hasMultiplier) ? parsed.amount : round2(Number(input.foreignAmount));
    if (!(fxAmount > 0)) return { error: `the ${tripCurrency} amount received must be a positive number` };
    const fxRate = myrAmount / fxAmount;
    if (
        previousRate != null &&
        previousRate > 0 &&
        Math.max(fxRate / previousRate, previousRate / fxRate) > RATE_SANITY_FACTOR
    ) {
        return {
            error:
                `that works out to ${formatExchangeRate(fxRate, tripCurrency)}, far from this trip's last exchange ` +
                `(${formatExchangeRate(previousRate, tripCurrency)}) — check both amounts and resend`,
        };
    }
    return { myrAmount, fxAmount, fxRate };
}

export interface CurrencyExchangeInput {
    date: string;
    myrAmount: number;
    foreignAmount: number;
    foreignAmountText?: string | null;
    /** The currency the user named, if any (code, word or symbol). */
    foreignCurrency?: string | null;
    /** Resolved active account the MYR came from. */
    paymentMethod: string;
    tripName?: string | null;
}

export type CurrencyExchangeResult =
    | {
          status: 'logged';
          expenseId: number;
          trip: Trip;
          date: string;
          description: string;
          myrAmount: number;
          fxAmount: number;
          fxRate: number;
          paymentMethod: string;
          previousRate: number | null;
          duplicateOfIds: number[];
      }
    | { status: 'not_logged'; reason: string; ask: boolean };

/**
 * Log MYR exchanged into a trip's currency, as the Dashboard's "Add exchange" does: an MYR
 * expense (category Travel, "Currency exchange (VND)") on the paying account, with trip_leg
 * 'exchange' and the foreign amount/rate. It funds the trip cash that later fund legs spend.
 */
export async function logCurrencyExchange(
    input: CurrencyExchangeInput,
    lookup: TripLookup
): Promise<CurrencyExchangeResult> {
    const notLogged = (reason: string, ask = false): CurrencyExchangeResult => ({ status: 'not_logged', reason, ask });
    const typedCurrency = input.foreignCurrency?.trim() ? normalizeCurrencyCode(input.foreignCurrency) : null;
    if (input.foreignCurrency?.trim() && !typedCurrency) {
        return notLogged(`"${input.foreignCurrency}" is not a currency I know — use its 3-letter code (e.g. VND)`, true);
    }
    const currency = typedCurrency ?? parseAmountText(input.foreignAmountText ?? undefined)?.currency ?? null;
    if (currency === HOME_CURRENCY) return notLogged('give the foreign amount you received, not the MYR', true);

    const picked = pickExchangeTrip(await lookup.trips(), { tripName: input.tripName, date: input.date, currency });
    if ('error' in picked) return notLogged(picked.error, picked.ask);
    const { trip } = picked;

    const previousRate = await lookup.rate(trip.id);
    const amounts = planCurrencyExchange(input, trip.tripCurrency, previousRate);
    if ('error' in amounts) return notLogged(amounts.error);

    const duplicateOfIds = (await lookup.rowsOn(input.date))
        .filter(
            (row) =>
                row.tripId === trip.id &&
                row.tripLeg === 'exchange' &&
                sameMoney(row.amount, amounts.myrAmount) &&
                sameMoney(row.fxAmount, amounts.fxAmount)
        )
        .map((row) => row.id);

    const description = `Currency exchange (${trip.tripCurrency})`;
    const expenseId = await appendExpense(
        input.date,
        amounts.myrAmount,
        HOME_CURRENCY,
        'Travel',
        description,
        input.paymentMethod,
        {
            tripId: trip.id,
            tripLeg: 'exchange',
            fxAmount: amounts.fxAmount,
            fxCurrency: trip.tripCurrency,
            fxRate: amounts.fxRate,
        }
    );
    lookup.invalidateRate(trip.id);

    return {
        status: 'logged',
        expenseId,
        trip,
        date: input.date,
        description,
        ...amounts,
        paymentMethod: input.paymentMethod,
        previousRate,
        duplicateOfIds,
    };
}

function formatForeign(amount: number, currency: string): string {
    return `${currency} ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function formatMyr(amount: number): string {
    return `RM ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Confirmation for a logged exchange; "Logged #id" lets a reply edit or delete it. */
export function formatCurrencyExchangeReply(result: Extract<CurrencyExchangeResult, { status: 'logged' }>): string {
    const cur = result.trip.tripCurrency;
    const rate = formatExchangeRate(result.fxRate, cur);
    const lines = [
        `✅ Logged #${result.expenseId} (currency exchange)`,
        `📅 Date: ${result.date}`,
        `💱 ${formatMyr(result.myrAmount)} → ${formatForeign(result.fxAmount, cur)}`,
        `💳 From: ${result.paymentMethod}`,
        `🧳 Trip: ${result.trip.name}`,
        `📈 Rate: ${rate}` +
            (result.previousRate != null ? ` (last exchange: ${formatExchangeRate(result.previousRate, cur)})` : ''),
    ];
    if (result.duplicateOfIds.length > 0) {
        lines.push(`⚠️ Possible duplicate of ${result.duplicateOfIds.map((id) => `#${id}`).join(', ')}`);
    }
    lines.push(`${cur} cash spending on this trip now converts at ${rate}.`);
    return lines.join('\n');
}

export type NewTripPlan<T extends Trip> =
    | {
          fields: { name: string; tripCurrency: string; startDate: string; endDate: string; notes: string | null };
          overlaps: T[];
      }
    | { error: string; ask: boolean };

/**
 * Checks a create_trip request: the start may not be after the end, names must be unique, and the
 * dates may not overlap a similarly named trip or another trip in the same currency (`overlaps`
 * lists the different-currency ones, which are allowed).
 */
export function planNewTrip<T extends Trip>(
    input: {
        name?: string | null;
        tripCurrency?: string | null;
        startDate?: string | null;
        endDate?: string | null;
        notes?: string | null;
    },
    existing: T[]
): NewTripPlan<T> {
    const name = input.name?.trim();
    if (!name) return { error: 'what should the trip be called?', ask: true };
    const tripCurrency = normalizeCurrencyCode(input.tripCurrency);
    if (!tripCurrency) return { error: 'which currency will you spend there (3-letter code, e.g. VND, THB, JPY)?', ask: true };
    const { startDate, endDate } = input;
    if (!isIsoDate(startDate) || !isIsoDate(endDate)) return { error: 'what are the start and end dates?', ask: true };
    if (startDate > endDate) {
        return { error: `the start date ${startDate} is after the end date ${endDate}`, ask: false };
    }
    const same = existing.find((t) => tripNameKey(t.name) === tripNameKey(name));
    if (same) {
        return {
            error: `a trip named "${same.name}" already exists (${same.startDate ?? '?'} → ${same.endDate ?? '?'}, ${same.tripCurrency}); change its dates in the Dashboard or pick another name`,
            ask: false,
        };
    }
    const overlaps = existing.filter(
        (t) => !!t.startDate && !!t.endDate && t.startDate <= endDate && startDate <= t.endDate
    );
    const describe = (trips: T[]) =>
        trips.map((t) => `"${t.name}" (${t.startDate} → ${t.endDate}, ${t.tripCurrency})`).join(', ');
    // A shorter name for a trip already on these dates ("Danang" for "Company Trip Danang") is
    // almost always that trip again. Similar names on other dates (a repeat visit) are fine.
    const similar = findTripsByName(overlaps, name);
    if (similar.length > 0) {
        return {
            error: `did you mean ${describe(similar)}? It already covers these dates. Edit it on the Dashboard to change it, or for a separate trip use dates that don't overlap it`,
            ask: true,
        };
    }
    // Two same-currency trips on one date: pickTrip can't tell which one a spend belongs to, so
    // every trip-currency spend in the overlap would be skipped.
    const sameCurrency = overlaps.filter((t) => t.tripCurrency === tripCurrency);
    if (sameCurrency.length > 0) {
        return {
            error: `${describe(sameCurrency)} is also a ${tripCurrency} trip on these dates, so ${tripCurrency} spends there couldn't be placed on either trip. Change that trip's dates on the Dashboard, or use dates that don't overlap it`,
            ask: true,
        };
    }
    // Different-currency overlaps stay a warning: the spend's currency tells the trips apart.
    return { fields: { name, tripCurrency, startDate, endDate, notes: input.notes?.trim() || null }, overlaps };
}

export function formatTripCreatedReply(trip: Trip, overlaps: Trip[]): string {
    const lines = [
        `🧳 Trip created: ${trip.name} (#${trip.id})`,
        `📅 ${trip.startDate} → ${trip.endDate}`,
        `💱 Currency: ${trip.tripCurrency}`,
    ];
    if (trip.tripCurrency === HOME_CURRENCY) {
        lines.push('RM spending inside these dates that is part of the trip is grouped into it.');
    } else {
        lines.push(
            `Next: send the cash you exchanged, e.g. ${exchangeExample(trip.tripCurrency)}. ` +
                `${trip.tripCurrency} spending inside these dates then lands on the trip board.`
        );
    }
    if (overlaps.length > 0) {
        const list = overlaps.map((t) => `${t.name} (${t.startDate} → ${t.endDate}, ${t.tripCurrency})`).join(', ');
        lines.push(`⚠️ Overlaps ${list}: an item dated inside both is only put on a trip when its currency tells them apart.`);
    }
    return lines.join('\n');
}

/**
 * Trip for get_trip_summary: the named trip; else the trip covering `date` (latest start first);
 * else the latest trip that has started by then; else the newest trip.
 */
export function pickSummaryTrip<T extends Trip>(
    trips: T[],
    tripName: string | null | undefined,
    date: string
): TripPick<T> {
    if (trips.length === 0) {
        return { error: 'No trips yet. Create one first, e.g. "create trip Vietnam 10-15 Oct, VND".', ask: false };
    }
    if (tripName?.trim()) {
        const matches = findTripsByName(trips, tripName);
        if (matches.length === 1) return { trip: matches[0] };
        if (matches.length > 1) {
            return { error: `"${tripName}" matches ${quotedNames(matches)}. Which trip?`, ask: true };
        }
        // ask: the user's next message (the trip's real name) must stay in this chat.
        return { error: `Trip "${tripName}" not found. Your trips: ${quotedNames(trips)}. Which one?`, ask: true };
    }
    const latestStartFirst = (a: T, b: T) => (b.startDate ?? '').localeCompare(a.startDate ?? '') || b.id - a.id;
    const covering = trips.filter((t) => tripCovers(t, date)).sort(latestStartFirst);
    if (covering.length > 0) return { trip: covering[0] };
    const started = trips.filter((t) => !!t.startDate && t.startDate <= date).sort(latestStartFirst);
    return { trip: started[0] ?? [...trips].sort((a, b) => b.id - a.id)[0] };
}

/** The Trips panel numbers for the model: no expense list, money rounded to 2 dp. */
export interface TripSummaryView {
    trip: string;
    startDate: string | null;
    endDate: string | null;
    currency: string;
    days: number | null;
    spentMyr: number;
    perDayMyr: number | null;
    exchangedMyr: number;
    /** Fund amounts are in the trip currency. */
    fundReceived: number;
    fundSpent: number;
    fundRemaining: number;
    fundSpentMyr: number;
    cardMyr: number;
    linkedMyr: number;
    tripTotalMyr: number;
    byCategory: { category: string; amountMyr: number; count: number }[];
    latestExchangeRate: string | null;
    entries: number;
}

export function tripSummaryView(summary: TripSummary): TripSummaryView {
    const { trip, days } = summary;
    return {
        trip: trip.name,
        startDate: trip.startDate,
        endDate: trip.endDate,
        currency: trip.tripCurrency,
        days,
        spentMyr: round2(summary.spentMyr),
        perDayMyr: days != null && days > 0 ? round2(summary.spentMyr / days) : null,
        exchangedMyr: round2(summary.exchangedMyr),
        fundReceived: round2(summary.fundReceived),
        fundSpent: round2(summary.fundSpent),
        fundRemaining: round2(summary.fundRemaining),
        fundSpentMyr: round2(summary.fundSpentMyr),
        cardMyr: round2(summary.cardMyr),
        linkedMyr: round2(summary.linkedMyr),
        tripTotalMyr: round2(summary.tripTotalMyr),
        byCategory: summary.byCategory.map((c) => ({ category: c.category, amountMyr: round2(c.amountMyr), count: c.count })),
        latestExchangeRate:
            summary.latestExchangeRate != null ? formatExchangeRate(summary.latestExchangeRate, trip.tripCurrency) : null,
        entries: summary.expenses.length,
    };
}

/** How get_trip_summary's numbers are named on the Dashboard's Trips panel (sent with the response). */
export const TRIP_SUMMARY_WORDING =
    'Use the Dashboard Trips panel labels: "Total spent" = spentMyr (perDayMyr per day over days), ' +
    '"Exchanged" = exchangedMyr, "Fund left" = fundRemaining and "Fund used" = fundSpent (both in the trip currency, not MYR), ' +
    '"Card" = cardMyr, "Linked" = linkedMyr (RM transactions grouped into the trip), ' +
    '"Total cost" = tripTotalMyr (MYR that left your accounts: exchanged + card + linked). ' +
    'Total spent counts trip cash at its exchange rate when spent, so Total cost minus Total spent is roughly the unspent cash. ' +
    'Give byCategory amounts in MYR. Leave out lines that are 0.';

/** Plain-text summary when the model sends no text back. */
export function formatTripSummaryReply(v: TripSummaryView): string {
    const dates = [v.startDate, v.endDate].filter(Boolean).join(' → ') || 'no dates';
    const perDay =
        v.perDayMyr != null && v.days
            ? ` (${formatMyr(v.perDayMyr)}/day · ${v.days} ${v.days === 1 ? 'day' : 'days'})`
            : '';
    const lines = [`🧳 ${v.trip} · ${dates} · ${v.currency}`, `Total spent: ${formatMyr(v.spentMyr)}${perDay}`];
    if (v.exchangedMyr > 0) lines.push(`Exchanged: ${formatMyr(v.exchangedMyr)}`);
    if (v.fundReceived > 0) {
        lines.push(`Fund left: ${formatForeign(v.fundRemaining, v.currency)} · Fund used: ${formatForeign(v.fundSpent, v.currency)}`);
    }
    if (v.cardMyr > 0) lines.push(`Card: ${formatMyr(v.cardMyr)}`);
    if (v.linkedMyr > 0) lines.push(`Linked: ${formatMyr(v.linkedMyr)}`);
    lines.push(`Total cost: ${formatMyr(v.tripTotalMyr)}`);
    if (v.byCategory.length > 0) {
        lines.push('', 'By category:', ...v.byCategory.map((c) => `• ${c.category}: ${formatMyr(c.amountMyr)} (${c.count})`));
    }
    if (v.latestExchangeRate) lines.push(`Rate: ${v.latestExchangeRate}`);
    return lines.join('\n');
}

/** Trips worth telling the expense specialist about: ongoing, upcoming, or recently ended. */
export async function buildTripContextHint(todayIso: string): Promise<string> {
    const from = shiftIsoDate(todayIso, -60);
    const to = shiftIsoDate(todayIso, 14);
    const trips = (await listTrips()).filter(
        (t) => t.startDate && t.endDate && t.endDate >= from && t.startDate <= to
    );
    if (trips.length === 0) return '';
    const lines = trips.map(
        (t) => `- "${t.name}": ${t.startDate} to ${t.endDate} (inclusive), trip currency ${t.tripCurrency}`
    );
    return (
        `\n[TRIPS]\n${lines.join('\n')}\n` +
        'For an item dated inside a trip: a k/m/tr amount or a large bare number with no currency word ("32k", "1.2m", "45000") is in that trip\'s currency; "rm"/"RM"/"myr" is MYR. ' +
        'Set tripExpense: true on everything spent as part of the trip (food, drinks, transport, activities, shopping, tips—including RM-priced items) and false for home bills, subscriptions, investments or transfers. ' +
        'Do NOT convert currencies yourself—MYR conversion and trip linking are automatic. ' +
        'Use these names as tripName for log_currency_exchange and get_trip_summary.'
    );
}

// ponytail self-check: amount parsing + trip planning without DB
if (require.main === module) {
    const assert = (cond: boolean, msg: string) => {
        if (!cond) throw new Error(msg);
    };
    const eqAmount = (text: string, amount: number, currency: string | null) => {
        const p = parseAmountText(text, 'VND');
        assert(p?.amount === amount && p.currency === currency, `parse ${text} → ${JSON.stringify(p)}`);
    };
    eqAmount('32k', 32_000, null);
    eqAmount('rm20', 20, 'MYR');
    eqAmount('RM 32', 32, 'MYR');
    eqAmount('20rm', 20, 'MYR');
    eqAmount('rm2k', 2_000, 'MYR');
    eqAmount('1.2m', 1_200_000, null);
    eqAmount('2,5tr', 2_500_000, null);
    eqAmount('45,000đ', 45_000, 'VND');
    eqAmount('35.000 vnd', 35_000, 'VND');
    eqAmount('1.234.000', 1_234_000, null);
    eqAmount('rm12.50', 12.5, 'MYR');
    assert(parseAmountText('500g') === null, '500g is a weight, not a price');
    assert(parseAmountText('2 pcs') === null, '2 pcs is a quantity, not a price');
    assert(parseAmountText('3in 1') === null, '3in 1 is not a price');

    const vnd = resolveAmount(32, 'MYR', '32k', 'VND');
    assert(vnd.amount === 32_000 && vnd.currency === 'VND', `32k on VND trip → ${JSON.stringify(vnd)}`);
    const rm = resolveAmount(20, 'MYR', 'rm20', 'VND');
    assert(rm.amount === 20 && rm.currency === 'MYR', `rm20 on VND trip → ${JSON.stringify(rm)}`);
    const home = resolveAmount(2000, 'MYR', '2k', null);
    assert(home.amount === 2000 && home.currency === 'MYR', `2k at home → ${JSON.stringify(home)}`);
    const bare = resolveAmount(40_000, 'VND', '40000', 'VND');
    assert(bare.amount === 40_000 && bare.currency === 'VND', 'bare number keeps the model reading');
    const miscopied = resolveAmount(32_000, 'VND', '32', 'VND');
    assert(miscopied.amount === 32_000, 'a bare number never overrides the model amount');

    const trip: Trip = {
        id: 2,
        name: 'Danang',
        startDate: '2026-09-26',
        endDate: '2026-09-29',
        tripCurrency: 'VND',
        notes: null,
    };
    const rate = 400 / 2_500_000;
    const fund = planTripExpense({ amount: 32_000, currency: 'VND', paymentMethod: 'Cash' }, trip, rate);
    assert(
        fund.kind === 'trip' && fund.fields.tripLeg === 'fund' && fund.amount === 5.12 && fund.paymentMethod === null,
        `VND cash → fund leg: ${JSON.stringify(fund)}`
    );
    const card = planTripExpense({ amount: 250_000, currency: 'VND', paymentMethod: 'RHB World Card' }, trip, rate);
    assert(
        card.kind === 'trip' && card.fields.tripLeg === 'card' && card.amount === 40 && card.paymentMethod === 'RHB World Card',
        `VND on card → card leg: ${JSON.stringify(card)}`
    );
    const linked = planTripExpense({ amount: 20, currency: 'MYR', paymentMethod: 'Cash', tripExpense: true }, trip, rate);
    assert(
        linked.kind === 'trip' && linked.fields.tripLeg === undefined && linked.amount === 20 && linked.paymentMethod === 'Cash',
        `RM trip item → grouped into trip: ${JSON.stringify(linked)}`
    );
    const unmatched = planTripExpense(
        { amount: 250_000, currency: 'VND', paymentMethod: null, paymentMethodText: 'rhb' },
        trip,
        rate
    );
    assert(unmatched.kind === 'skip', `unmatched account on a trip is skipped, not filed as cash: ${JSON.stringify(unmatched)}`);
    const typedCash = planTripExpense(
        { amount: 32_000, currency: 'VND', paymentMethod: null, paymentMethodText: 'cash' },
        trip,
        rate
    );
    assert(typedCash.kind === 'trip' && typedCash.fields.tripLeg === 'fund', 'typed "cash" still lands as a fund leg');
    const homeBill = planTripExpense({ amount: 41.9, currency: 'MYR', paymentMethod: 'RHB World Card' }, trip, rate);
    assert(homeBill.kind === 'plain', 'RM item not marked tripExpense stays off the trip');
    const noRate = planTripExpense({ amount: 32_000, currency: 'VND', paymentMethod: null }, trip, null);
    assert(noRate.kind === 'skip', 'VND with no exchange rate is skipped, not stored unconverted');
    assert(
        noRate.kind === 'skip' && noRate.reason.includes('"exchanged RM500 to 2.7m VND"') && !noRate.reason.includes('Dashboard'),
        `no-rate skip suggests sending the exchange in Telegram: ${JSON.stringify(noRate)}`
    );
    const otherCurrency = planTripExpense({ amount: 15, currency: 'USD', paymentMethod: null }, trip, rate);
    assert(otherCurrency.kind === 'plain' && !!otherCurrency.note, 'non-trip currency stays plain with a note');

    const dup = findDuplicates(
        [{ id: 1174, currency: 'MYR', amount: '20.00', fxAmount: null, fxCurrency: null } as ExpenseRow],
        { amount: 20, currency: 'MYR' }
    );
    assert(dup.length === 1 && dup[0] === 1174, 'same-day RM20 is flagged as a possible duplicate');
    const chance = findDuplicates(
        [{ id: 1, currency: 'MYR', amount: '4.80', fxAmount: null, fxCurrency: null } as ExpenseRow],
        { amount: 4.8, currency: 'MYR', fxAmount: 30_000, fxCurrency: 'VND' }
    );
    assert(chance.length === 0, 'VND 30k ≈ RM4.80 is not a duplicate of an unrelated RM4.80 row');

    const fundRow = { amount: 5.12, fxAmount: 32_000, fxCurrency: 'VND', fxRate: rate, tripLeg: 'fund' };
    const fixedVnd = recomputeTripLegAmount(fundRow, 40_000, 'VND');
    assert('fxAmount' in fixedVnd && fixedVnd.fxAmount === 40_000 && fixedVnd.amount === 6.4, `edit 40k → ${JSON.stringify(fixedVnd)}`);
    const fixedMyr = recomputeTripLegAmount(fundRow, 6, 'MYR');
    assert('fxAmount' in fixedMyr && fixedMyr.fxAmount === 32_000 && fixedMyr.amount === 6, `edit rm6 → ${JSON.stringify(fixedMyr)}`);
    assert('error' in recomputeTripLegAmount(fundRow, 5, 'USD'), 'other currency edit is rejected');

    // RM400 for VND 2,450,000 is 0.000163265…/VND; fx_rate used to keep only 0.000163.
    const vndRate = 400 / 2_450_000;
    const vndFund = { amount: round2(1_000_000 * vndRate), fxAmount: 1_000_000, fxCurrency: 'VND', fxRate: 0.000163, tripLeg: 'fund' };
    const doubled = recomputeTripLegAmount(vndFund, 2_000_000, 'VND', vndRate);
    assert('fxAmount' in doubled && doubled.amount === 326.53, `VND 1m → 2m at the trip rate → ${JSON.stringify(doubled)}`);
    const noTripRate = recomputeTripLegAmount(vndFund, 2_000_000, 'VND', null);
    assert('fxAmount' in noTripRate && noTripRate.amount !== 326, `no trip rate never uses the 6-decimal fx_rate → ${JSON.stringify(noTripRate)}`);
    const vndCard = { amount: 41, fxAmount: 250_000, fxCurrency: 'VND', fxRate: 0.000163, tripLeg: 'card' };
    const cardEdit = recomputeTripLegAmount(vndCard, 500_000, 'VND', vndRate);
    assert('fxAmount' in cardEdit && cardEdit.amount === 82, `card leg keeps its charged rate → ${JSON.stringify(cardEdit)}`);

    // 3.11 / 3.12: currency exchange, create_trip and get_trip_summary helpers.
    assert(normalizeCurrencyCode('dong') === 'VND' && normalizeCurrencyCode('₫') === 'VND', 'dong/₫ → VND');
    assert(normalizeCurrencyCode(' usd ') === 'USD' && normalizeCurrencyCode('ringgit') === 'MYR', 'usd / ringgit');
    assert(normalizeCurrencyCode('vietnam') === null && normalizeCurrencyCode('') === null, 'unknown currency → null');
    assert(isIsoDate('2026-10-04') && !isIsoDate('2026-02-30') && !isIsoDate('4/10/2026'), 'isIsoDate');

    const jb: Trip = { id: 4, name: 'JB', startDate: '2026-09-18', endDate: '2026-09-20', tripCurrency: 'MYR', notes: null };
    const danang: Trip = { ...trip, name: 'Company Trip Danang' };
    const trips = [danang, jb];
    const names = (list: Trip[]) => list.map((t) => t.name).join(',');
    assert(names(findTripsByName(trips, 'company trip danang')) === 'Company Trip Danang', 'exact trip name');
    assert(names(findTripsByName(trips, 'Danang')) === 'Company Trip Danang', 'one word of the trip name');
    assert(names(findTripsByName(trips, 'my JB trip')) === 'JB', 'filler words are ignored');
    assert(findTripsByName(trips, 'trip').length === 0, '"trip" alone names no trip');
    assert(findTripsByName(trips, 'Vietnam').length === 0, 'an unrelated word matches nothing');

    const pickedName = (p: TripPick<Trip>) => ('trip' in p ? p.trip.name : `error: ${p.error}`);
    const before = pickExchangeTrip(trips, { date: '2026-09-24', currency: null });
    assert(pickedName(before) === 'Company Trip Danang', `exchange 2 days before the trip → ${pickedName(before)}`);
    const during = pickExchangeTrip(trips, { date: '2026-09-27', currency: 'VND' });
    assert(pickedName(during) === 'Company Trip Danang', `exchange during the trip → ${pickedName(during)}`);
    const insideMyrTrip = pickExchangeTrip(trips, { date: '2026-09-19', currency: null });
    assert(pickedName(insideMyrTrip) === 'Company Trip Danang', 'an MYR trip is never an exchange target');
    const wrongCurrency = pickExchangeTrip(trips, { date: '2026-09-27', currency: 'THB' });
    assert('error' in wrongCurrency && wrongCurrency.ask, 'no THB trip → ask');
    const namedMyr = pickExchangeTrip(trips, { tripName: 'JB', date: '2026-09-19', currency: null });
    assert('error' in namedMyr && !namedMyr.ask, 'exchange on an MYR trip is refused');
    const namedWrongCurrency = pickExchangeTrip(trips, { tripName: 'danang', date: '2026-09-27', currency: 'USD' });
    assert('error' in namedWrongCurrency, 'named trip in another currency is refused');
    assert('error' in pickExchangeTrip(trips, { date: '2026-12-01', currency: null }), 'no trip near the date');
    const overlapping = pickExchangeTrip([danang, { ...danang, id: 7, name: 'Hoi An' }], { date: '2026-09-27', currency: null });
    assert('error' in overlapping && overlapping.ask, 'two trips fit → ask which');

    const exchanged = planCurrencyExchange({ myrAmount: 500, foreignAmount: 2.7, foreignAmountText: '2.7m' }, 'VND', null);
    assert(
        'fxRate' in exchanged && exchanged.fxAmount === 2_700_000 && exchanged.fxRate === 500 / 2_700_000,
        `"2.7m" wins over the model's 2.7 and the rate is not rounded → ${JSON.stringify(exchanged)}`
    );
    const vndText = planCurrencyExchange({ myrAmount: 400, foreignAmount: 0, foreignAmountText: '2.500.000 vnd' }, 'VND', null);
    assert('fxRate' in vndText && vndText.fxAmount === 2_500_000, `"2.500.000 vnd" → ${JSON.stringify(vndText)}`);
    const misread = planCurrencyExchange({ myrAmount: 500, foreignAmount: 2.7 }, 'VND', rate);
    assert('error' in misread, 'a rate 5x off the last exchange is refused');
    const nearby = planCurrencyExchange({ myrAmount: 500, foreignAmount: 2_900_000 }, 'VND', rate);
    assert('fxRate' in nearby && nearby.fxRate === 500 / 2_900_000, 'a normal rate move is fine');
    assert('error' in planCurrencyExchange({ myrAmount: 100, foreignAmount: 80, foreignAmountText: '80 usd' }, 'VND', null), 'USD on a VND trip');
    assert('error' in planCurrencyExchange({ myrAmount: 0, foreignAmount: 1_000 }, 'VND', null), 'MYR amount must be positive');
    assert(formatExchangeRate(rate, 'VND') === 'RM1 = 6,250 VND', `VND rate → ${formatExchangeRate(rate, 'VND')}`);
    assert(formatExchangeRate(4.21, 'USD') === '1 USD = RM4.21', `USD rate → ${formatExchangeRate(4.21, 'USD')}`);

    const lookup = new TripLookup();
    const rates = (lookup as unknown as { rates: Map<number, Promise<number | null>> }).rates;
    rates.set(2, Promise.resolve(null));
    lookup.invalidateRate(2);
    assert(!rates.has(2), 'invalidateRate drops the cached rate so the next spend re-reads it');

    const newTrip = planNewTrip({ name: ' Hanoi ', tripCurrency: 'dong', startDate: '2026-10-01', endDate: '2026-10-05' }, trips);
    assert(
        'fields' in newTrip && newTrip.fields.name === 'Hanoi' && newTrip.fields.tripCurrency === 'VND' && newTrip.overlaps.length === 0,
        `create_trip normalises → ${JSON.stringify(newTrip)}`
    );
    const sameCurrencyOverlap = planNewTrip({ name: 'Hanoi', tripCurrency: 'VND', startDate: '2026-09-28', endDate: '2026-10-02' }, trips);
    assert(
        'error' in sameCurrencyOverlap && sameCurrencyOverlap.ask && sameCurrencyOverlap.error.includes('Company Trip Danang'),
        `a same-currency overlap is refused (its spends could go on neither trip) → ${JSON.stringify(sameCurrencyOverlap)}`
    );
    const otherCurrencyOverlap = planNewTrip({ name: 'Bangkok', tripCurrency: 'THB', startDate: '2026-09-28', endDate: '2026-10-02' }, trips);
    assert(
        'fields' in otherCurrencyOverlap && names(otherCurrencyOverlap.overlaps) === 'Company Trip Danang',
        `a different-currency overlap is allowed and reported → ${JSON.stringify(otherCurrencyOverlap)}`
    );
    const shorterName = planNewTrip({ name: 'Danang', tripCurrency: 'VND', startDate: '2026-09-26', endDate: '2026-09-29' }, trips);
    assert(
        'error' in shorterName && shorterName.ask && shorterName.error.startsWith('did you mean "Company Trip Danang"'),
        `a shorter name for a trip on the same dates asks "did you mean" → ${JSON.stringify(shorterName)}`
    );
    const shorterNameOtherCurrency = planNewTrip({ name: 'Danang', tripCurrency: 'MYR', startDate: '2026-09-27', endDate: '2026-09-28' }, trips);
    assert('error' in shorterNameOtherCurrency && shorterNameOtherCurrency.ask, 'a similar name on overlapping dates asks even in another currency');
    const repeatVisit = planNewTrip({ name: 'Danang', tripCurrency: 'VND', startDate: '2027-03-01', endDate: '2027-03-04' }, trips);
    assert('fields' in repeatVisit, `a similar name on other dates (a repeat visit) is fine → ${JSON.stringify(repeatVisit)}`);
    const backwards = planNewTrip({ name: 'Bali', tripCurrency: 'IDR', startDate: '2026-11-05', endDate: '2026-11-01' }, trips);
    assert('error' in backwards && !backwards.ask, 'start after end is rejected');
    const noDates = planNewTrip({ name: 'Bali', tripCurrency: 'IDR' }, trips);
    assert('error' in noDates && noDates.ask, 'missing dates → ask');
    assert('error' in planNewTrip({ name: 'company trip danang', tripCurrency: 'VND', startDate: '2026-12-01', endDate: '2026-12-02' }, trips), 'duplicate name');

    const summaryOn = (date: string, name?: string) => pickedName(pickSummaryTrip(trips, name, date));
    assert(summaryOn('2026-09-27') === 'Company Trip Danang', 'summary: the trip covering the date');
    assert(summaryOn('2026-10-04') === 'Company Trip Danang', 'summary: else the latest started trip');
    assert(summaryOn('2026-01-01') === 'JB', 'summary: else the newest trip');
    assert(summaryOn('2026-10-04', 'jb') === 'JB', 'summary: by name');
    const unknownTrip = pickSummaryTrip(trips, 'Vietnam', '2026-10-04');
    assert(
        'error' in unknownTrip && unknownTrip.error.includes('"JB"') && unknownTrip.ask,
        'summary: not found lists the trips and asks (the chat keeps the context for the answer)'
    );
    assert('error' in pickSummaryTrip([], undefined, '2026-10-04'), 'summary: no trips');

    const view = tripSummaryView({
        trip: danang,
        exchangedMyr: 400,
        fundReceived: 2_500_000,
        fundSpent: 2_055_000,
        fundSpentMyr: 328.8,
        fundRemaining: 445_000,
        cardMyr: 0,
        linkedMyr: 294.68,
        spentMyr: 623.48,
        tripTotalMyr: 694.68,
        days: 4,
        byCategory: [{ category: 'Food', amountMyr: 300.123, count: 5 }],
        latestExchangeRate: rate,
        expenses: [],
    });
    assert(
        view.perDayMyr === 155.87 && view.latestExchangeRate === 'RM1 = 6,250 VND' && view.byCategory[0].amountMyr === 300.12,
        `trip summary view → ${JSON.stringify(view)}`
    );
    const fallback = formatTripSummaryReply(view);
    assert(
        fallback.includes('Total spent: RM 623.48') && fallback.includes('Total cost: RM 694.68') && fallback.includes('Fund left: VND 445,000') && !fallback.includes('Card:'),
        `fallback uses the Trips panel labels:\n${fallback}`
    );

    console.log('tripExpenseService self-check ok');
}

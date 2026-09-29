import { eq } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { expenses } from '../db/schema';
import {
    appendExpense,
    type ExpenseBatchEntry,
    type ExpenseTripFields,
    type SkippedExpense,
} from './expenseService';
import { getLatestExchangeRate, listTrips, type Trip } from './tripService';

const HOME_CURRENCY = 'MYR';

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

/**
 * How one expense lands on the trip board — mirrors the Dashboard's trip legs:
 * - trip-currency cash → `fund` (spent from exchanged cash; MYR at the trip's exchange rate)
 * - trip-currency on a card/e-wallet → `card` (MYR estimated at the same rate)
 * - MYR marked as trip spending → plain row grouped into the trip
 */
export function planTripExpense(
    item: { amount: number; currency: string; paymentMethod: string | null; tripExpense?: boolean },
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
            reason: `${trip.name} has no exchange yet — add one in the Dashboard, then resend`,
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
        return (await this.trips()).filter(
            (t) => t.startDate && t.endDate && t.startDate <= date && date <= t.endDate
        );
    }

    rate(tripId: number): Promise<number | null> {
        let rate = this.rates.get(tripId);
        if (!rate) {
            rate = getLatestExchangeRate(tripId);
            this.rates.set(tripId, rate);
        }
        return rate;
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
                : `no ${currency} trip covers ${input.date} — fix the trip dates in the Dashboard, then resend`;
        return {
            status: 'skipped',
            skipped: { date: input.date, description: input.description, amount, currency, reason },
        };
    }

    const rate = trip && currency === trip.tripCurrency && currency !== HOME_CURRENCY ? await lookup.rate(trip.id) : null;
    const plan = planTripExpense(
        { amount, currency, paymentMethod: input.paymentMethod, tripExpense: input.tripExpense },
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
 * Correcting the amount on a trip-currency row (fund/card leg): a trip-currency amount
 * keeps the row's rate, an MYR amount keeps the foreign amount and re-derives the rate.
 */
export function recomputeTripLegAmount(
    row: { amount: number; fxAmount: number | null; fxCurrency: string | null; fxRate: number | null },
    newAmount: number,
    newCurrency: string | undefined
): { amount: number; currency: string; fxAmount: number; fxRate: number } | { error: string } {
    const { fxAmount, fxCurrency } = row;
    if (fxAmount == null || !(fxAmount > 0) || !fxCurrency) {
        return { error: 'this trip expense has no foreign amount to correct' };
    }
    if (!(newAmount > 0)) return { error: 'the new amount must be positive' };
    const currency = newCurrency?.trim().toUpperCase() || fxCurrency;
    if (currency === fxCurrency) {
        const rate = row.fxRate != null && row.fxRate > 0 ? row.fxRate : row.amount / fxAmount;
        return { amount: round2(newAmount * rate), currency: HOME_CURRENCY, fxAmount: newAmount, fxRate: rate };
    }
    if (currency === HOME_CURRENCY) {
        return { amount: newAmount, currency: HOME_CURRENCY, fxAmount, fxRate: newAmount / fxAmount };
    }
    return { error: `this is a ${fxCurrency} trip expense — give the amount in ${fxCurrency} or MYR` };
}

/** Trips worth telling the expense specialist about: ongoing, upcoming, or recently ended. */
export async function buildTripContextHint(todayIso: string): Promise<string> {
    const shift = (days: number) =>
        new Date(Date.parse(`${todayIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const from = shift(-60);
    const to = shift(14);
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
        'Do NOT convert currencies yourself—MYR conversion and trip linking are automatic.'
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
    const homeBill = planTripExpense({ amount: 41.9, currency: 'MYR', paymentMethod: 'RHB World Card' }, trip, rate);
    assert(homeBill.kind === 'plain', 'RM item not marked tripExpense stays off the trip');
    const noRate = planTripExpense({ amount: 32_000, currency: 'VND', paymentMethod: null }, trip, null);
    assert(noRate.kind === 'skip', 'VND with no exchange rate is skipped, not stored unconverted');
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

    const fundRow = { amount: 5.12, fxAmount: 32_000, fxCurrency: 'VND', fxRate: rate };
    const fixedVnd = recomputeTripLegAmount(fundRow, 40_000, 'VND');
    assert('fxAmount' in fixedVnd && fixedVnd.fxAmount === 40_000 && fixedVnd.amount === 6.4, `edit 40k → ${JSON.stringify(fixedVnd)}`);
    const fixedMyr = recomputeTripLegAmount(fundRow, 6, 'MYR');
    assert('fxAmount' in fixedMyr && fixedMyr.fxAmount === 32_000 && fixedMyr.amount === 6, `edit rm6 → ${JSON.stringify(fixedMyr)}`);
    assert('error' in recomputeTripLegAmount(fundRow, 5, 'USD'), 'other currency edit is rejected');

    console.log('tripExpenseService self-check ok');
}

import { and, desc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { expenses, trips } from '../db/schema';
import { resolveCategory } from '../config/expenseCategories';
import { displayPaymentMethod } from '../config/paymentMethods';
import type { TripLeg } from './expenseService';

export type Trip = {
    id: number;
    name: string;
    startDate: string | null;
    endDate: string | null;
    tripCurrency: string;
    notes: string | null;
};

export type TripWithTotals = Trip & {
    spentMyr: number;
    entryCount: number;
};

export type TripExpense = {
    id: number;
    date: string;
    amount: number;
    category: string;
    description: string;
    paymentMethod: string | null;
    tripLeg: TripLeg | null;
    fxAmount: number | null;
    fxCurrency: string | null;
    fxRate: number | null;
};

export type TripCategorySpend = {
    category: string;
    amountMyr: number;
    count: number;
};

export type TripSummary = {
    trip: Trip;
    exchangedMyr: number;
    fundReceived: number;
    fundSpent: number;
    /** MYR equivalent of fund spend, at the rate recorded on each entry. */
    fundSpentMyr: number;
    fundRemaining: number;
    cardMyr: number;
    /** Regular MYR transactions grouped into this trip (tripLeg null). */
    linkedMyr: number;
    /** What was actually spent: fund spend (MYR equiv) + card + linked. */
    spentMyr: number;
    /** Money that left MYR accounts: exchanges + card + linked. */
    tripTotalMyr: number;
    days: number | null;
    byCategory: TripCategorySpend[];
    latestExchangeRate: number | null;
    expenses: TripExpense[];
};

export type TripLinkCandidate = {
    id: number;
    date: string;
    amount: number;
    category: string;
    description: string;
    paymentMethod: string | null;
};

function mapTrip(row: typeof trips.$inferSelect): Trip {
    return {
        id: row.id,
        name: row.name,
        startDate: row.startDate ?? null,
        endDate: row.endDate ?? null,
        tripCurrency: row.tripCurrency,
        notes: row.notes ?? null,
    };
}

function mapTripExpense(row: typeof expenses.$inferSelect): TripExpense {
    return {
        id: row.id,
        date: row.date,
        amount: parseFloat(row.amount),
        category: resolveCategory(row.category),
        description: row.description,
        paymentMethod: displayPaymentMethod(row.paymentMethod),
        tripLeg: (row.tripLeg as TripLeg | null) ?? null,
        fxAmount: row.fxAmount != null ? parseFloat(row.fxAmount) : null,
        fxCurrency: row.fxCurrency ?? null,
        fxRate: row.fxRate != null ? parseFloat(row.fxRate) : null,
    };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Amount that counts as spending for a trip entry (exchanges are funding, not spend). */
function spendMyr(row: { tripLeg: string | null; amount: number }): number {
    return row.tripLeg === 'exchange' ? 0 : row.amount;
}

export async function listTrips(): Promise<TripWithTotals[]> {
    const db = requireDb();
    const [rows, tripRows] = await Promise.all([
        db.select().from(trips).orderBy(desc(trips.id)),
        db
            .select({ tripId: expenses.tripId, tripLeg: expenses.tripLeg, amount: expenses.amount })
            .from(expenses)
            .where(isNotNull(expenses.tripId)),
    ]);

    const totals = new Map<number, { spentMyr: number; entryCount: number }>();
    for (const row of tripRows) {
        if (row.tripId == null) continue;
        const t = totals.get(row.tripId) ?? { spentMyr: 0, entryCount: 0 };
        t.spentMyr += spendMyr({ tripLeg: row.tripLeg, amount: parseFloat(row.amount) });
        t.entryCount += 1;
        totals.set(row.tripId, t);
    }

    return rows.map((row) => ({
        ...mapTrip(row),
        spentMyr: round2(totals.get(row.id)?.spentMyr ?? 0),
        entryCount: totals.get(row.id)?.entryCount ?? 0,
    }));
}

export async function getTripById(id: number): Promise<Trip | null> {
    const db = requireDb();
    const rows = await db.select().from(trips).where(eq(trips.id, id)).limit(1);
    return rows[0] ? mapTrip(rows[0]) : null;
}

export async function createTrip(fields: {
    name: string;
    startDate?: string | null;
    endDate?: string | null;
    tripCurrency: string;
    notes?: string | null;
}): Promise<Trip> {
    const db = requireDb();
    const [row] = await db
        .insert(trips)
        .values({
            name: fields.name.trim(),
            startDate: fields.startDate ?? null,
            endDate: fields.endDate ?? null,
            tripCurrency: fields.tripCurrency.trim().toUpperCase(),
            notes: fields.notes?.trim() || null,
        })
        .returning();
    return mapTrip(row);
}

export async function updateTrip(
    id: number,
    fields: {
        name?: string;
        startDate?: string | null;
        endDate?: string | null;
        tripCurrency?: string;
        notes?: string | null;
    }
): Promise<Trip | null> {
    const db = requireDb();
    const set: Record<string, string | null> = {};
    if (fields.name != null) set.name = fields.name.trim();
    if (fields.startDate !== undefined) set.startDate = fields.startDate;
    if (fields.endDate !== undefined) set.endDate = fields.endDate;
    if (fields.tripCurrency != null) set.tripCurrency = fields.tripCurrency.trim().toUpperCase();
    if (fields.notes !== undefined) set.notes = fields.notes?.trim() || null;

    if (Object.keys(set).length === 0) {
        return getTripById(id);
    }

    await db.update(trips).set(set).where(eq(trips.id, id));
    return getTripById(id);
}

const TRIP_HAS_LEG_ENTRIES = 'Cannot delete trip with exchange / fund / card entries - delete those first';

/** Postgres foreign_key_violation; Drizzle wraps driver errors, so check `cause` too. */
function isForeignKeyViolation(err: unknown): boolean {
    const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
    return e?.cause?.code === '23503' || e?.code === '23503';
}

export async function deleteTrip(id: number): Promise<boolean> {
    try {
        return await requireDb().transaction(async (tx) => {
            const legEntries = await tx
                .select({ id: expenses.id })
                .from(expenses)
                .where(and(eq(expenses.tripId, id), isNotNull(expenses.tripLeg)))
                .limit(1);
            if (legEntries.length > 0) {
                throw new Error(TRIP_HAS_LEG_ENTRIES);
            }
            // Plain grouped transactions stay as normal expenses; just ungroup them.
            await tx
                .update(expenses)
                .set({ tripId: null })
                .where(and(eq(expenses.tripId, id), isNull(expenses.tripLeg)));
            const result = await tx.delete(trips).where(eq(trips.id, id));
            return (result.count ?? 0) > 0;
        });
    } catch (err) {
        // A leg entry logged after the check (e.g. from Telegram) still references the trip,
        // so the delete hits the expenses.trip_id foreign key and the ungroup is rolled back.
        if (isForeignKeyViolation(err)) throw new Error(TRIP_HAS_LEG_ENTRIES);
        throw err;
    }
}

export async function listTripExpenses(tripId: number): Promise<TripExpense[]> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(expenses)
        .where(eq(expenses.tripId, tripId))
        .orderBy(desc(expenses.date), desc(expenses.id));
    return rows.map(mapTripExpense);
}

/**
 * MYR per 1 foreign unit for an exchange. Derived from the two amounts first: fx_rate kept only
 * 6 decimals before migrate-fx-rate-precision.sql (0.000163265 → 0.000163 for VND), and older
 * rows saved it rounded to 0.
 */
export function exchangeRateOf(row: {
    amount: number;
    fxAmount: number | null;
    fxRate: number | null;
}): number | null {
    if (row.fxAmount != null && row.fxAmount > 0 && row.amount > 0) return row.amount / row.fxAmount;
    return row.fxRate != null && row.fxRate > 0 ? row.fxRate : null;
}

/** Latest exchange rate for the trip (MYR per 1 foreign), or null. */
export async function getLatestExchangeRate(tripId: number): Promise<number | null> {
    for (const row of await listTripExpenses(tripId)) {
        if (row.tripLeg !== 'exchange') continue;
        const rate = exchangeRateOf(row);
        if (rate != null) return rate;
    }
    return null;
}

/** Regular transactions (not in any trip, no trip leg) that could be grouped into a trip. */
export async function listLinkCandidates(start: string, end: string): Promise<TripLinkCandidate[]> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(expenses)
        .where(
            and(
                isNull(expenses.tripId),
                isNull(expenses.tripLeg),
                gte(expenses.date, start),
                lte(expenses.date, end)
            )
        )
        .orderBy(desc(expenses.date), desc(expenses.id));
    return rows.map((row) => ({
        id: row.id,
        date: row.date,
        amount: parseFloat(row.amount),
        category: resolveCategory(row.category),
        description: row.description,
        paymentMethod: displayPaymentMethod(row.paymentMethod),
    }));
}

/** Group existing regular transactions into a trip. Returns number linked. */
export async function linkExpensesToTrip(tripId: number, expenseIds: number[]): Promise<number> {
    if (expenseIds.length === 0) return 0;
    const db = requireDb();
    const updated = await db
        .update(expenses)
        .set({ tripId })
        .where(
            and(
                inArray(expenses.id, expenseIds),
                isNull(expenses.tripId),
                isNull(expenses.tripLeg)
            )
        )
        .returning({ id: expenses.id });
    return updated.length;
}

/** Remove a regular transaction from a trip group (trip-leg entries cannot be unlinked). */
export async function unlinkExpenseFromTrip(tripId: number, expenseId: number): Promise<boolean> {
    const db = requireDb();
    const updated = await db
        .update(expenses)
        .set({ tripId: null })
        .where(
            and(
                eq(expenses.id, expenseId),
                eq(expenses.tripId, tripId),
                isNull(expenses.tripLeg)
            )
        )
        .returning({ id: expenses.id });
    return updated.length > 0;
}

function tripDays(startDate: string | null, endDate: string | null): number | null {
    if (!startDate || !endDate) return null;
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return Math.round((end - start) / 86_400_000) + 1;
}

export async function getTripSummary(tripId: number): Promise<TripSummary | null> {
    const trip = await getTripById(tripId);
    if (!trip) return null;

    const expenseRows = await listTripExpenses(tripId);
    let exchangedMyr = 0;
    let fundReceived = 0;
    let fundSpent = 0;
    let fundSpentMyr = 0;
    let cardMyr = 0;
    let linkedMyr = 0;
    let latestExchangeRate: number | null = null;
    const categoryMap = new Map<string, TripCategorySpend>();

    for (const row of expenseRows) {
        if (row.tripLeg === 'exchange') {
            exchangedMyr += row.amount;
            fundReceived += row.fxAmount ?? 0;
            latestExchangeRate ??= exchangeRateOf(row);
        } else if (row.tripLeg === 'fund') {
            fundSpent += row.fxAmount ?? 0;
            fundSpentMyr += row.amount;
        } else if (row.tripLeg === 'card') {
            cardMyr += row.amount;
        } else {
            linkedMyr += row.amount;
        }

        const spend = spendMyr(row);
        if (spend > 0) {
            const entry = categoryMap.get(row.category) ?? {
                category: row.category,
                amountMyr: 0,
                count: 0,
            };
            entry.amountMyr += spend;
            entry.count += 1;
            categoryMap.set(row.category, entry);
        }
    }

    const byCategory = [...categoryMap.values()]
        .map((c) => ({ ...c, amountMyr: round2(c.amountMyr) }))
        .sort((a, b) => b.amountMyr - a.amountMyr);

    return {
        trip,
        exchangedMyr,
        fundReceived,
        fundSpent,
        fundSpentMyr: round2(fundSpentMyr),
        fundRemaining: fundReceived - fundSpent,
        cardMyr,
        linkedMyr: round2(linkedMyr),
        spentMyr: round2(fundSpentMyr + cardMyr + linkedMyr),
        tripTotalMyr: round2(exchangedMyr + cardMyr + linkedMyr),
        days: tripDays(trip.startDate, trip.endDate),
        byCategory,
        latestExchangeRate,
        expenses: expenseRows,
    };
}

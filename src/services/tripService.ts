import { desc, eq } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { expenses, trips } from '../db/schema';
import { resolveCategory } from '../config/expenseCategories';
import { resolvePaymentMethod } from '../config/paymentMethods';
import type { TripLeg } from './expenseService';

export type Trip = {
    id: number;
    name: string;
    startDate: string | null;
    endDate: string | null;
    tripCurrency: string;
    notes: string | null;
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

export type TripSummary = {
    trip: Trip;
    exchangedMyr: number;
    fundReceived: number;
    fundSpent: number;
    fundRemaining: number;
    cardMyr: number;
    tripTotalMyr: number;
    latestExchangeRate: number | null;
    expenses: TripExpense[];
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
        paymentMethod: row.paymentMethod ? resolvePaymentMethod(row.paymentMethod) : null,
        tripLeg: (row.tripLeg as TripLeg | null) ?? null,
        fxAmount: row.fxAmount != null ? parseFloat(row.fxAmount) : null,
        fxCurrency: row.fxCurrency ?? null,
        fxRate: row.fxRate != null ? parseFloat(row.fxRate) : null,
    };
}

export async function listTrips(): Promise<Trip[]> {
    const db = requireDb();
    const rows = await db.select().from(trips).orderBy(desc(trips.id));
    return rows.map(mapTrip);
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

export async function deleteTrip(id: number): Promise<boolean> {
    const db = requireDb();
    const linked = await db.select({ id: expenses.id }).from(expenses).where(eq(expenses.tripId, id)).limit(1);
    if (linked.length > 0) {
        throw new Error('Cannot delete trip with linked expenses');
    }
    const result = await db.delete(trips).where(eq(trips.id, id));
    return (result.count ?? 0) > 0;
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

/** Latest exchange fxRate for the trip (MYR per 1 foreign), or null. */
export async function getLatestExchangeRate(tripId: number): Promise<number | null> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(expenses)
        .where(eq(expenses.tripId, tripId))
        .orderBy(desc(expenses.date), desc(expenses.id));

    for (const row of rows) {
        if (row.tripLeg !== 'exchange') continue;
        if (row.fxRate != null) {
            const rate = parseFloat(row.fxRate);
            if (rate > 0) return rate;
        }
        if (row.fxAmount != null) {
            const fx = parseFloat(row.fxAmount);
            const myr = parseFloat(row.amount);
            if (fx > 0 && myr > 0) return myr / fx;
        }
    }
    return null;
}

export async function getTripSummary(tripId: number): Promise<TripSummary | null> {
    const trip = await getTripById(tripId);
    if (!trip) return null;

    const expenseRows = await listTripExpenses(tripId);
    let exchangedMyr = 0;
    let fundReceived = 0;
    let fundSpent = 0;
    let cardMyr = 0;
    let latestExchangeRate: number | null = null;

    for (const row of expenseRows) {
        if (row.tripLeg === 'exchange') {
            exchangedMyr += row.amount;
            fundReceived += row.fxAmount ?? 0;
            if (row.fxRate != null && row.fxRate > 0 && latestExchangeRate == null) {
                latestExchangeRate = row.fxRate;
            } else if (
                latestExchangeRate == null &&
                row.fxAmount != null &&
                row.fxAmount > 0
            ) {
                latestExchangeRate = row.amount / row.fxAmount;
            }
        } else if (row.tripLeg === 'fund') {
            fundSpent += row.fxAmount ?? 0;
        } else if (row.tripLeg === 'card') {
            cardMyr += row.amount;
        }
    }

    return {
        trip,
        exchangedMyr,
        fundReceived,
        fundSpent,
        fundRemaining: fundReceived - fundSpent,
        cardMyr,
        tripTotalMyr: exchangedMyr + cardMyr,
        latestExchangeRate,
        expenses: expenseRows,
    };
}

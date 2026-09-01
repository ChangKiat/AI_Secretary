import { and, asc, desc, eq, gte, lte } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { bodyWeightLogs, userSettings } from '../db/schema';
import { getOrCreateUserSettings } from './nutritionService';

export interface BodyWeightLogEntry {
    id: number;
    date: string;
    weightKg: number;
}

function parseLog(row: typeof bodyWeightLogs.$inferSelect): BodyWeightLogEntry {
    return {
        id: row.id,
        date: row.date,
        weightKg: parseFloat(row.weightKg),
    };
}

async function syncLatestBodyWeight(telegramUserId: number): Promise<number | null> {
    const db = requireDb();
    const latest = await db
        .select()
        .from(bodyWeightLogs)
        .where(eq(bodyWeightLogs.telegramUserId, telegramUserId))
        .orderBy(desc(bodyWeightLogs.date), desc(bodyWeightLogs.id))
        .limit(1);

    const weightKg = latest[0] ? parseFloat(latest[0].weightKg) : null;
    await getOrCreateUserSettings(telegramUserId);
    await db
        .update(userSettings)
        .set({ bodyWeightKg: weightKg != null ? String(weightKg) : null })
        .where(eq(userSettings.telegramUserId, telegramUserId));
    return weightKg;
}

export async function listBodyWeightLogs(
    telegramUserId: number,
    start?: string,
    end?: string
): Promise<BodyWeightLogEntry[]> {
    const db = requireDb();
    const conditions = [eq(bodyWeightLogs.telegramUserId, telegramUserId)];
    if (start) conditions.push(gte(bodyWeightLogs.date, start));
    if (end) conditions.push(lte(bodyWeightLogs.date, end));

    const rows = await db
        .select()
        .from(bodyWeightLogs)
        .where(and(...conditions))
        .orderBy(asc(bodyWeightLogs.date));

    return rows.map(parseLog);
}

export async function getRecentBodyWeightLogs(
    telegramUserId: number,
    limit = 2
): Promise<BodyWeightLogEntry[]> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(bodyWeightLogs)
        .where(eq(bodyWeightLogs.telegramUserId, telegramUserId))
        .orderBy(desc(bodyWeightLogs.date), desc(bodyWeightLogs.id))
        .limit(limit);
    return rows.map(parseLog);
}

export async function upsertBodyWeightLog(
    telegramUserId: number,
    date: string,
    weightKg: number
): Promise<BodyWeightLogEntry> {
    const db = requireDb();
    const existing = await db
        .select()
        .from(bodyWeightLogs)
        .where(
            and(
                eq(bodyWeightLogs.telegramUserId, telegramUserId),
                eq(bodyWeightLogs.date, date)
            )
        )
        .limit(1);

    let row: typeof bodyWeightLogs.$inferSelect;
    if (existing[0]) {
        const updated = await db
            .update(bodyWeightLogs)
            .set({ weightKg: String(weightKg) })
            .where(eq(bodyWeightLogs.id, existing[0].id))
            .returning();
        row = updated[0];
    } else {
        const inserted = await db
            .insert(bodyWeightLogs)
            .values({
                telegramUserId,
                date,
                weightKg: String(weightKg),
            })
            .returning();
        row = inserted[0];
    }

    await syncLatestBodyWeight(telegramUserId);
    return parseLog(row);
}

export async function deleteBodyWeightLog(
    id: number,
    telegramUserId: number
): Promise<boolean> {
    const db = requireDb();
    const result = await db
        .delete(bodyWeightLogs)
        .where(
            and(eq(bodyWeightLogs.id, id), eq(bodyWeightLogs.telegramUserId, telegramUserId))
        )
        .returning({ id: bodyWeightLogs.id });

    if (result.length === 0) return false;
    await syncLatestBodyWeight(telegramUserId);
    return true;
}

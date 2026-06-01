import { createClient } from '@supabase/supabase-js';
import { eq, and, gte, lte } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { meals, userSettings } from '../db/schema';

const DEFAULT_PROTEIN_TARGET = parseFloat(
    process.env.DEFAULT_PROTEIN_TARGET_G || '150'
);

function getSupabase() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;
    return createClient(url, key);
}

export async function getOrCreateUserSettings(telegramUserId: number) {
    const db = requireDb();
    const existing = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.telegramUserId, telegramUserId));

    if (existing.length > 0) {
        return {
            dailyProteinTargetG: parseFloat(existing[0].dailyProteinTargetG),
            timezone: existing[0].timezone,
        };
    }

    await db.insert(userSettings).values({
        telegramUserId,
        dailyProteinTargetG: String(DEFAULT_PROTEIN_TARGET),
        timezone: 'Asia/Kuala_Lumpur',
    });

    return { dailyProteinTargetG: DEFAULT_PROTEIN_TARGET, timezone: 'Asia/Kuala_Lumpur' };
}

export async function updateProteinTarget(telegramUserId: number, targetG: number) {
    const db = requireDb();
    await getOrCreateUserSettings(telegramUserId);
    await db
        .update(userSettings)
        .set({ dailyProteinTargetG: String(targetG) })
        .where(eq(userSettings.telegramUserId, telegramUserId));
}

export async function uploadMealPhoto(
    telegramUserId: number,
    fileBuffer: Buffer,
    mimeType: string
): Promise<string | null> {
    const supabase = getSupabase();
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'meal-photos';
    if (!supabase) return null;

    const path = `${telegramUserId}/${Date.now()}.${mimeType.includes('png') ? 'png' : 'jpg'}`;
    const { error } = await supabase.storage.from(bucket).upload(path, fileBuffer, {
        contentType: mimeType,
        upsert: false,
    });

    if (error) {
        console.error('Supabase Storage upload error:', error.message);
        return null;
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return data.publicUrl;
}

export async function logMeal(
    telegramUserId: number,
    date: string,
    description: string,
    proteinG: number,
    mealType?: string,
    carbsG?: number,
    fatG?: number,
    calories?: number,
    photoPath?: string
) {
    const db = requireDb();
    await db.insert(meals).values({
        telegramUserId,
        date,
        mealType: mealType ?? null,
        description,
        proteinG: String(proteinG),
        carbsG: carbsG != null ? String(carbsG) : null,
        fatG: fatG != null ? String(fatG) : null,
        calories: calories != null ? String(calories) : null,
        photoPath: photoPath ?? null,
    });
}

export async function getNutritionSummary(
    telegramUserId: number,
    startDate: string,
    endDate: string
) {
    const db = requireDb();
    const settings = await getOrCreateUserSettings(telegramUserId);
    const rows = await db
        .select()
        .from(meals)
        .where(
            and(
                eq(meals.telegramUserId, telegramUserId),
                gte(meals.date, startDate),
                lte(meals.date, endDate)
            )
        );

    let totalProtein = 0;
    let totalCalories = 0;
    const byDate: Record<string, { protein: number; meals: string[] }> = {};

    for (const row of rows) {
        const protein = parseFloat(row.proteinG);
        totalProtein += protein;
        if (row.calories) totalCalories += parseFloat(row.calories);

        if (!byDate[row.date]) byDate[row.date] = { protein: 0, meals: [] };
        byDate[row.date].protein += protein;
        byDate[row.date].meals.push(row.description);
    }

    const dayCount =
        Math.max(
            1,
            Math.ceil(
                (new Date(endDate).getTime() - new Date(startDate).getTime()) /
                    (1000 * 60 * 60 * 24)
            ) + 1
        );

    return {
        totalProtein,
        totalCalories,
        dailyTarget: settings.dailyProteinTargetG,
        byDate,
        mealCount: rows.length,
        daysInRange: dayCount,
    };
}

export async function getTodayProteinRemaining(telegramUserId: number, date: string) {
    const summary = await getNutritionSummary(telegramUserId, date, date);
    const consumed = summary.byDate[date]?.protein ?? 0;
    const remaining = Math.max(0, summary.dailyTarget - consumed);
    return { consumed, remaining, target: summary.dailyTarget };
}

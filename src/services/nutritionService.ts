import { createClient } from '@supabase/supabase-js';
import { eq, and, gte, lte, desc } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { meals, userSettings } from '../db/schema';

const DEFAULT_PROTEIN_TARGET = parseFloat(
    process.env.DEFAULT_PROTEIN_TARGET_G || '150'
);
const DEFAULT_CALORIE_TARGET = parseFloat(
    process.env.DEFAULT_CALORIE_TARGET || '2200'
);
const DEFAULT_CARBS_TARGET = parseFloat(process.env.DEFAULT_CARBS_TARGET_G || '250');
const DEFAULT_FAT_TARGET = parseFloat(process.env.DEFAULT_FAT_TARGET_G || '70');

export interface NutritionTargets {
    dailyProteinTargetG: number;
    dailyCalorieTarget: number;
    dailyCarbsTargetG: number;
    dailyFatTargetG: number;
    timezone: string;
}

export interface DayMacros {
    protein: number;
    carbs: number;
    fat: number;
    calories: number;
    meals: string[];
}

export interface MealLogInput {
    description: string;
    mealType?: string;
    proteinG: number;
    carbsG: number;
    fatG: number;
    calories: number;
}

function parseSettingsRow(row: typeof userSettings.$inferSelect): NutritionTargets {
    return {
        dailyProteinTargetG: parseFloat(row.dailyProteinTargetG),
        dailyCalorieTarget: parseFloat(row.dailyCalorieTarget),
        dailyCarbsTargetG: parseFloat(row.dailyCarbsTargetG),
        dailyFatTargetG: parseFloat(row.dailyFatTargetG),
        timezone: row.timezone,
    };
}

function getSupabase() {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return null;
    return createClient(url, key);
}

export async function getOrCreateUserSettings(telegramUserId: number): Promise<NutritionTargets> {
    const db = requireDb();
    const existing = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.telegramUserId, telegramUserId));

    if (existing.length > 0) {
        return parseSettingsRow(existing[0]);
    }

    await db.insert(userSettings).values({
        telegramUserId,
        dailyProteinTargetG: String(DEFAULT_PROTEIN_TARGET),
        dailyCalorieTarget: String(DEFAULT_CALORIE_TARGET),
        dailyCarbsTargetG: String(DEFAULT_CARBS_TARGET),
        dailyFatTargetG: String(DEFAULT_FAT_TARGET),
        timezone: 'Asia/Kuala_Lumpur',
    });

    return {
        dailyProteinTargetG: DEFAULT_PROTEIN_TARGET,
        dailyCalorieTarget: DEFAULT_CALORIE_TARGET,
        dailyCarbsTargetG: DEFAULT_CARBS_TARGET,
        dailyFatTargetG: DEFAULT_FAT_TARGET,
        timezone: 'Asia/Kuala_Lumpur',
    };
}

export async function getNutritionTargets(telegramUserId: number): Promise<NutritionTargets> {
    return getOrCreateUserSettings(telegramUserId);
}

export async function updateProteinTarget(telegramUserId: number, targetG: number) {
    await updateNutritionTargets(telegramUserId, { dailyProteinTargetG: targetG });
}

export async function updateNutritionTargets(
    telegramUserId: number,
    targets: Partial<
        Pick<
            NutritionTargets,
            'dailyProteinTargetG' | 'dailyCalorieTarget' | 'dailyCarbsTargetG' | 'dailyFatTargetG'
        >
    >
) {
    const db = requireDb();
    await getOrCreateUserSettings(telegramUserId);

    const set: Record<string, string> = {};
    if (targets.dailyProteinTargetG != null) {
        set.dailyProteinTargetG = String(targets.dailyProteinTargetG);
    }
    if (targets.dailyCalorieTarget != null) {
        set.dailyCalorieTarget = String(targets.dailyCalorieTarget);
    }
    if (targets.dailyCarbsTargetG != null) {
        set.dailyCarbsTargetG = String(targets.dailyCarbsTargetG);
    }
    if (targets.dailyFatTargetG != null) {
        set.dailyFatTargetG = String(targets.dailyFatTargetG);
    }

    if (Object.keys(set).length > 0) {
        await db
            .update(userSettings)
            .set(set)
            .where(eq(userSettings.telegramUserId, telegramUserId));
    }
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

function emptyDayMacros(): DayMacros {
    return { protein: 0, carbs: 0, fat: 0, calories: 0, meals: [] };
}

function addRowToDay(byDate: Record<string, DayMacros>, row: typeof meals.$inferSelect) {
    if (!byDate[row.date]) byDate[row.date] = emptyDayMacros();
    const day = byDate[row.date];
    day.protein += parseFloat(row.proteinG);
    if (row.carbsG) day.carbs += parseFloat(row.carbsG);
    if (row.fatG) day.fat += parseFloat(row.fatG);
    if (row.calories) day.calories += parseFloat(row.calories);
    day.meals.push(row.description);
}

export function buildDayProgress(
    consumed: DayMacros,
    targets: NutritionTargets
) {
    return {
        calories: {
            consumed: Math.round(consumed.calories),
            target: targets.dailyCalorieTarget,
            remaining: Math.max(0, targets.dailyCalorieTarget - consumed.calories),
        },
        protein: {
            consumed: Math.round(consumed.protein),
            target: targets.dailyProteinTargetG,
            remaining: Math.max(0, targets.dailyProteinTargetG - consumed.protein),
        },
        carbs: {
            consumed: Math.round(consumed.carbs),
            target: targets.dailyCarbsTargetG,
            remaining: Math.max(0, targets.dailyCarbsTargetG - consumed.carbs),
        },
        fat: {
            consumed: Math.round(consumed.fat),
            target: targets.dailyFatTargetG,
            remaining: Math.max(0, targets.dailyFatTargetG - consumed.fat),
        },
    };
}

export async function getNutritionSummary(
    telegramUserId: number,
    startDate: string,
    endDate: string
) {
    const db = requireDb();
    const targets = await getOrCreateUserSettings(telegramUserId);
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
    let totalCarbs = 0;
    let totalFat = 0;
    let totalCalories = 0;
    const byDate: Record<string, DayMacros> = {};

    for (const row of rows) {
        const protein = parseFloat(row.proteinG);
        const carbs = row.carbsG ? parseFloat(row.carbsG) : 0;
        const fat = row.fatG ? parseFloat(row.fatG) : 0;
        const calories = row.calories ? parseFloat(row.calories) : 0;

        totalProtein += protein;
        totalCarbs += carbs;
        totalFat += fat;
        totalCalories += calories;
        addRowToDay(byDate, row);
    }

    const dayCount = Math.max(
        1,
        Math.ceil(
            (new Date(endDate).getTime() - new Date(startDate).getTime()) /
                (1000 * 60 * 60 * 24)
        ) + 1
    );

    const rangeTotals: DayMacros = {
        protein: totalProtein,
        carbs: totalCarbs,
        fat: totalFat,
        calories: totalCalories,
        meals: [],
    };
    const progressByDate: Record<string, ReturnType<typeof buildDayProgress>> = {};
    for (const [date, day] of Object.entries(byDate)) {
        progressByDate[date] = buildDayProgress(day, targets);
    }

    return {
        totalProtein: Math.round(totalProtein),
        totalCarbs: Math.round(totalCarbs),
        totalFat: Math.round(totalFat),
        totalCalories: Math.round(totalCalories),
        targets,
        dailyTarget: targets.dailyProteinTargetG,
        byDate,
        progressByDate,
        rangeProgress: buildDayProgress(rangeTotals, targets),
        mealCount: rows.length,
        daysInRange: dayCount,
    };
}

export async function getTodayMacroProgress(telegramUserId: number, date: string) {
    const summary = await getNutritionSummary(telegramUserId, date, date);
    const consumed = summary.byDate[date] ?? emptyDayMacros();
    return {
        consumed,
        progress: buildDayProgress(consumed, summary.targets),
        targets: summary.targets,
    };
}

export function formatMealLogReply(meal: MealLogInput, date: string, todayProgress: ReturnType<typeof buildDayProgress>) {
    const mealLine = meal.mealType
        ? `${meal.description} (${meal.mealType})`
        : meal.description;
    const p = Math.round(meal.proteinG);
    const c = Math.round(meal.carbsG);
    const f = Math.round(meal.fatG);
    const cal = Math.round(meal.calories);

    const t = todayProgress;
    return (
        `🍽️ ${mealLine}\n` +
        `Cal ${cal} · Protein ${p}g · Carbs ${c}g · Fat ${f}g\n` +
        `Today: ${t.calories.consumed}/${t.calories.target} cal · ` +
        `Protein ${t.protein.consumed}/${t.protein.target}g · ` +
        `Carbs ${t.carbs.consumed}/${t.carbs.target}g · ` +
        `Fat ${t.fat.consumed}/${t.fat.target}g\n` +
        `(approximate estimates)`
    );
}

export async function getMealHistory(
    telegramUserId: number,
    startDate: string,
    endDate: string
) {
    const db = requireDb();
    const rows = await db
        .select()
        .from(meals)
        .where(
            and(
                eq(meals.telegramUserId, telegramUserId),
                gte(meals.date, startDate),
                lte(meals.date, endDate)
            )
        )
        .orderBy(desc(meals.date), desc(meals.id));

    return rows.map((row) => ({
        id: row.id,
        date: row.date,
        mealType: row.mealType,
        description: row.description,
        proteinG: parseFloat(row.proteinG),
        carbsG: row.carbsG ? parseFloat(row.carbsG) : null,
        fatG: row.fatG ? parseFloat(row.fatG) : null,
        calories: row.calories ? parseFloat(row.calories) : null,
    }));
}

export async function updateMeal(
    id: number,
    telegramUserId: number,
    fields: {
        date?: string;
        description?: string;
        mealType?: string | null;
        proteinG?: number;
        carbsG?: number | null;
        fatG?: number | null;
        calories?: number | null;
    }
): Promise<boolean> {
    const db = requireDb();
    const set: Record<string, string | null> = {};

    if (fields.date != null) set.date = fields.date;
    if (fields.description != null) set.description = fields.description;
    if (fields.mealType !== undefined) set.mealType = fields.mealType;
    if (fields.proteinG != null) set.proteinG = String(fields.proteinG);
    if (fields.carbsG !== undefined) {
        set.carbsG = fields.carbsG != null ? String(fields.carbsG) : null;
    }
    if (fields.fatG !== undefined) {
        set.fatG = fields.fatG != null ? String(fields.fatG) : null;
    }
    if (fields.calories !== undefined) {
        set.calories = fields.calories != null ? String(fields.calories) : null;
    }

    if (Object.keys(set).length === 0) return false;

    const result = await db
        .update(meals)
        .set(set)
        .where(and(eq(meals.id, id), eq(meals.telegramUserId, telegramUserId)));

    return (result.count ?? 0) > 0;
}

export async function deleteMeal(id: number, telegramUserId: number): Promise<boolean> {
    const db = requireDb();
    const result = await db
        .delete(meals)
        .where(and(eq(meals.id, id), eq(meals.telegramUserId, telegramUserId)));

    return (result.count ?? 0) > 0;
}

export async function getTodayProteinRemaining(telegramUserId: number, date: string) {
    const { progress, targets } = await getTodayMacroProgress(telegramUserId, date);
    return {
        consumed: progress.protein.consumed,
        remaining: progress.protein.remaining,
        target: targets.dailyProteinTargetG,
        caloriesRemaining: progress.calories.remaining,
        carbsRemaining: progress.carbs.remaining,
        fatRemaining: progress.fat.remaining,
        progress,
        targets,
    };
}

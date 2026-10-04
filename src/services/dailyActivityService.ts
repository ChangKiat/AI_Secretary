import { and, asc, eq, gte, lte } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { dailyActivityLogs } from '../db/schema';
import { getWorkoutHistory } from './gymService';
import {
    caloriesFromSteps,
    computeBMR,
    getOrCreateUserSettings,
    type NutritionTargets,
} from './nutritionService';

export interface DailyActivityLogEntry {
    id: number;
    date: string;
    steps: number;
}

/** One day of the Dashboard "calories burned" series (HealthSection burnSeries). */
export interface DailyBurnDay {
    date: string;
    /** Sum of that day's workout caloriesBurned (rows without a value count as 0). */
    workoutKcal: number;
    steps: number;
    /** caloriesFromSteps(steps, bodyWeightKg). */
    stepKcal: number;
    /** computeBMR(...) ?? 0, the same resting baseline on every day. */
    bmr: number;
    /** Math.round(workoutKcal + stepKcal + bmr). Days where this is 0 are dropped. */
    totalKcal: number;
}

export interface DailyBurnSeries {
    days: DailyBurnDay[];
    /** computeBMR result, or null when weight/height/age/sex is missing (days then use 0). */
    bmrPerDay: number | null;
    /** Rounded sum of stepKcal over the returned days. */
    totalStepCalories: number;
    /** Sum of the days' totalKcal; equals the Dashboard Health "calories burned" total. */
    totalEnergyBurned: number;
}

function todayInKL(): string {
    const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' }));
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function addDaysISO(date: string, days: number): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

function assertISODate(label: string, value: string): void {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        throw new Error(`Invalid ${label} date "${value}" (expected YYYY-MM-DD)`);
    }
}

/**
 * Pure core of getDailyBurnSeries, mirroring Dashboard HealthSection burnSeries:
 * every date from start to min(end, today) plus any date in [start, end] with
 * workouts or steps; zero-total days are dropped.
 */
export function buildDailyBurnSeries(input: {
    start: string;
    end: string;
    today: string;
    workouts: { date: string; caloriesBurned: number | null }[];
    activity: { date: string; steps: number }[];
    settings: Pick<NutritionTargets, 'bodyWeightKg' | 'heightCm' | 'age' | 'sex'>;
}): DailyBurnSeries {
    const { start, end, today, settings } = input;
    assertISODate('start', start);
    assertISODate('end', end);
    assertISODate('today', today);
    const inRange = (date: string) => date >= start && date <= end;

    const workoutByDate = new Map<string, number>();
    for (const entry of input.workouts) {
        if (entry.caloriesBurned == null || !inRange(entry.date)) continue;
        workoutByDate.set(entry.date, (workoutByDate.get(entry.date) ?? 0) + entry.caloriesBurned);
    }
    const stepsByDate = new Map<string, number>();
    for (const entry of input.activity) {
        if (inRange(entry.date)) stepsByDate.set(entry.date, entry.steps);
    }

    const dates = new Set<string>();
    const last = end < today ? end : today;
    for (let date = start; date <= last; date = addDaysISO(date, 1)) dates.add(date);
    for (const date of workoutByDate.keys()) dates.add(date);
    for (const date of stepsByDate.keys()) dates.add(date);

    const bmrPerDay = computeBMR(settings.bodyWeightKg, settings.heightCm, settings.age, settings.sex);
    const bmr = bmrPerDay ?? 0;
    const days = [...dates]
        .sort()
        .map((date): DailyBurnDay => {
            const workoutKcal = workoutByDate.get(date) ?? 0;
            const steps = stepsByDate.get(date) ?? 0;
            const stepKcal = caloriesFromSteps(steps, settings.bodyWeightKg);
            return {
                date,
                workoutKcal,
                steps,
                stepKcal,
                bmr,
                totalKcal: Math.round(workoutKcal + stepKcal + bmr),
            };
        })
        .filter((d) => d.totalKcal > 0);

    return {
        days,
        bmrPerDay,
        totalStepCalories: Math.round(days.reduce((sum, d) => sum + d.stepKcal, 0)),
        totalEnergyBurned: days.reduce((sum, d) => sum + d.totalKcal, 0),
    };
}

/**
 * Daily energy burned (workouts + steps + BMR) for start..end, "today" in
 * Asia/Kuala_Lumpur. Same numbers as the Dashboard Health "calories burned".
 */
export async function getDailyBurnSeries(
    telegramUserId: number,
    start: string,
    end: string
): Promise<DailyBurnSeries> {
    assertISODate('start', start);
    assertISODate('end', end);
    const [workouts, activity, settings] = await Promise.all([
        getWorkoutHistory(telegramUserId, start, end),
        listDailyActivityLogs(telegramUserId, start, end),
        getOrCreateUserSettings(telegramUserId),
    ]);
    return buildDailyBurnSeries({ start, end, today: todayInKL(), workouts, activity, settings });
}

function parseLog(row: typeof dailyActivityLogs.$inferSelect): DailyActivityLogEntry {
    return {
        id: row.id,
        date: row.date,
        steps: row.steps,
    };
}

export async function listDailyActivityLogs(
    telegramUserId: number,
    start?: string,
    end?: string
): Promise<DailyActivityLogEntry[]> {
    const db = requireDb();
    const conditions = [eq(dailyActivityLogs.telegramUserId, telegramUserId)];
    if (start) conditions.push(gte(dailyActivityLogs.date, start));
    if (end) conditions.push(lte(dailyActivityLogs.date, end));

    const rows = await db
        .select()
        .from(dailyActivityLogs)
        .where(and(...conditions))
        .orderBy(asc(dailyActivityLogs.date));

    return rows.map(parseLog);
}

export async function upsertDailyActivityLog(
    telegramUserId: number,
    date: string,
    steps: number
): Promise<DailyActivityLogEntry> {
    const db = requireDb();
    const existing = await db
        .select()
        .from(dailyActivityLogs)
        .where(
            and(
                eq(dailyActivityLogs.telegramUserId, telegramUserId),
                eq(dailyActivityLogs.date, date)
            )
        )
        .limit(1);

    let row: typeof dailyActivityLogs.$inferSelect;
    if (existing[0]) {
        const updated = await db
            .update(dailyActivityLogs)
            .set({ steps })
            .where(eq(dailyActivityLogs.id, existing[0].id))
            .returning();
        row = updated[0];
    } else {
        const inserted = await db
            .insert(dailyActivityLogs)
            .values({ telegramUserId, date, steps })
            .returning();
        row = inserted[0];
    }

    return parseLog(row);
}

export async function deleteDailyActivityLog(
    id: number,
    telegramUserId: number
): Promise<boolean> {
    const db = requireDb();
    const result = await db
        .delete(dailyActivityLogs)
        .where(
            and(eq(dailyActivityLogs.id, id), eq(dailyActivityLogs.telegramUserId, telegramUserId))
        )
        .returning({ id: dailyActivityLogs.id });

    return result.length > 0;
}

// ponytail self-check: burn series without DB
if (require.main === module) {
    const fail = (msg: string, value: unknown) => {
        throw new Error(`${msg}: ${JSON.stringify(value)}`);
    };
    const profile = { bodyWeightKg: 70, heightCm: 175, age: 30, sex: 'male' as const };
    // BMR = 700 + 1093.75 - 150 + 5 = 1648.75; 10,000 steps at 70kg = 350 kcal
    const june = buildDailyBurnSeries({
        start: '2026-06-01',
        end: '2026-06-30',
        today: '2026-06-03',
        workouts: [
            { date: '2026-06-02', caloriesBurned: 100.4 },
            { date: '2026-06-02', caloriesBurned: null },
            { date: '2026-06-10', caloriesBurned: 50 },
            { date: '2026-07-01', caloriesBurned: 999 },
        ],
        activity: [{ date: '2026-06-02', steps: 10000 }],
        settings: profile,
    });
    const juneTotals = june.days.map((d) => `${d.date}=${d.totalKcal}`).join(',');
    if (juneTotals !== '2026-06-01=1649,2026-06-02=2099,2026-06-03=1649,2026-06-10=1699') {
        fail('burn series with BMR failed', june.days);
    }
    if (
        june.bmrPerDay !== 1648.75 ||
        june.totalStepCalories !== 350 ||
        june.totalEnergyBurned !== 7096
    ) {
        fail('burn series totals failed', june);
    }

    const noProfile = buildDailyBurnSeries({
        start: '2026-06-01',
        end: '2026-06-30',
        today: '2026-06-03',
        workouts: [{ date: '2026-06-10', caloriesBurned: 50 }],
        activity: [{ date: '2026-06-02', steps: 10000 }],
        settings: { bodyWeightKg: null, heightCm: null, age: null, sex: null },
    });
    if (
        noProfile.bmrPerDay !== null ||
        noProfile.days.map((d) => `${d.date}=${d.totalKcal}`).join(',') !==
            '2026-06-02=350,2026-06-10=50'
    ) {
        fail('burn series without BMR should drop zero days', noProfile);
    }

    const future = buildDailyBurnSeries({
        start: '2026-07-01',
        end: '2026-07-31',
        today: '2026-06-03',
        workouts: [],
        activity: [],
        settings: profile,
    });
    if (future.days.length !== 0 || future.totalEnergyBurned !== 0) {
        fail('future range should be empty', future);
    }

    const acrossMonths = buildDailyBurnSeries({
        start: '2026-02-27',
        end: '2026-03-02',
        today: '2026-12-31',
        workouts: [],
        activity: [],
        settings: profile,
    });
    if (
        acrossMonths.days.map((d) => d.date).join(',') !==
        '2026-02-27,2026-02-28,2026-03-01,2026-03-02'
    ) {
        fail('date walk across month end failed', acrossMonths.days);
    }

    let threw = false;
    try {
        buildDailyBurnSeries({
            start: '2026-02-31',
            end: '2026-03-02',
            today: '2026-12-31',
            workouts: [],
            activity: [],
            settings: profile,
        });
    } catch {
        threw = true;
    }
    if (!threw) fail('invalid start date should throw', '2026-02-31');

    console.log('dailyActivityService self-check ok');
}

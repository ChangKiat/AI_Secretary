import { and, eq, desc } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { workouts } from '../db/schema';

export async function logWorkout(
    telegramUserId: number,
    date: string,
    exercise: string,
    sets?: number,
    reps?: number,
    weightKg?: number,
    durationMin?: number,
    notes?: string
) {
    const db = requireDb();
    const row = {
        telegramUserId,
        date,
        exercise,
        sets: sets ?? null,
        reps: reps ?? null,
        weightKg: weightKg != null ? String(weightKg) : null,
        durationMin: durationMin != null ? String(durationMin) : null,
        notes: notes ?? null,
    };
    await db.insert(workouts).values(row);
}

export async function getWorkoutHistory(
    telegramUserId: number,
    startDate?: string,
    endDate?: string,
    exercise?: string
) {
    const db = requireDb();
    const rows = await db
        .select()
        .from(workouts)
        .where(eq(workouts.telegramUserId, telegramUserId))
        .orderBy(desc(workouts.date), desc(workouts.id));

    return rows
        .filter((row) => {
            if (startDate && row.date < startDate) return false;
            if (endDate && row.date > endDate) return false;
            if (exercise && !row.exercise.toLowerCase().includes(exercise.toLowerCase()))
                return false;
            return true;
        })
        .map((row) => ({
            id: row.id,
            date: row.date,
            exercise: row.exercise,
            sets: row.sets,
            reps: row.reps,
            weightKg: row.weightKg ? parseFloat(row.weightKg) : null,
            durationMin: row.durationMin ? parseFloat(row.durationMin) : null,
            notes: row.notes,
        }));
}

export async function updateWorkout(
    id: number,
    telegramUserId: number,
    fields: {
        date?: string;
        exercise?: string;
        sets?: number | null;
        reps?: number | null;
        weightKg?: number | null;
        durationMin?: number | null;
        notes?: string | null;
    }
): Promise<boolean> {
    const db = requireDb();
    const set: Record<string, string | number | null> = {};

    if (fields.date != null) set.date = fields.date;
    if (fields.exercise != null) set.exercise = fields.exercise;
    if (fields.sets !== undefined) set.sets = fields.sets;
    if (fields.reps !== undefined) set.reps = fields.reps;
    if (fields.weightKg !== undefined) {
        set.weightKg = fields.weightKg != null ? String(fields.weightKg) : null;
    }
    if (fields.durationMin !== undefined) {
        set.durationMin = fields.durationMin != null ? String(fields.durationMin) : null;
    }
    if (fields.notes !== undefined) set.notes = fields.notes;

    if (Object.keys(set).length === 0) return false;

    const result = await db
        .update(workouts)
        .set(set)
        .where(and(eq(workouts.id, id), eq(workouts.telegramUserId, telegramUserId)));

    return (result.count ?? 0) > 0;
}

export async function deleteWorkout(id: number, telegramUserId: number): Promise<boolean> {
    const db = requireDb();
    const result = await db
        .delete(workouts)
        .where(and(eq(workouts.id, id), eq(workouts.telegramUserId, telegramUserId)));

    return (result.count ?? 0) > 0;
}

export async function getRecentWorkoutsForSuggestion(
    telegramUserId: number,
    daysBack = 14
) {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - daysBack);
    const startStr = start.toISOString().slice(0, 10);
    const endStr = end.toISOString().slice(0, 10);

    const history = await getWorkoutHistory(telegramUserId, startStr, endStr);

    const exerciseCounts: Record<string, number> = {};
    for (const w of history) {
        exerciseCounts[w.exercise] = (exerciseCounts[w.exercise] || 0) + 1;
    }

    return { history, exerciseCounts, daysBack };
}

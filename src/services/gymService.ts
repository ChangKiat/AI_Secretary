import { and, eq, desc } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { workouts } from '../db/schema';

export interface WorkoutLogEntry {
    date: string;
    exercise: string;
    sets?: number;
    reps?: number;
    weightKg?: number;
    durationMin?: number;
    notes?: string;
    burn?: { caloriesBurned: number; fatBurnG: number } | null;
}

export interface WorkoutExerciseRecord {
    id: number;
    date: string;
    exercise: string;
    sets: number | null;
    reps: number | null;
    weightKg: number | null;
    durationMin: number | null;
    notes: string | null;
    caloriesBurned: number | null;
    fatBurnG: number | null;
    sessionId: string | null;
    sessionLabel: string | null;
}

export interface WorkoutSessionGroup {
    sessionId: string;
    sessionLabel: string | null;
    date: string;
    exercises: WorkoutExerciseRecord[];
    totalCaloriesBurned: number;
    totalFatBurnG: number;
}

function formatWorkoutDetail(entry: Pick<WorkoutLogEntry, 'sets' | 'reps' | 'weightKg' | 'durationMin'>): string {
    return [
        entry.sets && entry.reps ? `${entry.sets}x${entry.reps}` : entry.sets ? `${entry.sets} sets` : null,
        entry.durationMin != null
            ? entry.durationMin < 1
                ? `${Math.round(entry.durationMin * 60)}sec`
                : `${entry.durationMin}min`
            : null,
        entry.weightKg ? `${entry.weightKg}kg` : null,
    ]
        .filter(Boolean)
        .join(' @ ');
}

export function applyWorkoutDefaults<T extends { sets?: number; reps?: number }>(
    workout: T,
    defaultSets?: number,
    defaultReps?: number
): T {
    return {
        ...workout,
        sets: workout.sets ?? defaultSets,
        reps: workout.reps ?? defaultReps,
    };
}

function mapRowToExercise(row: typeof workouts.$inferSelect): WorkoutExerciseRecord {
    return {
        id: row.id,
        date: row.date,
        exercise: row.exercise,
        sets: row.sets,
        reps: row.reps,
        weightKg: row.weightKg ? parseFloat(row.weightKg) : null,
        durationMin: row.durationMin ? parseFloat(row.durationMin) : null,
        notes: row.notes,
        caloriesBurned: row.caloriesBurned ? parseFloat(row.caloriesBurned) : null,
        fatBurnG: row.fatBurnedG ? parseFloat(row.fatBurnedG) : null,
        sessionId: row.sessionId,
        sessionLabel: row.sessionLabel,
    };
}

function sumBurn(exercises: WorkoutExerciseRecord[]): { totalCaloriesBurned: number; totalFatBurnG: number } {
    let totalCaloriesBurned = 0;
    let totalFatBurnG = 0;
    for (const ex of exercises) {
        if (ex.caloriesBurned != null) totalCaloriesBurned += ex.caloriesBurned;
        if (ex.fatBurnG != null) totalFatBurnG += ex.fatBurnG;
    }
    return {
        totalCaloriesBurned: Math.round(totalCaloriesBurned),
        totalFatBurnG: Math.round(totalFatBurnG * 10) / 10,
    };
}

export function groupWorkoutsBySession(exercises: WorkoutExerciseRecord[]): {
    sessions: WorkoutSessionGroup[];
    standalone: WorkoutExerciseRecord[];
} {
    const sessionMap = new Map<string, WorkoutExerciseRecord[]>();
    const standalone: WorkoutExerciseRecord[] = [];

    for (const ex of exercises) {
        if (ex.sessionId) {
            const list = sessionMap.get(ex.sessionId) ?? [];
            list.push(ex);
            sessionMap.set(ex.sessionId, list);
        } else {
            standalone.push(ex);
        }
    }

    const sessions: WorkoutSessionGroup[] = [];
    for (const [sessionId, group] of sessionMap) {
        const burn = sumBurn(group);
        sessions.push({
            sessionId,
            sessionLabel: group.find((e) => e.sessionLabel)?.sessionLabel ?? null,
            date: group[0].date,
            exercises: group,
            ...burn,
        });
    }

    sessions.sort((a, b) => b.date.localeCompare(a.date) || b.sessionId.localeCompare(a.sessionId));
    return { sessions, standalone };
}

export function countWorkoutSessions(exercises: WorkoutExerciseRecord[]): number {
    const sessionIds = new Set<string>();
    let count = 0;
    for (const ex of exercises) {
        if (ex.sessionId) {
            sessionIds.add(ex.sessionId);
        } else {
            count++;
        }
    }
    return count + sessionIds.size;
}

export function formatWorkoutLogReply(
    date: string,
    exercise: string,
    opts: {
        sets?: number;
        reps?: number;
        weightKg?: number;
        durationMin?: number;
        notes?: string;
        burn?: { caloriesBurned: number; fatBurnG: number } | null;
    }
): string {
    const detail = formatWorkoutDetail(opts);

    const lines = ['✅ Logged', `📅 Date: ${date}`, `💪 Exercise: ${exercise}`];
    if (detail) lines.push(`📊 Details: ${detail}`);
    if (opts.burn) {
        lines.push(
            `🔥 Burn: ~${opts.burn.caloriesBurned} cal · ~${opts.burn.fatBurnG}g fat (approx.)`
        );
    } else {
        lines.push('💡 Tip: Set your body weight (e.g. "I weigh 70kg") for burn estimates.');
    }
    if (opts.notes) lines.push(`📝 Notes: ${opts.notes}`);
    return lines.join('\n');
}

export function formatBulkWorkoutLogReply(
    date: string,
    entries: WorkoutLogEntry[],
    sessionLabel?: string
): string {
    const lines = ['✅ Logged', `📅 Date: ${date}`];
    if (sessionLabel) lines.push(`📋 Session: ${sessionLabel}`);
    lines.push('');
    for (const entry of entries) {
        const detail = formatWorkoutDetail(entry);
        let line = `• ${entry.exercise}`;
        if (detail) line += ` — ${detail}`;
        if (entry.notes) line += ` (${entry.notes})`;
        lines.push(line);
    }

    let totalCal = 0;
    let totalFat = 0;
    let hasBurn = false;
    for (const entry of entries) {
        if (entry.burn) {
            totalCal += entry.burn.caloriesBurned;
            totalFat += entry.burn.fatBurnG;
            hasBurn = true;
        }
    }

    lines.push('');
    if (hasBurn) {
        lines.push(
            `🔥 Total burn: ~${Math.round(totalCal)} cal · ~${Math.round(totalFat * 10) / 10}g fat (approx.)`
        );
    } else {
        lines.push('💡 Tip: Set your body weight (e.g. "I weigh 70kg") for burn estimates.');
    }
    return lines.join('\n');
}

export async function logWorkout(
    telegramUserId: number,
    date: string,
    exercise: string,
    sets?: number,
    reps?: number,
    weightKg?: number,
    durationMin?: number,
    notes?: string,
    caloriesBurned?: number | null,
    fatBurnG?: number | null,
    sessionId?: string | null,
    sessionLabel?: string | null
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
        caloriesBurned: caloriesBurned != null ? String(caloriesBurned) : null,
        fatBurnedG: fatBurnG != null ? String(fatBurnG) : null,
        sessionId: sessionId ?? null,
        sessionLabel: sessionLabel ?? null,
    };
    await db.insert(workouts).values(row);
}

export async function logBulkWorkouts(
    telegramUserId: number,
    workoutList: {
        date: string;
        exercise: string;
        sets?: number;
        reps?: number;
        weightKg?: number;
        durationMin?: number;
        notes?: string;
        caloriesBurned?: number | null;
        fatBurnG?: number | null;
    }[],
    sessionId?: string | null,
    sessionLabel?: string | null
) {
    const db = requireDb();
    await db.insert(workouts).values(
        workoutList.map((w) => ({
            telegramUserId,
            date: w.date,
            exercise: w.exercise,
            sets: w.sets ?? null,
            reps: w.reps ?? null,
            weightKg: w.weightKg != null ? String(w.weightKg) : null,
            durationMin: w.durationMin != null ? String(w.durationMin) : null,
            notes: w.notes ?? null,
            caloriesBurned: w.caloriesBurned != null ? String(w.caloriesBurned) : null,
            fatBurnedG: w.fatBurnG != null ? String(w.fatBurnG) : null,
            sessionId: sessionId ?? null,
            sessionLabel: sessionLabel ?? null,
        }))
    );
}

export async function getWorkoutHistory(
    telegramUserId: number,
    startDate?: string,
    endDate?: string,
    exercise?: string
): Promise<WorkoutExerciseRecord[]> {
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
        .map(mapRowToExercise);
}

export async function getWorkoutHistoryGrouped(
    telegramUserId: number,
    startDate?: string,
    endDate?: string,
    exercise?: string
) {
    const exercises = await getWorkoutHistory(telegramUserId, startDate, endDate, exercise);
    return groupWorkoutsBySession(exercises);
}

export async function getWorkoutBurnSummary(
    telegramUserId: number,
    startDate: string,
    endDate: string
) {
    const exercises = await getWorkoutHistory(telegramUserId, startDate, endDate);
    const grouped = groupWorkoutsBySession(exercises);

    let totalCaloriesBurned = 0;
    let totalFatBurnG = 0;
    let sessionsWithBurn = 0;

    for (const ex of exercises) {
        if (ex.caloriesBurned != null) {
            totalCaloriesBurned += ex.caloriesBurned;
            sessionsWithBurn++;
        }
        if (ex.fatBurnG != null) {
            totalFatBurnG += ex.fatBurnG;
        }
    }

    return {
        startDate,
        endDate,
        sessions: grouped.sessions,
        standalone: grouped.standalone,
        exercises,
        sessionCount: countWorkoutSessions(exercises),
        exerciseCount: exercises.length,
        sessionsWithBurn,
        totalCaloriesBurned: Math.round(totalCaloriesBurned),
        totalFatBurnG: Math.round(totalFatBurnG * 10) / 10,
    };
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
        caloriesBurned?: number | null;
        fatBurnG?: number | null;
        sessionId?: string | null;
        sessionLabel?: string | null;
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
    if (fields.caloriesBurned !== undefined) {
        set.caloriesBurned =
            fields.caloriesBurned != null ? String(fields.caloriesBurned) : null;
    }
    if (fields.fatBurnG !== undefined) {
        set.fatBurnedG = fields.fatBurnG != null ? String(fields.fatBurnG) : null;
    }
    if (fields.sessionId !== undefined) set.sessionId = fields.sessionId;
    if (fields.sessionLabel !== undefined) set.sessionLabel = fields.sessionLabel;

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

// ponytail self-check: defaults + session grouping without DB
if (require.main === module) {
    const withDefaults = applyWorkoutDefaults(
        { exercise: 'Shoulder press', weightKg: 15 } as WorkoutLogEntry,
        4,
        12
    );
    if (withDefaults.sets !== 4 || withDefaults.reps !== 12) {
        throw new Error('applyWorkoutDefaults failed');
    }

    const exercises: WorkoutExerciseRecord[] = [
        {
            id: 1,
            date: '2026-06-29',
            exercise: 'Shoulder press',
            sets: 4,
            reps: 12,
            weightKg: 15,
            durationMin: null,
            notes: null,
            caloriesBurned: 50,
            fatBurnG: 5,
            sessionId: 'sess-1',
            sessionLabel: 'Shoulder + Abs day',
        },
        {
            id: 2,
            date: '2026-06-29',
            exercise: 'Crunches',
            sets: 4,
            reps: 12,
            weightKg: null,
            durationMin: null,
            notes: null,
            caloriesBurned: 30,
            fatBurnG: 3,
            sessionId: 'sess-1',
            sessionLabel: 'Shoulder + Abs day',
        },
        {
            id: 3,
            date: '2026-06-28',
            exercise: 'Bench press',
            sets: 3,
            reps: 8,
            weightKg: 60,
            durationMin: null,
            notes: null,
            caloriesBurned: 40,
            fatBurnG: 4,
            sessionId: null,
            sessionLabel: null,
        },
    ];

    const grouped = groupWorkoutsBySession(exercises);
    if (grouped.sessions.length !== 1 || grouped.standalone.length !== 1) {
        throw new Error('groupWorkoutsBySession failed');
    }
    if (countWorkoutSessions(exercises) !== 2) {
        throw new Error('countWorkoutSessions expected 2');
    }
    console.log('gymService self-check ok');
}

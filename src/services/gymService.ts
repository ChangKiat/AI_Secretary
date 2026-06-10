import { eq, desc } from 'drizzle-orm';
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
    // #region agent log
    fetch('http://127.0.0.1:7252/ingest/33c6738f-5e96-4778-a16c-73a09bcd6a03',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'68d811'},body:JSON.stringify({sessionId:'68d811',location:'gymService.ts:logWorkout',message:'inserting workout row',data:{row,setsType:typeof sets,repsType:typeof reps,durationMinType:typeof durationMin},timestamp:Date.now(),hypothesisId:'A,B,D'})}).catch(()=>{});
    // #endregion
    try {
        await db.insert(workouts).values(row);
        // #region agent log
        fetch('http://127.0.0.1:7252/ingest/33c6738f-5e96-4778-a16c-73a09bcd6a03',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'68d811'},body:JSON.stringify({sessionId:'68d811',location:'gymService.ts:logWorkout',message:'workout insert success',data:{exercise},timestamp:Date.now(),hypothesisId:'D'})}).catch(()=>{});
        // #endregion
    } catch (err: unknown) {
        const e = err as Error;
        // #region agent log
        fetch('http://127.0.0.1:7252/ingest/33c6738f-5e96-4778-a16c-73a09bcd6a03',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'68d811'},body:JSON.stringify({sessionId:'68d811',location:'gymService.ts:logWorkout',message:'workout insert failed',data:{errorMessage:e?.message,errorName:e?.name,row},timestamp:Date.now(),hypothesisId:'A,B,D'})}).catch(()=>{});
        // #endregion
        throw err;
    }
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
            date: row.date,
            exercise: row.exercise,
            sets: row.sets,
            reps: row.reps,
            weightKg: row.weightKg ? parseFloat(row.weightKg) : null,
            durationMin: row.durationMin ? parseFloat(row.durationMin) : null,
            notes: row.notes,
        }));
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

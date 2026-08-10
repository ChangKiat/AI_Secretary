import {
    normalizeSuggestHorizon,
    daysBackForHorizon,
    summarizeWorkoutsForSuggestion,
    type WorkoutExerciseRecord,
} from './gymService';

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
}

assert(normalizeSuggestHorizon(undefined) === 'today', 'default horizon today');
assert(normalizeSuggestHorizon('week') === 'week', 'week horizon');
assert(normalizeSuggestHorizon('nope') === 'today', 'invalid horizon → today');
assert(daysBackForHorizon('today') === 14, 'today daysBack 14');
assert(daysBackForHorizon('week') === 21, 'week daysBack 21');

const history: WorkoutExerciseRecord[] = [
    {
        id: 2,
        date: '2026-08-04',
        exercise: 'Squat',
        sets: 4,
        reps: 8,
        weightKg: 80,
        weightsKgText: null,
        durationMin: null,
        notes: null,
        caloriesBurned: null,
        fatBurnG: null,
        sessionId: 's2',
        sessionLabel: 'Leg day',
        supersetGroup: null,
    },
    {
        id: 1,
        date: '2026-08-01',
        exercise: 'Squat',
        sets: 4,
        reps: 8,
        weightKg: 70,
        weightsKgText: null,
        durationMin: null,
        notes: null,
        caloriesBurned: null,
        fatBurnG: null,
        sessionId: 's1',
        sessionLabel: 'Leg day',
        supersetGroup: null,
    },
];

const summary = summarizeWorkoutsForSuggestion(history);
assert(summary.exerciseCounts.Squat === 2, 'squat count');
assert(summary.lastLoads.Squat?.weightKg === 80, 'last load is newest');
assert(summary.recentSessionLabels[0] === 'Leg day', 'session label once');
assert(summary.recentSessionLabels.length === 1, 'dedupe session labels');

console.log('suggestion_payload_check: ok');

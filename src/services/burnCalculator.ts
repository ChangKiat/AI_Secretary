export interface BurnEstimate {
    caloriesBurned: number;
    fatBurnG: number;
}

const MET_ENTRIES: { keywords: string[]; met: number }[] = [
    { keywords: ['run', 'running', 'jog', 'jogging'], met: 9.8 },
    { keywords: ['sprint', 'sprinting'], met: 12.5 },
    { keywords: ['walk', 'walking'], met: 3.5 },
    { keywords: ['hike', 'hiking'], met: 6.0 },
    { keywords: ['cycle', 'cycling', 'bike', 'biking', 'bicycle'], met: 7.5 },
    { keywords: ['swim', 'swimming'], met: 8.0 },
    { keywords: ['treadmill'], met: 9.0 },
    { keywords: ['elliptical'], met: 7.0 },
    { keywords: ['row', 'rowing', 'rower'], met: 7.0 },
    { keywords: ['stair', 'stairs', 'stairmaster'], met: 9.0 },
    { keywords: ['jump rope', 'skipping', 'skip rope'], met: 11.0 },
    { keywords: ['hiit', 'interval'], met: 8.0 },
    { keywords: ['yoga'], met: 3.0 },
    { keywords: ['pilates'], met: 3.5 },
    { keywords: ['stretch', 'stretching'], met: 2.5 },
    { keywords: ['dance', 'dancing', 'zumba'], met: 6.5 },
    { keywords: ['badminton'], met: 5.5 },
    { keywords: ['tennis'], met: 7.3 },
    { keywords: ['basketball'], met: 6.5 },
    { keywords: ['football', 'soccer'], met: 7.0 },
    { keywords: ['squash'], met: 7.3 },
    { keywords: ['bench press', 'bench'], met: 6.0 },
    { keywords: ['squat', 'squats'], met: 6.0 },
    { keywords: ['deadlift', 'deadlifts'], met: 6.0 },
    { keywords: ['leg press'], met: 5.5 },
    { keywords: ['shoulder press', 'overhead press', 'ohp'], met: 5.5 },
    { keywords: ['lat pulldown', 'pull down'], met: 5.0 },
    { keywords: ['pull up', 'pullup', 'chin up', 'chinup'], met: 8.0 },
    { keywords: ['push up', 'pushup'], met: 8.0 },
    { keywords: ['plank'], met: 3.5 },
    { keywords: ['curl', 'bicep'], met: 3.5 },
    { keywords: ['tricep', 'dip'], met: 4.0 },
    { keywords: ['lunge', 'lunges'], met: 5.0 },
    { keywords: ['leg extension', 'leg curl'], met: 4.5 },
    { keywords: ['cable', 'machine'], met: 5.0 },
    { keywords: ['cardio'], met: 7.0 },
    { keywords: ['weight', 'weights', 'lifting', 'strength', 'gym'], met: 5.0 },
];

const DEFAULT_CARDIO_MET = 4.0;
const DEFAULT_STRENGTH_MET = 5.0;
const DEFAULT_STRENGTH_DURATION_MIN = 45;
const FAT_OXIDATION_RATIO = 0.35;

function lookupMet(exercise: string): number | null {
    const lower = exercise.toLowerCase();
    for (const entry of MET_ENTRIES) {
        if (entry.keywords.some((kw) => lower.includes(kw))) {
            return entry.met;
        }
    }
    return null;
}

function isCardioLike(exercise: string, durationMin?: number): boolean {
    if (durationMin != null && durationMin > 0) return true;
    const met = lookupMet(exercise);
    if (met != null && met >= 6.5) return true;
    const lower = exercise.toLowerCase();
    return /\b(run|jog|walk|cycle|swim|cardio|treadmill|row|hiit|dance|badminton|tennis|football|soccer)\b/.test(
        lower
    );
}

function estimateDurationMin(
    durationMin?: number,
    sets?: number,
    reps?: number,
    weightKg?: number
): number {
    if (durationMin != null && durationMin > 0) return durationMin;

    if (sets != null && reps != null && sets > 0 && reps > 0) {
        const restMin = 2;
        const workMinPerSet = 0.5;
        const volumeBonus =
            weightKg != null && weightKg > 0
                ? Math.min(15, (sets * reps * weightKg) / 500)
                : 0;
        return Math.min(90, sets * (workMinPerSet + restMin) + volumeBonus);
    }

    return DEFAULT_STRENGTH_DURATION_MIN;
}

function caloriesFromMet(met: number, bodyWeightKg: number, durationMin: number): number {
    const hours = durationMin / 60;
    return Math.round(met * bodyWeightKg * hours);
}

function fatGramsFromCalories(caloriesBurned: number): number {
    return Math.round(((caloriesBurned * FAT_OXIDATION_RATIO) / 9) * 10) / 10;
}

export function estimateBurn(
    exercise: string,
    durationMin?: number,
    sets?: number,
    reps?: number,
    weightKg?: number,
    bodyWeightKg?: number | null
): BurnEstimate | null {
    if (bodyWeightKg == null || bodyWeightKg <= 0) return null;

    const effectiveDuration = estimateDurationMin(durationMin, sets, reps, weightKg);
    const met = lookupMet(exercise);
    const cardio = isCardioLike(exercise, durationMin);

    let effectiveMet: number;
    if (met != null) {
        effectiveMet = met;
    } else if (cardio) {
        effectiveMet = DEFAULT_CARDIO_MET;
    } else {
        effectiveMet = DEFAULT_STRENGTH_MET;
    }

    const caloriesBurned = caloriesFromMet(effectiveMet, bodyWeightKg, effectiveDuration);
    const fatBurnG = fatGramsFromCalories(caloriesBurned);

    return { caloriesBurned, fatBurnG };
}

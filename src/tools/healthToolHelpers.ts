import {
    caloriesFromSteps,
    computeBMR,
    type NutritionTargets,
} from '../services/nutritionService';
import { buildDailyBurnSeries, type DailyBurnSeries } from '../services/dailyActivityService';

// Pure helpers behind the health tools in toolHandler.ts (update_user_settings, log_steps,
// get_workout_summary). Kept here so they stay testable without a DB or a Gemini chat.

export type BmrProfile = Pick<NutritionTargets, 'bodyWeightKg' | 'heightCm' | 'age' | 'sex'>;

export type UserSettingsUpdate = Partial<
    Pick<
        NutritionTargets,
        | 'dailyProteinTargetG'
        | 'dailyCalorieTarget'
        | 'dailyCarbsTargetG'
        | 'dailyFatTargetG'
        | 'bodyWeightKg'
        | 'heightCm'
        | 'age'
        | 'sex'
    >
>;

/** update_user_settings args as Gemini sends them (any field may be missing or malformed). */
export interface UserSettingsArgs {
    dailyProteinTargetG?: unknown;
    dailyCalorieTarget?: unknown;
    dailyCarbsTargetG?: unknown;
    dailyFatTargetG?: unknown;
    bodyWeightKg?: unknown;
    heightCm?: unknown;
    age?: unknown;
    sex?: unknown;
}

const PROFILE_FIELDS = ['bodyWeightKg', 'heightCm', 'age', 'sex'] as const;
const BMR_FIELD_LABELS: Record<(typeof PROFILE_FIELDS)[number], string> = {
    bodyWeightKg: 'weight',
    heightCm: 'height',
    age: 'age',
    sex: 'sex',
};

/** A number, or a numeric string such as "9,800"; anything else is undefined. */
function toFiniteNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string') return undefined;
    const text = value.replace(/[,\s]/g, '');
    if (text === '') return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? n : undefined;
}

function isGiven(value: unknown): boolean {
    return value !== undefined && value !== null && value !== '';
}

function shown(value: unknown): string {
    return JSON.stringify(value) ?? String(value);
}

export function formatCount(n: number): string {
    return Math.round(n).toLocaleString('en-US');
}

/** "a", "a and b", "a, b and c". */
function joinAnd(items: string[]): string {
    if (items.length <= 1) return items.join('');
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** m / man / male → male, f / woman / female → female (any case); anything else is undefined. */
export function normalizeSex(value: unknown): 'male' | 'female' | undefined {
    if (typeof value !== 'string') return undefined;
    const word = value.trim().toLowerCase();
    if (word === 'm' || word === 'man' || word === 'male') return 'male';
    if (word === 'f' || word === 'woman' || word === 'female') return 'female';
    return undefined;
}

/**
 * update_user_settings args → only the stated, valid fields. Missing/null args never reach
 * updateNutritionTargets, where null would clear the stored value.
 */
export function parseUserSettingsArgs(args: UserSettingsArgs): {
    updates: UserSettingsUpdate;
    /** Reply labels for the saved fields, e.g. "175cm height". */
    changed: string[];
    /** Why a stated field was not saved. */
    invalid: string[];
} {
    const updates: UserSettingsUpdate = {};
    const changed: string[] = [];
    const invalid: string[] = [];

    const positiveFields = [
        ['dailyCalorieTarget', 'calorie target', (n: number) => `${n} cal`],
        ['dailyProteinTargetG', 'protein target', (n: number) => `${n}g protein`],
        ['dailyCarbsTargetG', 'carbs target', (n: number) => `${n}g carbs`],
        ['dailyFatTargetG', 'fat target', (n: number) => `${n}g fat`],
        ['bodyWeightKg', 'body weight', (n: number) => `${n}kg body weight`],
    ] as const;
    for (const [key, label, describe] of positiveFields) {
        if (!isGiven(args[key])) continue;
        const n = toFiniteNumber(args[key]);
        if (n == null || n <= 0) {
            invalid.push(`${label} must be a number above 0 (got ${shown(args[key])})`);
            continue;
        }
        updates[key] = n;
        changed.push(describe(n));
    }

    if (isGiven(args.heightCm)) {
        let heightCm = toFiniteNumber(args.heightCm);
        // "1.75" is metres: nobody is under 3 cm tall.
        if (heightCm != null && heightCm > 0 && heightCm < 3) {
            heightCm = Math.round(heightCm * 1000) / 10;
        }
        if (heightCm == null || heightCm <= 0) {
            invalid.push(`height must be a number of cm above 0 (got ${shown(args.heightCm)})`);
        } else {
            updates.heightCm = heightCm;
            changed.push(`${heightCm}cm height`);
        }
    }

    if (isGiven(args.age)) {
        const age = toFiniteNumber(args.age);
        if (age == null || age <= 0 || !Number.isInteger(age)) {
            invalid.push(`age must be a whole number above 0 (got ${shown(args.age)})`);
        } else {
            updates.age = age;
            changed.push(`age ${age}`);
        }
    }

    if (isGiven(args.sex)) {
        const sex = normalizeSex(args.sex);
        if (!sex) {
            invalid.push(`sex must be male or female (got ${shown(args.sex)})`);
        } else {
            updates.sex = sex;
            changed.push(sex);
        }
    }

    return { updates, changed, invalid };
}

/** Whether the update touches a BMR input (weight, height, age, sex). */
export function touchesBmrProfile(updates: UserSettingsUpdate): boolean {
    return PROFILE_FIELDS.some((key) => updates[key] !== undefined);
}

/** Labels of the BMR inputs still missing, e.g. ["height", "age"]. */
export function missingBmrFields(profile: BmrProfile): string[] {
    return PROFILE_FIELDS.filter((key) => profile[key] == null).map((key) => BMR_FIELD_LABELS[key]);
}

export function bmrOf(profile: BmrProfile): number | null {
    return computeBMR(profile.bodyWeightKg, profile.heightCm, profile.age, profile.sex);
}

export function formatUserSettingsReply(input: {
    changed: string[];
    invalid: string[];
    /** Set when bodyWeightKg was also written to the weight log. */
    weighIn?: { kg: number; date: string } | null;
    /** BMR from the stored settings after the update. */
    bmr?: number | null;
    missingForBmr?: string[];
    profileChanged?: boolean;
}): string {
    const lines: string[] = [];
    if (input.changed.length > 0) {
        lines.push(`✅ Settings updated: ${input.changed.join(', ')}.`);
        if (input.weighIn) {
            lines.push(`⚖️ Also logged ${input.weighIn.kg}kg as the weigh-in for ${input.weighIn.date}.`);
        }
        if (input.bmr != null) {
            lines.push(`🔥 BMR ≈ ${formatCount(input.bmr)} kcal/day (resting burn)`);
        } else if (input.profileChanged && input.missingForBmr && input.missingForBmr.length > 0) {
            lines.push(`ℹ️ For a BMR estimate, also set your ${joinAnd(input.missingForBmr)}.`);
        }
    }
    if (input.invalid.length > 0) {
        lines.push(`⚠️ Not saved: ${input.invalid.join('; ')}.`);
    }
    if (lines.length === 0) {
        lines.push(
            '⚠️ Nothing saved: tell me what to change, e.g. "protein target 150g" or "I\'m 175cm, 30, male".'
        );
    }
    return lines.join('\n');
}

/** Far above any real day; also keeps the value inside the INTEGER steps column. */
const MAX_DAILY_STEPS = 1_000_000;

/** log_steps count: a finite number ≥ 0, rounded (as the Dashboard PUT /daily-activity does); null = reject. */
export function parseStepCount(value: unknown): number | null {
    const n = toFiniteNumber(value);
    if (n == null || n < 0) return null;
    const steps = Math.round(n);
    return steps <= MAX_DAILY_STEPS ? steps : null;
}

export function isIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Rounded caloriesFromSteps, the same per-step formula the Dashboard burn series uses. */
export function stepCalories(steps: number, bodyWeightKg: number | null): number {
    return Math.round(caloriesFromSteps(steps, bodyWeightKg));
}

export function formatStepsReply(input: {
    steps: number;
    date: string;
    stepKcal: number;
    bodyWeightKg: number | null;
    /** The count this log replaced, if the day already had one. */
    previousSteps: number | null;
}): string {
    const lines = [
        `👣 Logged ${formatCount(input.steps)} steps for ${input.date} (~${formatCount(input.stepKcal)} kcal).`,
    ];
    if (input.previousSteps != null && input.previousSteps !== input.steps) {
        lines.push(`Replaces the ${formatCount(input.previousSteps)} steps saved earlier for that day.`);
    }
    if (input.bodyWeightKg == null) {
        lines.push('ℹ️ Calories assume 70kg; set your body weight for a closer estimate.');
    }
    return lines.join('\n');
}

/**
 * get_workout_summary response: the workout-only figures from getWorkoutBurnSummary, renamed
 * so they can't be mistaken for the total, merged with the Dashboard "calories burned" series
 * (workouts + steps + BMR). `burn` is null when the series could not be built.
 */
export function buildWorkoutSummaryResponse<
    T extends { totalCaloriesBurned: number; totalFatBurnG: number },
>(summary: T, burn: DailyBurnSeries | null, missingForBmr: string[]) {
    const { totalCaloriesBurned, totalFatBurnG, ...workouts } = summary;
    const workoutOnly = {
        ...workouts,
        workoutCaloriesBurned: totalCaloriesBurned,
        workoutFatBurnG: totalFatBurnG,
    };
    if (!burn) {
        return {
            ...workoutOnly,
            totalEnergyBurned: null,
            note: 'Total energy burned (workouts + steps + BMR) could not be computed for these dates; report workoutCaloriesBurned and say it covers logged workouts only.',
        };
    }
    const missing = missingForBmr.length > 0 ? missingForBmr : ['height', 'age', 'sex'];
    return {
        ...workoutOnly,
        days: burn.days.map((d) => ({
            ...d,
            workoutKcal: Math.round(d.workoutKcal),
            stepKcal: Math.round(d.stepKcal),
            bmr: Math.round(d.bmr),
        })),
        totalStepCalories: burn.totalStepCalories,
        bmrPerDay: burn.bmrPerDay == null ? null : Math.round(burn.bmrPerDay),
        totalEnergyBurned: burn.totalEnergyBurned,
        labels: {
            workoutCaloriesBurned: 'Workouts only: calories from logged exercises',
            totalEnergyBurned:
                'Total energy burned: workouts + steps + BMR for each day up to today, the same figure as the Dashboard "calories burned"',
        },
        ...(burn.bmrPerDay == null
            ? {
                  bmrHint: `BMR (resting burn) is not included because your ${joinAnd(missing)} ${missing.length === 1 ? 'is' : 'are'} not set. Set height/age/sex, e.g. "I'm 175cm, 30, male".`,
              }
            : {}),
    };
}

// ponytail self-check: pure helpers, no DB
if (require.main === module) {
    const fail = (msg: string, value: unknown) => {
        throw new Error(`${msg}: ${JSON.stringify(value)}`);
    };

    const profile = parseUserSettingsArgs({ heightCm: 175, age: 30, sex: 'M', bodyWeightKg: null });
    if (
        JSON.stringify(profile.updates) !== JSON.stringify({ heightCm: 175, age: 30, sex: 'male' }) ||
        profile.changed.join('|') !== '175cm height|age 30|male' ||
        profile.invalid.length !== 0
    ) {
        fail('profile parse failed (only stated fields, sex normalised, null skipped)', profile);
    }
    if (normalizeSex('Woman') !== 'female' || normalizeSex('f') !== 'female' || normalizeSex('x') !== undefined) {
        fail('sex normalisation failed', [normalizeSex('Woman'), normalizeSex('f'), normalizeSex('x')]);
    }
    const metres = parseUserSettingsArgs({ heightCm: 1.75 });
    if (metres.updates.heightCm !== 175) fail('1.75 m should become 175 cm', metres);

    const bad = parseUserSettingsArgs({ age: 30.5, heightCm: 0, sex: 'other', dailyCalorieTarget: -5 });
    if (Object.keys(bad.updates).length !== 0 || bad.invalid.length !== 4) {
        fail('invalid values must not be saved', bad);
    }
    const badReply = formatUserSettingsReply({ changed: bad.changed, invalid: bad.invalid });
    if (badReply.includes('Settings updated') || !badReply.includes('age must be a whole number')) {
        fail('nothing-saved reply must not claim an update', badReply);
    }
    const emptyReply = formatUserSettingsReply({ changed: [], invalid: [] });
    if (emptyReply.includes('Settings updated') || !emptyReply.startsWith('⚠️ Nothing saved')) {
        fail('empty update reply', emptyReply);
    }

    // 70kg, 175cm, 30, male: 700 + 1093.75 - 150 + 5 = 1648.75
    const full = { bodyWeightKg: 70, heightCm: 175, age: 30, sex: 'male' as const };
    const bmrReply = formatUserSettingsReply({
        changed: profile.changed,
        invalid: [],
        bmr: bmrOf(full),
        missingForBmr: missingBmrFields(full),
        profileChanged: touchesBmrProfile(profile.updates),
    });
    if (!bmrReply.includes('✅ Settings updated: 175cm height, age 30, male.') || !bmrReply.includes('BMR ≈ 1,649 kcal/day')) {
        fail('BMR reply failed', bmrReply);
    }
    const partialProfile = { bodyWeightKg: 70, heightCm: null, age: null, sex: 'male' as const };
    const hintReply = formatUserSettingsReply({
        changed: ['70kg body weight'],
        invalid: [],
        weighIn: { kg: 70, date: '2026-10-04' },
        bmr: bmrOf(partialProfile),
        missingForBmr: missingBmrFields(partialProfile),
        profileChanged: true,
    });
    if (!hintReply.includes('weigh-in for 2026-10-04') || !hintReply.includes('also set your height and age')) {
        fail('missing-BMR hint failed', hintReply);
    }

    for (const [raw, expected] of [
        [9800, 9800],
        ['9,800', 9800],
        [9800.6, 9801],
        [0, 0],
        [-1, null],
        [Number.NaN, null],
        [Number.POSITIVE_INFINITY, null],
        ['abc', null],
        [5_000_000, null],
    ] as const) {
        if (parseStepCount(raw) !== expected) fail(`parseStepCount(${String(raw)})`, parseStepCount(raw));
    }
    if (!isIsoDate('2026-10-04') || isIsoDate('2026-02-31') || isIsoDate('04/10/2026')) {
        fail('isIsoDate failed', null);
    }
    const stepsReply = formatStepsReply({
        steps: 9800,
        date: '2026-10-04',
        stepKcal: stepCalories(9800, 70),
        bodyWeightKg: 70,
        previousSteps: 5000,
    });
    if (
        !stepsReply.startsWith('👣 Logged 9,800 steps for 2026-10-04 (~343 kcal).') ||
        !stepsReply.includes('Replaces the 5,000 steps')
    ) {
        fail('steps reply failed', stepsReply);
    }
    if (!formatStepsReply({ steps: 100, date: '2026-10-04', stepKcal: 4, bodyWeightKg: null, previousSteps: null }).includes('assume 70kg')) {
        fail('steps reply without weight should mention the 70kg assumption', null);
    }

    const summary = { startDate: '2026-06-01', endDate: '2026-06-03', sessionCount: 1, totalCaloriesBurned: 100, totalFatBurnG: 5.2 };
    const series = buildDailyBurnSeries({
        start: '2026-06-01',
        end: '2026-06-03',
        today: '2026-06-03',
        workouts: [{ date: '2026-06-02', caloriesBurned: 100.4 }],
        activity: [{ date: '2026-06-02', steps: 10000 }],
        settings: full,
    });
    const merged = buildWorkoutSummaryResponse(summary, series, []);
    if (
        merged.workoutCaloriesBurned !== 100 ||
        'totalCaloriesBurned' in merged ||
        merged.totalEnergyBurned !== 5397 ||
        merged.totalStepCalories !== 350 ||
        merged.bmrPerDay !== 1649 ||
        'bmrHint' in merged ||
        merged.days.map((d) => `${d.date}=${d.totalKcal}`).join(',') !== '2026-06-01=1649,2026-06-02=2099,2026-06-03=1649'
    ) {
        fail('workout summary merge failed', merged);
    }
    const noBmrSeries = buildDailyBurnSeries({
        start: '2026-06-01',
        end: '2026-06-03',
        today: '2026-06-03',
        workouts: [{ date: '2026-06-02', caloriesBurned: 100 }],
        activity: [],
        settings: { bodyWeightKg: 70, heightCm: null, age: null, sex: null },
    });
    const noBmr = buildWorkoutSummaryResponse(summary, noBmrSeries, ['height', 'age', 'sex']);
    if (
        noBmr.totalEnergyBurned !== 100 ||
        noBmr.bmrPerDay !== null ||
        !('bmrHint' in noBmr) ||
        !String(noBmr.bmrHint).includes('height, age and sex')
    ) {
        fail('missing BMR must add the set height/age/sex hint', noBmr);
    }
    const unavailable = buildWorkoutSummaryResponse(summary, null, []);
    if (unavailable.totalEnergyBurned !== null || unavailable.workoutCaloriesBurned !== 100) {
        fail('unavailable series must keep the workout-only figure', unavailable);
    }

    console.log('healthToolHelpers self-check ok');
}

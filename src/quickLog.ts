import { Markup, type Context } from 'telegraf';
import { getRecentBodyWeightLogs, upsertBodyWeightLog } from './services/bodyWeightService';
import { listDailyActivityLogs, upsertDailyActivityLog } from './services/dailyActivityService';
import { getNutritionTargets } from './services/nutritionService';
import {
    formatBodyWeightReply,
    formatStepsReply,
    parseStepCount,
    stepCalories,
} from './tools/healthToolHelpers';
import { klIsoDate } from './utils/klDate';

/**
 * The Weight and Steps buttons under the message box log without Gemini: a tap asks for the
 * number, and the next message that starts with a digit is saved for today ("… yesterday" for
 * yesterday). Any other message drops the tap and goes to Gemini as usual.
 */

export const WEIGHT_BUTTON = '⚖️ Weight';
export const STEPS_BUTTON = '👣 Steps';

/** Sent with /start and every quick-log reply, so the buttons come back if Telegram dropped them. */
export const quickLogKeyboard = Markup.keyboard([[WEIGHT_BUTTON, STEPS_BUTTON]]).resize().persistent();

type QuickLogKind = 'weight' | 'steps';

/** A tap waits this long for its number. */
const PENDING_TTL_MS = 10 * 60_000;
/** Outside this range a body weight is a typo ("855"), not a weigh-in. */
const MIN_BODY_WEIGHT_KG = 20;
const MAX_BODY_WEIGHT_KG = 300;
const YESTERDAY_SUFFIX = /\s+(?:yesterday|ytd|ytdy)$/i;

const ASK: Record<QuickLogKind, string> = {
    weight: '⚖️ Send your weight in kg, e.g. 85.5 (add "yesterday" for yesterday\'s).',
    steps: '👣 Send your steps, e.g. 9800 or 9.8k (add "yesterday" for yesterday\'s).',
};
const INVALID: Record<QuickLogKind, string> = {
    weight: `⚠️ Not logged: send just the weight in kg (${MIN_BODY_WEIGHT_KG}–${MAX_BODY_WEIGHT_KG}), e.g. 85.5.`,
    steps: '⚠️ Not logged: send just the step count, e.g. 9800 or 9.8k.',
};

const pending = new Map<number, { kind: QuickLogKind; at: number }>();

/** "85.5", "85.5kg", "9,800", "9.8k", "9800 steps", each optionally followed by "yesterday". Null = not a valid answer. */
export function parseQuickLogAnswer(
    kind: QuickLogKind,
    text: string
): { value: number; yesterday: boolean } | null {
    const trimmed = text.trim();
    const yesterday = YESTERDAY_SUFFIX.test(trimmed);
    const body = trimmed.replace(YESTERDAY_SUFFIX, '');
    if (kind === 'weight') {
        const match = /^(\d+(?:\.\d+)?)\s*(?:kgs?)?$/i.exec(body);
        const kg = match ? Number(match[1]) : NaN;
        if (!(kg >= MIN_BODY_WEIGHT_KG && kg <= MAX_BODY_WEIGHT_KG)) return null;
        // body_weight_logs.weight_kg keeps 2 decimals.
        return { value: Math.round(kg * 100) / 100, yesterday };
    }
    const match = /^(\d[\d,]*(?:\.\d+)?)\s*(k)?\s*(?:steps?)?$/i.exec(body);
    if (!match) return null;
    const steps = parseStepCount(match[2] ? Number(match[1].replace(/,/g, '')) * 1000 : match[1]);
    return steps == null ? null : { value: steps, yesterday };
}

async function logBodyWeight(userId: number, date: string, weightKg: number): Promise<string> {
    await upsertBodyWeightLog(userId, date, weightKg);
    const recent = await getRecentBodyWeightLogs(userId, 2);
    return formatBodyWeightReply(weightKg, date, recent.find((r) => r.date !== date));
}

/** Same reply as the log_steps tool. */
async function logSteps(userId: number, date: string, steps: number): Promise<string> {
    const [previous] = await listDailyActivityLogs(userId, date, date);
    await upsertDailyActivityLog(userId, date, steps);
    const { bodyWeightKg } = await getNutritionTargets(userId);
    return formatStepsReply({
        steps,
        date,
        stepKcal: stepCalories(steps, bodyWeightKg),
        bodyWeightKg,
        previousSteps: previous?.steps ?? null,
    });
}

/** Handles a button tap or the number after one. Resolves false when the message is for Gemini. */
export async function handleQuickLogText(ctx: Context, text: string): Promise<boolean> {
    const userId = ctx.from!.id;
    const trimmed = text.trim();
    if (trimmed === WEIGHT_BUTTON || trimmed === STEPS_BUTTON) {
        const kind: QuickLogKind = trimmed === WEIGHT_BUTTON ? 'weight' : 'steps';
        pending.set(userId, { kind, at: Date.now() });
        await ctx.reply(ASK[kind], quickLogKeyboard);
        return true;
    }

    const waiting = pending.get(userId);
    if (!waiting || Date.now() - waiting.at > PENDING_TTL_MS || !/^\d/.test(trimmed)) {
        pending.delete(userId);
        return false;
    }
    const answer = parseQuickLogAnswer(waiting.kind, trimmed);
    if (!answer) {
        // Still waiting: a typo shouldn't send the number to Gemini.
        await ctx.reply(INVALID[waiting.kind], quickLogKeyboard);
        return true;
    }
    pending.delete(userId);
    const date = klIsoDate(answer.yesterday ? -1 : 0);
    const reply =
        waiting.kind === 'weight'
            ? await logBodyWeight(userId, date, answer.value)
            : await logSteps(userId, date, answer.value);
    await ctx.reply(reply, quickLogKeyboard);
    return true;
}

// ponytail self-check: parsing only, no DB: npx tsx src/quickLog.ts
if (require.main === module) {
    const cases: [QuickLogKind, string, ReturnType<typeof parseQuickLogAnswer>][] = [
        ['weight', '85.5', { value: 85.5, yesterday: false }],
        ['weight', ' 85.5 kg ', { value: 85.5, yesterday: false }],
        ['weight', '86KG yesterday', { value: 86, yesterday: true }],
        ['weight', '85.456', { value: 85.46, yesterday: false }],
        ['weight', '855', null],
        ['weight', '8.5', null],
        ['weight', '85.5.', null],
        ['weight', '85 and lunch', null],
        ['steps', '9800', { value: 9800, yesterday: false }],
        ['steps', '9,800 steps', { value: 9800, yesterday: false }],
        ['steps', '9.8k', { value: 9800, yesterday: false }],
        ['steps', '10K ytd', { value: 10000, yesterday: true }],
        ['steps', '0', { value: 0, yesterday: false }],
        ['steps', '5000000', null],
        ['steps', '9800 kcal', null],
    ];
    for (const [kind, text, expected] of cases) {
        const actual = parseQuickLogAnswer(kind, text);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`parseQuickLogAnswer(${kind}, ${JSON.stringify(text)}): expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
    }
    console.log('quickLog self-check ok');
}

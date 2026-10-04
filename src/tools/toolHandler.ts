import { Context } from 'telegraf';
import { randomUUID } from 'crypto';
import { ChatSession, FunctionCall } from '@google/generative-ai';
import { resolveCategory, upsertBudget, getBudgets } from '../config/expenseCategories';
import {
    displayPaymentMethod,
    getExpensePaymentAccountNames,
    getPaymentAccountNames,
    resolvePaymentMethod,
    type PaymentMethodMatch,
} from '../config/paymentMethods';
import { resolvePaymentMethodMatchFresh } from '../config/cacheRefresh';
import {
    getSpendingSummary,
    deleteFixedExpense,
    formatExpenseLogReply,
    formatBulkExpenseLogReply,
    updateExpense,
    deleteExpense,
    getExpenseById,
    ExpenseBatchEntry,
    SkippedExpense,
} from '../services/expenseService';
import {
    asSentence,
    formatCurrencyExchangeReply,
    formatTripCreatedReply,
    formatTripSummaryReply,
    logCurrencyExchange,
    logExpenseWithTrip,
    pickSummaryTrip,
    planNewTrip,
    recomputeTripLegAmount,
    TRIP_SUMMARY_WORDING,
    TripLookup,
    tripSummaryView,
} from '../services/tripExpenseService';
import { createTrip, getLatestExchangeRate, getTripById, getTripSummary, listTrips } from '../services/tripService';
import {
    appendIncome,
    appendReimbursements,
    findRecentExpenseByDescription,
    formatIncomeLogReply,
    formatSharedExpenseReply,
    updateIncome,
    deleteIncome,
    getIncomeById,
    ReplyRecordTarget,
    deleteInvestmentFundingTransfer,
    fundingDestination,
    getIncomesByExpenseId,
    isAccountTransferCategory,
    isInvestmentCategory,
    isOtherCategory,
    normalizeOtherAccounts,
    upsertInvestmentFundingTransfer,
    validateFundingAccounts,
} from '../services/incomeService';
import {
    addInterestSchedule,
    deactivateInterestScheduleByDescription,
    getActiveInterestSchedules,
    updateInterestScheduleById,
    type InterestFrequency,
} from '../services/interestScheduleService';
import {
    createCalendarEvent,
    getSchedule,
    findCalendarEvents,
    rescheduleCalendarEvent,
    cancelCalendarEvent,
    CalendarEventSummary,
} from '../services/calendarService';
import {
    logWorkout,
    logBulkWorkouts,
    getWorkoutHistoryGrouped,
    getRecentWorkoutsForSuggestion,
    getWorkoutBurnSummary,
    formatWorkoutLogReply,
    formatBulkWorkoutLogReply,
    applyWorkoutDefaults,
    normalizeWeightsKg,
    normalizeSuggestHorizon,
    daysBackForHorizon,
    getWorkoutSessionRows,
    updateWorkout,
    deleteWorkout,
    deleteWorkoutsBySessionId,
    WorkoutLogEntry,
} from '../services/gymService';
import { resolveWorkoutBurn } from '../services/burnCalculator';
import {
    logMeal,
    getNutritionSummary,
    getTodayMacroProgress,
    updateNutritionTargets,
    uploadMealPhoto,
    formatMealLogReply,
    getMealHistory,
    updateMeal,
    deleteMeal,
    getMealById,
    getNutritionTargets,
    getMealSuggestionContext,
    MealBatchEntry,
} from '../services/nutritionService';
import { upsertBodyWeightLog, getRecentBodyWeightLogs } from '../services/bodyWeightService';
import {
    getDailyBurnSeries,
    listDailyActivityLogs,
    upsertDailyActivityLog,
} from '../services/dailyActivityService';
import {
    bmrOf,
    buildWorkoutSummaryResponse,
    formatStepsReply,
    formatUserSettingsReply,
    isIsoDate,
    missingBmrFields,
    parseStepCount,
    parseUserSettingsArgs,
    stepCalories,
    touchesBmrProfile,
    type UserSettingsArgs,
} from './healthToolHelpers';
import {
    addFixedExpenseTool,
    investInFundTool,
    listFixedExpensesTool,
    updateFixedExpenseTool,
    withdrawFromFundTool,
    type AddFixedExpenseArgs,
    type FundMoveArgs,
    type UpdateFixedExpenseArgs,
} from './fixedFundHandlers';

export type ToolCallResult = 'complete' | 'awaiting_input';

export interface ToolCallOptions {
    photoFileId?: string;
    photoBuffer?: Buffer;
    photoMimeType?: string;
    userCaption?: string;
    isVoiceInput?: boolean;
    suppressWorkoutReply?: boolean;
    workoutBatchCollector?: WorkoutLogEntry[];
    workoutBatchSessionId?: string;
    suppressMealReply?: boolean;
    mealBatchCollector?: MealBatchEntry[];
    suppressExpenseReply?: boolean;
    expenseBatchCollector?: ExpenseBatchEntry[];
    expenseSkipCollector?: SkippedExpense[];
    /** Shared across one model turn so a long trip list reads trips/rates once. */
    tripLookup?: TripLookup;
    suppressNoOpReply?: boolean;
    replyToExpenseId?: number;
    replyTarget?: ReplyRecordTarget;
}

function resolveToolRecordId(
    argsId: number | undefined,
    options: ToolCallOptions | undefined,
    type: ReplyRecordTarget['type']
): number | undefined {
    if (argsId != null && argsId > 0) return argsId;
    if (options?.replyTarget?.type === type) return options.replyTarget.id;
    return undefined;
}
function getUserId(ctx: Context): number {
    return ctx.from!.id;
}

function todayISO(): string {
    const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' }));
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

const RECEIPT_CAPTION_KEYWORDS =
    /\b(receipt|bill|invoice|statement|expense|transaction|bank|credit card)\b/i;

const OTHER_DAY_CAPTION =
    /\b(yesterday|ytd|ytdy|last\s+night|tomorrow|tmr|tmrw|\d{4}-\d{2}-\d{2})\b/i;

function resolveLogDate(argsDate: string | undefined, options?: ToolCallOptions): string {
    const today = todayISO();
    const caption = options?.userCaption ?? '';

    // A caption that mixes days ("Yesterday workout … Today lunch …") must keep the
    // model's per-item date; the blanket "today" override is only for single-day captions.
    if (/\btoday\b/i.test(caption) && !OTHER_DAY_CAPTION.test(caption)) {
        return today;
    }
    if (!argsDate) {
        return today;
    }

    const isPhoto = !!(options?.photoBuffer || options?.photoFileId);
    const isVoice = !!options?.isVoiceInput;
    if ((isPhoto || isVoice) && !RECEIPT_CAPTION_KEYWORDS.test(caption)) {
        const argsYear = parseInt(argsDate.slice(0, 4), 10);
        const todayYear = parseInt(today.slice(0, 4), 10);
        if (argsYear < todayYear) {
            return today;
        }
    }

    return argsDate;
}

/** The model occasionally echoes the user's "26/09/2026" header instead of ISO. */
function toIsoDate(date: string | undefined): string | undefined {
    const m = date?.trim().match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : date;
}

const TELEGRAM_TEXT_LIMIT = 4000;

/** Long lists (a trip ledger, a statement) can pass Telegram's 4096-char message cap. */
export async function replyInChunks(ctx: Context, text: string): Promise<void> {
    let chunk = '';
    for (const line of text.split('\n')) {
        if (chunk && chunk.length + line.length + 1 > TELEGRAM_TEXT_LIMIT) {
            await ctx.reply(chunk);
            chunk = '';
        }
        chunk = chunk ? `${chunk}\n${line}` : line;
    }
    if (chunk) await ctx.reply(chunk);
}

/** "cash", "in cash", "paid by cash", "tunai": never treated as an unknown account (3.2). */
const CASH_ACCOUNT_TEXT = /^(?:(?:paid|pay|by|in|with|using|via)\s+)*(?:cash|tunai)(?:\s+(?:payment|money))?$/i;

type AccountCheck =
    | { ok: true; name: string | null; text?: string }
    | { ok: false; input: string; match: PaymentMethodMatch; candidates: string[] };
type AccountMiss = Extract<AccountCheck, { ok: false }>;

/**
 * 3.2: resolves an account the user named, so a tool never silently stores "no account".
 * - Empty: ok, null (not stated).
 * - A cash variant: the active Cash account, or null when there is none (no warning). `text` is
 *   'cash' so the trip planner still books it as trip cash.
 * - Anything else: the active account it resolves to. A miss forces one cache reload first (the
 *   account may have just been added on the Dashboard); unknown, ambiguous or deactivated input
 *   is not ok and carries the candidates.
 * `allowInactive` (summary filters) accepts a deactivated account: its old rows still match.
 */
async function checkPaymentAccount(
    raw: string | null | undefined,
    options: { allowInactive?: boolean } = {}
): Promise<AccountCheck> {
    const input = raw?.trim();
    if (!input) return { ok: true, name: null };
    if (CASH_ACCOUNT_TEXT.test(input)) return { ok: true, name: resolvePaymentMethod('Cash'), text: 'cash' };
    const resolution = await resolvePaymentMethodMatchFresh(input);
    if (resolution.name) return { ok: true, name: resolution.name, text: input };
    const candidates = resolution.candidates ?? [];
    if (options.allowInactive && resolution.match === 'inactive' && candidates[0]) {
        return { ok: true, name: candidates[0], text: input };
    }
    return { ok: false, input, match: resolution.match, candidates };
}

/** functionResponse for an account that didn't resolve. */
function accountMissResponse(miss: AccountMiss, known: string[]): Record<string, unknown> {
    return {
        status: 'unknown_payment_method',
        input: miss.input,
        match: miss.match,
        candidates: miss.candidates,
        known,
    };
}

/** The question shown when an account doesn't resolve; `known` lists the accounts to pick from. */
function accountQuestion(miss: AccountMiss, known: string[]): string {
    if (miss.match === 'ambiguous') {
        return `"${miss.input}" matches more than one account: ${miss.candidates.join(', ')}. Which one?`;
    }
    const list = known.length > 0 ? ` Accounts: ${known.join(', ')}.` : '';
    if (miss.match === 'inactive') {
        const name = miss.candidates[0] ?? miss.input;
        return `${name} is deactivated (reactivate it in the Dashboard Setup tab to use it). Which account was it?${list}`;
    }
    return `I couldn't find an account called "${miss.input}". Which account was it?${list}`;
}

/** Short reason for a list item skipped because its account didn't resolve. */
function accountSkipReason(miss: AccountMiss): string {
    if (miss.match === 'ambiguous') {
        return `"${miss.input}" matches ${miss.candidates.join(' / ')} — say which, then resend`;
    }
    if (miss.match === 'inactive') {
        return `${miss.candidates[0] ?? miss.input} is deactivated — use an active account, then resend`;
    }
    return `couldn't match payment account "${miss.input}" — use the exact account name, then resend`;
}

/** Active investment accounts: where an Investment top-up can go. */
function investmentAccountNames(): string[] {
    const spendable = new Set(getExpensePaymentAccountNames());
    return getPaymentAccountNames().filter((name) => !spendable.has(name));
}

/** 3.3: the question for an Investment / funded Other expense whose accounts are missing or equal. */
function fundingQuestion(from: string | null, to: string | null, error: string): string {
    const asks: string[] = [];
    if (!from) asks.push('which account the money came from');
    if (!to) {
        const investments = investmentAccountNames();
        asks.push(
            `which investment account it went to${investments.length > 0 ? ` (${investments.join(', ')})` : ''}`
        );
    }
    return asks.length > 0
        ? `an investment top-up needs both accounts. Tell me ${asks.join(' and ')}.`
        : `${error}.`;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Same account text (trimmed, case-insensitive; null and empty are equal): the stored value is kept. */
function sameAccountName(a?: string | null, b?: string | null): boolean {
    return (a?.trim() ?? '').toLowerCase() === (b?.trim() ?? '').toLowerCase();
}

interface ExpenseItemArgs {
    date?: string;
    amount: number;
    currency?: string;
    amountText?: string;
    category: string;
    description: string;
    paymentMethod?: string;
    tripExpense?: boolean;
}

interface WorkoutArgs {
    date?: string;
    exercise: string;
    sets?: number;
    reps?: number;
    weightKg?: number;
    weightsKg?: number[];
    durationMin?: number;
    caloriesBurned?: number;
    notes?: string;
    supersetGroup?: number;
}

interface WorkoutEditArgs {
    id?: number;
    date?: string;
    exercise?: string;
    sets?: number;
    reps?: number;
    weightKg?: number;
    weightsKg?: number[];
    durationMin?: number;
    notes?: string;
}

/** Fields that change the edited exercise itself (date alone just moves the session). */
const WORKOUT_EDIT_FIELDS = [
    'exercise',
    'sets',
    'reps',
    'weightKg',
    'weightsKg',
    'durationMin',
    'notes',
] as const satisfies readonly (keyof WorkoutEditArgs)[];

async function buildWorkoutEntry(
    args: WorkoutArgs,
    date: string,
    bodyWeightKg: number | null
): Promise<WorkoutLogEntry> {
    const normalized = normalizeWeightsKg(args.weightsKg, args.weightKg, args.sets);
    const burn = resolveWorkoutBurn(
        {
            exercise: args.exercise,
            durationMin: args.durationMin,
            sets: normalized.sets,
            reps: args.reps,
            topWeightKg: normalized.topWeightKg,
            caloriesBurned: args.caloriesBurned,
        },
        bodyWeightKg
    );

    return {
        date,
        exercise: args.exercise,
        sets: normalized.sets,
        reps: args.reps,
        weightKg: normalized.topWeightKg,
        weightsKgText: normalized.weightsKgText,
        durationMin: args.durationMin,
        notes: args.notes,
        supersetGroup: args.supersetGroup ?? null,
        burn: burn ?? null,
    };
}

async function processWorkoutLog(
    userId: number,
    args: WorkoutArgs,
    date: string,
    bodyWeightKg: number | null,
    sessionId?: string | null,
    sessionLabel?: string | null
): Promise<WorkoutLogEntry> {
    const entry = await buildWorkoutEntry(args, date, bodyWeightKg);
    entry.workoutId = await logWorkout(
        userId,
        date,
        args.exercise,
        entry.sets,
        args.reps,
        entry.weightKg,
        args.durationMin,
        args.notes,
        entry.burn?.caloriesBurned ?? null,
        entry.burn?.fatBurnG ?? null,
        sessionId,
        sessionLabel,
        entry.weightsKgText,
        entry.supersetGroup
    );
    return entry;
}

const KNOWN_TOOL_NAMES = new Set([
    'log_expense',
    'log_income',
    'edit_expense',
    'delete_expense',
    'edit_income',
    'delete_income',
    'get_spending_summary',
    'add_fixed_expense',
    'update_fixed_expense',
    'get_all_fixed_expenses',
    'delete_fixed_expense',
    'invest_in_fund',
    'withdraw_from_fund',
    'add_interest_schedule',
    'update_interest_schedule',
    'get_all_interest_schedules',
    'delete_interest_schedule',
    'create_calendar_event',
    'check_schedule',
    'reschedule_calendar_event',
    'cancel_calendar_event',
    'log_bulk_expenses',
    'log_currency_exchange',
    'create_trip',
    'get_trip_summary',
    'log_workout',
    'log_bulk_workouts',
    'edit_workout',
    'delete_workout',
    'log_body_weight',
    'log_steps',
    'get_workout_summary',
    'get_workout_history',
    'suggest_workout',
    'log_meal',
    'get_meal_history',
    'edit_meal',
    'delete_meal',
    'get_nutrition_summary',
    'suggest_meal',
    'upsert_budget',
    'get_budgets',
    'update_user_settings',
]);

/** Handlers that relay the model's follow-up text to the user, so their functionResponse can't be deferred. */
export const TOOLS_READING_MODEL_REPLY = new Set([
    'get_spending_summary',
    'get_trip_summary',
    'get_all_fixed_expenses',
    'create_calendar_event',
    'check_schedule',
    'reschedule_calendar_event',
    'cancel_calendar_event',
    'get_workout_summary',
    'get_workout_history',
    'suggest_workout',
    'get_meal_history',
    'get_nutrition_summary',
    'suggest_meal',
    'get_budgets',
]);

/** Gemini sometimes invents PascalCase / duplicated names (e.g. LogBulkExpensesExpenses). */
export function resolveToolName(raw: string): string {
    if (KNOWN_TOOL_NAMES.has(raw)) return raw;
    let snake = raw
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .toLowerCase()
        .replace(/_+/g, '_');
    if (KNOWN_TOOL_NAMES.has(snake)) return snake;
    const parts = snake.split('_').filter(Boolean);
    const collapsed: string[] = [];
    for (const p of parts) {
        if (collapsed[collapsed.length - 1] !== p) collapsed.push(p);
    }
    snake = collapsed.join('_');
    return KNOWN_TOOL_NAMES.has(snake) ? snake : snake;
}

export async function handleToolCall(
    call: FunctionCall,
    chat: ChatSession,
    ctx: Context,
    options?: ToolCallOptions
): Promise<ToolCallResult> {
    const userId = getUserId(ctx);
    const rawName = call.name;
    const resolvedName = resolveToolName(rawName);
    if (resolvedName !== rawName && KNOWN_TOOL_NAMES.has(resolvedName)) {
        (call as { name: string }).name = resolvedName;
    }

    if (call.name === 'log_expense') {
        const args = call.args as ExpenseItemArgs & {
            reimbursements?: { source: string; amount: number }[];
            toInvestmentAccount?: string;
            dashboardNote?: string;
        };
        const resolvedDate = resolveLogDate(toIsoDate(args.date), options);
        const resolvedCategory = resolveCategory(args.category);
        // Nothing is logged: ask (single call) or list it as not logged (several calls in one turn).
        const notLogged = async (
            response: Record<string, unknown>,
            question: string,
            skipReason: string
        ): Promise<ToolCallResult> => {
            await chat.sendMessage([{ functionResponse: { name: 'log_expense', response } }]);
            if (options?.suppressExpenseReply) {
                options.expenseSkipCollector?.push({
                    date: resolvedDate,
                    description: args.description,
                    amount: args.amount,
                    currency: args.currency || 'MYR',
                    reason: skipReason,
                });
                return 'complete';
            }
            await ctx.reply(`⚠️ Not logged: ${question}`);
            return 'awaiting_input';
        };
        // 3.2: checked on the raw text before the trip planner, whose isCash(null) can't tell a
        // dropped account from trip cash. Cash variants and an omitted account pass.
        const account = await checkPaymentAccount(args.paymentMethod);
        if (!account.ok) {
            const known = getExpensePaymentAccountNames();
            return notLogged(
                accountMissResponse(account, known),
                accountQuestion(account, known),
                accountSkipReason(account)
            );
        }
        // 3.3: Investment (and Other with both accounts) also credits the destination account.
        const fundable = isInvestmentCategory(resolvedCategory) || isOtherCategory(resolvedCategory);
        const destinationCheck = fundable ? await checkPaymentAccount(args.toInvestmentAccount) : null;
        if (destinationCheck && !destinationCheck.ok) {
            const known = getPaymentAccountNames();
            return notLogged(
                accountMissResponse(destinationCheck, known),
                accountQuestion(destinationCheck, known),
                accountSkipReason(destinationCheck)
            );
        }
        let paymentMethod = account.name;
        let toInvestmentAccount = destinationCheck?.ok ? destinationCheck.name : null;
        if (isOtherCategory(resolvedCategory)) {
            ({ paymentMethod, toInvestmentAccount } = normalizeOtherAccounts(paymentMethod, toInvestmentAccount));
        }
        const fundingError = validateFundingAccounts(resolvedCategory, paymentMethod, toInvestmentAccount);
        if (fundingError) {
            return notLogged(
                {
                    status: 'needs_accounts',
                    error: fundingError,
                    paymentMethod,
                    toInvestmentAccount,
                    investmentAccounts: investmentAccountNames(),
                },
                fundingQuestion(paymentMethod, toInvestmentAccount, fundingError),
                'investment needs a from and a to account — say which, then resend'
            );
        }
        const destination = fundingDestination(resolvedCategory, paymentMethod, toInvestmentAccount);
        const result = await logExpenseWithTrip(
            {
                date: resolvedDate,
                amount: args.amount,
                currency: args.currency,
                amountText: args.amountText,
                category: resolvedCategory,
                description: args.description,
                paymentMethod,
                // Only 'cash' or nothing reaches here unresolved; the trip planner books both as trip cash.
                paymentMethodText: paymentMethod ?? account.text,
                tripExpense: args.tripExpense,
            },
            options?.tripLookup ?? new TripLookup()
        );
        if (result.status === 'skipped') {
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'log_expense',
                        response: { status: 'not_logged', reason: result.skipped.reason },
                    },
                },
            ]);
            if (options?.suppressExpenseReply) {
                options.expenseSkipCollector?.push(result.skipped);
            } else {
                await ctx.reply(formatBulkExpenseLogReply([], [result.skipped]));
            }
            return 'complete';
        }

        const entry = result.entry;
        // Shared-bill shares come in the bill's currency; trip-currency rows are stored in MYR.
        const reimbursements =
            entry.fxRate != null
                ? args.reimbursements?.map((r) => ({
                      ...r,
                      amount: Math.round(r.amount * entry.fxRate! * 100) / 100,
                  }))
                : args.reimbursements;
        if (reimbursements?.length) {
            await appendReimbursements(entry.expenseId, reimbursements, resolvedDate);
        }
        // 3.3: the linked Account transfer into the investment account (trip legs have none).
        let fundingLine = '';
        let fundingWarning: string | undefined;
        if (destination && paymentMethod && entry.tripLeg == null) {
            try {
                await upsertInvestmentFundingTransfer({
                    expenseId: entry.expenseId,
                    date: resolvedDate,
                    amount: entry.amount,
                    description: args.description,
                    fromPaymentMethod: paymentMethod,
                    toInvestmentAccount: destination,
                });
                fundingLine = `\n🏦 → ${destination} (linked transfer)`;
            } catch (err) {
                fundingWarning = `transfer to ${destination} not recorded (${errorMessage(err)}), fix it on the Dashboard`;
                fundingLine = `\n⚠️ ${fundingWarning[0].toUpperCase()}${fundingWarning.slice(1)}`;
            }
        }
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'log_expense',
                    response: {
                        status: 'success',
                        ...(destination && !fundingWarning ? { linkedTransferTo: destination } : {}),
                    },
                },
            },
        ]);
        // 3.13: what to record on the Dashboard for a Dashboard-only item (car service, share trade).
        const dashboardNote = args.dashboardNote?.trim();
        const replyExtra = fundingLine + (dashboardNote ? `\n📝 ${dashboardNote}` : '');
        if (options?.suppressExpenseReply) {
            const note = [entry.note, fundingWarning, dashboardNote].filter(Boolean).join('; ') || undefined;
            options.expenseBatchCollector?.push({ ...entry, note, reimbursements });
            return 'complete';
        }
        if (reimbursements?.length) {
            await ctx.reply(
                formatSharedExpenseReply(
                    resolvedDate,
                    entry.amount,
                    entry.currency,
                    resolvedCategory,
                    args.description,
                    reimbursements,
                    entry.expenseId,
                    entry.paymentMethod
                ) + replyExtra
            );
        } else {
            await ctx.reply(
                formatExpenseLogReply(
                    resolvedDate,
                    entry.amount,
                    entry.currency,
                    resolvedCategory,
                    args.description,
                    entry.expenseId,
                    entry.paymentMethod,
                    undefined,
                    entry
                ) + replyExtra
            );
        }
        return 'complete';
    } else if (call.name === 'log_income') {
        const args = call.args as {
            date?: string;
            amount: number;
            currency?: string;
            category: string;
            description: string;
            source?: string;
            relatedExpenseDescription?: string;
            paymentMethod?: string;
            fromPaymentMethod?: string;
            transferFee?: number;
            dashboardNote?: string;
        };
        const resolvedDate = resolveLogDate(args.date, options);
        const resolvedCurrency = args.currency || 'MYR';
        const isTransfer = isAccountTransferCategory(args.category ?? '');
        // 3.15: a move between your own accounts never funds the replied-to (or described) expense;
        // linking it would make both apps skip that expense's debit.
        let expenseId: number | undefined = isTransfer ? undefined : options?.replyToExpenseId;
        if (!isTransfer && !expenseId && args.relatedExpenseDescription) {
            const found = await findRecentExpenseByDescription(args.relatedExpenseDescription);
            if (found) expenseId = found;
        }
        // 3.2: the to-account (and a transfer's from-account) must resolve, or the user is asked.
        const toAccount = await checkPaymentAccount(args.paymentMethod);
        const fromAccount = isTransfer ? await checkPaymentAccount(args.fromPaymentMethod) : null;
        const accountMiss = !toAccount.ok ? toAccount : fromAccount && !fromAccount.ok ? fromAccount : null;
        if (accountMiss) {
            const known = getPaymentAccountNames();
            await chat.sendMessage([
                { functionResponse: { name: 'log_income', response: accountMissResponse(accountMiss, known) } },
            ]);
            await ctx.reply(`⚠️ Not logged: ${accountQuestion(accountMiss, known)}`);
            return 'awaiting_input';
        }
        const toName = toAccount.ok ? toAccount.name : null;
        const fromName = fromAccount?.ok ? fromAccount.name : null;
        // An Account transfer needs both sides: ask (keeping this chat open), as for an unknown account,
        // instead of letting appendIncome throw and end the conversation.
        if (isTransfer && (!fromName || !toName)) {
            const known = getPaymentAccountNames();
            const asks = [
                !fromName ? 'which account the money left' : null,
                !toName ? 'which account it went to' : null,
            ].filter(Boolean);
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'log_income',
                        response: {
                            status: 'needs_accounts',
                            error: 'Account transfer requires from and to accounts',
                            fromPaymentMethod: fromName,
                            paymentMethod: toName,
                            known,
                        },
                    },
                },
            ]);
            const list = known.length > 0 ? ` Accounts: ${known.join(', ')}.` : '';
            await ctx.reply(`⚠️ Not logged: an account transfer needs both accounts. Tell me ${asks.join(' and ')}.${list}`);
            return 'awaiting_input';
        }
        let incomeId: number;
        try {
            incomeId = await appendIncome(
                resolvedDate,
                args.amount,
                resolvedCurrency,
                args.category,
                args.description,
                args.source,
                expenseId,
                toName,
                fromName,
                args.transferFee
            );
        } catch (err) {
            // Equal transfer accounts, or a fee on a non-transfer: nothing was written.
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'log_income',
                        response: { status: 'error', message: errorMessage(err) },
                    },
                },
            ]);
            await ctx.reply(`⚠️ ${errorMessage(err)}`);
            return 'complete';
        }
        // The income is already written: a failed re-read falls back to what was passed in, so the user
        // still gets the confirmation (a throw here could also make runSpecialist retry and log it twice).
        const stored = await getIncomeById(incomeId).catch((err) => {
            console.warn(`log_income: re-reading income #${incomeId} failed:`, err);
            return null;
        });
        await chat.sendMessage([
            { functionResponse: { name: 'log_income', response: { status: 'success', incomeId } } },
        ]);
        const incomeDashboardNote = args.dashboardNote?.trim();
        await ctx.reply(
            formatIncomeLogReply(
                resolvedDate,
                args.amount,
                resolvedCurrency,
                args.category,
                args.description,
                incomeId,
                args.source,
                expenseId != null,
                stored?.paymentMethod ?? toName,
                stored ? stored.fromPaymentMethod : fromName,
                '✅ Logged income',
                stored ? stored.transferFee : args.transferFee
            ) + (incomeDashboardNote ? `\n📝 ${incomeDashboardNote}` : '')
        );
        return 'complete';
    } else if (call.name === 'edit_expense') {
        const args = call.args as {
            id?: number;
            date?: string;
            amount?: number;
            currency?: string;
            category?: string;
            description?: string;
            paymentMethod?: string;
            toInvestmentAccount?: string;
        };
        const id = resolveToolRecordId(args.id, options, 'expense');
        if (id == null) {
            await chat.sendMessage([
                { functionResponse: { name: 'edit_expense', response: { status: 'missing_id' } } },
            ]);
            await ctx.reply('⚠️ Reply to an expense confirmation or provide the expense #id to edit.');
            return 'complete';
        }
        const existing = await getExpenseById(id);
        if (!existing) {
            await chat.sendMessage([
                { functionResponse: { name: 'edit_expense', response: { status: 'not_found' } } },
            ]);
            await ctx.reply(`⚠️ Could not find expense #${id} to update.`);
            return 'complete';
        }
        let amountFields: Parameters<typeof updateExpense>[1] = {
            amount: args.amount,
            currency: args.currency,
        };
        const isTripCurrencyRow = existing.tripLeg === 'fund' || existing.tripLeg === 'card';
        if (isTripCurrencyRow && args.amount != null) {
            // Fund legs are cash bought at the trip's exchange rate; card legs keep their charged rate.
            const tripRate =
                existing.tripLeg === 'fund' && existing.tripId != null
                    ? await getLatestExchangeRate(existing.tripId)
                    : null;
            const recomputed = recomputeTripLegAmount(existing, args.amount, args.currency, tripRate);
            if ('error' in recomputed) {
                await chat.sendMessage([
                    {
                        functionResponse: {
                            name: 'edit_expense',
                            response: { status: 'failed', reason: recomputed.error },
                        },
                    },
                ]);
                await ctx.reply(`⚠️ Couldn't update #${id}: ${recomputed.error}.`);
                return 'complete';
            }
            amountFields = recomputed;
        } else if (isTripCurrencyRow) {
            // Trip-currency rows are always stored in MYR; a bare currency change would corrupt them.
            amountFields = {};
        }
        // Nothing is written: ask for the missing / unknown account.
        const notUpdated = async (
            response: Record<string, unknown>,
            question: string
        ): Promise<ToolCallResult> => {
            await chat.sendMessage([{ functionResponse: { name: 'edit_expense', response } }]);
            await ctx.reply(`⚠️ #${id} not updated: ${question}`);
            return 'awaiting_input';
        };
        // 3.2: a changed account must resolve (cash variants pass, empty clears it). The same text as
        // stored goes through as is: updateExpense keeps it even if it no longer resolves.
        let paymentMethodField: string | null | undefined = args.paymentMethod;
        let nextFrom = existing.paymentMethod;
        if (args.paymentMethod != null && !sameAccountName(args.paymentMethod, existing.paymentMethod)) {
            const check = await checkPaymentAccount(args.paymentMethod);
            if (!check.ok) {
                const known = getExpensePaymentAccountNames();
                return notUpdated(accountMissResponse(check, known), accountQuestion(check, known));
            }
            paymentMethodField = check.name;
            nextFrom = check.name;
        }
        // 3.3: an Investment row (or Other with a linked transfer) keeps its funding transfer in step,
        // checked before anything is written. Trip legs never carry one.
        let funding: { from: string; to: string } | 'delete' | null = null;
        if (existing.tripLeg == null) {
            let destination: string | null = null;
            if (args.toInvestmentAccount?.trim()) {
                const check = await checkPaymentAccount(args.toInvestmentAccount);
                if (!check.ok) {
                    const known = getPaymentAccountNames();
                    return notUpdated(accountMissResponse(check, known), accountQuestion(check, known));
                }
                destination = check.name;
            }
            const linkedTransfer = (await getIncomesByExpenseId(id)).find((income) =>
                isAccountTransferCategory(income.category)
            );
            const nextCategory = args.category != null ? resolveCategory(args.category) : existing.category;
            const keepsTransfer =
                isInvestmentCategory(nextCategory) ||
                (isOtherCategory(nextCategory) && (linkedTransfer != null || destination != null));
            if (keepsTransfer) {
                const nextTo = destination ?? displayPaymentMethod(linkedTransfer?.paymentMethod);
                // Both accounts required and different, as for an Investment row.
                const fundingError = validateFundingAccounts('Investment', nextFrom, nextTo);
                if (fundingError || !nextFrom || !nextTo) {
                    const error = fundingError ?? 'This expense requires both accounts';
                    return notUpdated(
                        {
                            status: 'needs_accounts',
                            error,
                            paymentMethod: nextFrom,
                            toInvestmentAccount: nextTo,
                            investmentAccounts: investmentAccountNames(),
                        },
                        fundingQuestion(nextFrom, nextTo, error)
                    );
                }
                funding = { from: nextFrom, to: nextTo };
            } else if (linkedTransfer) {
                funding = 'delete';
            }
        }
        const fields: Parameters<typeof updateExpense>[1] = {
            date: toIsoDate(args.date),
            ...amountFields,
            category: args.category,
            description: args.description,
            paymentMethod: paymentMethodField,
        };
        // A destination only applies to Investment / Other rows (never trip legs): say it was ignored
        // rather than drop it silently, or fail with no reason when it was the only change.
        const ignoredDestination =
            args.toInvestmentAccount?.trim() && (funding == null || funding === 'delete')
                ? args.toInvestmentAccount.trim()
                : null;
        const noTransferReason =
            existing.tripLeg != null
                ? 'trip expenses never move money to another account'
                : 'only Investment and Other expenses move money to another account';
        if (ignoredDestination && Object.values(fields).every((value) => value === undefined)) {
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'edit_expense',
                        response: {
                            status: 'not_applicable',
                            reason: noTransferReason,
                            category: args.category != null ? resolveCategory(args.category) : existing.category,
                        },
                    },
                },
            ]);
            await ctx.reply(`⚠️ #${id} not updated: ${noTransferReason}.`);
            return 'complete';
        }
        // "#12 went to StashAway" changes only the linked transfer, not the expense row.
        const transferOnly =
            funding != null &&
            funding !== 'delete' &&
            Object.values(fields).every((value) => value === undefined);
        if (!transferOnly) {
            let updated: boolean;
            try {
                updated = await updateExpense(id, fields);
            } catch (err) {
                await chat.sendMessage([
                    {
                        functionResponse: {
                            name: 'edit_expense',
                            response: { status: 'error', message: errorMessage(err) },
                        },
                    },
                ]);
                await ctx.reply(`⚠️ ${errorMessage(err) || 'Failed to update expense.'}`);
                return 'complete';
            }
            if (!updated) {
                await chat.sendMessage([
                    { functionResponse: { name: 'edit_expense', response: { status: 'failed' } } },
                ]);
                await ctx.reply(`⚠️ Failed to update expense #${id}.`);
                return 'complete';
            }
        }
        const row = (await getExpenseById(id))!;
        const trip = row.tripId != null ? await getTripById(row.tripId) : null;
        let fundingLine = '';
        if (funding === 'delete') {
            try {
                await deleteInvestmentFundingTransfer(id);
                fundingLine = '\n🗑️ Linked transfer removed';
            } catch (err) {
                fundingLine = `\n⚠️ Linked transfer not removed (${errorMessage(err)}), fix it on the Dashboard`;
            }
        } else if (funding) {
            try {
                await upsertInvestmentFundingTransfer({
                    expenseId: id,
                    date: row.date,
                    amount: row.amount,
                    description: row.description,
                    fromPaymentMethod: funding.from,
                    toInvestmentAccount: funding.to,
                });
                fundingLine = `\n🏦 → ${funding.to} (linked transfer)`;
            } catch (err) {
                fundingLine = `\n⚠️ Linked transfer not updated (${errorMessage(err)}), fix it on the Dashboard`;
            }
        }
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'edit_expense',
                    response: {
                        status: 'success',
                        expenseId: id,
                        ...(ignoredDestination
                            ? { ignoredToInvestmentAccount: ignoredDestination, reason: noTransferReason }
                            : {}),
                    },
                },
            },
        ]);
        await ctx.reply(
            formatExpenseLogReply(
                row.date,
                row.amount,
                row.currency,
                row.category,
                row.description,
                row.id,
                row.paymentMethod,
                '✅ Updated',
                { ...row, tripName: trip?.name }
            ) +
                fundingLine +
                (ignoredDestination ? `\n(No transfer to ${ignoredDestination}: ${noTransferReason}.)` : '')
        );
        return 'complete';
    } else if (call.name === 'delete_expense') {
        const args = call.args as { id?: number };
        const id = resolveToolRecordId(args.id, options, 'expense');
        if (id == null) {
            await chat.sendMessage([
                { functionResponse: { name: 'delete_expense', response: { status: 'missing_id' } } },
            ]);
            await ctx.reply('⚠️ Reply to an expense confirmation or provide the expense #id to delete.');
            return 'complete';
        }
        const deleted = await deleteExpense(id);
        if (!deleted) {
            await chat.sendMessage([
                { functionResponse: { name: 'delete_expense', response: { status: 'not_found' } } },
            ]);
            await ctx.reply(`⚠️ Could not find expense #${id} to delete.`);
            return 'complete';
        }
        await chat.sendMessage([
            { functionResponse: { name: 'delete_expense', response: { status: 'success', expenseId: id } } },
        ]);
        await ctx.reply(`🗑️ Deleted expense #${id}`);
        return 'complete';
    } else if (call.name === 'edit_income') {
        const args = call.args as {
            id?: number;
            date?: string;
            amount?: number;
            currency?: string;
            category?: string;
            description?: string;
            source?: string;
            paymentMethod?: string;
            fromPaymentMethod?: string;
            transferFee?: number;
        };
        const id = resolveToolRecordId(args.id, options, 'income');
        if (id == null) {
            await chat.sendMessage([
                { functionResponse: { name: 'edit_income', response: { status: 'missing_id' } } },
            ]);
            await ctx.reply('⚠️ Reply to an income confirmation or provide the income #id to edit.');
            return 'complete';
        }
        const existing = await getIncomeById(id);
        if (!existing) {
            await chat.sendMessage([
                { functionResponse: { name: 'edit_income', response: { status: 'not_found' } } },
            ]);
            await ctx.reply(`⚠️ Could not find income #${id} to update.`);
            return 'complete';
        }
        // 3.2: a changed account must resolve (cash variants pass, empty clears it), or the user is
        // asked. The same text as stored goes through: updateIncome keeps it even if it no longer
        // resolves. A from-account only matters for an Account transfer.
        const nextIsTransfer = isAccountTransferCategory(args.category ?? existing.category);
        const incomeAccount = async (
            incoming: string | undefined,
            stored: string | null
        ): Promise<{ value: string | null | undefined } | AccountMiss> => {
            if (incoming == null || sameAccountName(incoming, stored)) return { value: incoming };
            const check = await checkPaymentAccount(incoming);
            return check.ok ? { value: check.name } : check;
        };
        const toField = await incomeAccount(args.paymentMethod, existing.paymentMethod);
        const fromField = nextIsTransfer
            ? await incomeAccount(args.fromPaymentMethod, existing.fromPaymentMethod)
            : { value: args.fromPaymentMethod };
        const incomeMiss = 'ok' in toField ? toField : 'ok' in fromField ? fromField : null;
        if (incomeMiss) {
            const known = getPaymentAccountNames();
            await chat.sendMessage([
                { functionResponse: { name: 'edit_income', response: accountMissResponse(incomeMiss, known) } },
            ]);
            await ctx.reply(`⚠️ #${id} not updated: ${accountQuestion(incomeMiss, known)}`);
            return 'awaiting_input';
        }
        try {
            const updated = await updateIncome(id, {
                date: args.date,
                amount: args.amount,
                currency: args.currency,
                category: args.category,
                description: args.description,
                source: args.source,
                paymentMethod: 'value' in toField ? toField.value : undefined,
                fromPaymentMethod: 'value' in fromField ? fromField.value : undefined,
                transferFee: args.transferFee,
            });
            if (!updated) {
                await chat.sendMessage([
                    { functionResponse: { name: 'edit_income', response: { status: 'failed' } } },
                ]);
                await ctx.reply(`⚠️ Failed to update income #${id}.`);
                return 'complete';
            }
        } catch (err: any) {
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'edit_income',
                        response: { status: 'error', message: err?.message },
                    },
                },
            ]);
            await ctx.reply(`⚠️ ${err?.message || 'Failed to update income.'}`);
            return 'complete';
        }
        const row = (await getIncomeById(id))!;
        await chat.sendMessage([
            { functionResponse: { name: 'edit_income', response: { status: 'success', incomeId: id } } },
        ]);
        await ctx.reply(
            formatIncomeLogReply(
                row.date,
                row.amount,
                row.currency,
                row.category,
                row.description,
                row.id,
                row.source ?? undefined,
                row.expenseId != null,
                row.paymentMethod,
                row.fromPaymentMethod,
                '✅ Updated income',
                row.transferFee
            )
        );
        return 'complete';
    } else if (call.name === 'delete_income') {
        const args = call.args as { id?: number };
        const id = resolveToolRecordId(args.id, options, 'income');
        if (id == null) {
            await chat.sendMessage([
                { functionResponse: { name: 'delete_income', response: { status: 'missing_id' } } },
            ]);
            await ctx.reply('⚠️ Reply to an income confirmation or provide the income #id to delete.');
            return 'complete';
        }
        const deleted = await deleteIncome(id);
        if (!deleted) {
            await chat.sendMessage([
                { functionResponse: { name: 'delete_income', response: { status: 'not_found' } } },
            ]);
            await ctx.reply(`⚠️ Could not find income #${id} to delete.`);
            return 'complete';
        }
        await chat.sendMessage([
            { functionResponse: { name: 'delete_income', response: { status: 'success', incomeId: id } } },
        ]);
        await ctx.reply(`🗑️ Deleted income #${id}`);
        return 'complete';
    } else if (call.name === 'get_spending_summary') {
        const args = call.args as {
            category?: string;
            description?: string;
            paymentMethod?: string;
            startDate?: string;
            endDate?: string;
        };
        // 3.2: an account filter that matches no account would summarise nothing (or, before, the
        // whole month). A deactivated account still filters: its old rows keep its name.
        let paymentMethodFilter = args.paymentMethod;
        if (args.paymentMethod?.trim()) {
            const check = await checkPaymentAccount(args.paymentMethod, { allowInactive: true });
            if (!check.ok) {
                const known = getPaymentAccountNames();
                await chat.sendMessage([
                    {
                        functionResponse: {
                            name: 'get_spending_summary',
                            response: accountMissResponse(check, known),
                        },
                    },
                ]);
                await ctx.reply(`⚠️ ${accountQuestion(check, known)}`);
                return 'awaiting_input';
            }
            // Cash with no Cash account: filter on the text, which matches rows stored as "Cash".
            paymentMethodFilter = check.name ?? args.paymentMethod.trim();
        }
        const summaryData = await getSpendingSummary(
            args.category,
            args.description,
            args.startDate,
            args.endDate,
            paymentMethodFilter
        );
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'get_spending_summary', response: summaryData } },
        ]);
        await ctx.reply(toolResult.response.text());
        return 'complete';
    } else if (call.name === 'log_currency_exchange') {
        // 3.11: the Dashboard Trips panel's "Add exchange", from Telegram.
        const args = call.args as {
            date?: string;
            myrAmount: number;
            foreignAmount: number;
            foreignAmountText?: string;
            foreignCurrency?: string;
            paymentMethod?: string;
            tripName?: string;
        };
        const exchangeNotLogged = async (
            response: Record<string, unknown>,
            message: string,
            ask: boolean
        ): Promise<ToolCallResult> => {
            await chat.sendMessage([{ functionResponse: { name: 'log_currency_exchange', response } }]);
            await ctx.reply(`⚠️ Exchange not logged: ${asSentence(message)}`);
            return ask ? 'awaiting_input' : 'complete';
        };
        // Like the Dashboard, an exchange needs the active account the MYR came from.
        const account = await checkPaymentAccount(args.paymentMethod);
        if (!account.ok) {
            const known = getExpensePaymentAccountNames();
            return exchangeNotLogged(accountMissResponse(account, known), accountQuestion(account, known), true);
        }
        if (!account.name) {
            const known = getExpensePaymentAccountNames();
            const list = known.length > 0 ? ` Accounts: ${known.join(', ')}.` : '';
            return exchangeNotLogged(
                { status: 'needs_payment_method', known },
                account.text === 'cash'
                    ? `there is no active Cash account (add it in the Dashboard Setup tab). Which account paid?${list}`
                    : `which account did the MYR come from (Cash at a money changer, or a bank)?${list}`,
                true
            );
        }
        const exchange = await logCurrencyExchange(
            {
                date: resolveLogDate(toIsoDate(args.date), options),
                myrAmount: args.myrAmount,
                foreignAmount: args.foreignAmount,
                foreignAmountText: args.foreignAmountText,
                foreignCurrency: args.foreignCurrency,
                paymentMethod: account.name,
                tripName: args.tripName,
            },
            // Shared with the turn's other calls: logCurrencyExchange drops the cached rate, so
            // trip-currency spends later in the same message convert at the new rate.
            options?.tripLookup ?? new TripLookup()
        );
        if (exchange.status === 'not_logged') {
            return exchangeNotLogged({ status: 'not_logged', reason: exchange.reason }, exchange.reason, exchange.ask);
        }
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'log_currency_exchange',
                    response: {
                        status: 'success',
                        expenseId: exchange.expenseId,
                        trip: exchange.trip.name,
                        myrAmount: exchange.myrAmount,
                        fxAmount: exchange.fxAmount,
                        fxCurrency: exchange.trip.tripCurrency,
                    },
                },
            },
        ]);
        await ctx.reply(formatCurrencyExchangeReply(exchange));
        return 'complete';
    } else if (call.name === 'create_trip') {
        // 3.11: the Trips panel's "New trip", from Telegram.
        const args = call.args as {
            name?: string;
            tripCurrency?: string;
            startDate?: string;
            endDate?: string;
            notes?: string;
        };
        const newTrip = planNewTrip(
            { ...args, startDate: toIsoDate(args.startDate), endDate: toIsoDate(args.endDate) },
            await listTrips()
        );
        if ('error' in newTrip) {
            await chat.sendMessage([
                { functionResponse: { name: 'create_trip', response: { status: 'not_created', reason: newTrip.error } } },
            ]);
            await ctx.reply(`⚠️ Trip not created: ${asSentence(newTrip.error)}`);
            return newTrip.ask ? 'awaiting_input' : 'complete';
        }
        const trip = await createTrip(newTrip.fields);
        // An exchange or spend later in this message must see the new trip.
        options?.tripLookup?.invalidateTrips();
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'create_trip',
                    response: { status: 'success', tripId: trip.id, name: trip.name, tripCurrency: trip.tripCurrency },
                },
            },
        ]);
        await ctx.reply(formatTripCreatedReply(trip, newTrip.overlaps));
        return 'complete';
    } else if (call.name === 'get_trip_summary') {
        // 3.12: the Trips panel totals; the date-range summary counts the exchange as spending,
        // misses trip-cash rows and includes home bills.
        const args = call.args as { tripName?: string; date?: string };
        const picked = pickSummaryTrip(await listTrips(), args.tripName, toIsoDate(args.date) || todayISO());
        const summary = 'trip' in picked ? await getTripSummary(picked.trip.id) : null;
        if (!summary) {
            const message = 'error' in picked ? picked.error : 'Trip not found.';
            await chat.sendMessage([
                { functionResponse: { name: 'get_trip_summary', response: { status: 'not_found', message } } },
            ]);
            await ctx.reply(`⚠️ ${message}`);
            return 'error' in picked && picked.ask ? 'awaiting_input' : 'complete';
        }
        const view = tripSummaryView(summary);
        const toolResult = await chat.sendMessage([
            {
                functionResponse: {
                    name: 'get_trip_summary',
                    response: { status: 'success', ...view, wording: TRIP_SUMMARY_WORDING },
                },
            },
        ]);
        const text = toolResult.response.text();
        await replyInChunks(ctx, text.trim() ? text : formatTripSummaryReply(view));
        return 'complete';
    } else if (call.name === 'add_fixed_expense') {
        // 3.6 / 3.2: holding, destination account and the unknown-account guard (fixedFundHandlers.ts).
        return addFixedExpenseTool(call.args as AddFixedExpenseArgs, chat, ctx);
    } else if (call.name === 'update_fixed_expense') {
        return updateFixedExpenseTool(call.args as UpdateFixedExpenseArgs, chat, ctx);
    } else if (call.name === 'get_all_fixed_expenses') {
        return listFixedExpensesTool(chat, ctx);
    } else if (call.name === 'invest_in_fund') {
        const args = call.args as FundMoveArgs;
        return investInFundTool(args, resolveLogDate(toIsoDate(args.date), options), chat, ctx);
    } else if (call.name === 'withdraw_from_fund') {
        const args = call.args as FundMoveArgs;
        return withdrawFromFundTool(args, resolveLogDate(toIsoDate(args.date), options), chat, ctx);
    } else if (call.name === 'delete_fixed_expense') {
        const args = call.args as { description: string };
        const deleteStatus = await deleteFixedExpense(args.description);
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'delete_fixed_expense',
                    response: { status: deleteStatus === true ? 'success' : 'failed' },
                },
            },
        ]);
        if (deleteStatus === 'not_found') {
            await ctx.reply(
                `⚠️ I couldn't find any bill matching "${args.description}" to cancel.`
            );
        } else {
            await ctx.reply(
                `🗑️ Done! I have completely removed "${args.description}" from your recurring bills.`
            );
        }
        return 'complete';
    } else if (call.name === 'add_interest_schedule') {
        const args = call.args as {
            paymentMethod: string;
            frequency: string;
            dayOfMonth?: number;
            annualRatePct?: number;
            fixedAmount?: number;
            currency?: string;
            description?: string;
        };
        const frequency = (args.frequency?.toLowerCase() === 'monthly'
            ? 'monthly'
            : 'daily') as InterestFrequency;
        // 3.2 / financeConfig ACCOUNTS rule: an unknown, ambiguous or deactivated account is asked
        // about, never stored as raw text (the 9am accrual would then log interest with no account).
        const account = await checkPaymentAccount(args.paymentMethod);
        if (!account.ok) {
            const known = getPaymentAccountNames();
            await chat.sendMessage([
                { functionResponse: { name: 'add_interest_schedule', response: accountMissResponse(account, known) } },
            ]);
            await ctx.reply(`⚠️ Not saved: ${accountQuestion(account, known)}`);
            return 'awaiting_input';
        }
        if (!account.name) {
            await chat.sendMessage([
                { functionResponse: { name: 'add_interest_schedule', response: { status: 'needs_payment_method' } } },
            ]);
            await ctx.reply('⚠️ Please specify a valid payment account for interest.');
            return 'awaiting_input';
        }
        const resolvedAccount = account.name;
        const description =
            args.description?.trim() ||
            `${resolvedAccount} ${frequency} interest`;

        await addInterestSchedule({
            paymentMethod: resolvedAccount,
            frequency,
            dayOfMonth: frequency === 'monthly' ? args.dayOfMonth ?? 1 : null,
            annualRatePct: args.annualRatePct ?? null,
            fixedAmount: args.fixedAmount ?? null,
            currency: args.currency || 'MYR',
            description,
        });
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'add_interest_schedule',
                    response: { status: 'success' },
                },
            },
        ]);

        const ratePart =
            args.fixedAmount != null
                ? `RM ${args.fixedAmount} fixed`
                : args.annualRatePct != null
                  ? `${args.annualRatePct}% p.a.`
                  : 'configured rate';
        const whenPart =
            frequency === 'daily'
                ? 'daily'
                : `monthly on day ${args.dayOfMonth ?? 1}`;
        await ctx.reply(
            `💰 Done! I'll accrue ${description} ${whenPart} for ${resolvedAccount} (${ratePart}).`
        );
        return 'complete';
    } else if (call.name === 'update_interest_schedule') {
        const args = call.args as {
            description: string;
            annualRatePct?: number;
            fixedAmount?: number;
            frequency?: string;
            dayOfMonth?: number;
        };
        const schedules = await getActiveInterestSchedules();
        const match = schedules.find((s) =>
            s.description.toLowerCase().includes(args.description.toLowerCase())
        );
        if (!match) {
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'update_interest_schedule',
                        response: { status: 'not_found' },
                    },
                },
            ]);
            await ctx.reply(
                `⚠️ I couldn't find any interest schedule matching "${args.description}".`
            );
            return 'complete';
        }

        const fields: {
            annualRatePct?: number | null;
            fixedAmount?: number | null;
            frequency?: InterestFrequency;
            dayOfMonth?: number | null;
        } = {};
        if (args.annualRatePct !== undefined) fields.annualRatePct = args.annualRatePct;
        if (args.fixedAmount !== undefined) fields.fixedAmount = args.fixedAmount;
        if (args.frequency != null) {
            fields.frequency = (
                args.frequency.toLowerCase() === 'monthly' ? 'monthly' : 'daily'
            ) as InterestFrequency;
        }
        if (args.dayOfMonth !== undefined) fields.dayOfMonth = args.dayOfMonth;

        await updateInterestScheduleById(match.id, fields);
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'update_interest_schedule',
                    response: { status: 'success' },
                },
            },
        ]);
        await ctx.reply(`✅ Updated interest schedule "${match.description}".`);
        return 'complete';
    } else if (call.name === 'get_all_interest_schedules') {
        const schedules = await getActiveInterestSchedules();
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'get_all_interest_schedules',
                    response: { schedules },
                },
            },
        ]);
        await ctx.reply(
            schedules.length === 0
                ? 'No active interest schedules.'
                : schedules
                      .map((s) => {
                          const rate =
                              s.fixedAmount != null
                                  ? `RM ${s.fixedAmount} fixed`
                                  : s.annualRatePct != null
                                    ? `${s.annualRatePct}% p.a.`
                                    : 'no rate';
                          const when =
                              s.frequency === 'daily'
                                  ? 'daily'
                                  : `monthly (day ${s.dayOfMonth})`;
                          return `• ${s.description} — ${s.paymentMethod}, ${when}, ${rate}`;
                      })
                      .join('\n')
        );
        return 'complete';
    } else if (call.name === 'delete_interest_schedule') {
        const args = call.args as { description: string };
        const deleteStatus = await deactivateInterestScheduleByDescription(args.description);
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'delete_interest_schedule',
                    response: {
                        status: deleteStatus === true ? 'success' : 'failed',
                    },
                },
            },
        ]);
        if (deleteStatus === 'not_found') {
            await ctx.reply(
                `⚠️ I couldn't find any interest schedule matching "${args.description}".`
            );
        } else {
            await ctx.reply(
                `🗑️ Removed interest schedule matching "${args.description}".`
            );
        }
        return 'complete';
    } else if (call.name === 'create_calendar_event') {
        const args = call.args as {
            title: string;
            startDateTime?: string;
            endDateTime?: string;
            description?: string;
        };

        if (!args.startDateTime) {
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'create_calendar_event',
                        response: {
                            status: 'incomplete',
                            missing: ['startDateTime'],
                            partial: { title: args.title, description: args.description },
                        },
                    },
                },
            ]);
            const followUp = await chat.sendMessage(
                'The event is missing a date/time. Ask the user one short question to get it.'
            );
            await ctx.reply(followUp.response.text());
            return 'awaiting_input';
        }

        try {
            await createCalendarEvent(
                args.title,
                args.startDateTime,
                args.endDateTime || '',
                args.description || ''
            );
            await chat.sendMessage([
                { functionResponse: { name: 'create_calendar_event', response: { status: 'success' } } },
            ]);
            await ctx.reply(
                `📅 **Event Scheduled!**\n\n` +
                    `I've added "${args.title}" to my records and sent an invitation to your Gmail.\n\n` +
                    `👉 Please check your calendar on **"${args.startDateTime}"** or look for an invite email to confirm!`,
                { parse_mode: 'Markdown' }
            );
            return 'complete';
        } catch (error) {
            console.error('Tool Execution Error:', error);
            await ctx.reply('I had a problem connecting to the calendar. Please try again in a moment.');
            return 'complete';
        }
    } else if (call.name === 'check_schedule') {
        const args = call.args as { date: string };
        const scheduleData = await getSchedule(args.date);
        const nextResult = await chat.sendMessage([
            { functionResponse: { name: 'check_schedule', response: { schedule: scheduleData } } },
        ]);
        await ctx.reply(nextResult.response.text());
        return 'complete';
    } else if (call.name === 'reschedule_calendar_event') {
        const args = call.args as {
            title: string;
            newStartDateTime: string;
            date?: string;
            newEndDateTime?: string;
            newTitle?: string;
        };
        try {
            const matches = await findCalendarEvents({ title: args.title, date: args.date });
            if (matches.length !== 1) {
                await chat.sendMessage([
                    {
                        functionResponse: {
                            name: 'reschedule_calendar_event',
                            response: {
                                status: matches.length === 0 ? 'not_found' : 'ambiguous',
                                candidates: matches,
                                searchedTitle: args.title,
                                searchedDate: args.date || 'today',
                            },
                        },
                    },
                ]);
                const followUp = await chat.sendMessage(
                    matches.length === 0
                        ? 'No matching event found. Ask the user to clarify the event name or which day it is on.'
                        : 'Multiple events matched. Ask the user which one to reschedule (list titles and times briefly).'
                );
                await ctx.reply(followUp.response.text());
                return 'awaiting_input';
            }
            const updated = await rescheduleCalendarEvent(
                matches[0].id,
                args.newStartDateTime,
                args.newEndDateTime,
                args.newTitle
            );
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'reschedule_calendar_event',
                        response: { status: 'success', event: updated },
                    },
                },
            ]);
            await ctx.reply(
                `📅 **Rescheduled!**\n\n` +
                    `"${updated.title}" → **${updated.start}**`,
                { parse_mode: 'Markdown' }
            );
            return 'complete';
        } catch (error) {
            console.error('Tool Execution Error:', error);
            await ctx.reply('I had a problem rescheduling that event. Please try again in a moment.');
            return 'complete';
        }
    } else if (call.name === 'cancel_calendar_event') {
        const args = call.args as { title: string; date?: string };
        try {
            const matches = await findCalendarEvents({ title: args.title, date: args.date });
            if (matches.length !== 1) {
                await chat.sendMessage([
                    {
                        functionResponse: {
                            name: 'cancel_calendar_event',
                            response: {
                                status: matches.length === 0 ? 'not_found' : 'ambiguous',
                                candidates: matches,
                                searchedTitle: args.title,
                                searchedDate: args.date || 'today',
                            },
                        },
                    },
                ]);
                const followUp = await chat.sendMessage(
                    matches.length === 0
                        ? 'No matching event found. Ask the user to clarify the event name or which day it is on.'
                        : 'Multiple events matched. Ask the user which one to cancel (list titles and times briefly).'
                );
                await ctx.reply(followUp.response.text());
                return 'awaiting_input';
            }
            const cancelled: CalendarEventSummary = matches[0];
            await cancelCalendarEvent(cancelled.id);
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'cancel_calendar_event',
                        response: { status: 'success', event: cancelled },
                    },
                },
            ]);
            await ctx.reply(
                `🗑️ **Cancelled!**\n\n` +
                    `Removed "${cancelled.title}"${cancelled.start ? ` (${cancelled.start})` : ''} from your calendar.`,
                { parse_mode: 'Markdown' }
            );
            return 'complete';
        } catch (error) {
            console.error('Tool Execution Error:', error);
            await ctx.reply('I had a problem cancelling that event. Please try again in a moment.');
            return 'complete';
        }
    } else if (call.name === 'log_bulk_expenses') {
        const args = call.args as Record<string, unknown>;
        let expensesArray = (args.expenses ?? args.Expenses) as unknown;
        if (!Array.isArray(expensesArray) && typeof args.amount === 'number') {
            expensesArray = [args];
        }
        if (!Array.isArray(expensesArray) || expensesArray.length === 0) {
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'log_bulk_expenses',
                        response: { status: 'error', message: 'missing expenses array' },
                    },
                },
            ]);
            await ctx.reply('⚠️ Could not read any expenses from that image. Try again or send as text.');
            return 'complete';
        }
        const lookup = options?.tripLookup ?? new TripLookup();
        const logged: ExpenseBatchEntry[] = [];
        const skipped: SkippedExpense[] = [];
        let listKnownAccounts = false;
        for (const item of expensesArray as Partial<ExpenseItemArgs>[]) {
            // Statement rows keep their own dates—no photo "today" override here.
            const date = toIsoDate(item.date) || todayISO();
            const category = resolveCategory(item.category);
            const description = item.description?.trim() || 'Expense';
            const skip = (reason: string) =>
                skipped.push({
                    date,
                    description,
                    amount: Number(item.amount) || 0,
                    currency: item.currency?.trim().toUpperCase() || 'MYR',
                    reason,
                });
            // 3.2: same guard as log_expense, on the raw text before the trip planner.
            const account = await checkPaymentAccount(item.paymentMethod);
            if (!account.ok) {
                skip(accountSkipReason(account));
                if (account.match !== 'ambiguous') listKnownAccounts = true;
                continue;
            }
            // 3.3: a list entry has no destination account, so an Investment top-up is logged singly.
            if (isInvestmentCategory(category)) {
                skip('investment needs from/to accounts — log it singly');
                continue;
            }
            const result = await logExpenseWithTrip(
                {
                    date,
                    amount: Number(item.amount),
                    currency: item.currency,
                    amountText: item.amountText,
                    category,
                    description,
                    paymentMethod: account.name,
                    paymentMethodText: account.name ?? account.text,
                    tripExpense: item.tripExpense,
                },
                lookup
            );
            if (result.status === 'logged') logged.push(result.entry);
            else skipped.push(result.skipped);
        }
        const knownAccounts = getExpensePaymentAccountNames();
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'log_bulk_expenses',
                    response: {
                        status: 'success',
                        count: logged.length,
                        notLogged: skipped.length,
                        ...(listKnownAccounts ? { knownAccounts } : {}),
                    },
                },
            },
        ]);
        const accountsHint =
            listKnownAccounts && knownAccounts.length > 0 ? `\n\nAccounts: ${knownAccounts.join(', ')}` : '';
        await replyInChunks(ctx, formatBulkExpenseLogReply(logged, skipped) + accountsHint);
        return 'complete';
    } else if (call.name === 'log_workout') {
        const args = call.args as WorkoutArgs;
        const date = resolveLogDate(args.date, options);
        const settings = await getNutritionTargets(userId);
        const entry = await processWorkoutLog(
            userId,
            args,
            date,
            settings.bodyWeightKg,
            options?.workoutBatchSessionId
        );

        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'log_workout',
                    response: {
                        status: 'success',
                        caloriesBurned: entry.burn?.caloriesBurned ?? null,
                        fatBurnG: entry.burn?.fatBurnG ?? null,
                        bodyWeightKg: settings.bodyWeightKg,
                    },
                },
            },
        ]);

        if (options?.suppressWorkoutReply) {
            options.workoutBatchCollector?.push(entry);
        } else {
            await ctx.reply(
                formatWorkoutLogReply(date, args.exercise, {
                    sets: entry.sets,
                    reps: args.reps,
                    weightKg: entry.weightKg,
                    weightsKgText: entry.weightsKgText,
                    durationMin: args.durationMin,
                    notes: args.notes,
                    burn: entry.burn ?? null,
                    workoutId: entry.workoutId,
                })
            );
        }
        return 'complete';
    } else if (call.name === 'log_bulk_workouts') {
        const args = call.args as {
            date?: string;
            sessionLabel?: string;
            sessionNotes?: string;
            defaultSets?: number;
            defaultReps?: number;
            workouts: WorkoutArgs[];
        };
        const date = resolveLogDate(args.date, options);
        const sessionLabel = args.sessionLabel ?? args.sessionNotes;
        const sessionId = randomUUID();
        const settings = await getNutritionTargets(userId);
        const entries: WorkoutLogEntry[] = [];

        for (const w of args.workouts) {
            const wDate = w.date ? resolveLogDate(w.date, options) : date;
            const withDefaults = applyWorkoutDefaults(w, args.defaultSets, args.defaultReps);
            entries.push(await buildWorkoutEntry(withDefaults, wDate, settings.bodyWeightKg));
        }

        const workoutIds = await logBulkWorkouts(
            userId,
            entries.map((entry) => ({
                date: entry.date,
                exercise: entry.exercise,
                sets: entry.sets,
                reps: entry.reps,
                weightKg: entry.weightKg,
                weightsKgText: entry.weightsKgText,
                durationMin: entry.durationMin,
                notes: entry.notes,
                caloriesBurned: entry.burn?.caloriesBurned ?? null,
                fatBurnG: entry.burn?.fatBurnG ?? null,
                supersetGroup: entry.supersetGroup,
            })),
            sessionId,
            sessionLabel
        );

        let totalCal = 0;
        let totalFat = 0;
        for (const entry of entries) {
            if (entry.burn) {
                totalCal += entry.burn.caloriesBurned;
                totalFat += entry.burn.fatBurnG;
            }
        }

        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'log_bulk_workouts',
                    response: {
                        status: 'success',
                        count: entries.length,
                        totalCaloriesBurned: totalCal > 0 ? Math.round(totalCal) : null,
                        totalFatBurnG: totalFat > 0 ? Math.round(totalFat * 10) / 10 : null,
                        bodyWeightKg: settings.bodyWeightKg,
                    },
                },
            },
        ]);
        await ctx.reply(formatBulkWorkoutLogReply(date, entries, sessionLabel, workoutIds[0]));
        return 'complete';
    } else if (call.name === 'edit_workout' || call.name === 'delete_workout') {
        const args = call.args as WorkoutEditArgs & { wholeSession?: boolean };
        const respond = (response: object) =>
            chat.sendMessage([{ functionResponse: { name: call.name, response } }]);
        const workoutId = resolveToolRecordId(args.id, options, 'workout');
        const sessionRows = workoutId != null ? await getWorkoutSessionRows(workoutId, userId) : [];
        const target = sessionRows.find((r) => r.id === workoutId);
        if (!target) {
            await respond({ status: 'not_found' });
            await ctx.reply('⚠️ Reply to a workout confirmation (it shows a Workout ID) to edit or delete it.');
            return 'complete';
        }

        if (call.name === 'delete_workout') {
            const removed =
                args.wholeSession && target.sessionId
                    ? await deleteWorkoutsBySessionId(target.sessionId, userId)
                    : Number(await deleteWorkout(target.id, userId));
            await respond({ status: 'success', removed });
            await ctx.reply(`🗑️ Deleted ${removed} exercise${removed === 1 ? '' : 's'} (${target.date}).`);
            return 'complete';
        }

        const settings = await getNutritionTargets(userId);
        const newDate = args.date ?? target.date;
        const touchesTarget = WORKOUT_EDIT_FIELDS.some((k) => args[k] !== undefined);
        const updatedEntries: WorkoutLogEntry[] = [];
        for (const row of sessionRows) {
            // Rebuild through buildWorkoutEntry so progressive weights and burn stay consistent.
            const edited = row.id === target.id && touchesTarget;
            const entry = await buildWorkoutEntry(
                {
                    exercise: (edited && args.exercise) || row.exercise,
                    sets: edited && args.sets !== undefined ? args.sets : row.sets ?? undefined,
                    reps: edited && args.reps !== undefined ? args.reps : row.reps ?? undefined,
                    weightKg:
                        edited && args.weightKg !== undefined ? args.weightKg : row.weightKg ?? undefined,
                    weightsKg:
                        edited && (args.weightsKg !== undefined || args.weightKg !== undefined)
                            ? args.weightsKg
                            : row.weightsKgText?.split('/').map(Number),
                    durationMin:
                        edited && args.durationMin !== undefined
                            ? args.durationMin
                            : row.durationMin ?? undefined,
                    notes: edited && args.notes !== undefined ? args.notes : row.notes ?? undefined,
                    supersetGroup: row.supersetGroup ?? undefined,
                    // Keep machine-reported burn unless the edit changes the work done.
                    caloriesBurned: edited ? undefined : row.caloriesBurned ?? undefined,
                },
                newDate,
                settings.bodyWeightKg
            );
            entry.workoutId = row.id;
            if (edited || newDate !== row.date) {
                await updateWorkout(row.id, userId, {
                    date: newDate,
                    exercise: entry.exercise,
                    sets: entry.sets ?? null,
                    reps: entry.reps ?? null,
                    weightKg: entry.weightKg ?? null,
                    weightsKgText: entry.weightsKgText ?? null,
                    durationMin: entry.durationMin ?? null,
                    notes: entry.notes ?? null,
                    caloriesBurned: entry.burn?.caloriesBurned ?? null,
                    fatBurnG: entry.burn?.fatBurnG ?? null,
                });
            }
            updatedEntries.push(entry);
        }

        await respond({ status: 'success', date: newDate, count: updatedEntries.length });
        await ctx.reply(
            updatedEntries.length > 1
                ? formatBulkWorkoutLogReply(
                      newDate,
                      updatedEntries,
                      target.sessionLabel ?? undefined,
                      sessionRows[0].id,
                      '✅ Updated'
                  )
                : formatWorkoutLogReply(
                      newDate,
                      updatedEntries[0].exercise,
                      { ...updatedEntries[0], workoutId: target.id },
                      '✅ Updated'
                  )
        );
        return 'complete';
    } else if (call.name === 'get_workout_summary') {
        const args = call.args as { startDate: string; endDate: string };
        // `||`, not `??`: toIsoDate passes '' through, which would drop the date bound.
        const startDate = toIsoDate(args.startDate) || todayISO();
        const endDate = toIsoDate(args.endDate) || startDate;
        const summary = await getWorkoutBurnSummary(userId, startDate, endDate);
        // The summary is workouts only; the Dashboard "calories burned" adds steps + BMR (3.9).
        const burn = await getDailyBurnSeries(userId, startDate, endDate).catch((err) => {
            console.warn('get_workout_summary: daily burn series failed:', err);
            return null;
        });
        const missingForBmr =
            burn && burn.bmrPerDay == null ? missingBmrFields(await getNutritionTargets(userId)) : [];
        const toolResult = await chat.sendMessage([
            {
                functionResponse: {
                    name: 'get_workout_summary',
                    response: buildWorkoutSummaryResponse(summary, burn, missingForBmr),
                },
            },
        ]);
        await ctx.reply(toolResult.response.text());
        return 'complete';
    } else if (call.name === 'get_workout_history') {
        const args = call.args as { startDate?: string; endDate?: string; exercise?: string };
        const history = await getWorkoutHistoryGrouped(
            userId,
            args.startDate,
            args.endDate,
            args.exercise
        );
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'get_workout_history', response: history } },
        ]);
        await ctx.reply(toolResult.response.text());
        return 'complete';
    } else if (call.name === 'suggest_workout') {
        const args = call.args as { focus?: string; horizon?: string };
        const horizon = normalizeSuggestHorizon(args.horizon);
        const data = await getRecentWorkoutsForSuggestion(
            userId,
            daysBackForHorizon(horizon)
        );
        const toolResult = await chat.sendMessage([
            {
                functionResponse: {
                    name: 'suggest_workout',
                    response: {
                        ...data,
                        requestedFocus: args.focus || null,
                        horizon,
                    },
                },
            },
        ]);
        await ctx.reply(toolResult.response.text());
        return 'complete';
    } else if (call.name === 'log_meal') {
        const args = call.args as {
            date?: string;
            mealType?: string;
            description: string;
            proteinG: number;
            carbsG: number;
            fatG: number;
            calories: number;
        };
        const date = resolveLogDate(args.date, options);
        let photoPath: string | undefined;

        if (options?.photoBuffer && options.photoMimeType) {
            const uploaded = await uploadMealPhoto(
                userId,
                options.photoBuffer,
                options.photoMimeType
            );
            photoPath = uploaded || options.photoFileId;
        } else if (options?.photoFileId) {
            photoPath = options.photoFileId;
        }

        const mealId = await logMeal(
            userId,
            date,
            args.description,
            args.proteinG,
            args.mealType,
            args.carbsG,
            args.fatG,
            args.calories,
            photoPath
        );

        const { progress } = await getTodayMacroProgress(userId, date);
        const meal = {
            id: mealId,
            description: args.description,
            mealType: args.mealType,
            proteinG: args.proteinG,
            carbsG: args.carbsG,
            fatG: args.fatG,
            calories: args.calories,
        };

        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'log_meal',
                    response: { status: 'success', mealId, meal, todayProgress: progress },
                },
            },
        ]);
        if (options?.suppressMealReply) {
            options.mealBatchCollector?.push({ meal, date, mealId });
            return 'complete';
        }
        await ctx.reply(formatMealLogReply(meal, date, progress, mealId));
        return 'complete';
    } else if (call.name === 'get_meal_history') {
        const args = call.args as { startDate: string; endDate: string };
        const history = await getMealHistory(userId, args.startDate, args.endDate);
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'get_meal_history', response: { meals: history } } },
        ]);
        await ctx.reply(toolResult.response.text());
        return 'complete';
    } else if (call.name === 'edit_meal') {
        const args = call.args as {
            id?: number;
            description: string;
            mealType?: string;
            proteinG: number;
            carbsG: number;
            fatG: number;
            calories: number;
        };
        const mealId = resolveToolRecordId(args.id, options, 'meal');
        if (mealId == null) {
            await chat.sendMessage([
                { functionResponse: { name: 'edit_meal', response: { status: 'missing_id' } } },
            ]);
            await ctx.reply('⚠️ Reply to a meal confirmation or provide the meal id to edit.');
            return 'complete';
        }
        const existing = await getMealById(mealId, userId);
        if (!existing) {
            await chat.sendMessage([
                { functionResponse: { name: 'edit_meal', response: { status: 'not_found' } } },
            ]);
            await ctx.reply(`⚠️ Could not find meal #${mealId} to update.`);
            return 'complete';
        }

        const updated = await updateMeal(mealId, userId, {
            description: args.description,
            mealType: args.mealType,
            proteinG: args.proteinG,
            carbsG: args.carbsG,
            fatG: args.fatG,
            calories: args.calories,
        });

        if (!updated) {
            await chat.sendMessage([
                { functionResponse: { name: 'edit_meal', response: { status: 'failed' } } },
            ]);
            await ctx.reply(`⚠️ Failed to update meal #${mealId}.`);
            return 'complete';
        }

        const date = existing.date;
        const { progress } = await getTodayMacroProgress(userId, date);
        const meal = {
            description: args.description,
            mealType: args.mealType,
            proteinG: args.proteinG,
            carbsG: args.carbsG,
            fatG: args.fatG,
            calories: args.calories,
        };

        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'edit_meal',
                    response: { status: 'success', mealId, meal, todayProgress: progress },
                },
            },
        ]);
        await ctx.reply(
            formatMealLogReply(meal, date, progress, mealId, '✅ Updated')
        );
        return 'complete';
    } else if (call.name === 'delete_meal') {
        const args = call.args as { id?: number };
        const mealId = resolveToolRecordId(args.id, options, 'meal');
        if (mealId == null) {
            await chat.sendMessage([
                { functionResponse: { name: 'delete_meal', response: { status: 'missing_id' } } },
            ]);
            await ctx.reply('⚠️ Reply to a meal confirmation or provide the meal id to delete.');
            return 'complete';
        }
        const deleted = await deleteMeal(mealId, userId);

        if (!deleted) {
            await chat.sendMessage([
                { functionResponse: { name: 'delete_meal', response: { status: 'not_found' } } },
            ]);
            await ctx.reply(`⚠️ Could not find meal #${mealId} to delete.`);
            return 'complete';
        }

        const date = todayISO();
        const { progress } = await getTodayMacroProgress(userId, date);
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'delete_meal',
                    response: { status: 'success', mealId, todayProgress: progress },
                },
            },
        ]);
        await ctx.reply(
            `🗑️ Deleted meal #${mealId}.\n` +
                `Today: ${progress.calories.consumed}/${progress.calories.target} cal · ` +
                `Protein ${progress.protein.consumed}/${progress.protein.target}g`
        );
        return 'complete';
    } else if (call.name === 'get_nutrition_summary') {
        const args = call.args as { startDate: string; endDate: string };
        const summary = await getNutritionSummary(userId, args.startDate, args.endDate);
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'get_nutrition_summary', response: summary } },
        ]);
        await ctx.reply(toolResult.response.text());
        return 'complete';
    } else if (call.name === 'suggest_meal') {
        const args = call.args as { date?: string; horizon?: string };
        const date = args.date || todayISO();
        const horizon = normalizeSuggestHorizon(args.horizon);
        const remaining = await getMealSuggestionContext(userId, date);
        const toolResult = await chat.sendMessage([
            {
                functionResponse: {
                    name: 'suggest_meal',
                    response: { ...remaining, horizon },
                },
            },
        ]);
        await ctx.reply(toolResult.response.text());
        return 'complete';
    } else if (call.name === 'upsert_budget') {
        const args = call.args as { category: string; monthlyBudget: number };
        try {
            const result = await upsertBudget(args.category, args.monthlyBudget);
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'upsert_budget',
                        response: { status: 'success', ...result },
                    },
                },
            ]);
            if (result.created) {
                await ctx.reply(
                    `✅ Budget created: ${result.category} MYR ${result.monthlyBudget}/month`
                );
            } else {
                await ctx.reply(
                    `✅ Budget updated: ${result.category} → MYR ${result.monthlyBudget}/month`
                );
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to save budget';
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'upsert_budget',
                        response: { status: 'error', message },
                    },
                },
            ]);
            await ctx.reply(`⚠️ ${message}`);
        }
        return 'complete';
    } else if (call.name === 'get_budgets') {
        const list = getBudgets();
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'get_budgets', response: { budgets: list } } },
        ]);
        await ctx.reply(toolResult.response.text());
        return 'complete';
    } else if (call.name === 'update_user_settings') {
        // Only stated, valid fields are passed on: a null would clear the stored value.
        const { updates, changed, invalid } = parseUserSettingsArgs(call.args as UserSettingsArgs);
        if (changed.length === 0) {
            await chat.sendMessage([
                {
                    functionResponse: {
                        name: 'update_user_settings',
                        response: { status: invalid.length > 0 ? 'invalid' : 'no_change', invalid },
                    },
                },
            ]);
            await ctx.reply(formatUserSettingsReply({ changed, invalid }));
            return 'complete';
        }

        await updateNutritionTargets(userId, updates);
        // As the Dashboard settings save does: a new body weight is also today's weigh-in.
        const weighIn =
            updates.bodyWeightKg != null && updates.bodyWeightKg > 0
                ? { kg: updates.bodyWeightKg, date: todayISO() }
                : null;
        if (weighIn) await upsertBodyWeightLog(userId, weighIn.date, weighIn.kg);

        const settings = await getNutritionTargets(userId);
        const bmr = bmrOf(settings);
        const missingForBmr = missingBmrFields(settings);
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'update_user_settings',
                    response: {
                        status: invalid.length > 0 ? 'partial' : 'success',
                        saved: updates,
                        invalid,
                        weighInLogged: weighIn,
                        bmrKcalPerDay: bmr != null ? Math.round(bmr) : null,
                        missingForBmr,
                    },
                },
            },
        ]);
        await ctx.reply(
            formatUserSettingsReply({
                changed,
                invalid,
                weighIn,
                bmr,
                missingForBmr,
                profileChanged: touchesBmrProfile(updates),
            })
        );
        return 'complete';
    } else if (call.name === 'log_body_weight') {
        const args = call.args as { weightKg: number; date?: string };
        const date = args.date || todayISO();
        await upsertBodyWeightLog(userId, date, args.weightKg);
        await chat.sendMessage([
            { functionResponse: { name: 'log_body_weight', response: { status: 'success' } } },
        ]);

        const recent = await getRecentBodyWeightLogs(userId, 2);
        const previous = recent.find((r) => r.date !== date);
        const delta =
            previous != null ? args.weightKg - previous.weightKg : null;
        const deltaText =
            delta == null
                ? ''
                : delta === 0
                  ? ' (no change since last log)'
                  : ` (${delta > 0 ? '+' : ''}${delta.toFixed(2)}kg since ${previous!.date})`;

        await ctx.reply(`⚖️ Logged ${args.weightKg}kg for ${date}.${deltaText}`);
        return 'complete';
    } else if (call.name === 'log_steps') {
        const args = call.args as { steps?: unknown; date?: string };
        const steps = parseStepCount(args.steps);
        const date = resolveLogDate(toIsoDate(args.date), options);
        if (steps == null || !isIsoDate(date)) {
            const message =
                steps == null
                    ? `${JSON.stringify(args.steps ?? null)} is not a valid step count (a number of 0 or more)`
                    : `"${date}" is not a valid date (YYYY-MM-DD)`;
            await chat.sendMessage([
                { functionResponse: { name: 'log_steps', response: { status: 'invalid', message } } },
            ]);
            await ctx.reply(`⚠️ Steps not logged: ${message}.`);
            return 'complete';
        }

        const [previous] = await listDailyActivityLogs(userId, date, date);
        await upsertDailyActivityLog(userId, date, steps);
        const { bodyWeightKg } = await getNutritionTargets(userId);
        const stepKcal = stepCalories(steps, bodyWeightKg);
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'log_steps',
                    response: {
                        status: 'success',
                        date,
                        steps,
                        stepKcal,
                        previousSteps: previous?.steps ?? null,
                    },
                },
            },
        ]);
        await ctx.reply(
            formatStepsReply({
                steps,
                date,
                stepKcal,
                bodyWeightKg,
                previousSteps: previous?.steps ?? null,
            })
        );
        return 'complete';
    }

    await chat.sendMessage([
        {
            functionResponse: {
                name: call.name,
                response: { status: 'error', message: `unknown tool: ${call.name}` },
            },
        },
    ]).catch(() => undefined);
    await ctx.reply(
        `⚠️ I tried an unknown action (${call.name}). Please resend — for a single receipt say "receipt" or list the amount.`
    );
    return 'complete';
}

// ponytail self-check: Gemini hallucinated tool names
if (require.main === module) {
    if (resolveToolName('LogBulkExpensesExpenses') !== 'log_bulk_expenses') {
        throw new Error('expected LogBulkExpensesExpenses → log_bulk_expenses');
    }
    if (resolveToolName('log_expense') !== 'log_expense') {
        throw new Error('expected log_expense unchanged');
    }
    if (resolveToolName('LogExpense') !== 'log_expense') {
        throw new Error('expected LogExpense → log_expense');
    }
    console.log('toolHandler resolveToolName self-check ok');
}


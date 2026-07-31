import { Context } from 'telegraf';
import { randomUUID } from 'crypto';
import { ChatSession, FunctionCall } from '@google/generative-ai';
import { resolveCategory, upsertBudget, getBudgets } from '../config/expenseCategories';
import { resolvePaymentMethod } from '../config/paymentMethods';
import {
    appendExpense,
    getSpendingSummary,
    addFixedExpense,
    updateFixedExpensePrice,
    getAllFixedExpenses,
    deleteFixedExpense,
    logBulkExpenses,
    formatExpenseLogReply,
    updateExpense,
    deleteExpense,
    getExpenseById,
    ExpenseBatchEntry,
} from '../services/expenseService';
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
} from '../services/incomeService';
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
    WorkoutLogEntry,
} from '../services/gymService';
import { estimateBurn } from '../services/burnCalculator';
import {
    logMeal,
    getNutritionSummary,
    getTodayProteinRemaining,
    getTodayMacroProgress,
    updateNutritionTargets,
    uploadMealPhoto,
    formatMealLogReply,
    getMealHistory,
    updateMeal,
    deleteMeal,
    getMealById,
    getNutritionTargets,
    MealBatchEntry,
} from '../services/nutritionService';

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

function resolveLogDate(argsDate: string | undefined, options?: ToolCallOptions): string {
    const today = todayISO();
    const caption = options?.userCaption ?? '';

    if (/\btoday\b/i.test(caption)) {
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

interface WorkoutArgs {
    date?: string;
    exercise: string;
    sets?: number;
    reps?: number;
    weightKg?: number;
    weightsKg?: number[];
    durationMin?: number;
    notes?: string;
    supersetGroup?: number;
}

async function buildWorkoutEntry(
    args: WorkoutArgs,
    date: string,
    bodyWeightKg: number | null
): Promise<WorkoutLogEntry> {
    const normalized = normalizeWeightsKg(args.weightsKg, args.weightKg, args.sets);
    const burn = estimateBurn(
        args.exercise,
        args.durationMin,
        normalized.sets,
        args.reps,
        normalized.topWeightKg,
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
    await logWorkout(
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
    'create_calendar_event',
    'check_schedule',
    'reschedule_calendar_event',
    'cancel_calendar_event',
    'log_bulk_expenses',
    'log_workout',
    'log_bulk_workouts',
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
        const { date, amount, currency, category, description, reimbursements, paymentMethod } =
            call.args as {
            date?: string;
            amount: number;
            currency?: string;
            category: string;
            description: string;
            paymentMethod?: string;
            reimbursements?: { source: string; amount: number }[];
        };
        const resolvedDate = resolveLogDate(date, options);
        const resolvedCurrency = currency || 'MYR';
        const resolvedCategory = resolveCategory(category);
        const resolvedPaymentMethod = resolvePaymentMethod(paymentMethod);
        const expenseId = await appendExpense(
            resolvedDate,
            amount,
            resolvedCurrency,
            resolvedCategory,
            description,
            resolvedPaymentMethod
        );
        if (reimbursements?.length) {
            await appendReimbursements(expenseId, reimbursements, resolvedDate);
        }
        await chat.sendMessage([
            { functionResponse: { name: 'log_expense', response: { status: 'success' } } },
        ]);
        if (options?.suppressExpenseReply) {
            options.expenseBatchCollector?.push({
                date: resolvedDate,
                amount,
                currency: resolvedCurrency,
                category: resolvedCategory,
                description,
                expenseId,
                paymentMethod: resolvedPaymentMethod,
                reimbursements,
            });
            return 'complete';
        }
        if (reimbursements?.length) {
            await ctx.reply(
                formatSharedExpenseReply(
                    resolvedDate,
                    amount,
                    resolvedCurrency,
                    resolvedCategory,
                    description,
                    reimbursements,
                    expenseId,
                    resolvedPaymentMethod
                )
            );
        } else {
            await ctx.reply(
                formatExpenseLogReply(
                    resolvedDate,
                    amount,
                    resolvedCurrency,
                    resolvedCategory,
                    description,
                    expenseId,
                    resolvedPaymentMethod
                )
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
        };
        const resolvedDate = resolveLogDate(args.date, options);
        const resolvedCurrency = args.currency || 'MYR';
        let expenseId: number | undefined = options?.replyToExpenseId;
        if (!expenseId && args.relatedExpenseDescription) {
            const found = await findRecentExpenseByDescription(args.relatedExpenseDescription);
            if (found) expenseId = found;
        }
        const incomeId = await appendIncome(
            resolvedDate,
            args.amount,
            resolvedCurrency,
            args.category,
            args.description,
            args.source,
            expenseId,
            args.paymentMethod,
            args.fromPaymentMethod
        );
        await chat.sendMessage([
            { functionResponse: { name: 'log_income', response: { status: 'success', incomeId } } },
        ]);
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
                args.paymentMethod,
                args.fromPaymentMethod
            )
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
        const updated = await updateExpense(id, {
            date: args.date,
            amount: args.amount,
            currency: args.currency,
            category: args.category,
            description: args.description,
            paymentMethod: args.paymentMethod,
        });
        if (!updated) {
            await chat.sendMessage([
                { functionResponse: { name: 'edit_expense', response: { status: 'failed' } } },
            ]);
            await ctx.reply(`⚠️ Failed to update expense #${id}.`);
            return 'complete';
        }
        const row = (await getExpenseById(id))!;
        await chat.sendMessage([
            { functionResponse: { name: 'edit_expense', response: { status: 'success', expenseId: id } } },
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
                '✅ Updated'
            )
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
        try {
            const updated = await updateIncome(id, {
                date: args.date,
                amount: args.amount,
                currency: args.currency,
                category: args.category,
                description: args.description,
                source: args.source,
                paymentMethod: args.paymentMethod,
                fromPaymentMethod: args.fromPaymentMethod,
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
                '✅ Updated income'
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
        const summaryData = await getSpendingSummary(
            args.category,
            args.description,
            args.startDate,
            args.endDate,
            args.paymentMethod
        );
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'get_spending_summary', response: summaryData } },
        ]);
        await ctx.reply(toolResult.response.text());
        return 'complete';
    } else if (call.name === 'add_fixed_expense') {
        const args = call.args as {
            dayOfMonth?: number;
            amount: number;
            frequencyInMonths?: number;
            currency?: string;
            category?: string;
            description?: string;
            paymentMethod?: string;
        };
        const finalDay = args.dayOfMonth || 1;
        const frequency = args.frequencyInMonths || 1;
        const startMonth = parseInt(
            new Date().toLocaleString('en-US', {
                timeZone: 'Asia/Kuala_Lumpur',
                month: 'numeric',
            })
        );
        const currency = args.currency || 'MYR';
        const category = resolveCategory(args.category);
        const description = args.description || `Recurring ${category}`;
        const paymentMethod = resolvePaymentMethod(args.paymentMethod);

        await addFixedExpense(
            finalDay,
            args.amount,
            currency,
            category,
            description,
            frequency,
            startMonth,
            paymentMethod
        );
        await chat.sendMessage([
            { functionResponse: { name: 'add_fixed_expense', response: { status: 'success' } } },
        ]);

        let freqWord = 'monthly';
        if (frequency === 2) freqWord = 'every 2 months';
        if (frequency === 3) freqWord = 'quarterly';
        if (frequency === 12) freqWord = 'yearly';

        await ctx.reply(
            `🔄 Done! I've set up a ${freqWord} rule to log ${currency} ${args.amount} for ${description} on the ${finalDay} of the month.` +
                (paymentMethod ? ` Paid via: ${paymentMethod}.` : '')
        );
        return 'complete';
    } else if (call.name === 'update_fixed_expense') {
        const args = call.args as { description: string; newAmount: number };
        const updateStatus = await updateFixedExpensePrice(args.description, args.newAmount);
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'update_fixed_expense',
                    response: { status: updateStatus === true ? 'success' : 'failed' },
                },
            },
        ]);
        if (updateStatus === 'not_found') {
            await ctx.reply(
                `⚠️ I couldn't find any recurring bill matching "${args.description}" in your system.`
            );
        } else {
            await ctx.reply(
                `✅ Got it! I have updated your recurring ${args.description} bill to RM ${args.newAmount}.`
            );
        }
        return 'complete';
    } else if (call.name === 'get_all_fixed_expenses') {
        const allExpenses = await getAllFixedExpenses();
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'get_all_fixed_expenses', response: { expenses: allExpenses } } },
        ]);
        await ctx.reply(toolResult.response.text());
        return 'complete';
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
        await logBulkExpenses(expensesArray as Parameters<typeof logBulkExpenses>[0]);
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'log_bulk_expenses',
                    response: { status: 'success', count: expensesArray.length },
                },
            },
        ]);
        await ctx.reply(
            `✅ Successfully scanned the statement and logged ${expensesArray.length} expenses!`
        );
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

        await logBulkWorkouts(
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
        await ctx.reply(formatBulkWorkoutLogReply(date, entries, sessionLabel));
        return 'complete';
    } else if (call.name === 'get_workout_summary') {
        const args = call.args as { startDate: string; endDate: string };
        const summary = await getWorkoutBurnSummary(userId, args.startDate, args.endDate);
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'get_workout_summary', response: summary } },
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
        const args = call.args as { focus?: string };
        const data = await getRecentWorkoutsForSuggestion(userId);
        const toolResult = await chat.sendMessage([
            {
                functionResponse: {
                    name: 'suggest_workout',
                    response: { ...data, requestedFocus: args.focus || null },
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
        const args = call.args as { date?: string };
        const date = args.date || todayISO();
        const remaining = await getTodayProteinRemaining(userId, date);
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'suggest_meal', response: remaining } },
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
        const args = call.args as {
            dailyProteinTargetG?: number;
            dailyCalorieTarget?: number;
            dailyCarbsTargetG?: number;
            dailyFatTargetG?: number;
            bodyWeightKg?: number;
        };
        await updateNutritionTargets(userId, {
            dailyProteinTargetG: args.dailyProteinTargetG,
            dailyCalorieTarget: args.dailyCalorieTarget,
            dailyCarbsTargetG: args.dailyCarbsTargetG,
            dailyFatTargetG: args.dailyFatTargetG,
            bodyWeightKg: args.bodyWeightKg,
        });
        await chat.sendMessage([
            { functionResponse: { name: 'update_user_settings', response: { status: 'success' } } },
        ]);

        const parts: string[] = [];
        if (args.dailyCalorieTarget) parts.push(`${args.dailyCalorieTarget} cal`);
        if (args.dailyProteinTargetG) parts.push(`${args.dailyProteinTargetG}g protein`);
        if (args.dailyCarbsTargetG) parts.push(`${args.dailyCarbsTargetG}g carbs`);
        if (args.dailyFatTargetG) parts.push(`${args.dailyFatTargetG}g fat`);
        if (args.bodyWeightKg) parts.push(`${args.bodyWeightKg}kg body weight`);

        await ctx.reply(
            parts.length > 0
                ? `✅ Settings updated: ${parts.join(', ')}.`
                : `✅ Settings updated.`
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


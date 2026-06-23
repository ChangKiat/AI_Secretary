import { Context } from 'telegraf';
import { ChatSession, FunctionCall } from '@google/generative-ai';
import { resolveCategory } from '../config/expenseCategories';
import {
    appendExpense,
    getSpendingSummary,
    addFixedExpense,
    updateFixedExpensePrice,
    getAllFixedExpenses,
    deleteFixedExpense,
    logBulkExpenses,
    formatExpenseLogReply,
} from '../services/expenseService';
import { createCalendarEvent, getSchedule } from '../services/calendarService';
import {
    logWorkout,
    getWorkoutHistory,
    getRecentWorkoutsForSuggestion,
    getWorkoutBurnSummary,
    formatWorkoutLogReply,
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
} from '../services/nutritionService';

export type ToolCallResult = 'complete' | 'awaiting_input';

export interface ToolCallOptions {
    photoFileId?: string;
    photoBuffer?: Buffer;
    photoMimeType?: string;
    userCaption?: string;
    isVoiceInput?: boolean;
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

export async function handleToolCall(
    call: FunctionCall,
    chat: ChatSession,
    ctx: Context,
    options?: ToolCallOptions
): Promise<ToolCallResult> {
    const userId = getUserId(ctx);

    if (call.name === 'log_expense') {
        const { date, amount, currency, category, description } = call.args as any;
        const resolvedDate = resolveLogDate(date, options);
        await appendExpense(resolvedDate, amount, currency, category, description);
        await chat.sendMessage([
            { functionResponse: { name: 'log_expense', response: { status: 'success' } } },
        ]);
        await ctx.reply(
            formatExpenseLogReply(resolvedDate, amount, currency || 'MYR', category, description)
        );
        return 'complete';
    } else if (call.name === 'get_spending_summary') {
        const args = call.args as {
            category?: string;
            description?: string;
            startDate?: string;
            endDate?: string;
        };
        const summaryData = await getSpendingSummary(
            args.category,
            args.description,
            args.startDate,
            args.endDate
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

        await addFixedExpense(
            finalDay,
            args.amount,
            currency,
            category,
            description,
            frequency,
            startMonth
        );
        await chat.sendMessage([
            { functionResponse: { name: 'add_fixed_expense', response: { status: 'success' } } },
        ]);

        let freqWord = 'monthly';
        if (frequency === 2) freqWord = 'every 2 months';
        if (frequency === 3) freqWord = 'quarterly';
        if (frequency === 12) freqWord = 'yearly';

        await ctx.reply(
            `🔄 Done! I've set up a ${freqWord} rule to log ${currency} ${args.amount} for ${description} on the ${finalDay} of the month.`
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
    } else if (call.name === 'log_bulk_expenses') {
        const expensesArray = (call.args as any).expenses;
        await logBulkExpenses(expensesArray);
        await ctx.reply(
            `✅ Successfully scanned the statement and logged ${expensesArray.length} expenses!`
        );
        return 'complete';
    } else if (call.name === 'log_workout') {
        const args = call.args as {
            date?: string;
            exercise: string;
            sets?: number;
            reps?: number;
            weightKg?: number;
            durationMin?: number;
            notes?: string;
        };
        const date = args.date || todayISO();
        const settings = await getNutritionTargets(userId);
        const burn = estimateBurn(
            args.exercise,
            args.durationMin,
            args.sets,
            args.reps,
            args.weightKg,
            settings.bodyWeightKg
        );

        await logWorkout(
            userId,
            date,
            args.exercise,
            args.sets,
            args.reps,
            args.weightKg,
            args.durationMin,
            args.notes,
            burn?.caloriesBurned ?? null,
            burn?.fatBurnG ?? null
        );
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'log_workout',
                    response: {
                        status: 'success',
                        caloriesBurned: burn?.caloriesBurned ?? null,
                        fatBurnG: burn?.fatBurnG ?? null,
                        bodyWeightKg: settings.bodyWeightKg,
                    },
                },
            },
        ]);
        await ctx.reply(
            formatWorkoutLogReply(date, args.exercise, {
                sets: args.sets,
                reps: args.reps,
                weightKg: args.weightKg,
                durationMin: args.durationMin,
                notes: args.notes,
                burn: burn ?? null,
            })
        );
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
        const history = await getWorkoutHistory(
            userId,
            args.startDate,
            args.endDate,
            args.exercise
        );
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'get_workout_history', response: { workouts: history } } },
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
            id: number;
            description: string;
            mealType?: string;
            proteinG: number;
            carbsG: number;
            fatG: number;
            calories: number;
        };
        const existing = await getMealById(args.id, userId);
        if (!existing) {
            await chat.sendMessage([
                { functionResponse: { name: 'edit_meal', response: { status: 'not_found' } } },
            ]);
            await ctx.reply(`⚠️ Could not find meal #${args.id} to update.`);
            return 'complete';
        }

        const updated = await updateMeal(args.id, userId, {
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
            await ctx.reply(`⚠️ Failed to update meal #${args.id}.`);
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
                    response: { status: 'success', mealId: args.id, meal, todayProgress: progress },
                },
            },
        ]);
        await ctx.reply(
            formatMealLogReply(meal, date, progress, args.id, '✅ Updated')
        );
        return 'complete';
    } else if (call.name === 'delete_meal') {
        const args = call.args as { id: number };
        const deleted = await deleteMeal(args.id, userId);

        if (!deleted) {
            await chat.sendMessage([
                { functionResponse: { name: 'delete_meal', response: { status: 'not_found' } } },
            ]);
            await ctx.reply(`⚠️ Could not find meal #${args.id} to delete.`);
            return 'complete';
        }

        const date = todayISO();
        const { progress } = await getTodayMacroProgress(userId, date);
        await chat.sendMessage([
            {
                functionResponse: {
                    name: 'delete_meal',
                    response: { status: 'success', mealId: args.id, todayProgress: progress },
                },
            },
        ]);
        await ctx.reply(
            `🗑️ Deleted meal #${args.id}.\n` +
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

    return 'complete';
}

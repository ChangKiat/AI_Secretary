import { Context } from 'telegraf';
import { ChatSession, FunctionCall } from '@google/generative-ai';
import {
    appendExpense,
    getSpendingSummary,
    addFixedExpense,
    updateFixedExpensePrice,
    getAllFixedExpenses,
    deleteFixedExpense,
    logBulkExpenses,
} from '../services/expenseService';
import { createCalendarEvent, getSchedule } from '../services/calendarService';
import {
    logWorkout,
    getWorkoutHistory,
    getRecentWorkoutsForSuggestion,
} from '../services/gymService';
import {
    logMeal,
    getNutritionSummary,
    getTodayProteinRemaining,
    updateProteinTarget,
    uploadMealPhoto,
} from '../services/nutritionService';

export interface ToolCallOptions {
    photoFileId?: string;
    photoBuffer?: Buffer;
    photoMimeType?: string;
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

export async function handleToolCall(
    call: FunctionCall,
    chat: ChatSession,
    ctx: Context,
    options?: ToolCallOptions
) {
    const userId = getUserId(ctx);

    if (call.name === 'log_expense') {
        const { date, amount, currency, category, description } = call.args as any;
        await appendExpense(date, amount, currency, category, description);
        await chat.sendMessage([
            { functionResponse: { name: 'log_expense', response: { status: 'success' } } },
        ]);
        await ctx.reply(
            `✅ Logged ${currency || 'MYR'} ${amount} for ${description || category} on ${date || todayISO()}.`
        );
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
        const category = args.category || 'Fixed Expense';
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
    } else if (call.name === 'get_all_fixed_expenses') {
        const allExpenses = await getAllFixedExpenses();
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'get_all_fixed_expenses', response: { expenses: allExpenses } } },
        ]);
        await ctx.reply(toolResult.response.text());
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
    } else if (call.name === 'create_calendar_event') {
        const args = call.args as {
            title: string;
            startDateTime?: string;
            endDateTime?: string;
            description?: string;
        };

        if (!args.startDateTime) {
            const retry = await chat.sendMessage(
                'I need a specific date and time to schedule this. Please ask the user for the date and year.'
            );
            await ctx.reply(retry.response.text());
            return;
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
        } catch (error) {
            console.error('Tool Execution Error:', error);
            await ctx.reply('I had a problem connecting to the calendar. Please try again in a moment.');
        }
    } else if (call.name === 'check_schedule') {
        const args = call.args as { date: string };
        const scheduleData = await getSchedule(args.date);
        const nextResult = await chat.sendMessage([
            { functionResponse: { name: 'check_schedule', response: { schedule: scheduleData } } },
        ]);
        await ctx.reply(nextResult.response.text());
    } else if (call.name === 'log_bulk_expenses') {
        const expensesArray = (call.args as any).expenses;
        await logBulkExpenses(expensesArray);
        await ctx.reply(
            `✅ Successfully scanned the statement and logged ${expensesArray.length} expenses!`
        );
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
        await logWorkout(
            userId,
            date,
            args.exercise,
            args.sets,
            args.reps,
            args.weightKg,
            args.durationMin,
            args.notes
        );
        await chat.sendMessage([
            { functionResponse: { name: 'log_workout', response: { status: 'success' } } },
        ]);
        const detail = [
            args.sets && args.reps ? `${args.sets}x${args.reps}` : null,
            args.weightKg ? `${args.weightKg}kg` : null,
        ]
            .filter(Boolean)
            .join(' @ ');
        await ctx.reply(
            `💪 Logged ${args.exercise}${detail ? ` (${detail})` : ''} on ${date}.`
        );
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
    } else if (call.name === 'log_meal') {
        const args = call.args as {
            date?: string;
            mealType?: string;
            description: string;
            proteinG: number;
            carbsG?: number;
            fatG?: number;
            calories?: number;
        };
        const date = args.date || todayISO();
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

        await logMeal(
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
        await chat.sendMessage([
            { functionResponse: { name: 'log_meal', response: { status: 'success' } } },
        ]);
        await ctx.reply(
            `🍽️ Logged ${args.description}: ~${args.proteinG}g protein on ${date}.`
        );
    } else if (call.name === 'get_nutrition_summary') {
        const args = call.args as { startDate: string; endDate: string };
        const summary = await getNutritionSummary(userId, args.startDate, args.endDate);
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'get_nutrition_summary', response: summary } },
        ]);
        await ctx.reply(toolResult.response.text());
    } else if (call.name === 'suggest_meal') {
        const args = call.args as { date?: string };
        const date = args.date || todayISO();
        const remaining = await getTodayProteinRemaining(userId, date);
        const toolResult = await chat.sendMessage([
            { functionResponse: { name: 'suggest_meal', response: remaining } },
        ]);
        await ctx.reply(toolResult.response.text());
    } else if (call.name === 'update_user_settings') {
        const args = call.args as { dailyProteinTargetG?: number };
        if (args.dailyProteinTargetG) {
            await updateProteinTarget(userId, args.dailyProteinTargetG);
        }
        await chat.sendMessage([
            { functionResponse: { name: 'update_user_settings', response: { status: 'success' } } },
        ]);
        await ctx.reply(
            args.dailyProteinTargetG
                ? `✅ Daily protein target set to ${args.dailyProteinTargetG}g.`
                : `✅ Settings updated.`
        );
    }
}

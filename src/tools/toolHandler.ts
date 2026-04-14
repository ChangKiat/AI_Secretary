import { Context } from 'telegraf';
import { ChatSession, FunctionCall } from '@google/generative-ai';
import {
    appendExpenseToSheet,
    getSpendingSummary,
    addFixedExpenseToSheet,
    updateFixedExpensePrice,
    getAllFixedExpenses,
    deleteFixedExpense,
    logBulkExpensesToSheet
} from '../services/sheetsService';
import { createCalendarEvent, getSchedule } from '../services/calendarService';

export async function handleToolCall(call: FunctionCall, chat: ChatSession, ctx: Context) {
    
    // --- 1. LOG SINGLE EXPENSE ---
    if (call.name === 'log_expense') {
        const { date, amount, currency, category, description } = call.args as any;

        await appendExpenseToSheet(date, amount, currency, category, description);       
        await chat.sendMessage([{ functionResponse: { name: 'log_expense', response: { status: 'success' } } }]);
        await ctx.reply(`✅ Logged RM ${amount} for ${description || category} on ${date}.`);
    } 
    
    // --- 2. GET SUMMARY ---
    else if (call.name === 'get_spending_summary') {
        const args = call.args as { category?: string; description?: string; startDate?: string; endDate?: string; };
        const summaryData = await getSpendingSummary(args.category, args.description, args.startDate, args.endDate);
        
        const toolResult = await chat.sendMessage([{
            functionResponse: { name: 'get_spending_summary', response: summaryData }
        }]);
        await ctx.reply(toolResult.response.text());
    }
    
    // --- 3. ADD FIXED EXPENSE ---
    else if (call.name === 'add_fixed_expense') {
        const args = call.args as { dayOfMonth?: number; amount: number; frequencyInMonths?: number; currency?: string; category?: string; description?: string; };
        const finalDay = args.dayOfMonth || 1; 
        const frequency = args.frequencyInMonths || 1; 
        
        const startMonth = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur', month: 'numeric' }));
        const currency = args.currency || 'MYR';
        const category = args.category || 'Fixed Expense';
        const description = args.description || `Recurring ${category}`;

        await addFixedExpenseToSheet(finalDay, args.amount, currency, category, description, frequency, startMonth);
        await chat.sendMessage([{ functionResponse: { name: 'add_fixed_expense', response: { status: 'success' } } }]);

        let freqWord = "monthly";
        if (frequency === 2) freqWord = "every 2 months";
        if (frequency === 3) freqWord = "quarterly";
        if (frequency === 12) freqWord = "yearly";

        await ctx.reply(`🔄 Done! I've set up a ${freqWord} rule to log ${currency} ${args.amount} for ${description} on the ${finalDay} of the month.`);
    }
    
    // --- 4. UPDATE FIXED EXPENSE ---
    else if (call.name === 'update_fixed_expense') {
        const args = call.args as { description: string; newAmount: number; };
        const updateStatus = await updateFixedExpensePrice(args.description, args.newAmount);
        
        await chat.sendMessage([{ functionResponse: { name: 'update_fixed_expense', response: { status: updateStatus === true ? 'success' : 'failed' } } }]);

        if (updateStatus === "not_found") {
            await ctx.reply(`⚠️ I couldn't find any recurring bill matching "${args.description}" in your system.`);
        } else {
            await ctx.reply(`✅ Got it! I have updated your recurring ${args.description} bill to RM ${args.newAmount}.`);
        }
    }
    
    // --- 5. SHOW ALL FIXED EXPENSES ---
    else if (call.name === 'get_all_fixed_expenses') {
        const allExpenses = await getAllFixedExpenses();
        const toolResult = await chat.sendMessage([{ functionResponse: { name: 'get_all_fixed_expenses', response: { expenses: allExpenses } } }]);
        await ctx.reply(toolResult.response.text());
    }
    
    // --- 6. DELETE FIXED EXPENSE ---
    else if (call.name === 'delete_fixed_expense') {
        const args = call.args as { description: string; };
        const deleteStatus = await deleteFixedExpense(args.description);
        
        await chat.sendMessage([{ functionResponse: { name: 'delete_fixed_expense', response: { status: deleteStatus === true ? 'success' : 'failed' } } }]);

        if (deleteStatus === "not_found") {
            await ctx.reply(`⚠️ I couldn't find any bill matching "${args.description}" to cancel.`);
        } else {
            await ctx.reply(`🗑️ Done! I have completely removed "${args.description}" from your recurring bills.`);
        }
    }
    else if (call.name === 'create_calendar_event') {
    const args = call.args as { title: string; startDateTime?: string; endDateTime?: string; description?: string; };
    
    if (!args.startDateTime) {
        const retry = await chat.sendMessage("I need a specific date and time to schedule this. Please ask the user for the date and year.");
        await ctx.reply(retry.response.text());
        return;
    }

    try {
        const eventLink = await createCalendarEvent(
            args.title, 
            args.startDateTime, 
            args.endDateTime || "", 
            args.description || ""
        );
        
        await chat.sendMessage([{ 
            functionResponse: { name: 'create_calendar_event', response: { status: 'success' } } 
        }]);

        await ctx.reply(
            `📅 **Event Scheduled!**\n\n` +
            `I've added "${args.title}" to my records and sent an invitation to your Gmail.\n\n` +
            `👉 Please check your calendar on **"${args.startDateTime}"** or look for an invite email to confirm!`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error("Tool Execution Error:", error);
        await ctx.reply("I had a problem connecting to the calendar. Please try again in a moment.");
    }
}
else if (call.name === 'check_schedule') {
    const args = call.args as { date: string };
    const scheduleData = await getSchedule(args.date);
    const nextResult = await chat.sendMessage([{ 
        functionResponse: { 
            name: 'check_schedule', 
            response: { schedule: scheduleData } 
        } 
    }]);

    await ctx.reply(nextResult.response.text());
}
else if (call.name === 'log_bulk_expenses') {
    // Tell TypeScript to treat call.args as 'any' so we can grab .expenses
    const expensesArray = (call.args as any).expenses;
    
    await logBulkExpensesToSheet(expensesArray);
    await ctx.reply(`✅ Successfully scanned the statement and logged ${expensesArray.length} expenses into your Google Sheet!`);
}
}

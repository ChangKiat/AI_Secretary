import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';
import { appendExpense, getFixedExpensesForToday } from './services/expenseService';
import { ChatSession } from '@google/generative-ai';
import { handleToolCall } from './tools/toolHandler';
import {
    createGeminiModel,
    GEMINI_MODEL_DEFAULT,
    GEMINI_MODEL_HEAVY,
} from './config/gemini';
import { updateProteinTarget } from './services/nutritionService';
import cron from 'node-cron';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MY_CHAT_ID = process.env.MY_TELEGRAM_CHAT_ID!;
const userSessions = new Map<number, ChatSession>();

const defaultModel = createGeminiModel(genAI, GEMINI_MODEL_DEFAULT);
const heavyModel = createGeminiModel(genAI, GEMINI_MODEL_HEAVY);

cron.schedule(
    '0 9 * * *',
    async () => {
        try {
            const expensesToLog = await getFixedExpensesForToday();
            if (expensesToLog.length === 0) return;

            console.log(`Found ${expensesToLog.length} fixed expenses for today. Logging...`);
            let loggedList = '';

            for (const exp of expensesToLog) {
                await appendExpense(
                    exp.date,
                    exp.amount,
                    exp.currency,
                    exp.category,
                    exp.description
                );
                loggedList += `\n- ${exp.description} (${exp.currency} ${exp.amount})`;
            }

            const msg = `🗓️ *Automated Billing:* Good morning! I just logged today's scheduled expenses:${loggedList}`;
            await bot.telegram.sendMessage(MY_CHAT_ID, msg, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error('Cron Job Error:', error);
        }
    },
    { timezone: 'Asia/Kuala_Lumpur' }
);

bot.catch((err, ctx) => {
    console.error(`🚨 CRITICAL ERROR in ${ctx.updateType} event:`);
    console.error(err);
});

bot.command('setprotein', async (ctx) => {
    const text = ctx.message.text.replace('/setprotein', '').trim();
    const target = parseFloat(text);
    if (!target || target <= 0) {
        await ctx.reply('Usage: /setprotein 180');
        return;
    }
    await updateProteinTarget(ctx.from.id, target);
    await ctx.reply(`✅ Daily protein target set to ${target}g.`);
});

bot.launch(() => {
    console.log('🤖 Secretary Bot is running...');
    console.log(`   Default model: ${GEMINI_MODEL_DEFAULT}`);
    console.log(`   Heavy model:   ${GEMINI_MODEL_HEAVY}`);
});

function buildContextPrompt(userMessage: string): string {
    const now = new Date();
    const todayFormatted = now.toLocaleDateString('en-MY', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        timeZone: 'Asia/Kuala_Lumpur',
    });
    return `
        [SYSTEM CONTEXT]
        Today is ${todayFormatted}.
        Current Year: ${now.getFullYear()}.
        Current Month: ${now.getMonth() + 1}.
        Reference: If the user provides a date range like "24-26", calculate the start and end dates accordingly.
        ACTION: Use the appropriate tool for finances, calendar, gym, or nutrition. DO NOT JUST CHAT when an action is requested.

        [MESSAGE]: ${userMessage}`;
}

function getPhotoPrompt(caption: string): string {
    const lower = caption.toLowerCase();
    if (/\b(gym|workout|exercise|bench|squat|deadlift|training|leg day|push day|pull day)\b/.test(lower)) {
        return `You are a gym assistant. Analyze this image or caption and log workouts with log_workout. ${caption}`;
    }
    if (/\b(food|meal|protein|lunch|dinner|breakfast|snack|nutrition|macro|calories)\b/.test(lower)) {
        return `Estimate protein and macros from this meal photo. Call log_meal with your best estimates. Note values are approximate. ${caption}`;
    }
    return (
        caption ||
        'Please process this receipt and log the expense using log_expense or log_bulk_expenses.'
    );
}

async function runChatTurn(
    chat: ChatSession,
    ctx: import('telegraf').Context,
    prompt: string | (string | Record<string, unknown>)[],
    userId: number,
    toolOptions?: import('./tools/toolHandler').ToolCallOptions
) {
    const result = await chat.sendMessage(prompt as Parameters<ChatSession['sendMessage']>[0]);
    const response = result.response;
    const functionCalls = response.functionCalls();
    console.log(
        '🤖 AI Intent:',
        functionCalls ? `Calling Tool: ${functionCalls[0].name}` : 'Just Chatting'
    );

    if (functionCalls && functionCalls.length > 0) {
        for (const call of functionCalls) {
            await handleToolCall(call, chat, ctx, toolOptions);
        }
        userSessions.delete(userId);
    } else {
        const aiText = response.text();
        if (aiText && aiText.trim().length > 0) {
            await ctx.reply(aiText);
        } else {
            await ctx.reply("I processed that, but I couldn't find anything to log or report.");
        }
    }
}

bot.on(message('text'), async (ctx) => {
    const userMessage = ctx.message.text;
    const userId = ctx.from.id;
    await ctx.sendChatAction('typing');

    try {
        let chat = userSessions.get(userId);
        if (!chat) {
            chat = defaultModel.startChat();
            userSessions.set(userId, chat);
        }
        await runChatTurn(chat, ctx, buildContextPrompt(userMessage), userId);
    } catch (error: any) {
        console.error('Error:', error);
        if (error.message?.includes('429 Too Many Requests')) {
            await ctx.reply(
                "⏳ Whoa, slow down! I'm hitting my API rate limit. Give me a moment to cool off."
            );
        } else {
            await ctx.reply('Sorry, I encountered an error processing that.');
        }
    }
});

bot.on(message('photo'), async (ctx) => {
    await ctx.sendChatAction('typing');
    try {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const imagePart = await getGeminiFilePart(photo.file_id, 'image/jpeg');
        const caption = ctx.message.caption || '';
        const prompt = getPhotoPrompt(caption);
        const chat = defaultModel.startChat();

        const fileLink = await bot.telegram.getFileLink(photo.file_id);
        const response = await fetch(fileLink.href);
        const photoBuffer = Buffer.from(await response.arrayBuffer());

        await runChatTurn(
            chat,
            ctx,
            [imagePart, prompt],
            ctx.from.id,
            {
                photoFileId: photo.file_id,
                photoBuffer,
                photoMimeType: 'image/jpeg',
            }
        );
    } catch (error) {
        console.error('Error processing image:', error);
        await ctx.reply('Sorry, I had trouble reading that image.');
    }
});

bot.on(message('voice'), async (ctx) => {
    await ctx.sendChatAction('typing');
    try {
        const voice = ctx.message.voice;
        const audioPart = await getGeminiFilePart(voice.file_id, 'audio/ogg');
        const chat = defaultModel.startChat();
        await runChatTurn(
            chat,
            ctx,
            [audioPart, 'Listen to this audio command and execute the appropriate tool.'],
            ctx.from.id
        );
    } catch (error) {
        console.error('Error processing voice:', error);
        await ctx.reply("Sorry, I couldn't hear that clearly.");
    }
});

bot.on(message('document'), async (ctx) => {
    try {
        await ctx.sendChatAction('typing');
        const document = ctx.message.document;
        const mimeType = document.mime_type || '';

        if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') {
            await ctx.reply('I can only process image documents or PDFs.');
            return;
        }

        const imagePart = await getGeminiFilePart(document.file_id, mimeType);
        const caption =
            ctx.message.caption ||
            `You are an expert financial data extractor. Extract outgoing transactions using the appropriate tool.
            CRITICAL RULES:
            1. Bank/credit card statements with multiple items → log_bulk_expenses.
            2. IGNORE summary headers. ONLY individual line items.
            3. DATE RULE: Use the statement date for the year. NEVER use today's date.
            4. Single receipt → log_expense.
            5. Event flyer → create_calendar_event.`;
        const chat = heavyModel.startChat();
        await runChatTurn(chat, ctx, [imagePart, caption], ctx.from.id);
    } catch (error) {
        console.error('Error processing document:', error);
        await ctx.reply('Sorry, I had trouble reading that file.');
    }
});

async function getGeminiFilePart(fileId: string, mimeType: string) {
    const fileLink = await bot.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    const arrayBuffer = await response.arrayBuffer();
    return {
        inlineData: {
            data: Buffer.from(arrayBuffer).toString('base64'),
            mimeType: mimeType,
        },
    };
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

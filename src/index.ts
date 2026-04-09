import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { GoogleGenerativeAI } from '@google/generative-ai';
import 'dotenv/config';
import { appendExpenseToSheet, getFixedExpensesForToday,} from './services/sheetsService';
import { ChatSession } from '@google/generative-ai';
import { 
    checkScheduleDeclaration,
    logExpenseDeclaration, 
    getSummaryDeclaration, 
    addFixedExpenseDeclaration, 
    updateFixedExpenseDeclaration, 
    getAllFixedExpensesDeclaration, 
    deleteFixedExpenseDeclaration,
    createCalendarEventDeclaration 
} from './tools/tools';
import { handleToolCall } from './tools/toolHandler';
import { SYSTEM_INSTRUCTION } from './config/config';
import cron from 'node-cron';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MY_CHAT_ID = process.env.MY_TELEGRAM_CHAT_ID!;
const userSessions = new Map<number, ChatSession>();

cron.schedule('0 9 * * *', async () => {
    try {
        const expensesToLog = await getFixedExpensesForToday();
        
        if (expensesToLog.length === 0) return; 

        console.log(`Found ${expensesToLog.length} fixed expenses for today. Logging...`);
        let loggedList = "";

        for (const exp of expensesToLog) {
            await appendExpenseToSheet(exp.amount, exp.currency, exp.category, exp.description);
            loggedList += `\n- ${exp.description} (${exp.currency} ${exp.amount})`;
        }

        const message = `🗓️ *Automated Billing:* Good morning! I just logged today's scheduled expenses into your tracker:${loggedList}`;
        await bot.telegram.sendMessage(MY_CHAT_ID, message, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error("Cron Job Error:", error);
    }
}, {
    timezone: "Asia/Kuala_Lumpur" 
});

//grantCalendarAccess();
bot.launch(() => console.log('🤖 Secretary Bot is running...'));

const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
tools: [{ 
        functionDeclarations: [
            logExpenseDeclaration, 
            getSummaryDeclaration, 
            addFixedExpenseDeclaration, 
            updateFixedExpenseDeclaration,
            getAllFixedExpensesDeclaration,
            deleteFixedExpenseDeclaration,
            createCalendarEventDeclaration,
            checkScheduleDeclaration
        ] 
    }],
    systemInstruction: SYSTEM_INSTRUCTION
});

bot.on(message('text'), async (ctx) => {
    const userMessage = ctx.message.text;
    const userId = ctx.from.id; 
    await ctx.sendChatAction('typing');

    try {
        let chat = userSessions.get(userId);     
        if (!chat) {
            chat = model.startChat();
            userSessions.set(userId, chat);
        }   
        const now = new Date();
        const todayFormatted = now.toLocaleDateString('en-MY', { 
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Kuala_Lumpur' 
        });
        const contextPrompt = `
        [SYSTEM CONTEXT]
        Today is ${todayFormatted}. 
        Current Year: ${now.getFullYear()}.
        Current Month: ${now.getMonth() + 1}.
        Reference: If the user provides a date range like "24-26", calculate the start and end dates accordingly.
        ACTION: Always execute the calendar tool. DO NOT JUST CHAT.

        [MESSAGE]: ${userMessage}`;

        let result = await chat.sendMessage(contextPrompt);
        let response = result.response;
        let functionCalls = response.functionCalls();
        console.log('🤖 AI Intent:', functionCalls ? `Calling Tool: ${functionCalls[0].name}` : 'Just Chatting');
        if (functionCalls && functionCalls.length > 0) {
             for (const call of functionCalls) {
                await handleToolCall(call, chat, ctx);
            }
            userSessions.delete(userId);
        } else {
            await ctx.reply(response.text());
        }

    } catch (error: any) {
        console.error('Error:', error);
        
        if (error.message && error.message.includes('429 Too Many Requests')) {
            await ctx.reply("⏳ Whoa, slow down! I'm hitting my API rate limit. Give me a moment to cool off.");
        } else {
            await ctx.reply("Sorry, I encountered an error processing that.");
        }
    }
});

bot.on(message('photo'), async (ctx) => {
    await ctx.sendChatAction('typing');
    try {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        const imagePart = await getGeminiFilePart(photo.file_id, 'image/jpeg');
        const caption = ctx.message.caption || "Please process this receipt and log the expense.";
        const chat = model.startChat();
        
        let result = await chat.sendMessage([imagePart, caption]);
        let response = result.response;
        let functionCalls = response.functionCalls();

        if (functionCalls && functionCalls.length > 0) {
            for (const call of functionCalls) {
                await handleToolCall(call, chat, ctx);
            }
        } else {
            await ctx.reply(response.text());
        }
    } catch (error) {
        console.error('Error processing image:', error);
        await ctx.reply("Sorry, I had trouble reading that receipt.");
    }
});

bot.on(message('voice'), async (ctx) => {
    await ctx.sendChatAction('typing');
    try {
        const voice = ctx.message.voice;
        const audioPart = await getGeminiFilePart(voice.file_id, 'audio/ogg');
        const chat = model.startChat();
        
        let result = await chat.sendMessage([audioPart, "Listen to this audio command and execute it."]);
        let response = result.response;
        let functionCalls = response.functionCalls();

        if (functionCalls && functionCalls.length > 0) {
            for (const call of functionCalls) {
                await handleToolCall(call, chat, ctx);
            }
        } else {
            await ctx.reply(response.text());
        }
    } catch (error) {
        console.error('Error processing voice:', error);
        await ctx.reply("Sorry, I couldn't hear that clearly.");
    }
});

bot.on(message('document'), async (ctx) => {
    await ctx.sendChatAction('typing');
    try {
        const document = ctx.message.document;
        const mimeType = document.mime_type || '';

    if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') {
            await ctx.reply("I can only process image documents for receipts right now.");
            return;
        }

        const imagePart = await getGeminiFilePart(document.file_id, mimeType);
        const caption = ctx.message.caption || "This is a list of expenses. Extract every single outgoing transaction from this document and call the 'log_expense' tool for EACH ONE. If it contains meeting or event details, use 'create_calendar_event' to schedule it. ";
        const chat = model.startChat();
        
        let result = await chat.sendMessage([imagePart, caption]);
        let response = result.response;
        let functionCalls = response.functionCalls();

        if (functionCalls && functionCalls.length > 0) {
            for (const call of functionCalls) {
                await handleToolCall(call, chat, ctx);
            }
        } else {
            await ctx.reply(response.text());
        }
    } catch (error) {
        console.error('Error processing document:', error);
        await ctx.reply("Sorry, I had trouble reading that file.");
    }
});

async function getGeminiFilePart(fileId: string, mimeType: string) {
    const fileLink = await bot.telegram.getFileLink(fileId);
    
    const response = await fetch(fileLink.href);
    const arrayBuffer = await response.arrayBuffer();
    
    return {
        inlineData: {
            data: Buffer.from(arrayBuffer).toString("base64"),
            mimeType: mimeType
        }
    };
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));


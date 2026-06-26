import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import 'dotenv/config';
import { appendExpense, getFixedExpensesForToday } from './services/expenseService';
import { ChatSession } from '@google/generative-ai';
import { handleToolCall } from './tools/toolHandler';
import { formatBulkWorkoutLogReply } from './services/gymService';
import {
    createGeminiModel,
    GEMINI_MODEL_DEFAULT,
    GEMINI_MODEL_HEAVY,
} from './config/gemini';
import { loadExpenseCategories } from './config/expenseCategories';
import { updateProteinTarget, updateNutritionTargets } from './services/nutritionService';
import { parseMaxPx, resizeForGemini } from './utils/imageForGemini';
import cron from 'node-cron';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MY_CHAT_ID = process.env.MY_TELEGRAM_CHAT_ID!;
const GEMINI_IMAGE_MAX_PX = parseMaxPx(process.env.GEMINI_IMAGE_MAX_PX, 768);

interface UserChatState {
    chat: ChatSession;
    turnCount: number;
    lastActiveAt: number;
    awaitingInput: boolean;
}

const MIN_TURNS = 2;
const MAX_TURNS = 15;
const SESSION_TTL_MS = 30 * 60 * 1000;

const userSessions = new Map<number, UserChatState>();

let defaultModel: GenerativeModel;
let heavyModel: GenerativeModel;

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

bot.command('reset', async (ctx) => {
    userSessions.delete(ctx.from.id);
    await ctx.reply('Conversation reset. How can I help?');
});

bot.command('settargets', async (ctx) => {
    const parts = ctx.message.text.replace('/settargets', '').trim().split(/\s+/);
    if (parts.length < 4) {
        await ctx.reply('Usage: /settargets <calories> <protein_g> <carbs_g> <fat_g>\nExample: /settargets 2200 180 250 70');
        return;
    }
    const [cal, protein, carbs, fat] = parts.map(parseFloat);
    if (!cal || !protein || !carbs || !fat || cal <= 0 || protein <= 0 || carbs <= 0 || fat <= 0) {
        await ctx.reply('All values must be positive numbers.');
        return;
    }
    await updateNutritionTargets(ctx.from.id, {
        dailyCalorieTarget: cal,
        dailyProteinTargetG: protein,
        dailyCarbsTargetG: carbs,
        dailyFatTargetG: fat,
    });
    await ctx.reply(
        `✅ Daily targets set:\n` +
            `${cal} cal · ${protein}g protein · ${carbs}g carbs · ${fat}g fat`
    );
});

async function main() {
    await loadExpenseCategories();
    defaultModel = createGeminiModel(genAI, GEMINI_MODEL_DEFAULT);
    heavyModel = createGeminiModel(genAI, GEMINI_MODEL_HEAVY);

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

    bot.launch(() => {
        console.log('🤖 Secretary Bot is running...');
        console.log(`   Default model: ${GEMINI_MODEL_DEFAULT}`);
        console.log(`   Heavy model:   ${GEMINI_MODEL_HEAVY}`);
    });
}

main().catch((err) => {
    console.error('Failed to start bot:', err);
    process.exit(1);
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

const GYM_KEYWORDS =
    /\b(gym|workout|exercise|bench|squat|deadlift|training|leg day|push day|pull day)\b/;
const FOOD_KEYWORDS =
    /\b(food|meal|protein|lunch|dinner|breakfast|snack|nutrition|macro|calories|eat|ate|eating|had|drank|drink|roti|nasi|mee|rice|kuih|teh|kopi|ayam|ikan|sambal|burger|pizza|sandwich|egg|toast|oats|salad|fruit|pork|daging|wrong|actually|correct|fix|delete meal)\b/;

const NUTRITION_QUERY_KEYWORDS =
    /\b(how much|how am i|summary|remaining|target|progress|total)\b.*\b(protein|calories|carbs|fat|macro|nutrition)\b|\b(protein|calories|carbs|fat|macro|nutrition)\b.*\b(today|remaining|target|progress|total|summary)\b/;

const EXPENSE_PRICE_KEYWORDS =
    /\b(rm|myr|\$|usd|spent|paid|cost|price|ringgit)\s*[\d.]|\b[\d.]+\s*(rm|myr|ringgit)\b/i;

function getTextFoodPrompt(userMessage: string): string {
    const lower = userMessage.toLowerCase();
    const hasFoodKeywords = FOOD_KEYWORDS.test(lower);
    const hasPriceKeywords = EXPENSE_PRICE_KEYWORDS.test(userMessage);
    const isNutritionQuery = NUTRITION_QUERY_KEYWORDS.test(lower);
    if (isNutritionQuery) {
        return '';
    }
    if (!hasFoodKeywords) {
        return '';
    }
    if (hasPriceKeywords) {
        return (
            `\n\n[FOOD + EXPENSE LOG INSTRUCTION]\n` +
            `The user is logging a food purchase with a stated price. Call BOTH tools:\n` +
            `1. log_expense with amount, currency (MYR if "rm"), category "Food", description (food + location).\n` +
            `2. log_meal with estimated proteinG, carbsG, fatG, calories for the food.\n` +
            `Do NOT ask the user for macro values.`
        );
    }
    return (
        `\n\n[FOOD LOG INSTRUCTION]\n` +
        `The user is logging a meal from text. Identify the food(s) and quantity.\n` +
        `Estimate proteinG, carbsG, fatG, and calories for a typical Malaysian portion.\n` +
        `Call log_meal immediately. Do NOT ask the user for macro values.`
    );
}
const RECEIPT_KEYWORDS =
    /\b(receipt|bill|invoice|statement|expense|transaction|bank|credit card)\b/;

function getPhotoPrompt(caption: string): { prompt: string; useHeavyModel: boolean } {
    const lower = caption.toLowerCase();
    const hasPriceKeywords = EXPENSE_PRICE_KEYWORDS.test(caption);
    const isTodayMeal = /\btoday\b/i.test(caption);
    if (GYM_KEYWORDS.test(lower)) {
        return {
            prompt:
                `You are a gym assistant. Analyze this workout image. ` +
                `If multiple exercises are visible, call log_bulk_workouts once with all exercises. ` +
                `If only one exercise, call log_workout. ` +
                `Include sets, reps, weightKg, and durationMin. ` +
                `Do NOT call get_workout_summary or get_nutrition_summary. ${caption}`,
            useHeavyModel: false,
        };
    }
    const isEmptyCaption = caption.trim() === '';
    const isLikelyMealPhoto =
        !isEmptyCaption &&
        (FOOD_KEYWORDS.test(lower) || hasPriceKeywords || isTodayMeal);
    if (isLikelyMealPhoto) {
        const dateInstruction =
            `Use today's date from SYSTEM CONTEXT for the date field. ` +
            `If the caption says "today", you MUST use that date. ` +
            `Do NOT use image metadata or EXIF dates.`;
        if (hasPriceKeywords) {
            return {
                prompt:
                    `Analyze this meal image. Identify visible foods and estimate portions. ` +
                    `[FOOD + EXPENSE LOG INSTRUCTION]\n` +
                    `The user is logging a food purchase with a stated price. Call BOTH tools:\n` +
                    `1. log_expense with amount, currency (MYR if "rm"), category "Food", description (food + location).\n` +
                    `2. log_meal with estimated proteinG, carbsG, fatG, calories for the food.\n` +
                    `${dateInstruction} ` +
                    `Do NOT ask the user for macro values. ${caption}`.trim(),
                useHeavyModel: true,
            };
        }
        return {
            prompt:
                `Analyze this meal image. Identify visible foods and estimate portions. ` +
                `Call log_meal with description, mealType (if inferable), proteinG, carbsG, fatG, and calories. ` +
                `${dateInstruction} ` +
                `All macro values are required and approximate. Do NOT ask the user for macro values. ${caption}`.trim(),
            useHeavyModel: true,
        };
    }
    if (RECEIPT_KEYWORDS.test(lower)) {
        return {
            prompt:
                caption ||
                'Process this receipt or statement. Use log_expense for a single receipt or log_bulk_expenses for statements.',
            useHeavyModel: true,
        };
    }
  const dateInstruction =
        `Use today's date from SYSTEM CONTEXT for the date field. ` +
        `Infer mealType from time of day when possible. ` +
        `Do NOT use image metadata or EXIF dates.`;
    return {
        prompt:
            `Classify this image. ` +
            `If it shows gym equipment, a workout, exercise machine, weights, or fitness activity: ` +
            `call log_workout for one exercise, or log_bulk_workouts if multiple exercises are visible. ` +
            `Include sets, reps, weightKg, durationMin. ` +
            `If it is FOOD: identify visible foods, estimate portions, and call log_meal immediately with ` +
            `description, mealType (if inferable), proteinG, carbsG, fatG, and calories. ` +
            `${dateInstruction} ` +
            `Do NOT ask the user for dish name, macros, calories, meal type, or date—you must estimate from the image. ` +
            `If it is a RECEIPT or bank statement: use log_expense or log_bulk_expenses. ` +
            `Do NOT call get_workout_summary or get_nutrition_summary when logging from a photo. ` +
            `Do not log food as expenses. ${caption}`.trim(),
        useHeavyModel: true,
    };
}

function isFinancialDocumentCaption(caption: string): boolean {
    const lower = caption.toLowerCase();
    return RECEIPT_KEYWORDS.test(lower);
}

function getOrCreateSession(userId: number): UserChatState {
    const now = Date.now();
    const existing = userSessions.get(userId);

    if (existing) {
        const idle = now - existing.lastActiveAt;
        const expiredByTtl = idle > SESSION_TTL_MS && existing.turnCount >= MIN_TURNS;
        if (expiredByTtl || existing.turnCount >= MAX_TURNS) {
            userSessions.delete(userId);
        } else {
            existing.turnCount++;
            existing.lastActiveAt = now;
            return existing;
        }
    }

    const state: UserChatState = {
        chat: defaultModel.startChat(),
        turnCount: 1,
        lastActiveAt: now,
        awaitingInput: false,
    };
    userSessions.set(userId, state);
    return state;
}

function updateSessionState(
    userId: number,
    updates: Partial<Pick<UserChatState, 'awaitingInput'>>
) {
    const state = userSessions.get(userId);
    if (state) {
        Object.assign(state, updates);
        state.lastActiveAt = Date.now();
    }
}

function isGeminiOverloadError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('503') || msg.includes('Service Unavailable') || msg.includes('high demand');
}

async function runChatTurn(
    chat: ChatSession,
    ctx: import('telegraf').Context,
    prompt: string | (string | Record<string, unknown>)[],
    userId: number,
    toolOptions?: import('./tools/toolHandler').ToolCallOptions,
    trackSession = false
) {
    const result = await chat.sendMessage(prompt as Parameters<ChatSession['sendMessage']>[0]);
    const response = result.response;
    const functionCalls = response.functionCalls();
    console.log(
        '🤖 AI Intent:',
        functionCalls ? `Calling Tool: ${functionCalls[0].name}` : 'Just Chatting'
    );

    if (functionCalls && functionCalls.length > 0) {
        let shouldClearSession = true;
        const workoutCallCount = functionCalls.filter((c) => c.name === 'log_workout').length;
        const shouldBatchWorkouts = workoutCallCount > 1;
        const workoutBatchCollector: import('./services/gymService').WorkoutLogEntry[] = [];

        for (const call of functionCalls) {
            const callOptions =
                shouldBatchWorkouts && call.name === 'log_workout'
                    ? {
                          ...toolOptions,
                          suppressWorkoutReply: true,
                          workoutBatchCollector,
                      }
                    : toolOptions;
            const toolResult = await handleToolCall(call, chat, ctx, callOptions);
            if (toolResult === 'awaiting_input') {
                shouldClearSession = false;
            }
        }

        if (workoutBatchCollector.length > 1) {
            await ctx.reply(
                formatBulkWorkoutLogReply(workoutBatchCollector[0].date, workoutBatchCollector)
            );
        }

        if (trackSession) {
            if (shouldClearSession) {
                userSessions.delete(userId);
            } else {
                updateSessionState(userId, { awaitingInput: true });
            }
        }
    } else {
        const aiText = response.text();
        if (aiText && aiText.trim().length > 0) {
            await ctx.reply(aiText);
        } else {
            await ctx.reply("I processed that, but I couldn't find anything to log or report.");
        }
        if (trackSession) {
            updateSessionState(userId, { awaitingInput: true });
        }
    }
}

async function runPhotoChatTurn(
    ctx: import('telegraf').Context,
    prompt: string | (string | Record<string, unknown>)[],
    useHeavyModel: boolean,
    toolOptions: import('./tools/toolHandler').ToolCallOptions
) {
    const userId = ctx.from!.id;
    const chat = (useHeavyModel ? heavyModel : defaultModel).startChat();
    try {
        await runChatTurn(chat, ctx, prompt, userId, toolOptions);
    } catch (error) {
        if (useHeavyModel && isGeminiOverloadError(error)) {
            const fallbackChat = defaultModel.startChat();
            await runChatTurn(fallbackChat, ctx, prompt, userId, toolOptions);
        } else {
            throw error;
        }
    }
}

bot.on(message('text'), async (ctx) => {
    const userMessage = ctx.message.text;
    const userId = ctx.from.id;
    await ctx.sendChatAction('typing');

    try {
        const session = getOrCreateSession(userId);
        const prompt = buildContextPrompt(userMessage) + getTextFoodPrompt(userMessage);
        await runChatTurn(session.chat, ctx, prompt, userId, undefined, true);
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
        const photoBuffer = await fetchTelegramFile(photo.file_id);
        const imagePart = await buildGeminiFilePart(photoBuffer, 'image/jpeg');
        const caption = ctx.message.caption || '';
        const { prompt: photoInstruction, useHeavyModel } = getPhotoPrompt(caption);
        const prompt = buildContextPrompt(caption) + '\n' + photoInstruction;

        const toolOptions: import('./tools/toolHandler').ToolCallOptions = {
            photoFileId: photo.file_id,
            photoBuffer,
            photoMimeType: 'image/jpeg',
            userCaption: caption,
        };

        await runPhotoChatTurn(ctx, [imagePart, prompt], useHeavyModel, toolOptions);
    } catch (error) {
        console.error('Error processing image:', error);
        if (isGeminiOverloadError(error)) {
            await ctx.reply(
                '⏳ The AI service is busy right now. Please try sending the image again in a moment.'
            );
        } else {
            await ctx.reply('Sorry, I had trouble reading that image.');
        }
    }
});

bot.on(message('voice'), async (ctx) => {
    await ctx.sendChatAction('typing');
    try {
        const voice = ctx.message.voice;
        const audioBuffer = await fetchTelegramFile(voice.file_id);
        const audioPart = await buildGeminiFilePart(audioBuffer, 'audio/ogg');
        const chat = defaultModel.startChat();
        const voicePrompt =
            buildContextPrompt('') +
            '\nListen to this audio command and execute the appropriate tool. ' +
            `Use today's date from SYSTEM CONTEXT when logging meals or expenses unless the user specifies another date.`;
        await runChatTurn(
            chat,
            ctx,
            [audioPart, voicePrompt],
            ctx.from.id,
            { isVoiceInput: true }
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

        const fileBuffer = await fetchTelegramFile(document.file_id);
        const imagePart = await buildGeminiFilePart(fileBuffer, mimeType);
        const userCaption = ctx.message.caption || '';

        if (mimeType.startsWith('image/') && !isFinancialDocumentCaption(userCaption)) {
            const { prompt, useHeavyModel } = getPhotoPrompt(userCaption);
            const fullPrompt = buildContextPrompt(userCaption) + '\n' + prompt;

            await runPhotoChatTurn(ctx, [imagePart, fullPrompt], useHeavyModel, {
                photoFileId: document.file_id,
                photoBuffer: fileBuffer,
                photoMimeType: mimeType,
                userCaption,
            });
            return;
        }

        const caption =
            userCaption ||
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

async function fetchTelegramFile(fileId: string): Promise<Buffer> {
    const fileLink = await bot.telegram.getFileLink(fileId);
    const response = await fetch(fileLink.href);
    return Buffer.from(await response.arrayBuffer());
}

async function buildGeminiFilePart(buffer: Buffer, mimeType: string) {
    const { data, mimeType: outMime } = await resizeForGemini(
        buffer,
        mimeType,
        GEMINI_IMAGE_MAX_PX
    );
    return {
        inlineData: {
            data,
            mimeType: outMime,
        },
    };
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

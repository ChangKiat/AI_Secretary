import { Telegraf } from 'telegraf';
import { randomUUID } from 'crypto';
import { message } from 'telegraf/filters';
import { GoogleGenerativeAI, GenerativeModel, ChatSession } from '@google/generative-ai';
import 'dotenv/config';
import { appendExpense, getFixedExpensesForToday, formatBulkExpenseLogReply } from './services/expenseService';
import { upsertInvestmentFundingTransfer, resolveReplyRecord } from './services/incomeService';
import {
    accrueInterestForSchedule,
    getInterestSchedulesForToday,
} from './services/interestScheduleService';
import { applyLoanPayment } from './services/loanService';
import { handleToolCall } from './tools/toolHandler';
import { formatBulkWorkoutLogReply } from './services/gymService';
import {
    createPlannerModel,
    createDomainModel,
    GEMINI_MODEL_DEFAULT,
    GEMINI_MODEL_HEAVY,
    SKIP_PLANNER,
} from './config/gemini';
import { documentExpensePrompt } from './config/prompts';
import { loadExpenseCategories } from './config/expenseCategories';
import { loadPaymentAccounts } from './config/paymentMethods';
import {
    getMealById,
    updateProteinTarget,
    getTodayMacroProgress,
    formatBulkMealLogReply,
    updateNutritionTargets,
} from './services/nutritionService';
import { parseMaxPx, resizeForGemini } from './utils/imageForGemini';
import {
    routeMessage,
    routeByHeuristics,
    getOrCreateSession,
    getOrCreateDomainChat,
    filterSpecialistDomains,
    applyMoneyRoutingHints,
    UserChatState,
    SpecialistDomain,
} from './routing/router';
import cron from 'node-cron';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const MY_CHAT_ID = process.env.MY_TELEGRAM_CHAT_ID!;
const AUTHORIZED_USER_ID = Number(MY_CHAT_ID);
const GEMINI_IMAGE_MAX_PX = parseMaxPx(process.env.GEMINI_IMAGE_MAX_PX, 768);

const MIN_TURNS = 2;
const MAX_TURNS = 8;
const SESSION_TTL_MS = 10 * 60 * 1000;

const userSessions = new Map<number, UserChatState>();

let plannerModel: GenerativeModel;
let defaultModel: GenerativeModel;
let heavyModel: GenerativeModel;

const routeOptionsBase = () => ({
    genAI,
    plannerModel,
    defaultModel,
    heavyModel,
});

bot.catch((err, ctx) => {
    console.error(`🚨 CRITICAL ERROR in ${ctx.updateType} event:`);
    console.error(err);
});

// This bot is a single-user personal assistant — reject anyone but the owner
// before any Gemini call or DB write happens.
bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.id !== AUTHORIZED_USER_ID) {
        console.warn(
            `🚫 Blocked message from unauthorized user ${ctx.from?.id} (@${ctx.from?.username ?? 'unknown'})`
        );
        return;
    }
    return next();
});

async function notifyOwner(message: string) {
    try {
        await bot.telegram.sendMessage(MY_CHAT_ID, message, { parse_mode: 'Markdown' });
    } catch (notifyError) {
        console.error('Failed to send owner notification:', notifyError);
    }
}

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
    await loadPaymentAccounts();
    plannerModel = createPlannerModel(genAI);
    defaultModel = createDomainModel(genAI, 'expense');
    heavyModel = createDomainModel(genAI, 'expense', { heavy: true });

    cron.schedule(
        '0 9 * * *',
        async () => {
            try {
                const expensesToLog = await getFixedExpensesForToday();
                if (expensesToLog.length === 0) return;

                console.log(`Found ${expensesToLog.length} fixed expenses for today. Logging...`);
                let loggedList = '';

                for (const exp of expensesToLog) {
                    const expenseId = await appendExpense(
                        exp.date,
                        exp.amount,
                        exp.currency,
                        exp.category,
                        exp.description,
                        exp.paymentMethod
                    );
                    if (
                        exp.category.toLowerCase() === 'investment' &&
                        exp.paymentMethod &&
                        exp.toInvestmentAccount
                    ) {
                        await upsertInvestmentFundingTransfer({
                            expenseId,
                            date: exp.date,
                            amount: exp.amount,
                            description: exp.description,
                            fromPaymentMethod: exp.paymentMethod,
                            toInvestmentAccount: exp.toInvestmentAccount,
                        });
                    }
                    let loanNote = '';
                    if (exp.loan) {
                        const applied = await applyLoanPayment({
                            fixedExpenseId: exp.id,
                            date: exp.date,
                            expenseId,
                        });
                        if (applied) {
                            loanNote = ` · interest ${applied.interest.toFixed(2)} / principal ${applied.principal.toFixed(2)} / left ${applied.remainingAfter.toFixed(2)}`;
                        }
                    }
                    const via = exp.paymentMethod ? ` via ${exp.paymentMethod}` : '';
                    const toFund = exp.toInvestmentAccount ? ` → ${exp.toInvestmentAccount}` : '';
                    loggedList += `\n- ${exp.description} (${exp.currency} ${exp.amount}${via}${toFund}${loanNote})`;
                }

                const msg = `🗓️ *Automated Billing:* Good morning! I just logged today's scheduled expenses:${loggedList}`;
                await bot.telegram.sendMessage(MY_CHAT_ID, msg, { parse_mode: 'Markdown' });
            } catch (error) {
                console.error('Cron Job Error:', error);
                const detail = error instanceof Error ? error.message : String(error);
                await notifyOwner(`🚨 *Automated Billing failed:* Today's fixed expenses were NOT logged.\n${detail}`);
            }
        },
        { timezone: 'Asia/Kuala_Lumpur' }
    );

    cron.schedule(
        '0 9 * * *',
        async () => {
            try {
                const schedulesDue = await getInterestSchedulesForToday();
                if (schedulesDue.length === 0) return;

                console.log(`Found ${schedulesDue.length} interest schedules for today. Accruing...`);
                let loggedList = '';

                for (const sched of schedulesDue) {
                    const result = await accrueInterestForSchedule(sched);
                    if (!result) continue;
                    loggedList += `\n- ${sched.description} (${sched.currency} ${result.amount.toFixed(2)} → ${sched.paymentMethod})`;
                }

                if (!loggedList) return;

                const msg = `💰 *Interest accrued:* Good morning! I just logged today's scheduled interest:${loggedList}`;
                await bot.telegram.sendMessage(MY_CHAT_ID, msg, { parse_mode: 'Markdown' });
            } catch (error) {
                console.error('Interest Cron Job Error:', error);
                const detail = error instanceof Error ? error.message : String(error);
                await notifyOwner(`🚨 *Interest accrual failed:* Today's scheduled interest was NOT accrued.\n${detail}`);
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

function getReplyToText(ctx: import('telegraf').Context): string | undefined {
    const msg = ctx.message;
    if (!msg || !('reply_to_message' in msg) || !msg.reply_to_message) return undefined;
    const replied = msg.reply_to_message;
    if ('text' in replied && replied.text) return replied.text;
    return undefined;
}

async function buildReplyRecordContext(ctx: import('telegraf').Context): Promise<{
    replyToExpenseId?: number;
    replyTarget?: import('./services/incomeService').ReplyRecordTarget;
    promptHint: string;
}> {
    const replyText = getReplyToText(ctx);
    if (!replyText) return { promptHint: '' };
    const userId = ctx.from?.id;
    const target = await resolveReplyRecord(replyText, async (mealId) => {
        if (userId == null) return false;
        return (await getMealById(mealId, userId)) != null;
    });
    if (!target) return { promptHint: '' };

    const editHint = `For corrections use edit_${target.type}/delete_${target.type} with this id.`;
    const expenseExtra =
        target.type === 'expense'
            ? ' If they report a reimbursement, use log_income linked to this expense.'
            : '';
    return {
        replyToExpenseId: target.type === 'expense' ? target.id : undefined,
        replyTarget: target,
        promptHint: `\n[REPLY CONTEXT] User is replying to ${target.type} #${target.id}. ${editHint}${expenseExtra}`,
    };
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
    toolOptions?: import('./tools/toolHandler').ToolCallOptions
): Promise<'complete' | 'awaiting_input'> {
    const result = await chat.sendMessage(prompt as Parameters<ChatSession['sendMessage']>[0]);
    const response = result.response;
    const functionCalls = response.functionCalls();
    console.log(
        '🤖 AI Intent:',
        functionCalls ? `Calling Tool: ${functionCalls[0].name}` : 'Just Chatting'
    );

    if (functionCalls && functionCalls.length > 0) {
        let awaiting = false;
        const workoutCallCount = functionCalls.filter((c) => c.name === 'log_workout').length;
        const mealCallCount = functionCalls.filter((c) => c.name === 'log_meal').length;
        const expenseCallCount = functionCalls.filter((c) => c.name === 'log_expense').length;
        const shouldBatchWorkouts = workoutCallCount > 1;
        const shouldBatchMeals = mealCallCount > 1;
        const shouldBatchExpenses = expenseCallCount > 1;
        const workoutBatchCollector: import('./services/gymService').WorkoutLogEntry[] = [];
        const mealBatchCollector: import('./services/nutritionService').MealBatchEntry[] = [];
        const expenseBatchCollector: import('./services/expenseService').ExpenseBatchEntry[] = [];
        const workoutBatchSessionId = shouldBatchWorkouts ? randomUUID() : undefined;

        for (const call of functionCalls) {
            const callOptions = { ...toolOptions };
            if (shouldBatchWorkouts && call.name === 'log_workout') {
                callOptions.suppressWorkoutReply = true;
                callOptions.workoutBatchCollector = workoutBatchCollector;
                callOptions.workoutBatchSessionId = workoutBatchSessionId;
            }
            if (shouldBatchMeals && call.name === 'log_meal') {
                callOptions.suppressMealReply = true;
                callOptions.mealBatchCollector = mealBatchCollector;
            }
            if (shouldBatchExpenses && call.name === 'log_expense') {
                callOptions.suppressExpenseReply = true;
                callOptions.expenseBatchCollector = expenseBatchCollector;
            }
            const toolResult = await handleToolCall(call, chat, ctx, callOptions);
            if (toolResult === 'awaiting_input') {
                awaiting = true;
            }
        }

        if (workoutBatchCollector.length > 1) {
            await ctx.reply(
                formatBulkWorkoutLogReply(workoutBatchCollector[0].date, workoutBatchCollector)
            );
        }
        if (mealBatchCollector.length > 1) {
            const date = mealBatchCollector[0].date;
            const { progress } = await getTodayMacroProgress(userId, date);
            await ctx.reply(formatBulkMealLogReply(date, mealBatchCollector, progress));
        }
        if (expenseBatchCollector.length > 1) {
            await ctx.reply(
                formatBulkExpenseLogReply(expenseBatchCollector[0].date, expenseBatchCollector)
            );
        }

        return awaiting ? 'awaiting_input' : 'complete';
    }

    const aiText = response.text();
    if (aiText && aiText.trim().length > 0) {
        await ctx.reply(aiText);
    } else {
        await ctx.reply("I processed that, but I couldn't find anything to log or report.");
    }
    // Text-only reply (e.g. numbered receipt items) needs a follow-up from the user.
    return 'awaiting_input';
}

async function runDomainTurn(
    domain: SpecialistDomain,
    ctx: import('telegraf').Context,
    parts: string | (string | Record<string, unknown>)[],
    userId: number,
    session: UserChatState,
    toolOptions: import('./tools/toolHandler').ToolCallOptions,
    heavy = false
): Promise<'complete' | 'awaiting_input'> {
    const chat = getOrCreateDomainChat(session, domain, {
        ...routeOptionsBase(),
        userId,
        heavy,
    });
    return runChatTurn(chat, ctx, parts, userId, toolOptions);
}

async function handleChatOnly(ctx: import('telegraf').Context, contextPrompt: string) {
    const chat = plannerModel.startChat();
    const result = await chat.sendMessage(contextPrompt);
    const aiText = result.response.text();
    if (aiText?.trim()) {
        await ctx.reply(aiText);
    } else {
        await ctx.reply(
            'How can I help? I can log expenses, meals, workouts, or calendar events.'
        );
    }
}

async function routeAndExecute(
    ctx: import('telegraf').Context,
    userId: number,
    textForContext: string,
    mediaParts: (string | Record<string, unknown>)[] = [],
    toolOptions: import('./tools/toolHandler').ToolCallOptions = {},
    options?: { heavy?: boolean; forceDomains?: SpecialistDomain[] }
) {
    const session = getOrCreateSession(
        userId,
        userSessions,
        MIN_TURNS,
        MAX_TURNS,
        SESSION_TTL_MS
    );
    const replyCtx = await buildReplyRecordContext(ctx);
    const contextPrompt = buildContextPrompt(textForContext) + replyCtx.promptHint;
    const mergedToolOptions: import('./tools/toolHandler').ToolCallOptions = {
        ...toolOptions,
        replyToExpenseId: replyCtx.replyToExpenseId,
        replyTarget: replyCtx.replyTarget,
    };

    let domains: import('./routing/router').RouteDomain[];
    if (options?.forceDomains) {
        domains = options.forceDomains;
    } else if (session.awaitingInput && session.activeDomain) {
        domains = [session.activeDomain];
    } else if (SKIP_PLANNER) {
        domains = routeByHeuristics(textForContext, mediaParts.length > 0);
        const beforeMoney = domains.join(',');
        domains = applyMoneyRoutingHints(textForContext, domains);
        if (domains.join(',') !== beforeMoney) {
            console.log('🧭 Money hint adjusted route:', domains.join(', '));
        }
    } else {
        const plannerParts =
            mediaParts.length > 0
                ? [...mediaParts, contextPrompt]
                : contextPrompt;
        domains = await routeMessage(plannerParts, {
            userId,
            session,
            ...routeOptionsBase(),
        });
        // ponytail: flaky planner may ignore image and pick chat; upgrade path = vision-aware classifier
        if (mediaParts.length > 0 && filterSpecialistDomains(domains).length === 0) {
            console.log('🧭 Media present but planner chose chat — forcing expense');
            domains = ['expense'];
        }
        const beforeMoney = domains.join(',');
        domains = applyMoneyRoutingHints(textForContext, domains);
        if (domains.join(',') !== beforeMoney) {
            console.log('🧭 Money hint adjusted route:', domains.join(', '));
        }
    }

    const specialists = filterSpecialistDomains(domains);
    if (specialists.length === 0) {
        await handleChatOnly(ctx, contextPrompt);
        userSessions.delete(userId);
        return;
    }

    let anyAwaiting = false;
    let awaitDomain: SpecialistDomain | undefined;

    for (const domain of specialists) {
        const specialistParts =
            mediaParts.length > 0 ? [...mediaParts, contextPrompt] : contextPrompt;
        const heavy = options?.heavy && domain === 'expense';
        try {
            const status = await runDomainTurn(
                domain,
                ctx,
                specialistParts,
                userId,
                session,
                mergedToolOptions,
                heavy
            );
            if (status === 'awaiting_input') {
                anyAwaiting = true;
                awaitDomain = domain;
            }
        } catch (error) {
            if (heavy && isGeminiOverloadError(error)) {
                delete session.chats[domain];
                const status = await runDomainTurn(
                    domain,
                    ctx,
                    specialistParts,
                    userId,
                    session,
                    mergedToolOptions,
                    false
                );
                if (status === 'awaiting_input') {
                    anyAwaiting = true;
                    awaitDomain = domain;
                }
            } else {
                throw error;
            }
        }
    }

    if (anyAwaiting && awaitDomain) {
        userSessions.set(userId, session);
        session.awaitingInput = true;
        session.activeDomain = awaitDomain;
        session.lastActiveAt = Date.now();
    } else {
        userSessions.delete(userId);
    }
}

bot.on(message('text'), async (ctx) => {
    const userMessage = ctx.message.text;
    const userId = ctx.from.id;
    await ctx.sendChatAction('typing');

    try {
        await routeAndExecute(ctx, userId, userMessage);
    } catch (error: unknown) {
        console.error('Error:', error);
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('429 Too Many Requests')) {
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

        await routeAndExecute(ctx, ctx.from.id, caption, [imagePart], {
            photoFileId: photo.file_id,
            photoBuffer,
            photoMimeType: 'image/jpeg',
            userCaption: caption,
        });
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
        const voiceHint =
            '\nListen to this audio command and execute the appropriate tool. ' +
            "Use today's date from SYSTEM CONTEXT when logging meals or expenses unless the user specifies another date.";

        await routeAndExecute(ctx, ctx.from.id, voiceHint, [audioPart], {
            isVoiceInput: true,
        });
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
        const filePart = await buildGeminiFilePart(fileBuffer, mimeType);
        const userCaption = ctx.message.caption || '';
        const userId = ctx.from.id;

        if (mimeType === 'application/pdf') {
            const replyCtx = await buildReplyRecordContext(ctx);
            const contextPrompt =
                buildContextPrompt(userCaption) +
                replyCtx.promptHint +
                '\n' +
                documentExpensePrompt;
            const chat = createDomainModel(genAI, 'expense', { heavy: true }).startChat();
            try {
                await runChatTurn(
                    chat,
                    ctx,
                    [filePart, contextPrompt],
                    userId,
                    {
                        replyToExpenseId: replyCtx.replyToExpenseId,
                        replyTarget: replyCtx.replyTarget,
                    }
                );
            } catch (error) {
                if (isGeminiOverloadError(error)) {
                    const fallbackChat = createDomainModel(genAI, 'expense').startChat();
                    await runChatTurn(
                        fallbackChat,
                        ctx,
                        [filePart, contextPrompt],
                        userId,
                        {
                            replyToExpenseId: replyCtx.replyToExpenseId,
                            replyTarget: replyCtx.replyTarget,
                        }
                    );
                } else {
                    throw error;
                }
            }
            return;
        }

        await routeAndExecute(ctx, userId, userCaption, [filePart], {
            photoFileId: document.file_id,
            photoBuffer: fileBuffer,
            photoMimeType: mimeType,
            userCaption,
        });
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

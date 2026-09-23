import { Telegraf } from 'telegraf';
import { randomUUID } from 'crypto';
import { message } from 'telegraf/filters';
import { GoogleGenerativeAI, GenerativeModel, ChatSession, Part } from '@google/generative-ai';
import 'dotenv/config';
import { appendExpense, getFixedExpensesForToday, formatBulkExpenseLogReply } from './services/expenseService';
import { upsertInvestmentFundingTransfer, resolveReplyRecord } from './services/incomeService';
import {
    accrueInterestForSchedule,
    getInterestSchedulesForToday,
} from './services/interestScheduleService';
import { applyLoanPayment } from './services/loanService';
import { handleToolCall, resolveToolName, TOOLS_READING_MODEL_REPLY } from './tools/toolHandler';
import { getDomainDeclarations } from './tools/tools';
import { formatBulkWorkoutLogReply, getWorkoutSessionRows } from './services/gymService';
import {
    createPlannerModel,
    createDomainModel,
    startChatWithRetry,
    isRetryableGeminiError,
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
    hasMoneySignal,
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

    cron.schedule(
        '0 8 * * *',
        async () => {
            try {
                await bot.telegram.sendMessage(
                    MY_CHAT_ID,
                    '⚖️ Morning weigh-in — step on the scale and reply like "weight 85.5" to log it.'
                );
            } catch (error) {
                console.error('Weigh-in Reminder Cron Job Error:', error);
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

const REPLY_TARGET_DOMAIN: Record<
    import('./services/incomeService').ReplyRecordType,
    SpecialistDomain
> = { expense: 'expense', income: 'expense', meal: 'meal', workout: 'workout' };

/** YYYY-MM-DD in Malaysia time, `offsetDays` from today. */
function klIsoDate(offsetDays = 0): string {
    return new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Kuala_Lumpur',
    });
}

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
        Today is ${todayFormatted} (${klIsoDate()}). Yesterday was ${klIsoDate(-1)}.
        Current Year: ${now.getFullYear()}.
        Current Month: ${now.getMonth() + 1}.
        Reference: If the user provides a date range like "24-26", calculate the start and end dates accordingly.
        MIXED DAYS: A message may have sections for different days ("Yesterday workout … Today lunch …"). Each section's day applies only to the items under it—pass that exact date on every log call; never default a "yesterday" item to today.
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
    let workoutSession: Awaited<ReturnType<typeof getWorkoutSessionRows>> = [];
    const target = await resolveReplyRecord(replyText, async (t) => {
        if (userId == null) return false;
        if (t.type === 'workout') {
            workoutSession = await getWorkoutSessionRows(t.id, userId);
            return workoutSession.length > 0;
        }
        return (await getMealById(t.id, userId)) != null;
    });
    if (!target) return { promptHint: '' };

    let editHint = `For corrections use edit_${target.type}/delete_${target.type} with this id.`;
    if (target.type === 'workout') {
        const rows = workoutSession
            .map((r) => `#${r.id} ${r.exercise}${r.weightsKgText ? ` ${r.weightsKgText}kg` : r.weightKg ? ` ${r.weightKg}kg` : ''}`)
            .join('; ');
        editHint =
            `That session (${workoutSession[0].date}) has: ${rows}. ` +
            'Use edit_workout with the matching exercise id; a date change on any id moves the whole session—call it once. ' +
            'Use delete_workout (wholeSession for the entire session). Do NOT log_workout again.';
    }
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

async function runChatTurn(
    chat: ChatSession,
    ctx: import('telegraf').Context,
    prompt: string | (string | Record<string, unknown>)[],
    userId: number,
    toolOptions?: import('./tools/toolHandler').ToolCallOptions,
    allowedTools?: Set<string>
): Promise<'complete' | 'awaiting_input'> {
    const result = await chat.sendMessage(prompt as Parameters<ChatSession['sendMessage']>[0]);
    const response = result.response;
    const rawCalls = response.functionCalls();
    console.log(
        '🤖 AI Intent:',
        rawCalls ? `Calling Tools: ${rawCalls.map((c) => c.name).join(', ')}` : 'Just Chatting'
    );

    if (rawCalls && rawCalls.length > 0) {
        // Gemini expects ONE follow-up turn carrying a functionResponse for every call.
        // Handlers each send their own, which breaks the 2nd+ call of a multi-call turn
        // (400 → "Sorry, I encountered an error"). Buffer them and send once at the end,
        // unless a handler needs the model's follow-up text to answer the user.
        // ponytail: a multi-call turn that includes a reply-reading tool still sends
        // per call; upgrade path = handlers return their response instead of sending it.
        const pendingResponses: Part[] = [];
        const deferResponses =
            rawCalls.length > 1 &&
            !rawCalls.some((c) => TOOLS_READING_MODEL_REPLY.has(resolveToolName(c.name)));
        const turnChat: ChatSession = Object.assign(Object.create(chat), {
            sendMessage: async (parts: Part[]) => {
                pendingResponses.push(...parts);
                if (deferResponses) return { response: { text: (): string => '' } };
                return chat.sendMessage(pendingResponses.splice(0));
            },
        });

        // A specialist sees the whole message, so it sometimes calls tools it wasn't
        // given (workout specialist → log_expense on "tng rm7", expense → log_supplement).
        // The owning specialist already handles those; running them here double-logs.
        const functionCalls = rawCalls.filter((call) => {
            if (!allowedTools || allowedTools.has(resolveToolName(call.name))) return true;
            console.log(`🚫 Ignored out-of-domain tool call: ${call.name}`);
            pendingResponses.push({
                functionResponse: {
                    name: call.name,
                    response: { status: 'ignored', reason: 'not available to this specialist' },
                },
            });
            return false;
        });

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
            const toolResult = await handleToolCall(call, turnChat, ctx, callOptions);
            if (toolResult === 'awaiting_input') {
                awaiting = true;
            }
        }
        if (pendingResponses.length > 0) {
            // History bookkeeping only — every log above already replied to the user.
            await chat.sendMessage(pendingResponses).catch((err) => {
                console.warn('Deferred functionResponse send failed:', err);
            });
        }

        if (workoutBatchCollector.length > 1) {
            await ctx.reply(
                formatBulkWorkoutLogReply(
                    workoutBatchCollector[0].date,
                    workoutBatchCollector,
                    undefined,
                    workoutBatchCollector[0].workoutId
                )
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

    // This domain was fired speculatively alongside another specialist on a bare
    // photo (no price/payment text). If it found nothing to log, staying silent
    // is correct — the other specialist already handled it, and asking "was this
    // purchased?" on every plain meal photo would be noise.
    if (toolOptions?.suppressNoOpReply) {
        return 'complete';
    }

    const aiText = response.text();
    if (aiText && aiText.trim().length > 0) {
        await ctx.reply(aiText);
        // A genuine clarifying question (e.g. numbered receipt items, "what time?")
        // needs a follow-up reply. A flat statement/refusal does not — staying
        // "awaiting" would force the next, unrelated message into this same domain.
        return aiText.trim().endsWith('?') ? 'awaiting_input' : 'complete';
    }
    await ctx.reply("I processed that, but I couldn't find anything to log or report.");
    return 'complete';
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
    const allowedTools = new Set(getDomainDeclarations(domain).map((d) => d.name));
    return runChatTurn(chat, ctx, parts, userId, toolOptions, allowedTools);
}

async function handleChatOnly(ctx: import('telegraf').Context, contextPrompt: string) {
    let result;
    try {
        const chat = startChatWithRetry(plannerModel);
        result = await chat.sendMessage(contextPrompt);
    } catch (error) {
        if (!isRetryableGeminiError(error)) throw error;
        const heavyChat = startChatWithRetry(createPlannerModel(genAI, { heavy: true }), 0);
        result = await heavyChat.sendMessage(contextPrompt);
    }
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
    } else if (replyCtx.replyTarget) {
        // Replying to a confirmation ("edit date to yesterday") carries no keywords
        // for the router—the record type alone says who owns the correction.
        domains = [REPLY_TARGET_DOMAIN[replyCtx.replyTarget.type]];
        console.log(`🧭 Reply to ${replyCtx.replyTarget.type} #${replyCtx.replyTarget.id} →`, domains[0]);
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
            console.log('🧭 Media present but planner chose chat — forcing expense + meal');
            domains = ['expense', 'meal'];
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

    // A bare photo with no price/payment text is ambiguous—could be a receipt or
    // just a plate of food—so both specialists run. If expense finds no price to
    // log, it should stay quiet rather than ask "was this purchased?" on every
    // meal photo; meal already owns that case.
    const suppressExpenseNoOp =
        mediaParts.length > 0 &&
        specialists.includes('expense') &&
        specialists.includes('meal') &&
        !hasMoneySignal(textForContext);

    for (const domain of specialists) {
        const specialistParts =
            mediaParts.length > 0 ? [...mediaParts, contextPrompt] : contextPrompt;
        const heavy = options?.heavy && domain === 'expense';
        const domainToolOptions =
            domain === 'expense' && suppressExpenseNoOp
                ? { ...mergedToolOptions, suppressNoOpReply: true }
                : mergedToolOptions;
        try {
            const status = await runDomainTurn(
                domain,
                ctx,
                specialistParts,
                userId,
                session,
                domainToolOptions,
                heavy
            );
            if (status === 'awaiting_input') {
                anyAwaiting = true;
                awaitDomain = domain;
            }
        } catch (error) {
            if (!isRetryableGeminiError(error)) throw error;
            console.log(
                `🧭 ${domain} (${heavy ? 'heavy' : 'lite'}) overloaded — retrying with ${heavy ? 'lite' : 'heavy'} model`
            );
            delete session.chats[domain];
            const status = await runDomainTurn(
                domain,
                ctx,
                specialistParts,
                userId,
                session,
                domainToolOptions,
                !heavy
            );
            if (status === 'awaiting_input') {
                anyAwaiting = true;
                awaitDomain = domain;
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
        if (isRetryableGeminiError(error)) {
            await ctx.reply(
                '⏳ Gemini is overloaded right now (tried both models and it\'s still down). Please try again in a bit.'
            );
        } else if (msg.includes('429 Too Many Requests')) {
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
        if (isRetryableGeminiError(error)) {
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
        if (isRetryableGeminiError(error)) {
            await ctx.reply(
                '⏳ Gemini is overloaded right now. Please try sending the voice message again in a bit.'
            );
        } else {
            await ctx.reply("Sorry, I couldn't hear that clearly.");
        }
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
            const chat = startChatWithRetry(createDomainModel(genAI, 'expense', { heavy: true }));
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
                if (isRetryableGeminiError(error)) {
                    const fallbackChat = startChatWithRetry(createDomainModel(genAI, 'expense'));
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
        if (isRetryableGeminiError(error)) {
            await ctx.reply(
                '⏳ Gemini is overloaded right now (tried both models and it\'s still down). Please try again in a bit.'
            );
        } else {
            await ctx.reply('Sorry, I had trouble reading that file.');
        }
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

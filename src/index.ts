import { Telegraf } from 'telegraf';
import { randomUUID } from 'crypto';
import { message } from 'telegraf/filters';
import 'dotenv/config';
import { formatBulkExpenseLogReply } from './services/expenseService';
import { buildTripContextHint, TripLookup } from './services/tripExpenseService';
import { resolveReplyRecord } from './services/incomeService';
import {
    handleToolCall,
    replyInChunks,
    resolveToolName,
    TOOLS_READING_MODEL_REPLY,
} from './tools/toolHandler';
import { getDomainDeclarations } from './tools/tools';
import { buildHoldingsContextHints } from './tools/fixedFundHandlers';
import { formatBulkWorkoutLogReply, getWorkoutSessionRows } from './services/gymService';
import {
    createPlannerModel,
    createDomainModel,
    isRetryableAiError,
    isRateLimitAiError,
    transcribeVoice,
    AI_PROVIDER,
    MODEL_DEFAULT,
    MODEL_HEAVY,
    SKIP_PLANNER,
    VOICE_NEEDS_TRANSCRIPT,
    ChatModel,
    ChatSession,
    MessageRequest,
    Part,
} from './config/ai';
import { documentExpensePrompt } from './config/prompts';
import { loadExpenseCategories } from './config/expenseCategories';
import { loadPaymentAccounts } from './config/paymentMethods';
import { onFinanceNamesChanged, refreshFinanceCaches } from './config/cacheRefresh';
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
    breaksAwaitingPin,
    getOrCreateSession,
    getOrCreateDomainChat,
    invalidateDomainChats,
    filterSpecialistDomains,
    applyMoneyRoutingHints,
    hasMoneySignal,
    plannerRouteDomains,
    UserChatState,
    SpecialistDomain,
} from './routing/router';
import {
    handleQuickLogText,
    quickLogKeyboard,
    SUGGEST_WORKOUT_BUTTON,
    SUGGEST_WORKOUT_REQUEST,
} from './quickLog';
import { klIsoDate } from './utils/klDate';
import { isReceiptMealQuestion } from './routing/receiptReply';
import { requireDb } from './db/client';
import { createMessageClaimStore, checkMessageClaimSchema } from './services/messageClaimStore';
import { runMessageOnce, runToolWithoutReplay, hasAttemptedTool, INTERRUPTED_MESSAGE_REPLY } from './services/messageDedup';
import { createReceiptStore, checkReceiptSchema } from './services/receiptStore';
import { receiptContext, receiptPromptHint, isReceiptFoodSelection } from './services/receiptContext';
import { withReceiptTracking } from './receiptTracking';
import { linkTelegramByCode } from './services/userService';

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN!);
const MY_CHAT_ID = process.env.MY_TELEGRAM_CHAT_ID!;
const AUTHORIZED_USER_ID = Number(MY_CHAT_ID);
const GEMINI_IMAGE_MAX_PX = parseMaxPx(process.env.GEMINI_IMAGE_MAX_PX, 768);

const MIN_TURNS = 2;
const MAX_TURNS = 8;
const SESSION_TTL_MS = 10 * 60 * 1000;

const userSessions = new Map<number, UserChatState>();

let plannerModel: ChatModel;
let defaultModel: ChatModel;
let heavyModel: ChatModel;

const routeOptionsBase = () => ({
    plannerModel,
    defaultModel,
    heavyModel,
});

/** Tool descriptions and domain prompts embed the account/category names current at build time. */
function buildModels() {
    plannerModel = createPlannerModel();
    defaultModel = createDomainModel('expense');
    heavyModel = createDomainModel('expense', { heavy: true });
}

// A Dashboard edit renamed/added/removed an account or category: rebuild the models and let every
// session rebuild its domain chats, so the model sees the new names on the next turn.
onFinanceNamesChanged(() => {
    console.log('🔄 Payment accounts or expense categories changed — rebuilding AI models');
    buildModels();
    invalidateDomainChats();
});

bot.catch((err, ctx) => {
    console.error(`🚨 CRITICAL ERROR in ${ctx.updateType} event:`);
    console.error(err);
});

/** `/link <code>`: connects the sender's Telegram account to the Dashboard account that issued the code. */
async function handleLinkCommand(ctx: import('telegraf').Context, code: string | undefined): Promise<void> {
    if (!code) {
        await ctx.reply('Open your Dashboard profile, press Connect Telegram, then send the /link message it shows you.');
        return;
    }
    try {
        const result = await linkTelegramByCode(code, ctx.from!.id);
        if (result.status === 'invalid') {
            await ctx.reply('That code is wrong or has expired. Get a new one from your Dashboard profile.');
        } else if (result.status === 'already') {
            await ctx.reply(
                `This Telegram account is already connected to ${result.email}. Disconnect it in the Dashboard profile first.`
            );
        } else if (ctx.from!.id === AUTHORIZED_USER_ID) {
            await ctx.reply(`✅ Telegram connected to ${result.email}.`);
        } else {
            await ctx.reply(
                `✅ Telegram connected to ${result.email}. The bot is not open to new accounts yet, so it will not answer other messages for now.`
            );
        }
    } catch (err) {
        console.error('Telegram link failed:', err);
        await ctx.reply('Could not connect right now. Try again in a minute.');
    }
}

// Anyone may send /link (it only connects their own Telegram account). Everything else is still
// owner-only: the finance tables are not split per user yet, so reject other senders before any
// AI call or DB write happens.
bot.use(async (ctx, next) => {
    if (!ctx.from) return;
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const linkCommand = /^\/link(?:@\w+)?(?:\s+(\S+))?\s*$/i.exec(text);
    if (linkCommand) {
        await handleLinkCommand(ctx, linkCommand[1]);
        return;
    }
    if (ctx.from.id !== AUTHORIZED_USER_ID) {
        console.warn(
            `🚫 Blocked message from unauthorized user ${ctx.from?.id} (@${ctx.from?.username ?? 'unknown'})`
        );
        return;
    }
    // Pick up accounts/categories edited on the Dashboard (reloads at most once a minute; never throws).
    await refreshFinanceCaches();
    if (!ctx.message || !ctx.chat) return next();
    const outcome = await runMessageOnce(createMessageClaimStore(requireDb()), {
        botId: ctx.botInfo.id,
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
    }, () => withReceiptTracking(ctx, next, createReceiptStore(requireDb())));
    if (outcome === 'duplicate') {
        console.log(`Skipped repeated Telegram message ${ctx.chat.id}/${ctx.message.message_id}`);
    }
});

bot.start(async (ctx) => {
    await ctx.reply(
        'Tap ⚖️ Weight or 👣 Steps below to log them without the AI, or 💪 Suggest workout for your next session. For anything else, just type.',
        quickLogKeyboard
    );
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
    await checkMessageClaimSchema(requireDb());
    await checkReceiptSchema(requireDb());
    await loadExpenseCategories();
    await loadPaymentAccounts();
    buildModels();
    if (AI_PROVIDER === 'claude' && !process.env.ANTHROPIC_API_KEY) {
        console.warn('⚠️ AI_PROVIDER=claude but ANTHROPIC_API_KEY is not set: every Claude call will fail.');
    }
    if (!process.env.GOOGLE_CALENDAR_ID) {
        console.warn(
            "⚠️ GOOGLE_CALENDAR_ID is not set: calendar events go to the service account's private calendar, which you can't see."
        );
    }

    // The daily jobs (9am fixed bills and interest, 9:30pm check-in) run on the Dashboard server,
    // Dashboard/server/dailyJobs.ts, which sends their reports through this bot.

    bot.launch(() => {
        console.log('🤖 Secretary Bot is running...');
        console.log(`   AI provider:   ${AI_PROVIDER}`);
        console.log(`   Default model: ${MODEL_DEFAULT}`);
        console.log(`   Heavy model:   ${MODEL_HEAVY}`);
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
        Current Year: ${klIsoDate().slice(0, 4)}.
        Current Month: ${Number(klIsoDate().slice(5, 7))}.
        Reference: If the user provides a date range like "24-26", calculate the start and end dates accordingly.
        MIXED DAYS: A message may have sections for different days ("Yesterday workout … Today lunch …"). Each section's day applies only to the items under it—pass that exact date on every log call; never default a "yesterday" item to today.
        ACTION: Use the appropriate tool for finances, calendar, gym, or nutrition. DO NOT JUST CHAT when an action is requested.

        [MESSAGE]: ${userMessage}`;
}

function getReplyToMessage(ctx: import('telegraf').Context): { text: string; fromBot: boolean } | undefined {
    const msg = ctx.message;
    if (!msg || !('reply_to_message' in msg) || !msg.reply_to_message) return undefined;
    const replied = msg.reply_to_message;
    if ('text' in replied && replied.text) return { text: replied.text, fromBot: replied.from?.is_bot === true };
    return undefined;
}

async function buildReplyRecordContext(ctx: import('telegraf').Context): Promise<{
    replyToExpenseId?: number;
    replyTarget?: import('./services/incomeService').ReplyRecordTarget;
    /** Replying to the receipt item list: the answer belongs to meal even if its chat was reset. */
    replyToReceiptList?: boolean;
    promptHint: string;
}> {
    const reply = getReplyToMessage(ctx);
    if (!reply) return { promptHint: '' };
    const replyText = reply.text;
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
    if (!target) {
        if (!reply.fromBot) return { promptHint: '' };
        // A bot question with no record id (the receipt item list): quote it, so the answer
        // ("all eat by me", "2 person eat") still makes sense to a fresh specialist chat.
        return {
            replyToReceiptList: isReceiptMealQuestion(replyText),
            promptHint: `\n[REPLY CONTEXT] User is replying to your earlier message:\n"""\n${replyText}\n"""`,
        };
    }

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

/** "…?" or a question phrased as a request ("Please clarify which items…."). */
function isClarifyingQuestion(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.endsWith('?') || /^(?:please\s+)?(?:clarify|specify|confirm|let me know)\b/im.test(trimmed);
}

async function runChatTurn(
    chat: ChatSession,
    ctx: import('telegraf').Context,
    prompt: string | (string | Record<string, unknown>)[],
    userId: number,
    toolOptions?: import('./tools/toolHandler').ToolCallOptions,
    allowedTools?: Set<string>
): Promise<'complete' | 'awaiting_input'> {
    const result = await chat.sendMessage(prompt as MessageRequest);
    const response = result.response;
    const rawCalls = response.functionCalls();
    console.log(
        '🤖 AI Intent:',
        rawCalls ? `Calling Tools: ${rawCalls.map((c) => c.name).join(', ')}` : 'Just Chatting'
    );

    if (rawCalls && rawCalls.length > 0) {
        // Gemini and Claude expect ONE follow-up turn carrying a functionResponse for every call.
        // Handlers each send their own, which breaks the 2nd+ call of a multi-call turn
        // (400 → "Sorry, I encountered an error") and makes even a single log_* call
        // wait a full model round trip before the user sees the confirmation. Buffer
        // them and send once after every user-facing reply has gone out, unless a
        // handler needs the model's follow-up text to answer the user.
        // ponytail: a turn that includes a reply-reading tool still sends per call;
        // upgrade path = handlers return their response instead of sending it.
        const pendingResponses: (string | Part)[] = [];
        const deferResponses = !rawCalls.some((c) =>
            TOOLS_READING_MODEL_REPLY.has(resolveToolName(c.name))
        );
        const turnChat: ChatSession = {
            sendMessage: async (request: MessageRequest) => {
                // A follow-up instruction is a plain string; spreading it would push one part per character.
                pendingResponses.push(...(typeof request === 'string' ? [request] : request));
                if (deferResponses) return { response: { text: () => '', functionCalls: () => undefined } };
                return chat.sendMessage(pendingResponses.splice(0));
            },
        };

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
        const expenseSkipCollector: import('./services/expenseService').SkippedExpense[] = [];
        const workoutBatchSessionId = shouldBatchWorkouts ? randomUUID() : undefined;
        const tripLookup = new TripLookup();

        for (const call of functionCalls) {
            const callOptions = { ...toolOptions, tripLookup };
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
                callOptions.expenseSkipCollector = expenseSkipCollector;
            }
            const toolResult = await runToolWithoutReplay(ctx, () => handleToolCall(call, turnChat, ctx, callOptions));
            if (toolResult === 'awaiting_input') {
                awaiting = true;
            }
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
        if (expenseBatchCollector.length + expenseSkipCollector.length > 0) {
            await replyInChunks(
                ctx,
                formatBulkExpenseLogReply(expenseBatchCollector, expenseSkipCollector)
            );
        }

        if (pendingResponses.length > 0) {
            // History bookkeeping only — every log above already replied to the user,
            // which is why this send comes last instead of blocking those replies.
            await chat.sendMessage(pendingResponses).catch((err) => {
                console.warn('Deferred functionResponse send failed:', err);
            });
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
        return isClarifyingQuestion(aiText) ? 'awaiting_input' : 'complete';
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

/**
 * No specialist was picked (the SKIP_PLANNER heuristics, or the planner said chat). The planner
 * model answers with route_request: when that names specialists, they are returned for the caller
 * to run (the heuristics missed the message; no extra model call). Otherwise this replies itself
 * and returns [].
 */
async function handleChatOnly(
    ctx: import('telegraf').Context,
    contextPrompt: string
): Promise<SpecialistDomain[]> {
    let result;
    try {
        const chat = plannerModel.startChat();
        result = await chat.sendMessage(contextPrompt);
    } catch (error) {
        if (!isRetryableAiError(error)) throw error;
        const heavyChat = createPlannerModel({ heavy: true }).startChat();
        result = await heavyChat.sendMessage(contextPrompt);
    }
    const routed = filterSpecialistDomains(plannerRouteDomains(result.response.functionCalls()) ?? []);
    if (routed.length > 0) {
        console.log('🧭 Chat fallback → planner routed:', routed.join(', '));
        return routed;
    }
    const aiText = result.response.text();
    if (aiText?.trim()) {
        await ctx.reply(aiText);
    } else {
        await ctx.reply(
            'How can I help? I can log expenses, meals, workouts, or calendar events.'
        );
    }
    return [];
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
    const trackedReceipt = receiptContext.getStore();
    const receiptFoodReply = trackedReceipt?.followup && isReceiptFoodSelection(textForContext);
    const contextPrompt = buildContextPrompt(textForContext) +
        (receiptFoodReply ? '\n[REPLY CONTEXT] Food selection for the persisted receipt; not an expense correction.' : replyCtx.promptHint) +
        receiptPromptHint();
    const mergedToolOptions: import('./tools/toolHandler').ToolCallOptions = {
        ...toolOptions,
        replyToExpenseId: receiptFoodReply ? undefined : replyCtx.replyToExpenseId,
        replyTarget: receiptFoodReply ? undefined : replyCtx.replyTarget,
    };

    // A pinned (awaiting-input) session catches bare answers, but a message whose keywords
    // all belong to other domains (a gym log while meal awaits a receipt answer) is not an
    // answer: unpin so normal routing runs instead of the pinned specialist refusing it.
    if (
        !options?.forceDomains &&
        !replyCtx.replyTarget &&
        session.awaitingInput &&
        session.activeDomain &&
        breaksAwaitingPin(textForContext, session.activeDomain)
    ) {
        console.log(`🧭 Awaiting ${session.activeDomain}, but message signals another domain — unpinned`);
        session.awaitingInput = false;
        session.activeDomain = undefined;
    }

    let domains: import('./routing/router').RouteDomain[];
    if (options?.forceDomains) {
        domains = options.forceDomains;
    } else if (receiptFoodReply) {
        domains = ['meal'];
    } else if (replyCtx.replyTarget) {
        // Replying to a confirmation ("edit date to yesterday") carries no keywords
        // for the router—the record type alone says who owns the correction.
        domains = [REPLY_TARGET_DOMAIN[replyCtx.replyTarget.type]];
        console.log(`🧭 Reply to ${replyCtx.replyTarget.type} #${replyCtx.replyTarget.id} →`, domains[0]);
    } else if (replyCtx.replyToReceiptList) {
        domains = ['meal'];
        console.log('🧭 Reply to receipt item list → meal');
    } else if (session.awaitingInput && session.activeDomain) {
        console.log('🧭 Awaiting input →', session.activeDomain);
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

    let specialists = filterSpecialistDomains(domains);
    if (specialists.length === 0) {
        specialists = await handleChatOnly(ctx, contextPrompt);
        if (specialists.length === 0) {
            userSessions.delete(userId);
            return;
        }
    }

    // A bare photo with no price/payment text is ambiguous—could be a receipt or
    // just a plate of food—so both specialists run. If expense finds no price to
    // log, it should stay quiet rather than ask "was this purchased?" on every
    // meal photo; meal already owns that case.
    const suppressExpenseNoOp =
        mediaParts.length > 0 &&
        specialists.includes('expense') &&
        specialists.includes('meal') &&
        !hasMoneySignal(textForContext);

    // Only the expense specialist needs trip dates/currencies (to read "32k" as VND etc.).
    const tripHint = specialists.includes('expense') ? await buildTripContextHint(klIsoDate()) : '';
    // Active unit trust names for invest_in_fund / withdraw_from_fund (expense) and add_fixed_expense (financeConfig).
    const holdingsHints = await buildHoldingsContextHints(specialists);

    // Routing sees only the follow-up text and saved context: reattaching the original
    // image must not turn it into a new expense+meal media submission.
    let specialistMedia = mediaParts;
    if (trackedReceipt?.followup &&
        specialists.some(domain => domain === 'meal' || domain === 'expense')) {
        try {
            const buffer = await fetchTelegramFile(trackedReceipt.receipt.fileId);
            specialistMedia = [...mediaParts, await buildFilePart(buffer, trackedReceipt.receipt.mimeType)];
        } catch (error) {
            console.warn('Original receipt media unavailable; using saved record context', error);
            specialistMedia = [...mediaParts, '[Original receipt media unavailable. Use saved records; ask if item numbers or missing items cannot be identified.]'];
        }
    }

    // Each specialist has its own chat session and replies independently, so run
    // them concurrently — a food-photo turn (expense + meal) costs one turn of
    // latency instead of two. Reply order between domains is no longer guaranteed.
    const runSpecialist = async (
        domain: SpecialistDomain
    ): Promise<'complete' | 'awaiting_input'> => {
        const domainPrompt =
            (domain === 'expense' ? contextPrompt + tripHint : contextPrompt) + (holdingsHints[domain] ?? '');
        const specialistParts =
            specialistMedia.length > 0 && (domain === 'meal' || domain === 'expense')
                ? [...specialistMedia, domainPrompt]
                : mediaParts.length > 0 ? [...mediaParts, domainPrompt] : domainPrompt;
        const heavy = options?.heavy && domain === 'expense';
        const domainToolOptions =
            domain === 'expense' && suppressExpenseNoOp
                ? { ...mergedToolOptions, suppressNoOpReply: true }
                : mergedToolOptions;
        try {
            return await runDomainTurn(
                domain,
                ctx,
                specialistParts,
                userId,
                session,
                domainToolOptions,
                heavy
            );
        } catch (error) {
            if (!isRetryableAiError(error) || hasAttemptedTool(ctx)) throw error;
            console.log(
                `🧭 ${domain} (${heavy ? 'heavy' : 'lite'}) overloaded — retrying with ${heavy ? 'lite' : 'heavy'} model`
            );
            delete session.chats[domain];
            return runDomainTurn(
                domain,
                ctx,
                specialistParts,
                userId,
                session,
                domainToolOptions,
                !heavy
            );
        }
    };

    // allSettled so one overloaded specialist can't cancel another's in-flight log;
    // the first failure still surfaces to the caller's error reply afterwards.
    const results = await Promise.allSettled(specialists.map(runSpecialist));
    const failure = results.find(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
    );
    if (failure) throw failure.reason;

    let anyAwaiting = false;
    let awaitDomain: SpecialistDomain | undefined;
    results.forEach((result, i) => {
        if (result.status === 'fulfilled' && result.value === 'awaiting_input') {
            anyAwaiting = true;
            awaitDomain = specialists[i];
        }
    });

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
        if (await handleQuickLogText(ctx, userMessage)) return;
        if (userMessage.trim() === SUGGEST_WORKOUT_BUTTON) {
            await routeAndExecute(ctx, userId, SUGGEST_WORKOUT_REQUEST, [], {}, { forceDomains: ['workout'] });
            return;
        }
        await routeAndExecute(ctx, userId, userMessage);
    } catch (error: unknown) {
        console.error('Error:', error);
        if (hasAttemptedTool(ctx)) {
            await ctx.reply(INTERRUPTED_MESSAGE_REPLY);
            return;
        }
        if (isRetryableAiError(error)) {
            await ctx.reply(
                '⏳ The AI service is overloaded right now (tried both models and it\'s still down). Please try again in a bit.'
            );
        } else if (isRateLimitAiError(error)) {
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
        const imagePart = await buildFilePart(photoBuffer, 'image/jpeg');
        const caption = ctx.message.caption || '';

        await routeAndExecute(ctx, ctx.from.id, caption, [imagePart], {
            photoFileId: photo.file_id,
            photoBuffer,
            photoMimeType: 'image/jpeg',
            userCaption: caption,
        });
    } catch (error) {
        console.error('Error processing image:', error);
        if (hasAttemptedTool(ctx)) {
            await ctx.reply(INTERRUPTED_MESSAGE_REPLY);
            return;
        }
        if (isRetryableAiError(error)) {
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
        const audioPart = await buildFilePart(audioBuffer, 'audio/ogg');
        if (VOICE_NEEDS_TRANSCRIPT) {
            if (!process.env.GEMINI_API_KEY) {
                await ctx.reply('Voice notes need GEMINI_API_KEY (used to transcribe them for Claude). Please type it instead.');
                return;
            }
            const transcript = await transcribeVoice(audioPart);
            if (!transcript) {
                await ctx.reply("Sorry, I couldn't hear that clearly.");
                return;
            }
            console.log('🎙️ Voice transcript:', transcript);
            await routeAndExecute(ctx, ctx.from.id, transcript, [], { isVoiceInput: true });
            return;
        }
        const voiceHint =
            '\nListen to this audio command and execute the appropriate tool. ' +
            "Use today's date from SYSTEM CONTEXT when logging meals or expenses unless the user specifies another date.";

        await routeAndExecute(ctx, ctx.from.id, voiceHint, [audioPart], {
            isVoiceInput: true,
        });
    } catch (error) {
        console.error('Error processing voice:', error);
        if (hasAttemptedTool(ctx)) {
            await ctx.reply(INTERRUPTED_MESSAGE_REPLY);
            return;
        }
        if (isRetryableAiError(error)) {
            await ctx.reply(
                '⏳ The AI service is overloaded right now. Please try sending the voice message again in a bit.'
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
        const filePart = await buildFilePart(fileBuffer, mimeType);
        const userCaption = ctx.message.caption || '';
        const userId = ctx.from.id;

        if (mimeType === 'application/pdf') {
            const replyCtx = await buildReplyRecordContext(ctx);
            const contextPrompt =
                buildContextPrompt(userCaption) +
                replyCtx.promptHint +
                '\n' +
                documentExpensePrompt;
            const chat = createDomainModel('expense', { heavy: true }).startChat();
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
                if (isRetryableAiError(error) && !hasAttemptedTool(ctx)) {
                    const fallbackChat = createDomainModel('expense').startChat();
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
        if (hasAttemptedTool(ctx)) {
            await ctx.reply(INTERRUPTED_MESSAGE_REPLY);
            return;
        }
        if (isRetryableAiError(error)) {
            await ctx.reply(
                '⏳ The AI service is overloaded right now (tried both models and it\'s still down). Please try again in a bit.'
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

async function buildFilePart(buffer: Buffer, mimeType: string) {
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

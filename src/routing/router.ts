import { GoogleGenerativeAI, ChatSession, FunctionCall } from '@google/generative-ai';
import {
    createDomainModel,
    createPlannerModel,
    startChatWithRetry,
    isRetryableGeminiError,
} from '../config/gemini';
import { getPaymentSignalTerms, type PaymentSignalTerms } from '../config/paymentMethods';
import { RouteDomain, SpecialistDomain } from '../config/prompts';

const VALID_DOMAINS: RouteDomain[] = ['expense', 'financeConfig', 'meal', 'calendar', 'workout', 'chat'];
const SPECIALIST_DOMAINS: SpecialistDomain[] = ['expense', 'financeConfig', 'meal', 'calendar', 'workout'];

export interface UserChatState {
    chats: Partial<Record<SpecialistDomain, ChatSession>>;
    /** domainChatsGeneration when `chats` were built; see invalidateDomainChats. */
    chatsGeneration?: number;
    activeDomain?: SpecialistDomain;
    awaitingInput: boolean;
    turnCount: number;
    lastActiveAt: number;
}

export interface RouteOptions {
    userId: number;
    session?: UserChatState;
    genAI: GoogleGenerativeAI;
    plannerModel: import('@google/generative-ai').GenerativeModel;
    defaultModel: import('@google/generative-ai').GenerativeModel;
    heavyModel: import('@google/generative-ai').GenerativeModel;
}

function parseDomains(raw: unknown): RouteDomain[] {
    if (!Array.isArray(raw)) return ['chat'];
    const domains = raw.filter(
        (d): d is RouteDomain => typeof d === 'string' && VALID_DOMAINS.includes(d as RouteDomain)
    );
    return domains.length > 0 ? domains : ['chat'];
}

/** Domains named by a planner response's route_request call, or null when it made none. */
export function plannerRouteDomains(functionCalls: FunctionCall[] | undefined): RouteDomain[] | null {
    const routeCall = functionCalls?.find((c) => c.name === 'route_request');
    return routeCall ? parseDomains((routeCall.args as { domains?: unknown }).domains) : null;
}

const PRICE_SIGNAL =
    /\brm\s*\d|\bmyr\s*\d|\d+\s*(?:rm|myr)\b|\$\s*\d/i;
// Travel prices: "32k", "1.2mil", "2tr" (VND) — but not distances ("5k run", "ran 10k", "5km").
const K_AMOUNT_SIGNAL =
    /(?<!\b(?:ran|run|jog|jogged|walk|walked|cycled|rode)\s{1,3})\b\d+(?:[.,]\d+)?\s*(?:k|mil|tr)\b(?!\s*(?:run|jog|walk|race|steps?)\b)/i;
const FOREIGN_PRICE_SIGNAL =
    /\b\d[\d.,]*\s*(?:vnd|usd|sgd|thb|idr|jpy|krw|twd|cny|rmb|hkd|eur|gbp|aud|php)\b|\b(?:vnd|usd|sgd|thb|idr|jpy|krw|twd|cny|rmb|hkd|eur|gbp|aud|php)\s*\d|\d\s*[₫đ฿€£]/i;
const PAYMENT_SIGNAL =
    /\b(tng|touch\s*(?:n|and|&)\s*go|touchngo|grabpay|shopeepay|cimb|maybank|cash|credit\s*card)\b/i;
// A payment word with no known account ("paid with boost wallet", "lunch 15 by card") still means a
// spend: expense must see it, so log_expense can ask which account (3.2) instead of it being dropped.
const GENERIC_PAYMENT_SIGNAL =
    /\b(?:paid|pay(?:ing)?\s+(?:with|by|using|via|through)|e-?wallet|wallet|card)\b/i;
// Account-name words too common to mean that account on their own ("later" in ShopeePay Later,
// "world" in RHB World Card); the full account name still counts.
const COMMON_ACCOUNT_WORDS = new Set([
    'account', 'bank', 'con', 'credit', 'current', 'fix', 'fixed', 'funding', 'later', 'mutual',
    'public', 'savings', 'semi', 'societies', 'the', 'world',
]);

let accountSignalSource: PaymentSignalTerms | undefined;
let accountSignal: RegExp | null = null;

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * "Names a payment account": an account name (active or deactivated, so the 3.2 guard can ask about
 * it), a nickname, or a distinctive 3+ letter word of an account name ("rhb", "uob"). Rebuilt when
 * the payment-account cache reloads, so an account added on the Dashboard routes without a restart.
 */
function accountPaymentSignal(): RegExp | null {
    const terms = getPaymentSignalTerms();
    if (terms === accountSignalSource) return accountSignal;
    accountSignalSource = terms;
    const alternatives = new Set<string>();
    for (const phrase of [...terms.accountNames, ...terms.nicknames]) {
        const words = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean);
        if (words.join('').length >= 3) alternatives.add(words.map(escapeRegExp).join('\\s*'));
    }
    for (const name of terms.accountNames) {
        for (const word of name.toLowerCase().split(/[^a-z0-9]+/)) {
            if (/^[a-z][a-z0-9]{2,}$/.test(word) && !COMMON_ACCOUNT_WORDS.has(word)) alternatives.add(word);
        }
    }
    accountSignal =
        alternatives.size > 0
            ? new RegExp(`(?<![a-z0-9])(?:${[...alternatives].join('|')})(?![a-z0-9])`, 'i')
            : null;
    return accountSignal;
}

// Words that only signal food when no specific dish/nutrition term is present —
// "dinner"/"eat" alone is ambiguous with a social plan (see SCHEDULE_SIGNAL below).
// Note: trailing "s?" lets these match plurals too ("meal" must also match "meals").
const GENERIC_MEAL_SIGNAL = /\b(eat|eats|ate|eaten|lunch|dinner|breakfast|supper|snacks?|had)\b/i;
const SPECIFIC_FOOD_SIGNAL =
    /\b(foods?|meals?|proteins?|calories?|macros?|nutrition|nasi|roti|kopi|chicken\s*rice|rice|soups?|noodles?|ramen|burgers?|pizzas?|salads?|smoothies?|drinks?|juices?|coffee|tea|shakes?|milkshakes?|latte|boba|waffles?|bread|cakes?|whey|scoops?)\b|myprotein/i;
const BODY_WEIGHT_SIGNAL = /\b(weigh[- ]?in|weight)\b/i;
const WORKOUT_SIGNAL =
    /\b(gym|workout|exercise|training|bench|squat|deadlift|press|reps?|sets?|\d+\s*[x×]\s*\d+|cardio|run|jog|steps?)\b/i;
const CALENDAR_SIGNAL =
    /\b(meeting|calendar|schedule|reschedule|postpone|cancel\s+(?:the\s+)?(?:meeting|event)|am i free|event|appointment)\b/i;
// A future-date reference plus a clock time (e.g. "next Tuesday ... 7-8pm") means the
// user is planning something, not logging a meal that already happened or is happening now.
const FUTURE_DATE_SIGNAL =
    /\b(next\s+(?:mon|tue|wed|thu|fri|sat|sun)\w*|this\s+(?:mon|tue|wed|thu|fri|sat|sun)\w*|tomorrow|tmr|tmrw)\b/i;
const TIME_EXPR_SIGNAL =
    /\b\d{1,2}(?::\d{2})?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;
// "add a monthly RM500 StashAway investment" is a fixed bill; a bare "monthly" is not ("monthly spending").
const FINANCE_CONFIG_SIGNAL =
    /\b(fixed (?:expenses?|bills?)|recurring (?:bills?|expenses?|payments?|interest)|quarterly bills?|yearly bills?|interest schedule|automate interest|schedule.*interest|budgets?|(?:add|set\s*up|create|new)\s+(?:an?\s+)?(?:monthly|quarterly|yearly|annual))\b/i;
// "how many calories did I burn" asks for calories burned (workouts + steps + BMR): workout, not food.
const BURN_SIGNAL = /\bburn(?:s|ed|t|ing)?\b/i;
// Profile stats for BMR ("I'm 175cm, 30, male"): update_user_settings, which meal owns.
const PROFILE_SIGNAL = /\b[12]\d{2}\s*cm\b|\bheight\b|\byears?\s+old\b|\b(?:male|female)\b/i;
// Spending questions and top-ups that name no price ("how much did I spend in Vietnam", "Danang trip
// summary", "topped up 200 public mutual"). Not "how much" alone: "how much protein" is meal.
const SPENDING_SIGNAL =
    /\bspen(?:d|ds|t|ding)\b(?!\s+(?:time|the\s+(?:day|night|weekend)))|\btrip\s+summary\b|\btop(?:ped|ping)?[- ]?ups?\b/i;
// Trip setup and currency exchanges, which may name no price ("exchanged 500 ringgit to dong",
// "create trip Bali 1-5 Nov"): expense owns log_currency_exchange and create_trip.
const TRIP_SIGNAL = /\b(?:exchange|exchanged|money\s*changer|(?:new|create)\s+(?:a\s+)?trip)\b/i;

function hasPriceSignal(text: string): boolean {
    return PRICE_SIGNAL.test(text) || K_AMOUNT_SIGNAL.test(text) || FOREIGN_PRICE_SIGNAL.test(text);
}

/** Whether the text itself names a price or payment method (vs. relying on an image to supply one). */
export function hasMoneySignal(text: string): boolean {
    return (
        hasPriceSignal(text) ||
        PAYMENT_SIGNAL.test(text) ||
        GENERIC_PAYMENT_SIGNAL.test(text) ||
        (accountPaymentSignal()?.test(text) ?? false)
    );
}

/** A line that is only a date: "26/09/2026", "26/9", "26-09-2026:". */
const DATE_HEADER_LINE = /^\s*\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\s*:?\s*$/;

/**
 * A typed spending list (e.g. a trip log): 3+ priced lines plus a date header or
 * travel-style amounts. Its coffee/beer lines are purchases, not meals, so only
 * expense should see it. A plain "breakfast rm8 / lunch rm12 / dinner rm10" still
 * reaches meal as before.
 */
export function isExpenseLedger(text: string): boolean {
    const lines = text.split(/\r?\n/);
    if (lines.filter(hasPriceSignal).length < 3) return false;
    return (
        lines.some((line) => DATE_HEADER_LINE.test(line)) ||
        K_AMOUNT_SIGNAL.test(text) ||
        FOREIGN_PRICE_SIGNAL.test(text)
    );
}

/** If text has price/payment, drop chat and ensure expense is included (unless financeConfig already owns it — setup, not a logged transaction). */
export function applyMoneyRoutingHints(text: string, domains: RouteDomain[]): RouteDomain[] {
    if (domains.includes('financeConfig')) return domains;
    if (isExpenseLedger(text)) return ['expense'];
    if (!hasMoneySignal(text)) return domains;
    const next = domains.filter((d) => d !== 'chat');
    if (!next.includes('expense')) next.push('expense');
    return next.length > 0 ? next : ['expense'];
}

/**
 * Keyword routing when SKIP_PLANNER is on.
 * ponytail: regex heuristics miss ambiguous phrasing; upgrade path = restore planner or a tiny classifier.
 */
export function routeByHeuristics(text: string, hasMedia: boolean): RouteDomain[] {
    if (FINANCE_CONFIG_SIGNAL.test(text)) {
        console.log('🧭 Heuristic routed: financeConfig');
        return ['financeConfig'];
    }

    const domains: RouteDomain[] = [];
    const push = (d: RouteDomain) => {
        if (!domains.includes(d)) domains.push(d);
    };

    const hasScheduleSignal = FUTURE_DATE_SIGNAL.test(text) && TIME_EXPR_SIGNAL.test(text);

    if (hasMoneySignal(text) || TRIP_SIGNAL.test(text) || SPENDING_SIGNAL.test(text)) push('expense');
    const asksBurn = BURN_SIGNAL.test(text);
    // With "burn", "calories" is energy burned, not food: it alone doesn't bring in meal.
    const foodText = asksBurn ? text.replace(/\bcalories?\b/gi, ' ') : text;
    if (SPECIFIC_FOOD_SIGNAL.test(foodText) || BODY_WEIGHT_SIGNAL.test(text) || PROFILE_SIGNAL.test(text)) {
        push('meal');
    } else if (GENERIC_MEAL_SIGNAL.test(text) && !hasScheduleSignal) {
        push('meal');
    }
    // "set my weight to 80kg" is a weigh-in, not workout sets: only meal saves it.
    const workoutText = BODY_WEIGHT_SIGNAL.test(text) ? text.replace(/\bsets?\b/gi, ' ') : text;
    if (WORKOUT_SIGNAL.test(workoutText) || asksBurn) push('workout');
    if (CALENDAR_SIGNAL.test(text) || hasScheduleSignal) push('calendar');
    // Caption-only regex can't see the photo, so a payment-note caption on a
    // food photo (e.g. "tng rm14") would otherwise miss the meal log entirely.
    // Mirrors the planner's own instruction: expense (+ meal if food outlet).
    if (hasMedia && domains.includes('expense')) push('meal');

    let next = applyMoneyRoutingHints(text, domains);
    if (filterSpecialistDomains(next).length === 0 && hasMedia) {
        // Bare photo, no caption signal: could be a receipt or a plate of food—
        // let both specialists look. Meal ignores non-food images; expense ignores
        // images with no visible price.
        next = ['expense', 'meal'];
    }
    if (next.length === 0) next = ['chat'];

    console.log('🧭 Heuristic routed:', next.join(', '));
    return next;
}

export async function routeMessage(
    prompt: string | (string | Record<string, unknown>)[],
    options: RouteOptions
): Promise<RouteDomain[]> {
    const { session, plannerModel, genAI } = options;

    if (session?.awaitingInput && session.activeDomain) {
        return [session.activeDomain];
    }

    let result;
    try {
        const chat = startChatWithRetry(plannerModel);
        result = await chat.sendMessage(prompt as Parameters<ChatSession['sendMessage']>[0]);
    } catch (error) {
        if (!isRetryableGeminiError(error)) throw error;
        console.log('🧭 Planner (lite) overloaded — retrying with heavy model');
        const heavyChat = startChatWithRetry(createPlannerModel(genAI, { heavy: true }), 0);
        result = await heavyChat.sendMessage(prompt as Parameters<ChatSession['sendMessage']>[0]);
    }
    const domains = plannerRouteDomains(result.response.functionCalls());
    if (domains) {
        console.log('🧭 Planner routed:', domains.join(', '));
        return domains;
    }

    console.log('🧭 Planner chat fallback → chat');
    return ['chat'];
}

let domainChatsGeneration = 0;

/**
 * A domain chat keeps the tool descriptions and prompt (account and category names) it was built
 * with. Call when those names change: each session drops its cached domain chats on its next
 * getOrCreateDomainChat, except the chat awaiting the user's answer, which keeps its context.
 */
export function invalidateDomainChats(): void {
    domainChatsGeneration++;
}

export function getOrCreateDomainChat(
    state: UserChatState,
    domain: SpecialistDomain,
    options: RouteOptions & { heavy?: boolean }
): ChatSession {
    if (state.chatsGeneration !== domainChatsGeneration) {
        const pendingDomain = state.awaitingInput ? state.activeDomain : undefined;
        const pendingChat = pendingDomain ? state.chats[pendingDomain] : undefined;
        state.chats = pendingDomain && pendingChat ? { [pendingDomain]: pendingChat } : {};
        state.chatsGeneration = domainChatsGeneration;
    }
    const existing = state.chats[domain];
    if (existing) return existing;

    const model = createDomainModel(options.genAI, domain, {
        heavy: options.heavy,
    });
    const chat = startChatWithRetry(model);
    state.chats[domain] = chat;
    return chat;
}

export function getOrCreateSession(
    userId: number,
    sessions: Map<number, UserChatState>,
    minTurns: number,
    maxTurns: number,
    ttlMs: number
): UserChatState {
    const now = Date.now();
    const existing = sessions.get(userId);

    if (existing) {
        const idle = now - existing.lastActiveAt;
        const expiredByTtl = idle > ttlMs && existing.turnCount >= minTurns;
        if (expiredByTtl || existing.turnCount >= maxTurns) {
            sessions.delete(userId);
        } else {
            existing.turnCount++;
            existing.lastActiveAt = now;
            return existing;
        }
    }

    const state: UserChatState = {
        chats: {},
        chatsGeneration: domainChatsGeneration,
        awaitingInput: false,
        turnCount: 1,
        lastActiveAt: now,
    };
    sessions.set(userId, state);
    return state;
}

export function filterSpecialistDomains(domains: RouteDomain[]): SpecialistDomain[] {
    return domains.filter((d): d is SpecialistDomain =>
        SPECIALIST_DOMAINS.includes(d as SpecialistDomain)
    );
}

export type { RouteDomain, SpecialistDomain };

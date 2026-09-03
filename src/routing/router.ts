import { GoogleGenerativeAI, ChatSession } from '@google/generative-ai';
import { createDomainModel } from '../config/gemini';
import { RouteDomain, SpecialistDomain } from '../config/prompts';

const VALID_DOMAINS: RouteDomain[] = ['expense', 'financeConfig', 'meal', 'calendar', 'workout', 'chat'];
const SPECIALIST_DOMAINS: SpecialistDomain[] = ['expense', 'financeConfig', 'meal', 'calendar', 'workout'];

export interface UserChatState {
    chats: Partial<Record<SpecialistDomain, ChatSession>>;
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

const PRICE_SIGNAL =
    /\brm\s*\d|\bmyr\s*\d|\d+\s*(?:rm|myr)\b|\$\s*\d/i;
const PAYMENT_SIGNAL =
    /\b(tng|touch\s*(?:n|and|&)\s*go|touchngo|grabpay|shopeepay|cimb|maybank|cash|credit\s*card)\b/i;

// Words that only signal food when no specific dish/nutrition term is present —
// "dinner"/"eat" alone is ambiguous with a social plan (see SCHEDULE_SIGNAL below).
const GENERIC_MEAL_SIGNAL = /\b(eat|ate|eaten|lunch|dinner|breakfast|supper|snack|had)\b/i;
const SPECIFIC_FOOD_SIGNAL =
    /\b(food|meal|protein|calorie|macro|nutrition|nasi|roti|kopi|chicken\s*rice|rice|soup|noodle|ramen|burger|pizza|salad)\b/i;
const BODY_WEIGHT_SIGNAL = /\b(weigh[- ]?in|weight)\b/i;
const WORKOUT_SIGNAL =
    /\b(gym|workout|exercise|training|bench|squat|deadlift|press|reps?|sets?|\d+\s*[x×]\s*\d+|cardio|run|jog)\b/i;
const CALENDAR_SIGNAL =
    /\b(meeting|calendar|schedule|reschedule|postpone|cancel\s+(?:the\s+)?(?:meeting|event)|am i free|event|appointment)\b/i;
// A future-date reference plus a clock time (e.g. "next Tuesday ... 7-8pm") means the
// user is planning something, not logging a meal that already happened or is happening now.
const FUTURE_DATE_SIGNAL =
    /\b(next\s+(?:mon|tue|wed|thu|fri|sat|sun)\w*|this\s+(?:mon|tue|wed|thu|fri|sat|sun)\w*|tomorrow|tmr|tmrw)\b/i;
const TIME_EXPR_SIGNAL =
    /\b\d{1,2}(?::\d{2})?\s*(?:-|–|to)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i;
const FINANCE_CONFIG_SIGNAL =
    /\b(fixed (?:expense|bill)|recurring (?:bill|expense|payment|interest)|quarterly bill|yearly bill|interest schedule|automate interest|schedule.*interest|budgets?)\b/i;

/** If text has price/payment, drop chat and ensure expense is included (unless financeConfig already owns it — setup, not a logged transaction). */
export function applyMoneyRoutingHints(text: string, domains: RouteDomain[]): RouteDomain[] {
    if (domains.includes('financeConfig')) return domains;
    if (!PRICE_SIGNAL.test(text) && !PAYMENT_SIGNAL.test(text)) return domains;
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

    if (PRICE_SIGNAL.test(text) || PAYMENT_SIGNAL.test(text)) push('expense');
    if (SPECIFIC_FOOD_SIGNAL.test(text) || BODY_WEIGHT_SIGNAL.test(text)) {
        push('meal');
    } else if (GENERIC_MEAL_SIGNAL.test(text) && !hasScheduleSignal) {
        push('meal');
    }
    if (WORKOUT_SIGNAL.test(text)) push('workout');
    if (CALENDAR_SIGNAL.test(text) || hasScheduleSignal) push('calendar');
    // Caption-only regex can't see the photo, so a payment-note caption on a
    // food photo (e.g. "tng rm14") would otherwise miss the meal log entirely.
    // Mirrors the planner's own instruction: expense (+ meal if food outlet).
    if (hasMedia && domains.includes('expense')) push('meal');

    let next = applyMoneyRoutingHints(text, domains);
    if (filterSpecialistDomains(next).length === 0 && hasMedia) {
        next = ['expense'];
    }
    if (next.length === 0) next = ['chat'];

    console.log('🧭 Heuristic routed:', next.join(', '));
    return next;
}

export async function routeMessage(
    prompt: string | (string | Record<string, unknown>)[],
    options: RouteOptions
): Promise<RouteDomain[]> {
    const { session, plannerModel } = options;

    if (session?.awaitingInput && session.activeDomain) {
        return [session.activeDomain];
    }

    const chat = plannerModel.startChat();
    const result = await chat.sendMessage(
        prompt as Parameters<ChatSession['sendMessage']>[0]
    );
    const functionCalls = result.response.functionCalls();

    if (functionCalls?.length) {
        const routeCall = functionCalls.find((c) => c.name === 'route_request');
        if (routeCall) {
            const domains = parseDomains((routeCall.args as { domains?: unknown }).domains);
            console.log('🧭 Planner routed:', domains.join(', '));
            return domains;
        }
    }

    console.log('🧭 Planner chat fallback → chat');
    return ['chat'];
}

export function getOrCreateDomainChat(
    state: UserChatState,
    domain: SpecialistDomain,
    options: RouteOptions & { heavy?: boolean }
): ChatSession {
    const existing = state.chats[domain];
    if (existing) return existing;

    const model = createDomainModel(options.genAI, domain, {
        heavy: options.heavy && domain === 'expense',
    });
    const chat = model.startChat();
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

export function updateSessionState(
    sessions: Map<number, UserChatState>,
    userId: number,
    updates: Partial<Pick<UserChatState, 'awaitingInput' | 'activeDomain'>>
) {
    const state = sessions.get(userId);
    if (state) {
        Object.assign(state, updates);
        state.lastActiveAt = Date.now();
    }
}

export type { RouteDomain, SpecialistDomain };

import { GoogleGenerativeAI, ChatSession } from '@google/generative-ai';
import { createDomainModel } from '../config/gemini';
import { RouteDomain, SpecialistDomain } from '../config/prompts';

const VALID_DOMAINS: RouteDomain[] = ['expense', 'meal', 'calendar', 'workout', 'chat'];
const SPECIALIST_DOMAINS: SpecialistDomain[] = ['expense', 'meal', 'calendar', 'workout'];

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

/** If text has price/payment, drop chat and ensure expense is included. */
export function applyMoneyRoutingHints(text: string, domains: RouteDomain[]): RouteDomain[] {
    if (!PRICE_SIGNAL.test(text) && !PAYMENT_SIGNAL.test(text)) return domains;
    const next = domains.filter((d) => d !== 'chat');
    if (!next.includes('expense')) next.push('expense');
    return next.length > 0 ? next : ['expense'];
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

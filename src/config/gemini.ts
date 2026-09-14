import { GoogleGenerativeAI, GenerativeModel, ChatSession } from '@google/generative-ai';
import { buildPlannerInstruction, buildDomainInstruction, SpecialistDomain } from './prompts';
import { getExpenseCategoryNames } from './expenseCategories';
import { getDomainDeclarations, getPlannerDeclarations } from '../tools/tools';

export const GEMINI_MODEL_DEFAULT =
    process.env.GEMINI_MODEL_DEFAULT || 'gemini-3.5-flash-lite';
export const GEMINI_MODEL_HEAVY =
    process.env.GEMINI_MODEL_HEAVY || 'gemini-3.5-flash';

/** Skip Gemini planner; route with keyword heuristics instead. */
export const SKIP_PLANNER = /^(1|true|yes)$/i.test(
    (process.env.SKIP_PLANNER || '').trim()
);

const generationConfig = {
    maxOutputTokens: 2048,
    temperature: 0.1,
};

/**
 * A hung request during a Gemini outage can otherwise sit until Telegraf's own
 * 90s handler timeout kills the whole update with no reply to the user. Fail
 * faster so our own retry/heavy-model fallback gets a chance to run instead.
 */
const requestOptions = { timeout: 20_000 };

export function createPlannerModel(
    genAI: GoogleGenerativeAI,
    options?: { heavy?: boolean }
): GenerativeModel {
    return genAI.getGenerativeModel(
        {
            model: options?.heavy ? GEMINI_MODEL_HEAVY : GEMINI_MODEL_DEFAULT,
            generationConfig,
            tools: [{ functionDeclarations: getPlannerDeclarations() }],
            systemInstruction: buildPlannerInstruction(),
        },
        requestOptions
    );
}

export function createDomainModel(
    genAI: GoogleGenerativeAI,
    domain: SpecialistDomain,
    options?: { heavy?: boolean }
): GenerativeModel {
    const categoryNames = getExpenseCategoryNames();
    const modelName = options?.heavy ? GEMINI_MODEL_HEAVY : GEMINI_MODEL_DEFAULT;
    return genAI.getGenerativeModel(
        {
            model: modelName,
            generationConfig,
            tools: [{ functionDeclarations: getDomainDeclarations(domain) }],
            systemInstruction: buildDomainInstruction(domain, categoryNames),
        },
        requestOptions
    );
}

/** Transient Gemini failures worth a retry — capacity/overload/timeout, not a bad request. */
export function isRetryableGeminiError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    return /\b503\b|Service Unavailable|high demand|overloaded|request aborted|timed? ?out/i.test(
        msg
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * gemini-3.5-flash-lite returns 503 "high demand" fairly often. Wrap sendMessage
 * with one short retry before letting the error bubble up to model-fallback logic.
 * Kept small (1 retry, 20s request timeout each) so a full-outage worst case still
 * lands well under Telegraf's 90s handler timeout instead of stacking past it.
 */
export function wrapChatWithRetry(chat: ChatSession, maxRetries = 1): ChatSession {
    const originalSendMessage = chat.sendMessage.bind(chat);
    chat.sendMessage = (async (...args: Parameters<ChatSession['sendMessage']>) => {
        let lastError: unknown;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await originalSendMessage(...args);
            } catch (error) {
                lastError = error;
                if (attempt === maxRetries || !isRetryableGeminiError(error)) throw error;
                await delay(500 * 2 ** attempt);
            }
        }
        throw lastError;
    }) as ChatSession['sendMessage'];
    return chat;
}

export function startChatWithRetry(model: GenerativeModel, maxRetries = 1): ChatSession {
    return wrapChatWithRetry(model.startChat(), maxRetries);
}

/** @deprecated Use createPlannerModel or createDomainModel */
export function createGeminiModel(
    genAI: GoogleGenerativeAI,
    modelName: string
): GenerativeModel {
    const categoryNames = getExpenseCategoryNames();
    const domain: SpecialistDomain = 'expense';
    return genAI.getGenerativeModel({
        model: modelName,
        generationConfig,
        tools: [{ functionDeclarations: getDomainDeclarations(domain) }],
        systemInstruction: buildDomainInstruction(domain, categoryNames),
    });
}

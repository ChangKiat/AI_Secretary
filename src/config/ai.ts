import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import * as gemini from './gemini';
import * as claude from './claude';
import type { SpecialistDomain } from './prompts';

/**
 * Which model family runs the bot: AI_PROVIDER=claude (Claude Haiku 5.5, ANTHROPIC_API_KEY) or
 * gemini (the default, GEMINI_API_KEY). Both speak the Gemini chat shape below, so the router and
 * tool handlers don't know which one answered.
 */
export type AiProvider = 'gemini' | 'claude';
export const AI_PROVIDER: AiProvider = /^claude$/i.test((process.env.AI_PROVIDER || '').trim())
    ? 'claude'
    : 'gemini';

export const MODEL_DEFAULT =
    AI_PROVIDER === 'claude' ? claude.CLAUDE_MODEL_DEFAULT : gemini.GEMINI_MODEL_DEFAULT;
export const MODEL_HEAVY = AI_PROVIDER === 'claude' ? claude.CLAUDE_MODEL_HEAVY : gemini.GEMINI_MODEL_HEAVY;

/** Skip the planner model; route with keyword heuristics instead. */
export const SKIP_PLANNER = /^(1|true|yes)$/i.test((process.env.SKIP_PLANNER || '').trim());

export interface FunctionCall {
    name: string;
    args: object;
}

export type Part =
    | { text: string }
    | { inlineData: { data: string; mimeType: string } }
    | { functionResponse: { name: string; response: object } };

export type MessageRequest = string | Array<string | Part>;

export interface ModelResponse {
    text(): string;
    functionCalls(): FunctionCall[] | undefined;
}

export interface ChatSession {
    sendMessage(request: MessageRequest): Promise<{ response: ModelResponse }>;
}

export interface ChatModel {
    startChat(): ChatSession;
}

let genAI: GoogleGenerativeAI | undefined;

function getGenAI(): GoogleGenerativeAI {
    genAI ??= new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    return genAI;
}

function geminiChatModel(model: GenerativeModel): ChatModel {
    return { startChat: () => gemini.startChatWithRetry(model) };
}

export function createPlannerModel(options?: { heavy?: boolean }): ChatModel {
    return AI_PROVIDER === 'claude'
        ? claude.createPlannerModel(options)
        : geminiChatModel(gemini.createPlannerModel(getGenAI(), options));
}

export function createDomainModel(domain: SpecialistDomain, options?: { heavy?: boolean }): ChatModel {
    return AI_PROVIDER === 'claude'
        ? claude.createDomainModel(domain, options)
        : geminiChatModel(gemini.createDomainModel(getGenAI(), domain, options));
}

/** Transient failure (overload, timeout, network): the caller retries on the other model. */
export function isRetryableAiError(error: unknown): boolean {
    return claude.isRetryableClaudeError(error) || gemini.isRetryableGeminiError(error);
}

export function isRateLimitAiError(error: unknown): boolean {
    if (claude.isClaudeRateLimitError(error)) return true;
    const msg = error instanceof Error ? error.message : String(error);
    return msg.includes('429 Too Many Requests');
}

/** Claude can't hear audio, so with AI_PROVIDER=claude a voice note is transcribed by Gemini first. */
export const VOICE_NEEDS_TRANSCRIPT = AI_PROVIDER === 'claude';

export async function transcribeVoice(audioPart: Extract<Part, { inlineData: unknown }>): Promise<string> {
    if (!process.env.GEMINI_API_KEY) {
        throw new Error('Voice notes need GEMINI_API_KEY for transcription when AI_PROVIDER=claude');
    }
    const model = getGenAI().getGenerativeModel({ model: gemini.GEMINI_MODEL_DEFAULT }, { timeout: 20_000 });
    const result = await model.generateContent([
        audioPart,
        'Transcribe this voice note word for word. Reply with the transcript only.',
    ]);
    return result.response.text().trim();
}

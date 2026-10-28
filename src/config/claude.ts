import Anthropic from '@anthropic-ai/sdk';
import type { FunctionDeclaration, FunctionDeclarationSchema, Schema } from '@google/generative-ai';
import { buildPlannerInstruction, buildDomainInstruction, SpecialistDomain } from './prompts';
import { getExpenseCategoryNames } from './expenseCategories';
import { getDomainDeclarations, getPlannerDeclarations } from '../tools/tools';
import type { ChatModel, ChatSession, FunctionCall, MessageRequest, ModelResponse } from './ai';

export const CLAUDE_MODEL_DEFAULT = process.env.CLAUDE_MODEL_DEFAULT || 'claude-haiku-5-5';
export const CLAUDE_MODEL_HEAVY = process.env.CLAUDE_MODEL_HEAVY || 'claude-haiku-5-5';

type Effort = NonNullable<Anthropic.OutputConfig['effort']>;
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

function parseEffort(envVal: string | undefined, fallback: Effort): Effort {
    const value = (envVal || '').trim().toLowerCase() as Effort;
    return EFFORTS.includes(value) ? value : fallback;
}

/**
 * Haiku 5.5 always thinks a little; effort is the only dial. Low keeps routine logging fast and
 * cheap; the heavy model (PDF statements, and the fallback after a failed lite call) thinks more.
 */
const EFFORT_DEFAULT = parseEffort(process.env.CLAUDE_EFFORT_DEFAULT, 'low');
const EFFORT_HEAVY = parseEffort(process.env.CLAUDE_EFFORT_HEAVY, 'medium');

/** Thinking counts toward max_tokens, so leave room above the old 2048-token Gemini answers. */
const MAX_TOKENS = 16000;

/**
 * Same budget as gemini.ts: Telegraf kills a handler after 90s, so the lite call fails fast and
 * leaves time for the heavy fallback. The heavy call reads PDFs and writes long bulk-expense lists.
 */
const requestOptions = { timeout: 20_000, maxRetries: 1 };
const heavyRequestOptions = { timeout: 60_000, maxRetries: 0 };

let client: Anthropic | undefined;

/** Built on first use, so AI_PROVIDER=gemini runs without ANTHROPIC_API_KEY. */
function getClient(): Anthropic {
    client ??= new Anthropic();
    return client;
}

/** tools.ts declares Gemini schemas; Claude takes the same shape as plain JSON Schema. */
function toJsonSchema(schema: Schema | FunctionDeclarationSchema): Record<string, unknown> {
    const { type, format, nullable, properties, items, ...rest } = schema as {
        type: string;
        format?: string;
        nullable?: boolean;
        properties?: Record<string, Schema>;
        items?: Schema;
    };
    const out: Record<string, unknown> = { ...rest, type: nullable ? [type, 'null'] : type };
    // Gemini wants format: 'enum' beside enum; JSON Schema has no such format.
    if (format && format !== 'enum') out.format = format;
    if (properties) {
        out.properties = Object.fromEntries(
            Object.entries(properties).map(([key, value]) => [key, toJsonSchema(value)])
        );
    }
    if (items) out.items = toJsonSchema(items);
    return out;
}

function toClaudeTools(declarations: FunctionDeclaration[]): Anthropic.Tool[] {
    return declarations.map((declaration) => ({
        name: declaration.name,
        description: declaration.description,
        input_schema: (declaration.parameters
            ? toJsonSchema(declaration.parameters)
            : { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema,
    }));
}

interface ClaudeModelConfig {
    model: string;
    effort: Effort;
    system: string;
    tools: Anthropic.Tool[];
    requestOptions: { timeout: number; maxRetries: number };
}

function claudeModel(config: ClaudeModelConfig): ChatModel {
    return { startChat: () => new ClaudeChatSession(config) };
}

export function createPlannerModel(options?: { heavy?: boolean }): ChatModel {
    return claudeModel({
        model: options?.heavy ? CLAUDE_MODEL_HEAVY : CLAUDE_MODEL_DEFAULT,
        effort: options?.heavy ? EFFORT_HEAVY : EFFORT_DEFAULT,
        system: buildPlannerInstruction(),
        tools: toClaudeTools(getPlannerDeclarations()),
        requestOptions: options?.heavy ? heavyRequestOptions : requestOptions,
    });
}

/** Like gemini.ts: the account/category names are read now, and index.ts rebuilds on a change. */
export function createDomainModel(domain: SpecialistDomain, options?: { heavy?: boolean }): ChatModel {
    return claudeModel({
        model: options?.heavy ? CLAUDE_MODEL_HEAVY : CLAUDE_MODEL_DEFAULT,
        effort: options?.heavy ? EFFORT_HEAVY : EFFORT_DEFAULT,
        system: buildDomainInstruction(domain, getExpenseCategoryNames()),
        tools: toClaudeTools(getDomainDeclarations(domain)),
        requestOptions: options?.heavy ? heavyRequestOptions : requestOptions,
    });
}

/** Transient Claude failures worth the heavy-model fallback: timeouts, network, 5xx/529 overloaded. */
export function isRetryableClaudeError(error: unknown): boolean {
    return error instanceof Anthropic.APIConnectionError || error instanceof Anthropic.InternalServerError;
}

export function isClaudeRateLimitError(error: unknown): boolean {
    return error instanceof Anthropic.RateLimitError;
}

function appendText(blocks: Anthropic.ContentBlockParam[], text: string): void {
    const last = blocks[blocks.length - 1];
    if (last?.type === 'text') {
        last.text += `\n${text}`;
    } else if (text) {
        blocks.push({ type: 'text', text });
    }
}

function fileBlock(data: string, mimeType: string): Anthropic.ContentBlockParam {
    if (mimeType === 'application/pdf') {
        return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
    }
    if (mimeType.startsWith('image/')) {
        return {
            type: 'image',
            source: {
                type: 'base64',
                media_type: mimeType as Anthropic.Base64ImageSource['media_type'],
                data,
            },
        };
    }
    throw new Error(`Claude can't read ${mimeType} files`);
}

function toModelResponse(message: Anthropic.Message): ModelResponse {
    if (message.stop_reason === 'refusal') {
        console.warn('Claude declined the request:', message.stop_details);
        const declined = "Sorry, I can't help with that one.";
        return { text: () => declined, functionCalls: () => undefined };
    }
    if (message.stop_reason === 'max_tokens') {
        console.warn(`Claude hit max_tokens (${MAX_TOKENS}); the reply or tool call may be cut off`);
    }
    const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');
    const calls: FunctionCall[] = message.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({ name: block.name, args: block.input as object }));
    return { text: () => text, functionCalls: () => (calls.length > 0 ? calls : undefined) };
}

/**
 * Gemini's ChatSession on the Messages API, so the tool handlers run unchanged. Two differences:
 * - A functionResponse carries only a tool name; Claude needs the tool_use id. Each response takes
 *   the oldest unanswered tool_use of that name (or the oldest of any name).
 * - Claude rejects a turn that leaves a tool_use unanswered, which the deferred and ignored calls in
 *   index.ts can do, so any tool_use still open gets a placeholder result.
 * History is append-only and committed only after a call succeeds: Haiku 5.5 rejects thinking
 * blocks replayed after an edit to earlier turns.
 * A turn that answers tools may not call new ones: the handlers relay or drop its text and never
 * run its calls, and Claude, unlike Gemini, often follows a result with another lookup.
 */
class ClaudeChatSession implements ChatSession {
    private readonly history: Anthropic.MessageParam[] = [];
    /** tool_use blocks from the last assistant turn that have no tool_result yet. */
    private openToolUses: Anthropic.ToolUseBlock[] = [];

    constructor(private readonly config: ClaudeModelConfig) {}

    async sendMessage(request: MessageRequest): Promise<{ response: ModelResponse }> {
        const userTurn: Anthropic.MessageParam = { role: 'user', content: this.buildUserContent(request) };
        const answersTools =
            typeof request !== 'string' &&
            request.some((part) => typeof part !== 'string' && 'functionResponse' in part);
        const message = await getClient().messages.create(
            {
                model: this.config.model,
                max_tokens: MAX_TOKENS,
                output_config: { effort: this.config.effort },
                // Explicit breakpoint: the tools + system prefix is shared by every chat of this
                // model. The top-level one caches the growing conversation for its next turn.
                system: [{ type: 'text', text: this.config.system, cache_control: { type: 'ephemeral' } }],
                cache_control: { type: 'ephemeral' },
                tools: this.config.tools,
                tool_choice: { type: answersTools ? 'none' : 'auto' },
                messages: [...this.history, userTurn],
            },
            this.config.requestOptions
        );
        // A declined turn is left out, so the next message replays the history before it.
        if (message.stop_reason !== 'refusal') {
            this.history.push(userTurn, { role: 'assistant', content: message.content });
            this.openToolUses = message.content.filter(
                (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
            );
        }
        return { response: toModelResponse(message) };
    }

    private buildUserContent(request: MessageRequest): Anthropic.ContentBlockParam[] {
        const open = [...this.openToolUses];
        const results: Anthropic.ToolResultBlockParam[] = [];
        const blocks: Anthropic.ContentBlockParam[] = [];
        for (const part of typeof request === 'string' ? [request] : request) {
            if (typeof part === 'string') {
                appendText(blocks, part);
            } else if ('text' in part) {
                appendText(blocks, part.text);
            } else if ('inlineData' in part) {
                blocks.push(fileBlock(part.inlineData.data, part.inlineData.mimeType));
            } else {
                const { name, response } = part.functionResponse;
                const byName = open.findIndex((toolUse) => toolUse.name === name);
                const [toolUse] = open.splice(byName >= 0 ? byName : 0, 1);
                if (toolUse) {
                    results.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(response) });
                } else {
                    // A second reply-reading call in one turn answers after its turn was closed.
                    appendText(blocks, `Result of ${name}: ${JSON.stringify(response)}`);
                }
            }
        }
        for (const toolUse of open) {
            results.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify({ status: 'no_result' }),
            });
        }
        // tool_result blocks must open the user turn; any text goes after them.
        return [...results, ...blocks];
    }
}

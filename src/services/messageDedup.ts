export interface MessageKey {
    botId: number;
    chatId: number;
    messageId: number;
}

export interface MessageClaimStore {
    claim(key: MessageKey): Promise<boolean>;
    finish(key: MessageKey, status: 'handled' | 'failed'): Promise<void>;
}

/** At-most-once admission. Never release an uncertain claim: a write may have committed. */
export async function runMessageOnce(
    store: MessageClaimStore,
    key: MessageKey,
    handle: () => Promise<unknown>
): Promise<'handled' | 'duplicate'> {
    if (!await store.claim(key)) return 'duplicate';
    try {
        await handle();
        // "handled" means the handler finished, not that every requested operation succeeded.
        await store.finish(key, 'handled');
        return 'handled';
    } catch (error) {
        await store.finish(key, 'failed').catch(() => {});
        throw error;
    }
}

const attemptedContexts = new WeakSet<object>();

export class ToolExecutionInterruptedError extends Error {
    constructor(cause: unknown) {
        super('Tool execution was interrupted; do not replay the model turn.', { cause });
        this.name = 'ToolExecutionInterruptedError';
    }
}

/** AI retries are safe before tools, but a handler may write before its response fails. */
export async function runToolWithoutReplay<T>(context: object, action: () => Promise<T>): Promise<T> {
    attemptedContexts.add(context);
    try {
        return await action();
    } catch (error) {
        throw new ToolExecutionInterruptedError(error);
    }
}

export function hasAttemptedTool(context: object): boolean {
    return attemptedContexts.has(context);
}

export const INTERRUPTED_MESSAGE_REPLY =
    'Processing was interrupted after an action started. Some records may already be saved. ' +
    'I have not replayed this message. Check your confirmations or Dashboard before sending any missing items again.';

import type { Context } from 'telegraf';
import { receiptContext } from './services/receiptContext';
import { createReceiptStore } from './services/receiptStore';

/** Called after authorization and durable message admission, before any handler writes. */
export async function withReceiptTracking(
    ctx: Context,
    next: () => Promise<unknown>,
    store: ReturnType<typeof createReceiptStore>
): Promise<void> {
    if (!ctx.message || !ctx.chat || !ctx.from) { await next(); return; }
    const message = ctx.message;
    const key = { botId: ctx.botInfo.id, chatId: ctx.chat.id, userId: ctx.from.id };
    const photo = 'photo' in message ? message.photo.at(-1) : undefined;
    const document = 'document' in message ? message.document : undefined;
    const supportedDocument = document && (document.mime_type?.startsWith('image/') || document.mime_type === 'application/pdf');
    const media = photo ? { fileId: photo.file_id, mimeType: 'image/jpeg' }
        : supportedDocument ? { fileId: document.file_id, mimeType: document.mime_type! } : undefined;
    const replied = 'reply_to_message' in message ? message.reply_to_message : undefined;
    const receipt = media
        ? await store.create({ ...key, ...media, messageId: message.message_id,
            caption: 'caption' in message ? message.caption ?? '' : '',
            sentAt: new Date(message.date * 1000).toISOString() })
        : replied ? await store.find(key, replied.message_id) : undefined;
    if (!receipt) { await next(); return; }
    await store.link(key, message.message_id, receipt.id);
    const originalReply = ctx.reply.bind(ctx);
    ctx.reply = async (...args: Parameters<typeof originalReply>) => {
        const sent = await originalReply(...args);
        await store.link(key, sent.message_id, receipt.id);
        return sent;
    };
    try {
        await receiptContext.run({ receipt, followup: !media }, next);
    } finally {
        ctx.reply = originalReply;
    }
}

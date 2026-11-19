import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { ReceiptSnapshot } from './receiptContext';

type Database = Pick<PostgresJsDatabase, 'execute'>;
export interface ReceiptIdentity { botId: number; chatId: number; userId: number }

export function createReceiptStore(db: Database) {
    return {
        async create(key: ReceiptIdentity & { messageId: number; caption: string; fileId: string; mimeType: string; sentAt: string }): Promise<ReceiptSnapshot> {
            const [row] = await db.execute(sql`
                INSERT INTO telegram_receipts (bot_id, chat_id, telegram_user_id, message_id, caption, file_id, mime_type, sent_at)
                VALUES (${key.botId}, ${key.chatId}, ${key.userId}, ${key.messageId}, ${key.caption}, ${key.fileId}, ${key.mimeType}, ${key.sentAt})
                ON CONFLICT (bot_id, chat_id, message_id) DO UPDATE SET message_id = EXCLUDED.message_id
                RETURNING id
            `);
            await this.link(key, key.messageId, Number(row.id));
            return { id: Number(row.id), caption: key.caption, fileId: key.fileId, mimeType: key.mimeType,
                sentAt: key.sentAt, expenses: [], meals: [] };
        },
        async link(key: ReceiptIdentity, messageId: number, receiptId: number): Promise<void> {
            // Owner scope is checked even on writes; never attach a message to another user's receipt.
            await db.execute(sql`
                INSERT INTO telegram_receipt_messages (bot_id, chat_id, message_id, receipt_id)
                SELECT ${key.botId}, ${key.chatId}, ${messageId}, id FROM telegram_receipts
                WHERE id = ${receiptId} AND bot_id = ${key.botId} AND chat_id = ${key.chatId}
                    AND telegram_user_id = ${key.userId}
                ON CONFLICT (bot_id, chat_id, message_id) DO NOTHING
            `);
        },
        async find(key: ReceiptIdentity, messageId: number): Promise<ReceiptSnapshot | undefined> {
            const [row] = await db.execute(sql`
                SELECT r.id, r.caption, r.file_id, r.mime_type, r.sent_at,
                    COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'date', e.date,
                        'amount', e.amount, 'currency', e.currency, 'description', e.description,
                        'paymentMethod', e.payment_method) ORDER BY e.id)
                        FROM expenses e WHERE e.receipt_id = r.id), '[]'::jsonb) AS expenses,
                    COALESCE((SELECT jsonb_agg(jsonb_build_object('id', m.id, 'date', m.date,
                        'description', m.description, 'mealType', m.meal_type, 'proteinG', m.protein_g,
                        'carbsG', m.carbs_g, 'fatG', m.fat_g, 'calories', m.calories) ORDER BY m.id)
                        FROM meals m WHERE m.receipt_id = r.id AND m.telegram_user_id = ${key.userId}), '[]'::jsonb) AS meals
                FROM telegram_receipt_messages links JOIN telegram_receipts r ON r.id = links.receipt_id
                WHERE links.bot_id = ${key.botId} AND links.chat_id = ${key.chatId} AND links.message_id = ${messageId}
                    AND r.telegram_user_id = ${key.userId} AND r.bot_id = ${key.botId} AND r.chat_id = ${key.chatId}
            `);
            if (!row) return undefined;
            return { id: Number(row.id), caption: String(row.caption), fileId: String(row.file_id),
                mimeType: String(row.mime_type), sentAt: String(row.sent_at),
                expenses: row.expenses as Record<string, unknown>[], meals: row.meals as Record<string, unknown>[] };
        },
    };
}

export async function checkReceiptSchema(db: Database): Promise<void> {
    await db.execute(sql`SELECT r.file_id, r.mime_type, r.sent_at, m.receipt_id, e.receipt_id, l.receipt_id
        FROM telegram_receipts r LEFT JOIN telegram_receipt_messages l ON l.receipt_id = r.id
        LEFT JOIN meals m ON m.receipt_id = r.id LEFT JOIN expenses e ON e.receipt_id = r.id LIMIT 0`);
}

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { MessageClaimStore } from './messageDedup';

export function createMessageClaimStore(database: Pick<PostgresJsDatabase, 'execute'>): MessageClaimStore {
    return {
        async claim(key) {
            const rows = await database.execute(sql`
                INSERT INTO telegram_message_claims (bot_id, chat_id, message_id)
                VALUES (${key.botId}, ${key.chatId}, ${key.messageId})
                ON CONFLICT (bot_id, chat_id, message_id) DO NOTHING
                RETURNING message_id
            `);
            return rows.length === 1;
        },
        async finish(key, status) {
            await database.execute(sql`
                UPDATE telegram_message_claims SET status = ${status}, finished_at = NOW()
                WHERE bot_id = ${key.botId} AND chat_id = ${key.chatId} AND message_id = ${key.messageId}
            `);
        },
    };
}

/** Fail startup before accepting messages if the required migration has not been applied. */
export async function checkMessageClaimSchema(database: Pick<PostgresJsDatabase, 'execute'>): Promise<void> {
    await database.execute(sql`SELECT bot_id, chat_id, message_id, status, finished_at FROM telegram_message_claims LIMIT 0`);
}

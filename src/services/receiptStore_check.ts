import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Context } from 'telegraf';
import { createReceiptStore, checkReceiptSchema } from './receiptStore';
import { currentReceiptId, receiptContext, receiptPromptHint, isReceiptFoodSelection } from './receiptContext';
import { withReceiptTracking } from '../receiptTracking';

async function main() {
    const url = 'postgresql://postgres:devpassword@localhost:5433/tracking_dev';
    const schema = `receipt_test_${process.pid}_${Date.now()}`;
    const admin = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
    const connect = () => postgres(url, { max: 5, connect_timeout: 3, onnotice: () => {}, connection: { search_path: schema } });
    let client = connect();
    try {
        await admin.unsafe(`CREATE SCHEMA ${schema}`);
        await client`CREATE TABLE expenses (id SERIAL PRIMARY KEY, date TEXT, amount NUMERIC, currency TEXT, description TEXT, payment_method TEXT)`;
        await client`CREATE TABLE meals (id SERIAL PRIMARY KEY, telegram_user_id BIGINT, date TEXT, description TEXT, meal_type TEXT, protein_g NUMERIC, carbs_g NUMERIC, fat_g NUMERIC, calories NUMERIC)`;
        await assert.rejects(checkReceiptSchema(drizzle(client)));
        const migration = await readFile('scripts/migrate-telegram-receipts.sql', 'utf8');
        await client.unsafe(migration);
        await client.unsafe(migration);
        await checkReceiptSchema(drizzle(client));
        let store = createReceiptStore(drizzle(client));
        const owner = { botId: 1, chatId: -1001234567890, userId: 42 };
        let replyId = 1000;
        function context(message: Record<string, unknown>): Context {
            return {
                botInfo: { id: owner.botId }, chat: { id: owner.chatId }, from: { id: owner.userId },
                message: { date: 1795046400, ...message },
                reply: async () => ({ message_id: ++replyId }),
            } as unknown as Context;
        }
        const first = context({ message_id: 10, caption: 'yesterday dinner', photo: [{ file_id: 'original-image' }] });
        let firstReceipt = 0;
        let confirmation = 0;
        await withReceiptTracking(first, async () => {
            firstReceipt = currentReceiptId()!;
            assert(firstReceipt);
            await client`INSERT INTO expenses (receipt_id, date, amount, currency, description, payment_method)
                VALUES (${firstReceipt}, '2026-11-18', 13, 'MYR', 'Rice shop', 'Cash')`;
            await client`INSERT INTO meals (receipt_id, telegram_user_id, date, description, protein_g)
                VALUES (${firstReceipt}, 42, '2026-11-18', 'Rice', 20)`;
            confirmation = (await first.reply('Logged expense #1')).message_id;
        }, store);
        assert.equal(currentReceiptId(), undefined);
        assert.equal((await store.find(owner, 10))?.expenses.length, 1);

        // No memory from the first request or store survives this reconnect.
        await client.end();
        client = connect();
        store = createReceiptStore(drizzle(client));
        const reply = context({ message_id: 11, text: 'Yes all is my', reply_to_message: { message_id: confirmation } });
        let followupConfirmation = 0;
        await withReceiptTracking(reply, async () => {
            const state = receiptContext.getStore()!;
            assert.equal(state.followup, true);
            assert.equal(state.receipt.id, firstReceipt);
            assert.equal(state.receipt.fileId, 'original-image');
            assert.equal(state.receipt.caption, 'yesterday dinner');
            assert.equal(state.receipt.expenses[0].id, 1);
            assert.equal(state.receipt.meals[0].id, 1);
            assert(receiptPromptHint().includes('2026-11-18'));
            followupConfirmation = (await reply.reply('Already logged')).message_id;
        }, store);
        assert.equal((await store.find(owner, followupConfirmation))?.id, firstReceipt);
        assert.equal((await store.find(owner, 11))?.id, firstReceipt);
        assert.equal(await store.find({ ...owner, userId: 99 }, 10), undefined);
        assert.equal(await store.find({ ...owner, chatId: 99 }, 10), undefined);
        assert.equal(await store.find({ ...owner, botId: 99 }, 10), undefined);
        await store.link({ ...owner, userId: 99 }, 900, firstReceipt);
        assert.equal(await store.find(owner, 900), undefined);

        // Snapshot reflects later Dashboard edits/deletes, not stale captured tool arguments.
        await client`UPDATE meals SET description = 'Noodles', protein_g = 15 WHERE id = 1`;
        assert.equal((await store.find(owner, 10))?.meals[0].description, 'Noodles');
        await client`DELETE FROM meals WHERE id = 1`;
        assert.equal((await store.find(owner, 10))?.meals.length, 0);

        // New uploads replying to old receipts are separate; parallel handlers cannot mix links.
        const ids = await Promise.all([20, 21].map(async messageId => {
            const ctx = context({ message_id: messageId, photo: [{ file_id: `photo-${messageId}` }], reply_to_message: { message_id: 10 } });
            let id = 0;
            await withReceiptTracking(ctx, async () => {
                id = currentReceiptId()!;
                await new Promise(resolve => setTimeout(resolve, 5));
                assert.equal(currentReceiptId(), id);
                assert.equal(receiptContext.getStore()?.followup, false);
                await ctx.reply('Saved');
            }, store);
            return id;
        }));
        assert.notEqual(ids[0], ids[1]);
        assert(!ids.includes(firstReceipt));
        assert.equal(currentReceiptId(), undefined);
        await withReceiptTracking(context({ message_id: 30, text: 'all mine' }), async () => {
            assert.equal(currentReceiptId(), undefined); // No guessing without a reply.
        }, store);
        await withReceiptTracking(context({ message_id: 31, document: { file_id: 'receipt-pdf', mime_type: 'application/pdf' } }), async () => {
            assert.equal(receiptContext.getStore()?.receipt.mimeType, 'application/pdf');
        }, store);
        for (const text of ['Yes all is my', 'all mine', 'all except 2 and 5', '3 and 4 is mine', 'shared with 1 friend', 'we ate together', 'all']) {
            assert(isReceiptFoodSelection(text), text);
        }
        for (const text of ['paid with RHB World Card', 'change amount to 12', 'refund all', 'delete expense']) {
            assert(!isReceiptFoodSelection(text), text);
        }
        console.log('receipts: passed persistence, reply chains, owner isolation, current rows, media, concurrent contexts and selection routing');
    } finally {
        await client.end();
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await admin.end();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

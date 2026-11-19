import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createMessageClaimStore, checkMessageClaimSchema } from './messageClaimStore';
import { runMessageOnce, runToolWithoutReplay, hasAttemptedTool, ToolExecutionInterruptedError } from './messageDedup';

async function main() {
    // Fixed local-only target; never read DATABASE_URL or load production configuration.
    const url = 'postgresql://postgres:devpassword@localhost:5433/tracking_dev';
    const schema = `message_dedup_test_${process.pid}_${Date.now()}`;
    const admin = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
    const connect = () => postgres(url, {
        max: 5, connect_timeout: 3, onnotice: () => {}, connection: { search_path: schema },
    });
    let client = connect();
    try {
        await admin.unsafe(`CREATE SCHEMA ${schema}`);
        await assert.rejects(checkMessageClaimSchema(drizzle(client)), /telegram_message_claims/);
        const migration = await readFile('scripts/migrate-telegram-message-claims.sql', 'utf8');
        await client.unsafe(migration);
        await client.unsafe(migration);
        await checkMessageClaimSchema(drizzle(client));
        await client`CREATE TABLE writes (id SERIAL PRIMARY KEY)`;
        let store = createMessageClaimStore(drizzle(client));
        const key = { botId: 1, chatId: -1001234567890, messageId: 12 };
        const write = async () => { await client`INSERT INTO writes DEFAULT VALUES`; };

        const results = await Promise.all(Array.from({ length: 20 }, () => runMessageOnce(store, key, write)));
        assert.equal(results.filter(r => r === 'handled').length, 1);
        assert.equal(results.filter(r => r === 'duplicate').length, 19);
        assert.equal((await client`SELECT count(*)::int AS n FROM writes`)[0].n, 1);

        // Reconnect with a fresh store to simulate restart: no in-memory cache is involved.
        await client.end();
        client = connect();
        store = createMessageClaimStore(drizzle(client));
        assert.equal(await runMessageOnce(store, key, write), 'duplicate');
        for (const different of [{ ...key, messageId: 13 }, { ...key, chatId: 2 }, { ...key, botId: 2 }]) {
            assert.equal(await runMessageOnce(store, different, write), 'handled');
        }
        assert.equal((await client`SELECT count(*)::int AS n FROM writes`)[0].n, 4);

        // A failure after saving must not allow a replay, even after reconnect.
        const partial = { ...key, messageId: 14 };
        await assert.rejects(runMessageOnce(store, partial, async () => { await write(); throw new Error('reply failed'); }), /reply failed/);
        assert.equal(await runMessageOnce(store, partial, write), 'duplicate');
        const crashed = { ...key, messageId: 15 };
        assert(await store.claim(crashed)); // Simulate process death after admission.
        await client.end();
        client = connect();
        store = createMessageClaimStore(drizzle(client));
        assert.equal(await runMessageOnce(store, partial, write), 'duplicate');
        assert.equal(await runMessageOnce(store, crashed, write), 'duplicate');
        assert.equal((await client`SELECT count(*)::int AS n FROM writes`)[0].n, 5);

        // A database admission failure must never run the handler.
        let called = false;
        await assert.rejects(runMessageOnce({
            claim: async () => { throw new Error('database unavailable'); }, finish: async () => {},
        }, key, async () => { called = true; }), /database unavailable/);
        assert.equal(called, false);

        // Failure to mark completion also keeps the durable claim.
        const unfinished = { ...key, messageId: 16 };
        await assert.rejects(runMessageOnce({
            claim: store.claim, finish: async () => { throw new Error('finish failed'); },
        }, unfinished, write), /finish failed/);
        assert.equal(await runMessageOnce(store, unfinished, write), 'duplicate');

        const context = {};
        assert.equal(hasAttemptedTool(context), false);
        await assert.rejects(runToolWithoutReplay(context, async () => {
            throw new Error('503 overloaded after saving');
        }), ToolExecutionInterruptedError);
        assert.equal(hasAttemptedTool(context), true);
        assert.equal(hasAttemptedTool({}), false);
        const successful = {};
        assert.equal(await runToolWithoutReplay(successful, async () => 'saved'), 'saved');
        assert.equal(hasAttemptedTool(successful), true);
        console.log('messageDedup: passed concurrency, restart, distinct messages, partial failure, fail-closed and tool retry checks');
    } finally {
        await client.end();
        // The generated schema name is local-only and contains digits/underscores only.
        await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await admin.end();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });

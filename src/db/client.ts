import 'dotenv/config';

import { drizzle } from 'drizzle-orm/postgres-js';

import postgres from 'postgres';

import { spawnSync } from 'node:child_process';

import * as schema from './schema';

import { buildPoolerUrlForClient, isDirectSupabaseHost, isPoolerSupabaseHost, projectRefFromDirectHost } from './resolveDatabaseUrl';

function canResolveHostSync(hostname: string): boolean {
    const script = `require('node:dns').lookup(${JSON.stringify(hostname)}, {all:true}, (err) => process.exit(err ? 1 : 0))`;
    const result = spawnSync(process.execPath, ['-e', script], {
        stdio: 'ignore',
        timeout: 5000,
    });
    return result.status === 0;
}

function resolveConnectionStringSync(connectionString: string): string {

    const parsed = new URL(connectionString);



    if (isPoolerSupabaseHost(parsed.hostname)) {

        return connectionString;

    }



    if (!isDirectSupabaseHost(parsed.hostname)) {

        return connectionString;

    }



    if (canResolveHostSync(parsed.hostname)) {
        return connectionString;
    } else {

        const region = process.env.DATABASE_POOLER_REGION?.trim();

        if (!region) {

            return connectionString;

        }

        const projectRef = projectRefFromDirectHost(parsed.hostname);

        console.warn(

            `Direct Supabase host "${parsed.hostname}" is unreachable; using pooler region "${region}".`

        );

        return buildPoolerUrlForClient(projectRef, parsed.password, region, 6543);
    }
}



const rawConnectionString = process.env.DATABASE_URL;

const connectionString = rawConnectionString ? resolveConnectionStringSync(rawConnectionString) : null;



if (!connectionString) {

    console.warn('⚠️ DATABASE_URL is not set. Database features will fail until configured.');

}



// Supabase's transaction pooler (port 6543) does not support prepared statements.
// Its session pooler (port 5432) allows only 15 connections, shared by the bot and the
// Dashboard, so keep each pool small and hand idle connections back after 20 seconds.
const client = connectionString
    ? postgres(connectionString, {
          prepare: new URL(connectionString).port !== '6543',
          max: 5,
          idle_timeout: 20,
      })
    : null;

export const db = client ? drizzle(client, { schema }) : null;



export function requireDb() {

    if (!db) {

        throw new Error('Database not configured. Set DATABASE_URL in your environment.');

    }

    return db;

}

export async function closeDb() {
    if (client) {
        await client.end();
    }
}


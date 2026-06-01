import 'dotenv/config';

import { drizzle } from 'drizzle-orm/postgres-js';

import postgres from 'postgres';

import { lookupSync } from 'node:dns';

import * as schema from './schema';

import { buildPoolerUrlForClient, isDirectSupabaseHost, isPoolerSupabaseHost, projectRefFromDirectHost } from './resolveDatabaseUrl';



function resolveConnectionStringSync(connectionString: string): string {

    const parsed = new URL(connectionString);



    if (isPoolerSupabaseHost(parsed.hostname)) {

        return connectionString;

    }



    if (!isDirectSupabaseHost(parsed.hostname)) {

        return connectionString;

    }



    try {

        lookupSync(parsed.hostname, { all: true });

        return connectionString;

    } catch {

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



const client = connectionString ? postgres(connectionString) : null;

// #region agent log
if (connectionString) {
    try {
        const u = new URL(connectionString);
        fetch('http://127.0.0.1:7252/ingest/33c6738f-5e96-4778-a16c-73a09bcd6a03',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ddacc8'},body:JSON.stringify({sessionId:'ddacc8',runId:'pre-fix',hypothesisId:'H2',location:'src/db/client.ts:init',message:'db client connection target',data:{host:u.hostname,port:u.port,dbname:u.pathname.replace(/^\//,''),user:u.username},timestamp:Date.now()})}).catch(()=>{});
    } catch { /* ignore parse errors */ }
}
// #endregion

export const db = client ? drizzle(client, { schema }) : null;



export function requireDb() {

    if (!db) {

        throw new Error('Database not configured. Set DATABASE_URL in your environment.');

    }

    return db;

}


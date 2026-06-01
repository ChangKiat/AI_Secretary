import dns from 'node:dns/promises';
import postgres from 'postgres';

const POOLER_REGIONS = [
    'ap-southeast-1',
    'ap-southeast-2',
    'ap-northeast-1',
    'ap-northeast-2',
    'ap-south-1',
    'us-east-1',
    'us-west-1',
    'eu-west-1',
    'eu-central-1',
    'eu-west-2',
    'eu-west-3',
    'sa-east-1',
];

function encodePassword(password: string): string {
    return encodeURIComponent(decodeURIComponent(password));
}

export function isDirectSupabaseHost(hostname: string): boolean {
    return hostname.startsWith('db.') && hostname.endsWith('.supabase.co');
}

export function isPoolerSupabaseHost(hostname: string): boolean {
    return hostname.endsWith('.pooler.supabase.com');
}

export function projectRefFromDirectHost(hostname: string): string {
    return hostname.replace(/^db\./, '').split('.')[0];
}

function projectRefFromUrl(parsed: URL): string | null {
    if (parsed.username.startsWith('postgres.')) {
        return parsed.username.slice('postgres.'.length);
    }
    if (isDirectSupabaseHost(parsed.hostname)) {
        return projectRefFromDirectHost(parsed.hostname);
    }
    return null;
}

export function buildPoolerUrlForClient(
    projectRef: string,
    password: string,
    region: string,
    port: 5432 | 6543
): string {
    const encodedPassword = encodePassword(password);
    return `postgresql://postgres.${projectRef}:${encodedPassword}@aws-0-${region}.pooler.supabase.com:${port}/postgres`;
}

export async function canResolveHost(hostname: string): Promise<boolean> {
    try {
        await dns.lookup(hostname, { all: true });
        return true;
    } catch {
        return false;
    }
}

async function probeDatabaseUrl(url: string, hypothesisId: string): Promise<boolean> {
    const parsed = new URL(url);
    const sql = postgres(url, { connect_timeout: 8, max: 1 });
    try {
        await sql`SELECT 1`;
        // #region agent log
        fetch('http://127.0.0.1:7252/ingest/33c6738f-5e96-4778-a16c-73a09bcd6a03',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ca014c'},body:JSON.stringify({sessionId:'ca014c',runId:'post-fix',hypothesisId,location:'src/db/resolveDatabaseUrl.ts:probeDatabaseUrl',message:'database probe succeeded',data:{host:parsed.hostname,port:parsed.port,user:parsed.username},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        return true;
    } catch (e) {
        const err = e as NodeJS.ErrnoException;
        // #region agent log
        fetch('http://127.0.0.1:7252/ingest/33c6738f-5e96-4778-a16c-73a09bcd6a03',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ca014c'},body:JSON.stringify({sessionId:'ca014c',runId:'post-fix',hypothesisId,location:'src/db/resolveDatabaseUrl.ts:probeDatabaseUrl',message:'database probe failed',data:{host:parsed.hostname,port:parsed.port,code:err.code,message:err.message},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        return false;
    } finally {
        await sql.end({ timeout: 2 }).catch(() => {});
    }
}

export async function resolveSupabaseDatabaseUrl(connectionString: string): Promise<string> {
    const parsed = new URL(connectionString);
    const preferredRegion = process.env.DATABASE_POOLER_REGION?.trim();

    if (isDirectSupabaseHost(parsed.hostname) && (await canResolveHost(parsed.hostname))) {
        if (await probeDatabaseUrl(connectionString, 'H3')) {
            return connectionString;
        }
    }

    if (isPoolerSupabaseHost(parsed.hostname) && (await probeDatabaseUrl(connectionString, 'H2'))) {
        return connectionString;
    }

    const projectRef = projectRefFromUrl(parsed);
    if (!projectRef) {
        if (await probeDatabaseUrl(connectionString, 'H3')) {
            return connectionString;
        }
        throw new Error(`Cannot connect using DATABASE_URL host "${parsed.hostname}".`);
    }

    const regions = preferredRegion
        ? [preferredRegion, ...POOLER_REGIONS.filter((r) => r !== preferredRegion)]
        : POOLER_REGIONS;

    // #region agent log
    fetch('http://127.0.0.1:7252/ingest/33c6738f-5e96-4778-a16c-73a09bcd6a03',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'ca014c'},body:JSON.stringify({sessionId:'ca014c',runId:'post-fix',hypothesisId:'H2',location:'src/db/resolveDatabaseUrl.ts:resolveSupabaseDatabaseUrl',message:'probing pooler regions',data:{projectRef,regionsToTry:regions.length,preferredRegion:preferredRegion||null},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    for (const region of regions) {
        for (const port of [6543, 5432] as const) {
            const candidate = buildPoolerUrlForClient(projectRef, parsed.password, region, port);
            if (await probeDatabaseUrl(candidate, 'H2')) {
                console.warn(`Using Supabase pooler (${region}:${port}) for project "${projectRef}".`);
                return candidate;
            }
        }
    }

    throw new Error(
        `Cannot connect to Supabase for project "${projectRef}". ` +
        `No pooler region accepted this project ref/password combination. ` +
        `Open Supabase → Project Settings → Database, confirm the project is active (not paused), reset the database password if needed, ` +
        `copy the Session/Transaction pooler URI, and update DATABASE_URL.`
    );
}

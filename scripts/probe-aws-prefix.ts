import 'dotenv/config';
import postgres from 'postgres';

const u = new URL(process.env.DATABASE_URL!);
const ref = u.username.startsWith('postgres.') ? u.username.slice(9) : u.hostname.replace(/^db\./, '').split('.')[0];
const pw = encodeURIComponent(decodeURIComponent(u.password));

const regions = ['ap-southeast-1', 'ap-southeast-2', 'us-east-1', 'us-east-2', 'us-west-1', 'eu-central-1', 'eu-west-1'];
const prefixes = ['aws-0', 'aws-1'];

async function tryHost(prefix: string, region: string, port: number) {
    const host = `${prefix}-${region}.pooler.supabase.com`;
    const url = `postgresql://postgres.${ref}:${pw}@${host}:${port}/postgres`;
    const sql = postgres(url, { connect_timeout: 8, max: 1 });
    try {
        await sql`SELECT 1`;
        console.log('SUCCESS', host, port);
        return true;
    } catch (e: any) {
        console.log('FAIL', host, port, '-', e.message?.slice(0, 90));
        return false;
    } finally {
        await sql.end({ timeout: 2 }).catch(() => {});
    }
}

async function main() {
    console.log('ref', ref);
    for (const prefix of prefixes) {
        for (const region of regions) {
            for (const port of [6543, 5432]) {
                if (await tryHost(prefix, region, port)) return;
            }
        }
    }
}

main();

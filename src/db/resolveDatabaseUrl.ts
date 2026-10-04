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

export function buildPoolerUrlForClient(
    projectRef: string,
    password: string,
    region: string,
    port: 5432 | 6543
): string {
    const encodedPassword = encodePassword(password);
    return `postgresql://postgres.${projectRef}:${encodedPassword}@aws-0-${region}.pooler.supabase.com:${port}/postgres`;
}

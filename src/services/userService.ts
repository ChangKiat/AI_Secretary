import { and, eq, gt, isNull } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { users } from '../db/schema';

export type LinkResult =
    | { status: 'linked'; email: string }
    /** This Telegram account is already connected to a Dashboard account. */
    | { status: 'already'; email: string }
    /** No unused, unexpired code matches. */
    | { status: 'invalid' };

/**
 * Connects a Telegram account to the Dashboard account that issued `code` (profile page,
 * "Connect Telegram"). The ID comes from the message's sender, never from user input, so a
 * person can only connect a Telegram account they control.
 */
export async function linkTelegramByCode(code: string, telegramUserId: number): Promise<LinkResult> {
    const db = requireDb();
    const [existing] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.telegramUserId, telegramUserId))
        .limit(1);
    if (existing) return { status: 'already', email: existing.email };

    const [linked] = await db
        .update(users)
        .set({ telegramUserId, telegramLinkCode: null, telegramLinkCodeExpiresAt: null })
        .where(
            and(
                eq(users.telegramLinkCode, code.trim().toUpperCase()),
                gt(users.telegramLinkCodeExpiresAt, new Date()),
                isNull(users.telegramUserId)
            )
        )
        .returning({ email: users.email });
    return linked ? { status: 'linked', email: linked.email } : { status: 'invalid' };
}

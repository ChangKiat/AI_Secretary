import { eq } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { userSettings } from '../db/schema';
import { getOrCreateUserSettings } from './nutritionService';

export async function getSalaryAfterTax(telegramUserId: number): Promise<number> {
    const db = requireDb();
    const existing = await db
        .select({ salaryAfterTax: userSettings.salaryAfterTax })
        .from(userSettings)
        .where(eq(userSettings.telegramUserId, telegramUserId));

    if (existing.length > 0) {
        return parseFloat(existing[0].salaryAfterTax);
    }

    await getOrCreateUserSettings(telegramUserId);
    return 0;
}

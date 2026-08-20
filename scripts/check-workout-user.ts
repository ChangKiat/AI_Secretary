import 'dotenv/config';
import { requireDb, closeDb } from '../src/db/client';
import { workouts } from '../src/db/schema';

async function main() {
    const db = requireDb();
    const rows = await db.select({ id: workouts.telegramUserId }).from(workouts).limit(5);
    console.log(JSON.stringify(rows));
    await closeDb();
    process.exit(0);
}

main();

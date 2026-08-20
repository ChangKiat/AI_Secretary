import 'dotenv/config';
import { getWorkoutHistoryGrouped } from '../src/services/gymService';
import { closeDb } from '../src/db/client';

async function main() {
    const telegramUserId = 806121250;
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 21);
    const grouped = await getWorkoutHistoryGrouped(
        telegramUserId,
        start.toISOString().slice(0, 10),
        end.toISOString().slice(0, 10)
    );
    console.log(JSON.stringify(grouped, null, 2));
    await closeDb();
    process.exit(0);
}

main();

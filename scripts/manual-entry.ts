import 'dotenv/config';
import { appendExpense, updateExpense } from '../src/services/expenseService';
import { appendIncome, updateIncome } from '../src/services/incomeService';
import { loadExpenseCategories } from '../src/config/expenseCategories';
import { loadPaymentAccounts } from '../src/config/paymentMethods';
import { addInterestSchedule, InterestFrequency } from '../src/services/interestScheduleService';
import { logBulkWorkouts } from '../src/services/gymService';
import { updateNutritionTargets, logMeal } from '../src/services/nutritionService';
import { closeDb } from '../src/db/client';
import { randomUUID } from 'crypto';

type ExpensePayload = {
    kind: 'expense';
    date?: string;
    amount: number;
    currency?: string;
    category: string;
    description: string;
    paymentMethod?: string | null;
};

type IncomePayload = {
    kind: 'income';
    date?: string;
    amount: number;
    currency?: string;
    category: string;
    description: string;
    source?: string;
    expenseId?: number;
    paymentMethod?: string | null;
    fromPaymentMethod?: string | null;
};

type UpdateExpensePayload = {
    kind: 'update_expense';
    id: number;
    date?: string;
    amount?: number;
    currency?: string;
    category?: string;
    description?: string;
    paymentMethod?: string | null;
};

type UpdateIncomePayload = {
    kind: 'update_income';
    id: number;
    date?: string;
    amount?: number;
    currency?: string;
    category?: string;
    description?: string;
    source?: string | null;
    paymentMethod?: string | null;
    fromPaymentMethod?: string | null;
};

type AddInterestSchedulePayload = {
    kind: 'add_interest_schedule';
    paymentMethod: string;
    frequency: InterestFrequency;
    dayOfMonth?: number | null;
    annualRatePct?: number | null;
    fixedAmount?: number | null;
    currency?: string;
    description: string;
};

type WorkoutBulkPayload = {
    kind: 'workout_bulk';
    telegramUserId: number;
    date?: string;
    sessionLabel?: string;
    exercises: {
        exercise: string;
        sets?: number;
        reps?: number;
        weightKg?: number;
        notes?: string;
    }[];
};

type NutritionTargetsPayload = {
    kind: 'nutrition_targets';
    telegramUserId: number;
    dailyProteinTargetG?: number;
    dailyCalorieTarget?: number;
    dailyCarbsTargetG?: number;
    dailyFatTargetG?: number;
    bodyWeightKg?: number;
};

type MealPayload = {
    kind: 'meal';
    telegramUserId: number;
    date?: string;
    mealType?: string;
    description: string;
    proteinG: number;
    carbsG?: number;
    fatG?: number;
    calories?: number;
};

type Payload =
    | ExpensePayload
    | IncomePayload
    | UpdateExpensePayload
    | UpdateIncomePayload
    | AddInterestSchedulePayload
    | WorkoutBulkPayload
    | NutritionTargetsPayload
    | MealPayload;

function todayInKL(): string {
    const t = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kuala_Lumpur' }));
    const y = t.getFullYear();
    const m = String(t.getMonth() + 1).padStart(2, '0');
    const d = String(t.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

async function main() {
    const raw = process.argv[2];
    if (!raw) {
        console.error('Usage: tsx scripts/manual-entry.ts \'<json payload>\'');
        process.exit(1);
    }
    const payload = JSON.parse(raw) as Payload;

    await loadExpenseCategories();
    await loadPaymentAccounts();

    if (payload.kind === 'expense') {
        const id = await appendExpense(
            payload.date,
            payload.amount,
            payload.currency || 'MYR',
            payload.category,
            payload.description,
            payload.paymentMethod
        );
        console.log(JSON.stringify({ ok: true, kind: 'expense', id }));
    } else if (payload.kind === 'income') {
        const id = await appendIncome(
            payload.date,
            payload.amount,
            payload.currency || 'MYR',
            payload.category,
            payload.description,
            payload.source,
            payload.expenseId,
            payload.paymentMethod,
            payload.fromPaymentMethod
        );
        console.log(JSON.stringify({ ok: true, kind: 'income', id }));
    } else if (payload.kind === 'update_expense') {
        const { id, ...fields } = payload;
        const updated = await updateExpense(id, fields);
        console.log(JSON.stringify({ ok: updated, kind: 'update_expense', id }));
    } else if (payload.kind === 'update_income') {
        const { id, ...fields } = payload;
        const updated = await updateIncome(id, fields);
        console.log(JSON.stringify({ ok: updated, kind: 'update_income', id }));
    } else if (payload.kind === 'add_interest_schedule') {
        const ok = await addInterestSchedule({
            paymentMethod: payload.paymentMethod,
            frequency: payload.frequency,
            dayOfMonth: payload.dayOfMonth,
            annualRatePct: payload.annualRatePct,
            fixedAmount: payload.fixedAmount,
            currency: payload.currency,
            description: payload.description,
        });
        console.log(JSON.stringify({ ok, kind: 'add_interest_schedule' }));
    } else if (payload.kind === 'workout_bulk') {
        const date = payload.date || todayInKL();
        const sessionId = randomUUID();
        await logBulkWorkouts(
            payload.telegramUserId,
            payload.exercises.map((e) => ({ ...e, date })),
            sessionId,
            payload.sessionLabel ?? null
        );
        console.log(JSON.stringify({ ok: true, kind: 'workout_bulk', sessionId, count: payload.exercises.length }));
    } else if (payload.kind === 'nutrition_targets') {
        const { telegramUserId, kind, ...targets } = payload;
        await updateNutritionTargets(telegramUserId, targets);
        console.log(JSON.stringify({ ok: true, kind: 'nutrition_targets', targets }));
    } else if (payload.kind === 'meal') {
        const date = payload.date || todayInKL();
        const mealId = await logMeal(
            payload.telegramUserId,
            date,
            payload.description,
            payload.proteinG,
            payload.mealType,
            payload.carbsG,
            payload.fatG,
            payload.calories
        );
        console.log(JSON.stringify({ ok: true, kind: 'meal', mealId }));
    } else {
        console.error(`Unknown kind: ${(payload as Payload).kind}`);
        process.exit(1);
    }

    await closeDb();
    process.exit(0);
}

main().catch(async (err) => {
    console.error('Manual entry failed:', err);
    await closeDb();
    process.exit(1);
});

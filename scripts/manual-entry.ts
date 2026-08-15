import 'dotenv/config';
import { appendExpense, updateExpense } from '../src/services/expenseService';
import { appendIncome, updateIncome } from '../src/services/incomeService';
import { loadExpenseCategories } from '../src/config/expenseCategories';
import { loadPaymentAccounts } from '../src/config/paymentMethods';
import { closeDb } from '../src/db/client';

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

type Payload = ExpensePayload | IncomePayload | UpdateExpensePayload | UpdateIncomePayload;

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

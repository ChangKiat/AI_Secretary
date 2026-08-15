import { and, eq, inArray } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { fixedExpenses, loanPayments } from '../db/schema';

export type LoanMethod = 'reducing' | 'flat' | 'included';

export interface LoanTerms {
    method: LoanMethod;
    installment: number;
    remaining: number;
    originalPrincipal: number;
    annualRatePct: number;
    tenureMonths: number;
}

export interface InstallmentSplit {
    interest: number;
    principal: number;
    installment: number;
    remainingAfter: number;
}

export interface FixedExpenseLoanFields {
    loanMethod: LoanMethod | null;
    originalPrincipal?: number | null;
    remainingPrincipal?: number | null;
    annualRatePct?: number | null;
    tenureMonths?: number | null;
    loanStartDate?: string | null;
}

export interface AppliedLoanPayment extends InstallmentSplit {
    skipped: boolean;
}

function roundMoney(value: number): number {
    return Math.round(value * 100) / 100;
}

function parseNum(value: string | null | undefined): number {
    if (value == null) return 0;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

export function parseLoanMethod(value: string | null | undefined): LoanMethod | null {
    if (value === 'reducing' || value === 'flat' || value === 'included') return value;
    return null;
}

export function computeInstallmentSplit(terms: LoanTerms): InstallmentSplit | null {
    const remaining = roundMoney(terms.remaining);
    if (!(remaining > 0) || !(terms.installment > 0)) {
        return null;
    }

    if (terms.method === 'included') {
        const principal = roundMoney(Math.min(remaining, terms.installment));
        if (principal <= 0) return null;
        return {
            interest: 0,
            principal,
            installment: principal,
            remainingAfter: roundMoney(remaining - principal),
        };
    }

    if (terms.tenureMonths < 1) return null;

    const rate = Math.max(0, terms.annualRatePct);
    let interest: number;

    if (terms.method === 'flat') {
        const years = terms.tenureMonths / 12;
        const totalInterest = terms.originalPrincipal * (rate / 100) * years;
        interest = roundMoney(totalInterest / terms.tenureMonths);
    } else {
        const monthlyRate = rate / 12 / 100;
        interest = roundMoney(remaining * monthlyRate);
    }

    if (interest > terms.installment) {
        interest = roundMoney(terms.installment);
    }

    const principal = roundMoney(Math.min(remaining, Math.max(0, terms.installment - interest)));
    const installment = roundMoney(interest + principal);
    if (installment <= 0) return null;

    return {
        interest,
        principal,
        installment,
        remainingAfter: roundMoney(remaining - principal),
    };
}

export function suggestedInstallmentAmount(input: {
    method: LoanMethod;
    originalPrincipal: number;
    annualRatePct: number;
    tenureMonths: number;
}): number | null {
    const principal = input.originalPrincipal;
    const n = input.tenureMonths;
    if (input.method === 'included' || !(principal > 0) || n < 1) return null;

    const rate = Math.max(0, input.annualRatePct);
    if (input.method === 'flat') {
        const totalInterest = principal * (rate / 100) * (n / 12);
        return roundMoney((principal + totalInterest) / n);
    }

    const monthlyRate = rate / 12 / 100;
    if (monthlyRate === 0) return roundMoney(principal / n);

    const factor = (1 + monthlyRate) ** n;
    return roundMoney((principal * monthlyRate * factor) / (factor - 1));
}

export function loanColumnsForCategory(
    category: string,
    loan?: FixedExpenseLoanFields | null
): {
    loanMethod: string | null;
    originalPrincipal: string | null;
    remainingPrincipal: string | null;
    annualRatePct: string | null;
    tenureMonths: number | null;
    loanStartDate: string | null;
} {
    const cleared = {
        loanMethod: null,
        originalPrincipal: null,
        remainingPrincipal: null,
        annualRatePct: null,
        tenureMonths: null,
        loanStartDate: null,
    };
    if (category.trim().toLowerCase() !== 'loan' || !loan?.loanMethod) {
        return cleared;
    }
    const remaining = loan.remainingPrincipal ?? 0;
    const original =
        loan.originalPrincipal != null && loan.originalPrincipal > 0
            ? loan.originalPrincipal
            : remaining;
    return {
        loanMethod: loan.loanMethod,
        originalPrincipal: String(original),
        remainingPrincipal: String(remaining),
        annualRatePct:
            loan.loanMethod === 'included' || loan.annualRatePct == null
                ? null
                : String(loan.annualRatePct),
        tenureMonths: loan.loanMethod === 'included' ? null : (loan.tenureMonths ?? null),
        loanStartDate: loan.loanMethod === 'included' ? null : (loan.loanStartDate ?? null),
    };
}

export function loanFieldsFromRow(row: {
    loanMethod?: string | null;
    originalPrincipal?: string | null;
    remainingPrincipal?: string | null;
    annualRatePct?: string | null;
    tenureMonths?: number | null;
    loanStartDate?: string | null;
}): {
    loanMethod: LoanMethod | null;
    originalPrincipal: number | null;
    remainingPrincipal: number | null;
    annualRatePct: number | null;
    tenureMonths: number | null;
    loanStartDate: string | null;
} {
    const method = parseLoanMethod(row.loanMethod);
    if (!method) {
        return {
            loanMethod: null,
            originalPrincipal: null,
            remainingPrincipal: null,
            annualRatePct: null,
            tenureMonths: null,
            loanStartDate: null,
        };
    }
    return {
        loanMethod: method,
        originalPrincipal: row.originalPrincipal != null ? parseNum(row.originalPrincipal) : null,
        remainingPrincipal: row.remainingPrincipal != null ? parseNum(row.remainingPrincipal) : null,
        annualRatePct: row.annualRatePct != null ? parseNum(row.annualRatePct) : null,
        tenureMonths: row.tenureMonths ?? null,
        loanStartDate: row.loanStartDate ?? null,
    };
}

export async function getPaidLoanIdsOnDate(
    fixedExpenseIds: number[],
    date: string
): Promise<Set<number>> {
    if (fixedExpenseIds.length === 0) return new Set();
    const db = requireDb();
    const rows = await db
        .select({
            fixedExpenseId: loanPayments.fixedExpenseId,
        })
        .from(loanPayments)
        .where(
            and(inArray(loanPayments.fixedExpenseId, fixedExpenseIds), eq(loanPayments.date, date))
        );
    return new Set(rows.map((row) => row.fixedExpenseId));
}

export async function applyLoanPayment(fields: {
    fixedExpenseId: number;
    date: string;
    expenseId: number;
}): Promise<AppliedLoanPayment | null> {
    const db = requireDb();
    const [row] = await db
        .select()
        .from(fixedExpenses)
        .where(eq(fixedExpenses.id, fields.fixedExpenseId))
        .limit(1);
    if (!row) return null;

    const method = parseLoanMethod(row.loanMethod);
    if (!method) return null;

    const [existing] = await db
        .select()
        .from(loanPayments)
        .where(
            and(
                eq(loanPayments.fixedExpenseId, fields.fixedExpenseId),
                eq(loanPayments.date, fields.date)
            )
        )
        .limit(1);
    if (existing) {
        return {
            interest: parseNum(existing.interestAmount),
            principal: parseNum(existing.principalAmount),
            installment: parseNum(existing.installment),
            remainingAfter: parseNum(existing.remainingAfter),
            skipped: true,
        };
    }

    const split = computeInstallmentSplit({
        method,
        installment: parseNum(row.amount),
        remaining: parseNum(row.remainingPrincipal),
        originalPrincipal: parseNum(row.originalPrincipal),
        annualRatePct: parseNum(row.annualRatePct),
        tenureMonths: row.tenureMonths ?? 0,
    });
    if (!split) return null;

    await db.insert(loanPayments).values({
        fixedExpenseId: fields.fixedExpenseId,
        expenseId: fields.expenseId,
        date: fields.date,
        installment: String(split.installment),
        interestAmount: String(split.interest),
        principalAmount: String(split.principal),
        remainingAfter: String(split.remainingAfter),
    });
    await db
        .update(fixedExpenses)
        .set({ remainingPrincipal: String(split.remainingAfter) })
        .where(eq(fixedExpenses.id, fields.fixedExpenseId));

    return { ...split, skipped: false };
}

export async function reverseLoanPayment(expenseId: number): Promise<boolean> {
    const db = requireDb();
    const [payment] = await db
        .select()
        .from(loanPayments)
        .where(eq(loanPayments.expenseId, expenseId))
        .limit(1);
    if (!payment) return false;

    const [loan] = await db
        .select()
        .from(fixedExpenses)
        .where(eq(fixedExpenses.id, payment.fixedExpenseId))
        .limit(1);
    if (loan) {
        const restored = roundMoney(
            parseNum(loan.remainingPrincipal) + parseNum(payment.principalAmount)
        );
        await db
            .update(fixedExpenses)
            .set({ remainingPrincipal: String(restored) })
            .where(eq(fixedExpenses.id, payment.fixedExpenseId));
    }

    await db.delete(loanPayments).where(eq(loanPayments.id, payment.id));
    return true;
}

if (require.main === module) {
    const reducing = computeInstallmentSplit({
        method: 'reducing',
        installment: 1000,
        remaining: 10_000,
        originalPrincipal: 10_000,
        annualRatePct: 12,
        tenureMonths: 12,
    });
    if (
        !reducing ||
        reducing.interest !== 100 ||
        reducing.principal !== 900 ||
        reducing.remainingAfter !== 9100
    ) {
        throw new Error(`reducing split failed: ${JSON.stringify(reducing)}`);
    }

    const last = computeInstallmentSplit({
        method: 'reducing',
        installment: 1000,
        remaining: 50,
        originalPrincipal: 10_000,
        annualRatePct: 12,
        tenureMonths: 12,
    });
    if (!last || last.interest !== 0.5 || last.principal !== 50 || last.installment !== 50.5) {
        throw new Error(`last payment split failed: ${JSON.stringify(last)}`);
    }

    const flat = computeInstallmentSplit({
        method: 'flat',
        installment: 1025,
        remaining: 12_000,
        originalPrincipal: 12_000,
        annualRatePct: 2.5,
        tenureMonths: 12,
    });
    if (!flat || flat.interest !== 25 || flat.principal !== 1000 || flat.remainingAfter !== 11_000) {
        throw new Error(`flat split failed: ${JSON.stringify(flat)}`);
    }

    const emi = suggestedInstallmentAmount({
        method: 'reducing',
        originalPrincipal: 10_000,
        annualRatePct: 12,
        tenureMonths: 12,
    });
    if (emi !== 888.49) {
        throw new Error(`EMI helper failed: ${emi}`);
    }

    const included = computeInstallmentSplit({
        method: 'included',
        installment: 500,
        remaining: 10_000,
        originalPrincipal: 10_000,
        annualRatePct: 0,
        tenureMonths: 0,
    });
    if (
        !included ||
        included.interest !== 0 ||
        included.principal !== 500 ||
        included.remainingAfter !== 9500
    ) {
        throw new Error(`included split failed: ${JSON.stringify(included)}`);
    }

    console.log('loanService self-check ok');
}

import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm';
import { requireDb } from '../db/client';
import {
    investmentEvents,
    investmentInstruments,
    investmentLots,
} from '../db/schema';
import { appendExpense } from './expenseService';
import { appendIncome } from './incomeService';
import { getPaymentAccountById } from './paymentAccountService';

export type InstrumentKind = 'equity' | 'fund' | 'fd' | 'other';
export type InvestmentEventType =
    | 'buy'
    | 'sell'
    | 'dividend'
    | 'interest'
    | 'fee'
    | 'price_mark';

export interface InvestmentInstrument {
    id: number;
    paymentAccountId: number;
    kind: InstrumentKind;
    symbol: string | null;
    name: string;
    currency: string;
    lastPrice: number | null;
    lastPriceAt: string | null;
    principal: number | null;
    annualRatePct: number | null;
    startDate: string | null;
    maturityDate: string | null;
    active: boolean;
}

export interface InvestmentLot {
    id: number;
    instrumentId: number;
    openedAt: string;
    quantity: number;
    remainingQty: number;
    unitCost: number;
    buyEventId: number | null;
}

export interface InvestmentEvent {
    id: number;
    instrumentId: number;
    eventType: InvestmentEventType;
    date: string;
    quantity: number | null;
    unitPrice: number | null;
    amount: number | null;
    realizedGain: number | null;
    notes: string | null;
    linkedIncomeId: number | null;
    linkedExpenseId: number | null;
}

export interface HoldingPosition {
    instrument: InvestmentInstrument;
    quantity: number;
    costBasis: number;
    marketValue: number;
    unrealizedGain: number;
    lastPrice: number | null;
}

export interface PortfolioSummary {
    paymentAccountId: number;
    holdings: HoldingPosition[];
    events: InvestmentEvent[];
    totalCostBasis: number;
    totalMarketValue: number;
    totalUnrealizedGain: number;
    totalRealizedGain: number;
}

const INSTRUMENT_KINDS = new Set<InstrumentKind>(['equity', 'fund', 'fd', 'other']);
const EVENT_TYPES = new Set<InvestmentEventType>([
    'buy',
    'sell',
    'dividend',
    'interest',
    'fee',
    'price_mark',
]);

function parseNum(value: string | null | undefined): number {
    if (value == null) return 0;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

function parseNumOrNull(value: string | null | undefined): number | null {
    if (value == null) return null;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : null;
}

function roundMoney(n: number): number {
    return Math.round(n * 100) / 100;
}

function roundQty(n: number): number {
    return Math.round(n * 1e8) / 1e8;
}

function todayDateString(): string {
    return new Date().toISOString().slice(0, 10);
}

function mapKind(value: string): InstrumentKind {
    if (INSTRUMENT_KINDS.has(value as InstrumentKind)) return value as InstrumentKind;
    return 'other';
}

function mapEventType(value: string): InvestmentEventType {
    if (EVENT_TYPES.has(value as InvestmentEventType)) return value as InvestmentEventType;
    return 'buy';
}

function mapInstrument(row: typeof investmentInstruments.$inferSelect): InvestmentInstrument {
    return {
        id: row.id,
        paymentAccountId: row.paymentAccountId,
        kind: mapKind(row.kind),
        symbol: row.symbol,
        name: row.name,
        currency: row.currency,
        lastPrice: parseNumOrNull(row.lastPrice),
        lastPriceAt: row.lastPriceAt,
        principal: parseNumOrNull(row.principal),
        annualRatePct: parseNumOrNull(row.annualRatePct),
        startDate: row.startDate,
        maturityDate: row.maturityDate,
        active: row.active,
    };
}

function mapEvent(row: typeof investmentEvents.$inferSelect): InvestmentEvent {
    return {
        id: row.id,
        instrumentId: row.instrumentId,
        eventType: mapEventType(row.eventType),
        date: row.date,
        quantity: parseNumOrNull(row.quantity),
        unitPrice: parseNumOrNull(row.unitPrice),
        amount: parseNumOrNull(row.amount),
        realizedGain: parseNumOrNull(row.realizedGain),
        notes: row.notes,
        linkedIncomeId: row.linkedIncomeId,
        linkedExpenseId: row.linkedExpenseId,
    };
}

function mapLot(row: typeof investmentLots.$inferSelect): InvestmentLot {
    return {
        id: row.id,
        instrumentId: row.instrumentId,
        openedAt: row.openedAt,
        quantity: parseNum(row.quantity),
        remainingQty: parseNum(row.remainingQty),
        unitCost: parseNum(row.unitCost),
        buyEventId: row.buyEventId,
    };
}

export function isValidInstrumentKind(value: unknown): value is InstrumentKind {
    return typeof value === 'string' && INSTRUMENT_KINDS.has(value as InstrumentKind);
}

async function requireInvestmentAccount(accountId: number) {
    const account = await getPaymentAccountById(accountId);
    if (!account || !account.active) throw new Error('Investment account not found');
    if (account.accountType !== 'investment') {
        throw new Error('Portfolio is only available on investment accounts');
    }
    return account;
}

export async function getInstrumentById(id: number): Promise<InvestmentInstrument | null> {
    const db = requireDb();
    const [row] = await db
        .select()
        .from(investmentInstruments)
        .where(eq(investmentInstruments.id, id))
        .limit(1);
    return row ? mapInstrument(row) : null;
}

async function requireInstrument(id: number): Promise<InvestmentInstrument> {
    const instrument = await getInstrumentById(id);
    if (!instrument || !instrument.active) throw new Error('Instrument not found');
    return instrument;
}

export async function listInstrumentsForAccount(
    paymentAccountId: number,
    includeInactive = false
): Promise<InvestmentInstrument[]> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(investmentInstruments)
        .where(
            includeInactive
                ? eq(investmentInstruments.paymentAccountId, paymentAccountId)
                : and(
                      eq(investmentInstruments.paymentAccountId, paymentAccountId),
                      eq(investmentInstruments.active, true)
                  )
        )
        .orderBy(asc(investmentInstruments.name));
    return rows.map(mapInstrument);
}

export async function createInstrument(fields: {
    paymentAccountId: number;
    kind: InstrumentKind;
    name: string;
    symbol?: string | null;
    currency?: string;
    lastPrice?: number | null;
    principal?: number | null;
    annualRatePct?: number | null;
    startDate?: string | null;
    maturityDate?: string | null;
}): Promise<number> {
    await requireInvestmentAccount(fields.paymentAccountId);
    const name = fields.name.trim();
    if (!name) throw new Error('Instrument name is required');
    if (!isValidInstrumentKind(fields.kind)) throw new Error('Invalid instrument kind');

    if (fields.kind === 'fd') {
        if (fields.principal == null || !Number.isFinite(fields.principal) || fields.principal < 0) {
            throw new Error('FD principal is required');
        }
        if (
            fields.annualRatePct == null ||
            !Number.isFinite(fields.annualRatePct) ||
            fields.annualRatePct < 0
        ) {
            throw new Error('FD annual rate is required');
        }
        if (!fields.startDate) throw new Error('FD start date is required');
    }

    const db = requireDb();
    const lastPrice =
        fields.lastPrice != null && Number.isFinite(fields.lastPrice) ? fields.lastPrice : null;
    const [row] = await db
        .insert(investmentInstruments)
        .values({
            paymentAccountId: fields.paymentAccountId,
            kind: fields.kind,
            name,
            symbol: fields.symbol?.trim() || null,
            currency: fields.currency?.trim() || 'MYR',
            lastPrice: lastPrice != null ? String(lastPrice) : null,
            lastPriceAt: lastPrice != null ? todayDateString() : null,
            principal:
                fields.kind === 'fd' && fields.principal != null
                    ? String(roundMoney(fields.principal))
                    : null,
            annualRatePct:
                fields.kind === 'fd' && fields.annualRatePct != null
                    ? String(fields.annualRatePct)
                    : null,
            startDate: fields.kind === 'fd' ? fields.startDate ?? null : null,
            maturityDate: fields.kind === 'fd' ? fields.maturityDate ?? null : null,
        })
        .returning({ id: investmentInstruments.id });
    return row.id;
}

export async function updateInstrument(
    id: number,
    fields: {
        name?: string;
        symbol?: string | null;
        lastPrice?: number | null;
        principal?: number | null;
        annualRatePct?: number | null;
        startDate?: string | null;
        maturityDate?: string | null;
        active?: boolean;
    }
): Promise<void> {
    const existing = await requireInstrument(id);
    const db = requireDb();
    const patch: Partial<typeof investmentInstruments.$inferInsert> = {};

    if (fields.name != null) {
        const name = fields.name.trim();
        if (!name) throw new Error('Instrument name is required');
        patch.name = name;
    }
    if (fields.symbol !== undefined) patch.symbol = fields.symbol?.trim() || null;
    if (fields.active !== undefined) patch.active = fields.active;

    if (fields.lastPrice !== undefined) {
        if (fields.lastPrice == null) {
            patch.lastPrice = null;
            patch.lastPriceAt = null;
        } else {
            if (!Number.isFinite(fields.lastPrice) || fields.lastPrice < 0) {
                throw new Error('Invalid last price');
            }
            patch.lastPrice = String(fields.lastPrice);
            patch.lastPriceAt = todayDateString();
        }
    }

    if (existing.kind === 'fd') {
        if (fields.principal !== undefined) {
            if (fields.principal == null || !Number.isFinite(fields.principal) || fields.principal < 0) {
                throw new Error('Invalid FD principal');
            }
            patch.principal = String(roundMoney(fields.principal));
        }
        if (fields.annualRatePct !== undefined) {
            if (
                fields.annualRatePct == null ||
                !Number.isFinite(fields.annualRatePct) ||
                fields.annualRatePct < 0
            ) {
                throw new Error('Invalid FD annual rate');
            }
            patch.annualRatePct = String(fields.annualRatePct);
        }
        if (fields.startDate !== undefined) patch.startDate = fields.startDate;
        if (fields.maturityDate !== undefined) patch.maturityDate = fields.maturityDate;
    }

    if (Object.keys(patch).length === 0) return;
    await db.update(investmentInstruments).set(patch).where(eq(investmentInstruments.id, id));
}

export async function deactivateInstrument(id: number): Promise<void> {
    await updateInstrument(id, { active: false });
}

async function listOpenLots(instrumentId: number): Promise<InvestmentLot[]> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(investmentLots)
        .where(
            and(
                eq(investmentLots.instrumentId, instrumentId),
                gt(investmentLots.remainingQty, '0')
            )
        )
        .orderBy(asc(investmentLots.openedAt), asc(investmentLots.id));
    return rows.map(mapLot).filter((lot) => lot.remainingQty > 0);
}

function positionFromLots(
    instrument: InvestmentInstrument,
    lots: InvestmentLot[]
): { quantity: number; costBasis: number } {
    let quantity = 0;
    let costBasis = 0;
    for (const lot of lots) {
        quantity += lot.remainingQty;
        costBasis += lot.remainingQty * lot.unitCost;
    }
    return { quantity: roundQty(quantity), costBasis: roundMoney(costBasis) };
}

function holdingMarketValue(
    instrument: InvestmentInstrument,
    quantity: number,
    costBasis: number
): { marketValue: number; lastPrice: number | null } {
    if (instrument.kind === 'fd') {
        const principal = instrument.principal ?? 0;
        return { marketValue: roundMoney(principal), lastPrice: null };
    }
    const lastPrice = instrument.lastPrice;
    if (lastPrice != null) {
        return { marketValue: roundMoney(quantity * lastPrice), lastPrice };
    }
    return { marketValue: costBasis, lastPrice: null };
}

export async function sumHoldingsMarketValueByAccount(): Promise<Map<number, number>> {
    const db = requireDb();
    const instruments = await db
        .select()
        .from(investmentInstruments)
        .where(eq(investmentInstruments.active, true));
    const result = new Map<number, number>();
    if (instruments.length === 0) return result;

    const ids = instruments.map((i) => i.id);
    const lots = await db
        .select()
        .from(investmentLots)
        .where(inArray(investmentLots.instrumentId, ids));

    const lotsByInstrument = new Map<number, InvestmentLot[]>();
    for (const row of lots) {
        const lot = mapLot(row);
        if (lot.remainingQty <= 0) continue;
        const list = lotsByInstrument.get(lot.instrumentId) ?? [];
        list.push(lot);
        lotsByInstrument.set(lot.instrumentId, list);
    }

    for (const row of instruments) {
        const instrument = mapInstrument(row);
        let mv = 0;
        if (instrument.kind === 'fd') {
            mv = roundMoney(instrument.principal ?? 0);
        } else {
            const openLots = lotsByInstrument.get(instrument.id) ?? [];
            const { quantity, costBasis } = positionFromLots(instrument, openLots);
            mv = holdingMarketValue(instrument, quantity, costBasis).marketValue;
        }
        result.set(
            instrument.paymentAccountId,
            roundMoney((result.get(instrument.paymentAccountId) ?? 0) + mv)
        );
    }
    return result;
}

export async function getPortfolioSummary(paymentAccountId: number): Promise<PortfolioSummary> {
    await requireInvestmentAccount(paymentAccountId);
    const instruments = await listInstrumentsForAccount(paymentAccountId);
    const db = requireDb();

    const holdings: HoldingPosition[] = [];
    let totalCostBasis = 0;
    let totalMarketValue = 0;
    let totalUnrealizedGain = 0;

    for (const instrument of instruments) {
        if (instrument.kind === 'fd') {
            const costBasis = roundMoney(instrument.principal ?? 0);
            const marketValue = costBasis;
            holdings.push({
                instrument,
                quantity: 1,
                costBasis,
                marketValue,
                unrealizedGain: 0,
                lastPrice: null,
            });
            totalCostBasis += costBasis;
            totalMarketValue += marketValue;
            continue;
        }

        const openLots = await listOpenLots(instrument.id);
        const { quantity, costBasis } = positionFromLots(instrument, openLots);
        if (quantity <= 0 && costBasis <= 0) {
            holdings.push({
                instrument,
                quantity: 0,
                costBasis: 0,
                marketValue: 0,
                unrealizedGain: 0,
                lastPrice: instrument.lastPrice,
            });
            continue;
        }
        const { marketValue, lastPrice } = holdingMarketValue(instrument, quantity, costBasis);
        const unrealizedGain = roundMoney(marketValue - costBasis);
        holdings.push({
            instrument,
            quantity,
            costBasis,
            marketValue,
            unrealizedGain,
            lastPrice,
        });
        totalCostBasis += costBasis;
        totalMarketValue += marketValue;
        totalUnrealizedGain += unrealizedGain;
    }

    const instrumentIds = instruments.map((i) => i.id);
    let events: InvestmentEvent[] = [];
    let totalRealizedGain = 0;
    if (instrumentIds.length > 0) {
        const eventRows = await db
            .select()
            .from(investmentEvents)
            .where(inArray(investmentEvents.instrumentId, instrumentIds))
            .orderBy(desc(investmentEvents.date), desc(investmentEvents.id));
        events = eventRows.map(mapEvent);
        for (const event of events) {
            if (event.eventType === 'sell' && event.realizedGain != null) {
                totalRealizedGain += event.realizedGain;
            }
        }
    }

    return {
        paymentAccountId,
        holdings,
        events,
        totalCostBasis: roundMoney(totalCostBasis),
        totalMarketValue: roundMoney(totalMarketValue),
        totalUnrealizedGain: roundMoney(totalUnrealizedGain),
        totalRealizedGain: roundMoney(totalRealizedGain),
    };
}

export async function recordBuy(fields: {
    instrumentId: number;
    date: string;
    quantity: number;
    unitPrice: number;
    notes?: string | null;
    /** When set, creates an expense on this payment method for total cost. */
    fromPaymentMethod?: string | null;
}): Promise<{ eventId: number; lotId: number }> {
    const instrument = await requireInstrument(fields.instrumentId);
    if (instrument.kind === 'fd') throw new Error('Use FD principal fields; buys are for share lots');
    if (!Number.isFinite(fields.quantity) || fields.quantity <= 0) {
        throw new Error('Buy quantity must be positive');
    }
    if (!Number.isFinite(fields.unitPrice) || fields.unitPrice < 0) {
        throw new Error('Buy unit price is invalid');
    }

    const quantity = roundQty(fields.quantity);
    const unitPrice = fields.unitPrice;
    const amount = roundMoney(quantity * unitPrice);
    const db = requireDb();

    let linkedExpenseId: number | null = null;
    if (fields.fromPaymentMethod?.trim()) {
        linkedExpenseId = await appendExpense(
            fields.date,
            amount,
            instrument.currency || 'MYR',
            'Investment',
            fields.notes?.trim() || `Buy ${instrument.symbol || instrument.name}`,
            fields.fromPaymentMethod.trim()
        );
    }

    const [eventRow] = await db
        .insert(investmentEvents)
        .values({
            instrumentId: instrument.id,
            eventType: 'buy',
            date: fields.date,
            quantity: String(quantity),
            unitPrice: String(unitPrice),
            amount: String(amount),
            notes: fields.notes?.trim() || null,
            linkedExpenseId,
        })
        .returning({ id: investmentEvents.id });

    const [lotRow] = await db
        .insert(investmentLots)
        .values({
            instrumentId: instrument.id,
            openedAt: fields.date,
            quantity: String(quantity),
            remainingQty: String(quantity),
            unitCost: String(unitPrice),
            buyEventId: eventRow.id,
        })
        .returning({ id: investmentLots.id });

    await db
        .update(investmentInstruments)
        .set({
            lastPrice: String(unitPrice),
            lastPriceAt: fields.date,
        })
        .where(eq(investmentInstruments.id, instrument.id));

    return { eventId: eventRow.id, lotId: lotRow.id };
}

export async function recordSell(fields: {
    instrumentId: number;
    date: string;
    quantity: number;
    unitPrice: number;
    notes?: string | null;
    /** When set, creates income credited to this payment method for proceeds. */
    toPaymentMethod?: string | null;
}): Promise<{ eventId: number; realizedGain: number }> {
    const instrument = await requireInstrument(fields.instrumentId);
    if (instrument.kind === 'fd') throw new Error('FD instruments do not support share sells');
    if (!Number.isFinite(fields.quantity) || fields.quantity <= 0) {
        throw new Error('Sell quantity must be positive');
    }
    if (!Number.isFinite(fields.unitPrice) || fields.unitPrice < 0) {
        throw new Error('Sell unit price is invalid');
    }

    const sellQty = roundQty(fields.quantity);
    const unitPrice = fields.unitPrice;
    const openLots = await listOpenLots(instrument.id);
    const available = openLots.reduce((sum, lot) => sum + lot.remainingQty, 0);
    if (sellQty > available + 1e-10) {
        throw new Error(`Insufficient quantity: have ${roundQty(available)}, selling ${sellQty}`);
    }

    let remaining = sellQty;
    let costBasisSold = 0;
    const db = requireDb();

    for (const lot of openLots) {
        if (remaining <= 0) break;
        const take = Math.min(lot.remainingQty, remaining);
        costBasisSold += take * lot.unitCost;
        const newRemaining = roundQty(lot.remainingQty - take);
        await db
            .update(investmentLots)
            .set({ remainingQty: String(newRemaining) })
            .where(eq(investmentLots.id, lot.id));
        remaining = roundQty(remaining - take);
    }

    const proceeds = roundMoney(sellQty * unitPrice);
    const realizedGain = roundMoney(proceeds - costBasisSold);

    let linkedIncomeId: number | null = null;
    if (fields.toPaymentMethod?.trim()) {
        linkedIncomeId = await appendIncome(
            fields.date,
            proceeds,
            instrument.currency || 'MYR',
            'Other',
            fields.notes?.trim() || `Sell ${instrument.symbol || instrument.name}`,
            undefined,
            undefined,
            fields.toPaymentMethod.trim()
        );
    }

    const [eventRow] = await db
        .insert(investmentEvents)
        .values({
            instrumentId: instrument.id,
            eventType: 'sell',
            date: fields.date,
            quantity: String(sellQty),
            unitPrice: String(unitPrice),
            amount: String(proceeds),
            realizedGain: String(realizedGain),
            notes: fields.notes?.trim() || null,
            linkedIncomeId,
        })
        .returning({ id: investmentEvents.id });

    await db
        .update(investmentInstruments)
        .set({
            lastPrice: String(unitPrice),
            lastPriceAt: fields.date,
        })
        .where(eq(investmentInstruments.id, instrument.id));

    return { eventId: eventRow.id, realizedGain };
}

export async function recordDividend(fields: {
    instrumentId: number;
    date: string;
    amount: number;
    notes?: string | null;
    toPaymentMethod?: string | null;
}): Promise<number> {
    const instrument = await requireInstrument(fields.instrumentId);
    if (!Number.isFinite(fields.amount) || fields.amount <= 0) {
        throw new Error('Dividend amount must be positive');
    }
    const amount = roundMoney(fields.amount);
    const account = await requireInvestmentAccount(instrument.paymentAccountId);
    const creditTo = fields.toPaymentMethod?.trim() || account.name;

    const linkedIncomeId = await appendIncome(
        fields.date,
        amount,
        instrument.currency || 'MYR',
        'Other',
        fields.notes?.trim() || `Dividend ${instrument.symbol || instrument.name}`,
        undefined,
        undefined,
        creditTo
    );

    const db = requireDb();
    const [eventRow] = await db
        .insert(investmentEvents)
        .values({
            instrumentId: instrument.id,
            eventType: 'dividend',
            date: fields.date,
            amount: String(amount),
            notes: fields.notes?.trim() || null,
            linkedIncomeId,
        })
        .returning({ id: investmentEvents.id });
    return eventRow.id;
}

export async function recordInterest(fields: {
    instrumentId: number;
    date: string;
    amount: number;
    notes?: string | null;
    toPaymentMethod?: string | null;
    syncCash?: boolean;
}): Promise<number> {
    const instrument = await requireInstrument(fields.instrumentId);
    if (!Number.isFinite(fields.amount) || fields.amount <= 0) {
        throw new Error('Interest amount must be positive');
    }
    const amount = roundMoney(fields.amount);
    const syncCash = fields.syncCash !== false;
    const account = await requireInvestmentAccount(instrument.paymentAccountId);
    const creditTo = fields.toPaymentMethod?.trim() || account.name;

    let linkedIncomeId: number | null = null;
    if (syncCash) {
        linkedIncomeId = await appendIncome(
            fields.date,
            amount,
            instrument.currency || 'MYR',
            'Other',
            fields.notes?.trim() || `Interest ${instrument.name}`,
            undefined,
            undefined,
            creditTo
        );
    }

    const db = requireDb();
    const [eventRow] = await db
        .insert(investmentEvents)
        .values({
            instrumentId: instrument.id,
            eventType: 'interest',
            date: fields.date,
            amount: String(amount),
            notes: fields.notes?.trim() || null,
            linkedIncomeId,
        })
        .returning({ id: investmentEvents.id });
    return eventRow.id;
}

export async function recordPriceMark(fields: {
    instrumentId: number;
    date: string;
    unitPrice: number;
    notes?: string | null;
}): Promise<number> {
    const instrument = await requireInstrument(fields.instrumentId);
    if (instrument.kind === 'fd') throw new Error('FD uses principal; use update instead of price mark');
    if (!Number.isFinite(fields.unitPrice) || fields.unitPrice < 0) {
        throw new Error('Invalid price');
    }

    const db = requireDb();
    await db
        .update(investmentInstruments)
        .set({
            lastPrice: String(fields.unitPrice),
            lastPriceAt: fields.date,
        })
        .where(eq(investmentInstruments.id, instrument.id));

    const [eventRow] = await db
        .insert(investmentEvents)
        .values({
            instrumentId: instrument.id,
            eventType: 'price_mark',
            date: fields.date,
            unitPrice: String(fields.unitPrice),
            notes: fields.notes?.trim() || null,
        })
        .returning({ id: investmentEvents.id });
    return eventRow.id;
}

/** Simple interest: principal × rate% × days/365 from start (or last interest) to toDate. */
export async function accrueFdInterest(
    instrumentId: number,
    toDate: string,
    options?: { amountOverride?: number; toPaymentMethod?: string | null; syncCash?: boolean }
): Promise<{ eventId: number; amount: number }> {
    const instrument = await requireInstrument(instrumentId);
    if (instrument.kind !== 'fd') throw new Error('Accrue is only for FD instruments');
    if (instrument.principal == null || instrument.annualRatePct == null || !instrument.startDate) {
        throw new Error('FD is missing principal, rate, or start date');
    }

    const db = requireDb();
    const priorInterest = await db
        .select()
        .from(investmentEvents)
        .where(
            and(
                eq(investmentEvents.instrumentId, instrumentId),
                eq(investmentEvents.eventType, 'interest')
            )
        )
        .orderBy(desc(investmentEvents.date), desc(investmentEvents.id))
        .limit(1);

    const fromDate = priorInterest[0]?.date ?? instrument.startDate;
    if (toDate < fromDate) throw new Error('Accrue date must be on or after the accrual start');

    let amount: number;
    if (options?.amountOverride != null) {
        if (!Number.isFinite(options.amountOverride) || options.amountOverride <= 0) {
            throw new Error('Interest override must be positive');
        }
        amount = roundMoney(options.amountOverride);
    } else {
        const start = new Date(`${fromDate}T00:00:00Z`);
        const end = new Date(`${toDate}T00:00:00Z`);
        const days = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000));
        if (days <= 0) throw new Error('No days to accrue since last interest / start date');
        amount = roundMoney(
            (instrument.principal * instrument.annualRatePct * days) / (100 * 365)
        );
        if (amount <= 0) throw new Error('Computed interest is zero');
    }

    // Idempotent: skip if an interest event already exists for this exact date with same amount
    const sameDay = await db
        .select()
        .from(investmentEvents)
        .where(
            and(
                eq(investmentEvents.instrumentId, instrumentId),
                eq(investmentEvents.eventType, 'interest'),
                eq(investmentEvents.date, toDate)
            )
        )
        .limit(1);
    if (sameDay[0]) {
        const existingAmount = parseNum(sameDay[0].amount);
        if (Math.abs(existingAmount - amount) < 0.005) {
            return { eventId: sameDay[0].id, amount: existingAmount };
        }
    }

    const eventId = await recordInterest({
        instrumentId,
        date: toDate,
        amount,
        notes: `FD interest accrued to ${toDate}`,
        toPaymentMethod: options?.toPaymentMethod,
        syncCash: options?.syncCash,
    });
    return { eventId, amount };
}

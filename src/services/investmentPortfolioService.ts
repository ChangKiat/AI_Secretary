import { and, asc, desc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { requireDb } from '../db/client';
import {
    expenses,
    fixedExpenses,
    investmentEvents,
    investmentInstruments,
    investmentLots,
} from '../db/schema';
import { resolveCategory } from '../config/expenseCategories';
import { resolvePaymentMethod } from '../config/paymentMethods';
import { appendExpense } from './expenseService';
import { appendIncome, type DbExecutor } from './incomeService';
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

export interface AccountHoldingSummary {
    id: number;
    name: string;
    kind: InstrumentKind;
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

function roundUnitCost(n: number): number {
    return Math.round(n * 1e6) / 1e6;
}

function parseFee(fee: number | null | undefined): number {
    if (fee == null) return 0;
    if (!Number.isFinite(fee) || fee < 0) {
        throw new Error('Fee must be a non-negative number');
    }
    return roundMoney(fee);
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

function addCalendarMonths(dateStr: string, months: number): string {
    const [year, month, day] = dateStr.split('-').map(Number);
    const lastOfTarget = new Date(year, month - 1 + months + 1, 0);
    const clampedDay = Math.min(day, lastOfTarget.getDate());
    const result = new Date(year, month - 1 + months, clampedDay);
    const y = result.getFullYear();
    const m = String(result.getMonth() + 1).padStart(2, '0');
    const d = String(result.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

async function requireActiveAccount(accountId: number) {
    const account = await getPaymentAccountById(accountId);
    if (!account || !account.active) throw new Error('Account not found');
    return account;
}

async function requireInvestmentAccount(accountId: number) {
    const account = await requireActiveAccount(accountId);
    if (account.accountType !== 'investment') {
        throw new Error('Portfolio is only available on investment accounts');
    }
    return account;
}

async function requirePortfolioHostAccount(accountId: number) {
    const account = await requireActiveAccount(accountId);
    if (account.accountType !== 'account' && account.accountType !== 'investment') {
        throw new Error('Portfolio is only available on bank or investment accounts');
    }
    return account;
}

async function requireInstrumentAccount(accountId: number, kind: InstrumentKind) {
    if (kind === 'fd') return requirePortfolioHostAccount(accountId);
    return requireInvestmentAccount(accountId);
}

export async function sumFdLockedForAccount(accountId: number): Promise<number> {
    const instruments = await listInstrumentsForAccount(accountId);
    let locked = 0;
    for (const instrument of instruments) {
        if (instrument.kind !== 'fd') continue;
        locked += instrument.principal ?? 0;
    }
    return roundMoney(locked);
}

export async function sumFdLockedByAccount(): Promise<Map<number, number>> {
    const db = requireDb();
    const rows = await db
        .select()
        .from(investmentInstruments)
        .where(and(eq(investmentInstruments.active, true), eq(investmentInstruments.kind, 'fd')));
    const result = new Map<number, number>();
    for (const row of rows) {
        const principal = roundMoney(parseNum(row.principal));
        if (principal <= 0) continue;
        result.set(
            row.paymentAccountId,
            roundMoney((result.get(row.paymentAccountId) ?? 0) + principal)
        );
    }
    return result;
}

/** Expenses that paid for a holding buy — their cash went into the holding. */
export async function listInvestedExpenseIds(): Promise<Set<number>> {
    const db = requireDb();
    const rows = await db
        .select({ expenseId: investmentEvents.linkedExpenseId })
        .from(investmentEvents)
        .where(and(eq(investmentEvents.eventType, 'buy'), isNotNull(investmentEvents.linkedExpenseId)));
    return new Set(rows.map((row) => row.expenseId!));
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
    tenureMonths?: number | null;
    cashBalance?: number;
}): Promise<number> {
    const account = await requireInstrumentAccount(fields.paymentAccountId, fields.kind);
    const name = fields.name.trim();
    if (!name) throw new Error('Instrument name is required');
    if (!isValidInstrumentKind(fields.kind)) throw new Error('Invalid instrument kind');

    let maturityDate = fields.maturityDate ?? null;
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
        if (
            fields.tenureMonths != null &&
            (!Number.isInteger(fields.tenureMonths) || fields.tenureMonths <= 0)
        ) {
            throw new Error('FD tenure months must be a positive integer');
        }
        if (fields.tenureMonths != null) {
            maturityDate = addCalendarMonths(fields.startDate, fields.tenureMonths);
        } else if (!maturityDate) {
            throw new Error('FD tenure months is required');
        }

        if (account.accountType === 'account') {
            if (fields.cashBalance == null || !Number.isFinite(fields.cashBalance)) {
                throw new Error('Cash balance is required to allocate FD');
            }
            const locked = await sumFdLockedForAccount(account.id);
            const available = roundMoney(fields.cashBalance - locked);
            if (roundMoney(fields.principal) > available + 0.005) {
                throw new Error(`FD principal exceeds available cash (${available.toFixed(2)})`);
            }
        }
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
                    : fields.kind === 'fund'
                      ? String(roundMoney(fields.principal ?? 0))
                      : null,
            annualRatePct:
                fields.kind === 'fd' && fields.annualRatePct != null
                    ? String(fields.annualRatePct)
                    : null,
            startDate: fields.kind === 'fd' ? fields.startDate ?? null : null,
            maturityDate: fields.kind === 'fd' ? maturityDate : null,
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

    if (existing.kind === 'fd' || existing.kind === 'fund') {
        if (fields.principal !== undefined) {
            if (fields.principal == null || !Number.isFinite(fields.principal) || fields.principal < 0) {
                throw new Error(existing.kind === 'fund' ? 'Invalid invested amount' : 'Invalid FD principal');
            }
            patch.principal = String(roundMoney(fields.principal));
        }
        if (existing.kind === 'fd' && fields.annualRatePct !== undefined) {
            if (
                fields.annualRatePct == null ||
                !Number.isFinite(fields.annualRatePct) ||
                fields.annualRatePct < 0
            ) {
                throw new Error('Invalid FD annual rate');
            }
            patch.annualRatePct = String(fields.annualRatePct);
        }
        if (existing.kind === 'fd') {
            if (fields.startDate !== undefined) patch.startDate = fields.startDate;
            if (fields.maturityDate !== undefined) patch.maturityDate = fields.maturityDate;
        }
    }

    if (Object.keys(patch).length === 0) return;
    if (patch.active === false) {
        // Deactivating a holding also unlinks the fixed bills that contribute to it (as the FK's
        // ON DELETE SET NULL would), so they fall back to plain Investment bills in both apps
        // instead of failing every contribution run.
        await db.transaction(async (tx) => {
            await tx.update(investmentInstruments).set(patch).where(eq(investmentInstruments.id, id));
            await tx
                .update(fixedExpenses)
                .set({ instrumentId: null })
                .where(eq(fixedExpenses.instrumentId, id));
        });
        return;
    }
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
    _instrument: InvestmentInstrument,
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

function isPrincipalFund(instrument: InvestmentInstrument): boolean {
    return instrument.kind === 'fund' && instrument.principal != null;
}

function fundPosition(instrument: InvestmentInstrument): {
    costBasis: number;
    marketValue: number;
    lastPrice: number | null;
} {
    const costBasis = roundMoney(instrument.principal ?? 0);
    const marketValue =
        instrument.lastPrice != null ? roundMoney(instrument.lastPrice) : costBasis;
    return { costBasis, marketValue, lastPrice: instrument.lastPrice };
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
    if (isPrincipalFund(instrument)) {
        const pos = fundPosition(instrument);
        return { marketValue: pos.marketValue, lastPrice: pos.lastPrice };
    }
    const lastPrice = instrument.lastPrice;
    if (lastPrice != null) {
        return { marketValue: roundMoney(quantity * lastPrice), lastPrice };
    }
    return { marketValue: costBasis, lastPrice: null };
}

export async function sumHoldingsByAccount(): Promise<{
    marketValue: Map<number, number>;
    costBasis: Map<number, number>;
    unrealizedGain: Map<number, number>;
    names: Map<number, string[]>;
    holdings: Map<number, AccountHoldingSummary[]>;
}> {
    const db = requireDb();
    const instruments = await db
        .select()
        .from(investmentInstruments)
        .where(eq(investmentInstruments.active, true));
    const marketValue = new Map<number, number>();
    const costBasisByAccount = new Map<number, number>();
    const unrealizedGain = new Map<number, number>();
    const names = new Map<number, string[]>();
    const holdings = new Map<number, AccountHoldingSummary[]>();
    if (instruments.length === 0) {
        return { marketValue, costBasis: costBasisByAccount, unrealizedGain, names, holdings };
    }

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

    const addMoney = (map: Map<number, number>, accountId: number, amount: number) => {
        map.set(accountId, roundMoney((map.get(accountId) ?? 0) + amount));
    };

    for (const row of instruments) {
        const instrument = mapInstrument(row);
        let mv = 0;
        let costBasis = 0;
        let gain = 0;
        if (instrument.kind === 'fd') {
            costBasis = roundMoney(instrument.principal ?? 0);
            mv = costBasis;
        } else if (isPrincipalFund(instrument)) {
            const pos = fundPosition(instrument);
            costBasis = pos.costBasis;
            mv = pos.marketValue;
            gain = roundMoney(mv - costBasis);
        } else {
            const openLots = lotsByInstrument.get(instrument.id) ?? [];
            const position = positionFromLots(instrument, openLots);
            costBasis = position.costBasis;
            mv = holdingMarketValue(instrument, position.quantity, costBasis).marketValue;
            gain = roundMoney(mv - costBasis);
        }
        addMoney(marketValue, instrument.paymentAccountId, mv);
        addMoney(costBasisByAccount, instrument.paymentAccountId, costBasis);
        addMoney(unrealizedGain, instrument.paymentAccountId, gain);
        const list = names.get(instrument.paymentAccountId) ?? [];
        list.push(instrument.name);
        names.set(instrument.paymentAccountId, list);
        const holdingList = holdings.get(instrument.paymentAccountId) ?? [];
        holdingList.push({ id: instrument.id, name: instrument.name, kind: instrument.kind });
        holdings.set(instrument.paymentAccountId, holdingList);
    }
    for (const list of names.values()) {
        list.sort((a, b) => a.localeCompare(b, 'en-MY', { sensitivity: 'base' }));
    }
    for (const list of holdings.values()) {
        list.sort((a, b) => a.name.localeCompare(b.name, 'en-MY', { sensitivity: 'base' }));
    }
    return { marketValue, costBasis: costBasisByAccount, unrealizedGain, names, holdings };
}

export async function sumHoldingsMarketValueByAccount(): Promise<Map<number, number>> {
    const { marketValue } = await sumHoldingsByAccount();
    return marketValue;
}

export async function getPortfolioSummary(paymentAccountId: number): Promise<PortfolioSummary> {
    await requirePortfolioHostAccount(paymentAccountId);
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

        if (isPrincipalFund(instrument)) {
            const { costBasis, marketValue, lastPrice } = fundPosition(instrument);
            const unrealizedGain = roundMoney(marketValue - costBasis);
            holdings.push({
                instrument,
                quantity: 1,
                costBasis,
                marketValue,
                unrealizedGain,
                lastPrice,
            });
            totalCostBasis += costBasis;
            totalMarketValue += marketValue;
            totalUnrealizedGain += unrealizedGain;
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
    /** Brokerage / clearing / stamp; added to cash out and lot cost. */
    fee?: number | null;
    /** When set, creates an expense on this payment method for total cost. */
    fromPaymentMethod?: string | null;
}): Promise<{ eventId: number; lotId: number }> {
    const instrument = await requireInstrument(fields.instrumentId);
    if (instrument.kind === 'fd') throw new Error('Use FD principal fields; buys are for share lots');
    if (instrument.kind === 'fund') throw new Error('Use unit trust invest');
    if (!Number.isFinite(fields.quantity) || fields.quantity <= 0) {
        throw new Error('Buy quantity must be positive');
    }
    if (!Number.isFinite(fields.unitPrice) || fields.unitPrice < 0) {
        throw new Error('Buy unit price is invalid');
    }

    const quantity = roundQty(fields.quantity);
    const unitPrice = fields.unitPrice;
    const gross = roundMoney(quantity * unitPrice);
    const fee = parseFee(fields.fee);
    const amount = roundMoney(gross + fee);
    const unitCost = roundUnitCost(amount / quantity);
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
            unitCost: String(unitCost),
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
    /** Brokerage / clearing / stamp; subtracted from proceeds. */
    fee?: number | null;
    /** When set, creates income credited to this payment method for proceeds. */
    toPaymentMethod?: string | null;
}): Promise<{ eventId: number; realizedGain: number }> {
    const instrument = await requireInstrument(fields.instrumentId);
    if (instrument.kind === 'fd') throw new Error('FD instruments do not support share sells');
    if (instrument.kind === 'fund') throw new Error('Use unit trust withdraw');
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

    const gross = roundMoney(sellQty * unitPrice);
    const fee = parseFee(fields.fee);
    if (fee > gross) {
        throw new Error('Sell fee cannot exceed proceeds');
    }
    const proceeds = roundMoney(gross - fee);
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

/**
 * The Investment expense a unit trust invest debits, inserted on `executor` so it joins the
 * buy's transaction. Same columns as appendExpense (expenseService, which takes no executor);
 * keep the two in step.
 */
async function insertInvestExpense(
    executor: DbExecutor,
    fields: { date: string; amount: number; currency: string; description: string; paymentMethod: string }
): Promise<number> {
    const [row] = await executor
        .insert(expenses)
        .values({
            date: fields.date,
            amount: String(fields.amount),
            currency: fields.currency || 'MYR',
            category: resolveCategory('Investment'),
            description: fields.description,
            paymentMethod: resolvePaymentMethod(fields.paymentMethod),
        })
        .returning({ id: expenses.id });
    return row.id;
}

/**
 * Writes the expense (unless `linkedExpenseId` reuses one), the principal update and the buy
 * together: on `executor` when the caller passes its transaction (a fixed-bill contribution adds
 * its funding transfer to it), otherwise in a transaction of its own.
 */
export async function recordFundInvest(
    fields: {
        instrumentId: number;
        date: string;
        amount: number;
        notes?: string | null;
        fromPaymentMethod?: string | null;
        /** Reuse an expense already logged for this contribution instead of adding another. */
        linkedExpenseId?: number | null;
    },
    executor?: DbExecutor
): Promise<{ eventId: number; linkedExpenseId: number }> {
    const instrument = await requireInstrument(fields.instrumentId);
    if (instrument.kind !== 'fund') throw new Error('Invest is only for unit trusts');
    if (!Number.isFinite(fields.amount) || fields.amount <= 0) {
        throw new Error('Amount must be positive');
    }
    const amount = roundMoney(fields.amount);
    const principal = roundMoney((instrument.principal ?? 0) + amount);
    const lastPrice = roundMoney((instrument.lastPrice ?? instrument.principal ?? 0) + amount);
    const account = await requireInvestmentAccount(instrument.paymentAccountId);
    const debitFrom = fields.fromPaymentMethod?.trim() || account.name;

    const write = async (db: DbExecutor) => {
        const linkedExpenseId =
            fields.linkedExpenseId ??
            (await insertInvestExpense(db, {
                date: fields.date,
                amount,
                currency: instrument.currency || 'MYR',
                description: fields.notes?.trim() || `Invest ${instrument.name}`,
                paymentMethod: debitFrom,
            }));

        await db
            .update(investmentInstruments)
            .set({
                principal: String(principal),
                lastPrice: String(lastPrice),
                lastPriceAt: fields.date,
            })
            .where(eq(investmentInstruments.id, instrument.id));

        const [eventRow] = await db
            .insert(investmentEvents)
            .values({
                instrumentId: instrument.id,
                eventType: 'buy',
                date: fields.date,
                amount: String(amount),
                notes: fields.notes?.trim() || null,
                linkedExpenseId,
            })
            .returning({ id: investmentEvents.id });
        return { eventId: eventRow.id, linkedExpenseId };
    };
    return executor ? write(executor) : requireDb().transaction(write);
}

export async function recordFundWithdraw(fields: {
    instrumentId: number;
    date: string;
    amount: number;
    notes?: string | null;
    toPaymentMethod?: string | null;
}): Promise<{ eventId: number }> {
    const instrument = await requireInstrument(fields.instrumentId);
    if (instrument.kind !== 'fund') throw new Error('Withdraw is only for unit trusts');
    if (!Number.isFinite(fields.amount) || fields.amount <= 0) {
        throw new Error('Amount must be positive');
    }
    const amount = roundMoney(fields.amount);
    const principal = roundMoney(instrument.principal ?? 0);
    if (amount > principal + 0.005) {
        throw new Error(`Amount cannot exceed invested (${principal.toFixed(2)})`);
    }
    const newPrincipal = roundMoney(principal - amount);
    const currentValue = instrument.lastPrice ?? principal;
    const newValue = roundMoney(Math.max(0, currentValue - amount));
    const account = await requireInvestmentAccount(instrument.paymentAccountId);
    const creditTo = fields.toPaymentMethod?.trim() || account.name;

    const linkedIncomeId = await appendIncome(
        fields.date,
        amount,
        instrument.currency || 'MYR',
        'Other',
        fields.notes?.trim() || `Withdraw ${instrument.name}`,
        undefined,
        undefined,
        creditTo
    );

    const db = requireDb();
    await db
        .update(investmentInstruments)
        .set({
            principal: String(newPrincipal),
            lastPrice: String(newValue),
            lastPriceAt: fields.date,
        })
        .where(eq(investmentInstruments.id, instrument.id));

    const [eventRow] = await db
        .insert(investmentEvents)
        .values({
            instrumentId: instrument.id,
            eventType: 'sell',
            date: fields.date,
            amount: String(amount),
            notes: fields.notes?.trim() || null,
            linkedIncomeId,
        })
        .returning({ id: investmentEvents.id });
    return { eventId: eventRow.id };
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
    const account = await requirePortfolioHostAccount(instrument.paymentAccountId);
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

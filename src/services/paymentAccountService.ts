import { and, asc, eq } from 'drizzle-orm';
import { requireDb } from '../db/client';
import { paymentAccounts } from '../db/schema';

export type PaymentAccountType = 'account' | 'credit' | 'investment';

export const DEFAULT_REBATE_CATEGORIES = ['Petrol', 'Groceries', 'Dining', 'Grab'] as const;

export type RebateRuleType = 'simple' | 'tiered';

export interface DescriptionMappingRule {
    keywords: string[];
    rebateCategory: string;
    expenseCategory?: string;
}

export interface SimpleRebateCategory {
    name: string;
    cap: number | null;
    isDefault?: boolean;
    fixedRate?: number;
}

export interface SimpleRebateConfig {
    enabled: true;
    ruleType: 'simple';
    minSpendThreshold: number;
    highRate: number;
    lowRate: number;
    categoryCap: number;
    rebateCategories: string[];
    categories?: SimpleRebateCategory[];
    categoryMappings: Record<string, string>;
    descriptionRules?: DescriptionMappingRule[];
}

export interface RebateCategoryDef {
    name: string;
    cap: number | null;
    isDefault?: boolean;
    fixedRate?: number;
    minSpendPerMapping?: number;
    minTotalSpend?: number;
}

export interface RebateTier {
    minTotalSpend: number;
    rates: Record<string, number>;
}

export interface TieredRebateConfig {
    enabled: true;
    ruleType: 'tiered';
    tiers: RebateTier[];
    categories: RebateCategoryDef[];
    categoryMappings: Record<string, string>;
    descriptionRules?: DescriptionMappingRule[];
}

export type RebateConfig = SimpleRebateConfig | TieredRebateConfig;

export function isSimpleRebateConfig(config: RebateConfig): config is SimpleRebateConfig {
    return config.ruleType === 'simple';
}

export function isTieredRebateConfig(config: RebateConfig): config is TieredRebateConfig {
    return config.ruleType === 'tiered';
}

export interface PaymentAccount {
    id: number;
    name: string;
    accountType: PaymentAccountType;
    initialBalance: number;
    balanceBaselineDate: string;
    creditLimit: number | null;
    statementDay: number | null;
    rebateConfig: RebateConfig | null;
    active: boolean;
}

/** Default seed — keep in sync with scripts/init-db.sql */
export const DEFAULT_PAYMENT_ACCOUNTS: { name: string; accountType: PaymentAccountType }[] = [
    { name: 'TnG', accountType: 'account' },
    { name: 'CIMB', accountType: 'account' },
    { name: 'GrabPay', accountType: 'account' },
    { name: 'ShopeePay', accountType: 'account' },
    { name: 'Cash', accountType: 'account' },
    { name: 'Maybank', accountType: 'account' },
    { name: 'Public Bank', accountType: 'account' },
    { name: 'UOB', accountType: 'account' },
    { name: 'Credit Card', accountType: 'credit' },
];

function parseAmount(value: string | null | undefined): number {
    if (value == null) return 0;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : 0;
}

function todayDateString(): string {
    return new Date().toISOString().slice(0, 10);
}

function mapAccountType(value: string): PaymentAccountType {
    if (value === 'credit') return 'credit';
    if (value === 'investment') return 'investment';
    return 'account';
}

function parseCategoryMappings(obj: Record<string, unknown>): Record<string, string> {
    const categoryMappings: Record<string, string> = {};
    if (obj.categoryMappings != null && typeof obj.categoryMappings === 'object') {
        for (const [key, val] of Object.entries(obj.categoryMappings as Record<string, unknown>)) {
            if (typeof val === 'string' && val.trim() !== '') {
                categoryMappings[key.trim()] = val.trim();
            }
        }
    }
    return categoryMappings;
}

function parseDescriptionRules(obj: Record<string, unknown>): DescriptionMappingRule[] {
    const rules: DescriptionMappingRule[] = [];
    if (!Array.isArray(obj.descriptionRules)) return rules;
    for (const item of obj.descriptionRules) {
        if (item == null || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        if (typeof r.rebateCategory !== 'string' || !r.rebateCategory.trim()) continue;
        const keywords: string[] = [];
        if (Array.isArray(r.keywords)) {
            for (const kw of r.keywords) {
                if (typeof kw === 'string' && kw.trim()) keywords.push(kw.trim());
            }
        }
        if (keywords.length === 0) continue;
        const rule: DescriptionMappingRule = {
            keywords,
            rebateCategory: r.rebateCategory.trim(),
        };
        if (typeof r.expenseCategory === 'string' && r.expenseCategory.trim()) {
            rule.expenseCategory = r.expenseCategory.trim();
        }
        rules.push(rule);
    }
    return rules;
}

function parseCategoryExtras(c: Record<string, unknown>): {
    isDefault?: boolean;
    fixedRate?: number;
} {
    const extras: { isDefault?: boolean; fixedRate?: number } = {};
    if (c.isDefault === true) extras.isDefault = true;
    if (typeof c.fixedRate === 'number' && c.fixedRate >= 0) extras.fixedRate = c.fixedRate;
    return extras;
}

function parseCap(value: unknown, fallback: number | null): number | null {
    if (value === null) return null;
    if (typeof value === 'number' && value >= 0) return value;
    return fallback;
}

function parseSimpleRebateConfig(obj: Record<string, unknown>): SimpleRebateConfig {
    const minSpendThreshold =
        typeof obj.minSpendThreshold === 'number' && obj.minSpendThreshold >= 0
            ? obj.minSpendThreshold
            : 1500;
    const highRate =
        typeof obj.highRate === 'number' && obj.highRate >= 0 ? obj.highRate : 0.1;
    const lowRate = typeof obj.lowRate === 'number' && obj.lowRate >= 0 ? obj.lowRate : 0.002;
    const categoryCap =
        typeof obj.categoryCap === 'number' && obj.categoryCap >= 0 ? obj.categoryCap : 15;
    const rebateCategories = Array.isArray(obj.rebateCategories)
        ? obj.rebateCategories.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
        : [...DEFAULT_REBATE_CATEGORIES];

    let categories: SimpleRebateCategory[] | undefined;
    if (Array.isArray(obj.categories)) {
        const parsed: SimpleRebateCategory[] = [];
        for (const cat of obj.categories) {
            if (cat == null || typeof cat !== 'object') continue;
            const c = cat as Record<string, unknown>;
            if (typeof c.name !== 'string' || !c.name.trim()) continue;
            const cap = parseCap(c.cap, categoryCap);
            parsed.push({ name: c.name.trim(), cap, ...parseCategoryExtras(c) });
        }
        if (parsed.length > 0) categories = parsed;
    }
    if (!categories) {
        categories = rebateCategories.map((name) => ({ name, cap: categoryCap }));
    }

    return {
        enabled: true,
        ruleType: 'simple',
        minSpendThreshold,
        highRate,
        lowRate,
        categoryCap,
        rebateCategories: categories.map((c) => c.name),
        categories,
        categoryMappings: parseCategoryMappings(obj),
        descriptionRules: parseDescriptionRules(obj),
    };
}

function parseTieredRebateConfig(obj: Record<string, unknown>): TieredRebateConfig {
    const tiers: RebateTier[] = [];
    if (Array.isArray(obj.tiers)) {
        for (const tier of obj.tiers) {
            if (tier == null || typeof tier !== 'object') continue;
            const t = tier as Record<string, unknown>;
            const minTotalSpend =
                typeof t.minTotalSpend === 'number' && t.minTotalSpend >= 0 ? t.minTotalSpend : 0;
            const rates: Record<string, number> = {};
            if (t.rates != null && typeof t.rates === 'object') {
                for (const [key, val] of Object.entries(t.rates as Record<string, unknown>)) {
                    if (typeof val === 'number' && val >= 0) rates[key] = val;
                }
            }
            tiers.push({ minTotalSpend, rates });
        }
    }
    tiers.sort((a, b) => b.minTotalSpend - a.minTotalSpend);

    const categories: RebateCategoryDef[] = [];
    if (Array.isArray(obj.categories)) {
        for (const cat of obj.categories) {
            if (cat == null || typeof cat !== 'object') continue;
            const c = cat as Record<string, unknown>;
            if (typeof c.name !== 'string' || !c.name.trim()) continue;
            const cap = parseCap(c.cap, 0);
            const def: RebateCategoryDef = { name: c.name.trim(), cap, ...parseCategoryExtras(c) };
            if (typeof c.minSpendPerMapping === 'number' && c.minSpendPerMapping >= 0) {
                def.minSpendPerMapping = c.minSpendPerMapping;
            }
            if (typeof c.minTotalSpend === 'number' && c.minTotalSpend >= 0) {
                def.minTotalSpend = c.minTotalSpend;
            }
            categories.push(def);
        }
    }

    return {
        enabled: true,
        ruleType: 'tiered',
        tiers,
        categories,
        categoryMappings: parseCategoryMappings(obj),
        descriptionRules: parseDescriptionRules(obj),
    };
}

function parseRebateConfig(value: unknown): RebateConfig | null {
    if (value == null || typeof value !== 'object') return null;
    const obj = value as Record<string, unknown>;
    if (obj.enabled !== true) return null;
    if (obj.ruleType === 'tiered') return parseTieredRebateConfig(obj);
    return parseSimpleRebateConfig(obj);
}

export function normalizeRebateConfig(value: unknown): RebateConfig | null {
    if (value == null) return null;
    if (typeof value === 'object' && (value as { enabled?: boolean }).enabled === false) return null;
    return parseRebateConfig(value);
}

export function isValidRebateConfig(value: unknown): value is RebateConfig | null {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    if (obj.enabled === false) return true;
    if (obj.enabled !== true) return false;
    if (obj.ruleType === 'tiered') {
        if (!Array.isArray(obj.tiers) || !Array.isArray(obj.categories)) return false;
        if (obj.categoryMappings != null && typeof obj.categoryMappings !== 'object') return false;
        if (obj.descriptionRules != null && !Array.isArray(obj.descriptionRules)) return false;
        return true;
    }
    if (obj.minSpendThreshold != null && (typeof obj.minSpendThreshold !== 'number' || obj.minSpendThreshold < 0)) {
        return false;
    }
    if (obj.highRate != null && (typeof obj.highRate !== 'number' || obj.highRate < 0)) return false;
    if (obj.lowRate != null && (typeof obj.lowRate !== 'number' || obj.lowRate < 0)) return false;
    if (obj.categoryCap != null && (typeof obj.categoryCap !== 'number' || obj.categoryCap < 0)) return false;
    if (obj.categoryMappings != null && typeof obj.categoryMappings !== 'object') return false;
    if (obj.descriptionRules != null && !Array.isArray(obj.descriptionRules)) return false;
    return true;
}

function mapRow(row: typeof paymentAccounts.$inferSelect): PaymentAccount {
    return {
        id: row.id,
        name: row.name,
        accountType: mapAccountType(row.accountType),
        initialBalance: parseAmount(row.initialBalance),
        balanceBaselineDate: row.balanceBaselineDate,
        creditLimit: row.creditLimit != null ? parseAmount(row.creditLimit) : null,
        statementDay: row.statementDay ?? null,
        rebateConfig: parseRebateConfig(row.rebateConfig),
        active: row.active,
    };
}

export function isValidStatementDay(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31;
}

export function normalizePaymentAccountName(name: string): string {
    return name.trim();
}

export function isValidPaymentAccountType(value: string): value is PaymentAccountType {
    return value === 'account' || value === 'credit' || value === 'investment';
}

export function isDebitBalanceType(accountType: PaymentAccountType): boolean {
    return accountType === 'account' || accountType === 'investment';
}

async function ensureDefaultPaymentAccounts(): Promise<void> {
    const db = requireDb();
    const rows = await db.select().from(paymentAccounts).limit(1);
    if (rows.length > 0) return;
    
    await db.insert(paymentAccounts).values(
        DEFAULT_PAYMENT_ACCOUNTS.map((account) => ({
            name: account.name,
            accountType: account.accountType,
            active: true,
            initialBalance: '0',
            balanceBaselineDate: todayDateString(),
            creditLimit: account.accountType === 'credit' ? '0' : null,
        }))
    );
}

export async function listActivePaymentAccounts(): Promise<PaymentAccount[]> {
    const db = requireDb();
    await ensureDefaultPaymentAccounts();
    const rows = await db
        .select()
        .from(paymentAccounts)
        .where(eq(paymentAccounts.active, true))
        .orderBy(asc(paymentAccounts.name));

    return rows.map(mapRow);
}

export async function getPaymentAccountById(id: number): Promise<PaymentAccount | null> {
    const db = requireDb();
    const rows = await db.select().from(paymentAccounts).where(eq(paymentAccounts.id, id)).limit(1);
    return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function createPaymentAccount(
    name: string,
    accountType: PaymentAccountType,
    fields?: {
        initialBalance?: number;
        creditLimit?: number | null;
        statementDay?: number | null;
        rebateConfig?: RebateConfig | null;
    }
): Promise<number> {
    const db = requireDb();
    const normalized = normalizePaymentAccountName(name);
    if (!normalized) throw new Error('Account name is required');
    const initialBalance = String(fields?.initialBalance ?? 0);
    const creditLimit =
        accountType === 'credit'
            ? String(fields?.creditLimit ?? 0)
            : null;
    const balanceBaselineDate = todayDateString();
    const statementDay =
        accountType === 'credit' && fields?.statementDay != null
            ? fields.statementDay
            : null;
    const rebateConfig =
        accountType === 'credit' && fields?.rebateConfig != null
            ? fields.rebateConfig
            : null;

    const [row] = await db
        .insert(paymentAccounts)
        .values({
            name: normalized,
            accountType,
            active: true,
            initialBalance,
            balanceBaselineDate,
            creditLimit,
            statementDay,
            rebateConfig,
        })
        .returning({ id: paymentAccounts.id });

    return row.id;
}

export async function updatePaymentAccount(
    id: number,
    fields: {
        name?: string;
        accountType?: PaymentAccountType;
        initialBalance?: number;
        creditLimit?: number | null;
        statementDay?: number | null;
        rebateConfig?: RebateConfig | null;
        active?: boolean;
    }
): Promise<boolean> {
    const db = requireDb();
    const set: Record<string, string | boolean | number | null | RebateConfig> = {};

    if (fields.name != null) {
        const normalized = normalizePaymentAccountName(fields.name);
        if (!normalized) throw new Error('Account name is required');
        set.name = normalized;
    }

    if (fields.accountType != null) {
        set.accountType = fields.accountType;

        if (fields.accountType === 'credit') {
            if (fields.initialBalance == null) {
                set.initialBalance = '0';
                set.balanceBaselineDate = todayDateString();
            }
        } else if (fields.creditLimit === undefined) {
            set.creditLimit = null;
            if (fields.statementDay === undefined) {
                set.statementDay = null;
            }
            if (fields.rebateConfig === undefined) {
                set.rebateConfig = null;
            }
        }
    }

    if (fields.initialBalance != null) {
        set.initialBalance = String(fields.initialBalance);
        set.balanceBaselineDate = todayDateString();
    }

    if (fields.creditLimit !== undefined) {
        set.creditLimit = fields.creditLimit == null ? null : String(fields.creditLimit);
    }

    if (fields.statementDay !== undefined) {
        set.statementDay = fields.statementDay;
    }

    if (fields.rebateConfig !== undefined) {
        set.rebateConfig = fields.rebateConfig;
    }

    if (fields.active != null) set.active = fields.active;

    if (Object.keys(set).length === 0) return false;

    const result = await db
        .update(paymentAccounts)
        .set(set)
        .where(eq(paymentAccounts.id, id));

    return (result.count ?? 0) > 0;
}

export async function deactivatePaymentAccount(id: number): Promise<boolean> {
    const db = requireDb();
    const result = await db
        .update(paymentAccounts)
        .set({ active: false })
        .where(and(eq(paymentAccounts.id, id), eq(paymentAccounts.active, true)));

    return (result.count ?? 0) > 0;
}

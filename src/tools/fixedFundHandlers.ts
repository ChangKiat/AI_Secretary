import type { Context } from 'telegraf';
import type { ChatSession } from '../config/ai';
import { resolveCategory } from '../config/expenseCategories';
import {
    getExpensePaymentAccountNames,
    getPaymentAccountNames,
    type PaymentMethodMatch,
} from '../config/paymentMethods';
import { resolvePaymentMethodMatchFresh } from '../config/cacheRefresh';
import type { SpecialistDomain } from '../config/prompts';
import {
    addFixedExpense,
    getActiveFixedExpenses,
    updateFixedExpenseById,
} from '../services/expenseService';
import {
    attachHoldingContributionStatus,
    resolveContributionHolding,
} from '../services/fixedContributionService';
import {
    fundingDestination,
    isInvestmentCategory,
    isOtherCategory,
    normalizeOtherAccounts,
    validateFundingAccounts,
} from '../services/incomeService';
import {
    findFundInstrumentByName,
    getInstrumentById,
    listActiveFundHoldings,
    recordFundInvest,
    recordFundWithdraw,
    type FundHolding,
} from '../services/investmentPortfolioService';
import type { ToolCallResult } from './toolHandler';

// Handlers behind the fixed-bill tools (add_fixed_expense, update_fixed_expense,
// get_all_fixed_expenses) and the unit trust tools (invest_in_fund, withdraw_from_fund), plus the
// [HOLDINGS] context hint. toolHandler.ts dispatches to them; replies are built here (only
// get_all_fixed_expenses relays the model's text, and it is in TOOLS_READING_MODEL_REPLY).

type FunctionResponse = Record<string, unknown>;

async function respond(
    chat: ChatSession,
    ctx: Context,
    name: string,
    response: FunctionResponse,
    text: string,
    result: ToolCallResult = 'complete'
): Promise<ToolCallResult> {
    await chat.sendMessage([{ functionResponse: { name, response } }]);
    await ctx.reply(text);
    return result;
}

function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function money(amount: number): string {
    return amount.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function textArg(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
}

// --- Accounts the user named (3.2: never silently stored as "no account") -----------------------

type AccountArg =
    | { ok: true; name: string | null }
    | { ok: false; input: string; match: PaymentMethodMatch; candidates: string[] };

/**
 * Empty input → { ok, name: null }. Otherwise the active account it resolves to, after one forced
 * cache reload (the account may have just been added on the Dashboard). "cash" with no active Cash
 * account is stored as no account without a warning, like trip cash.
 */
async function resolveAccountArg(raw: unknown): Promise<AccountArg> {
    const input = textArg(raw);
    if (!input) return { ok: true, name: null };
    const resolution = await resolvePaymentMethodMatchFresh(input);
    if (resolution.name) return { ok: true, name: resolution.name };
    if (/^cash$/i.test(input)) return { ok: true, name: null };
    return { ok: false, input, match: resolution.match, candidates: resolution.candidates ?? [] };
}

function accountProblem(
    arg: Extract<AccountArg, { ok: false }>,
    field: string,
    known: string[]
): { response: FunctionResponse; text: string } {
    const response: FunctionResponse = {
        status: 'unknown_payment_method',
        field,
        input: arg.input,
        match: arg.match,
        known,
        ...(arg.candidates.length > 0 ? { candidates: arg.candidates } : {}),
    };
    if (arg.match === 'ambiguous') {
        return {
            response,
            text: `⚠️ "${arg.input}" matches several accounts: ${arg.candidates.join(', ')}. Which one?`,
        };
    }
    if (arg.match === 'inactive') {
        return {
            response,
            text: `⚠️ "${arg.candidates[0] ?? arg.input}" is a deactivated account. Which active account should I use?`,
        };
    }
    return {
        response,
        text:
            `⚠️ I couldn't find an account called "${arg.input}". Which one is it?` +
            (known.length > 0 ? ` Your accounts: ${known.join(', ')}.` : '') +
            ' New accounts are added in the Dashboard Setup tab.',
    };
}

// --- Unit trust holdings ----------------------------------------------------------------------

function fundLabel(fund: FundHolding): string {
    return `${fund.name} (${fund.accountName})`;
}

/** The unit trust the user named, or the reply asking which one (ambiguous or not found). */
async function resolveFundArg(
    raw: unknown
): Promise<{ fund: FundHolding } | { response: FunctionResponse; text: string }> {
    const input = textArg(raw);
    const lookup = await findFundInstrumentByName(input);
    if ('match' in lookup) return { fund: lookup.match };
    if (lookup.candidates.length > 0) {
        const labels = lookup.candidates.map(fundLabel);
        return {
            response: { status: 'holding_ambiguous', input, candidates: labels },
            text: input
                ? `⚠️ "${input}" matches several unit trusts: ${labels.join(', ')}. Which one?`
                : `Which unit trust? ${labels.join(', ')}.`,
        };
    }
    const known = (await listActiveFundHoldings()).map(fundLabel);
    return {
        response: { status: 'holding_not_found', input, known },
        text:
            known.length > 0
                ? `⚠️ I couldn't find a unit trust called "${input}". Yours: ${known.join(', ')}. Which one? (Stocks, ETFs and FDs are recorded on the Dashboard.)`
                : '⚠️ You have no active unit trust holdings. Add the holding in its investment account\'s portfolio on the Dashboard (Cashflow tab → Account balances) first.',
    };
}

/** [HOLDINGS] lines for one domain's prompt; '' when there are no active unit trusts. */
export function formatHoldingsHint(funds: FundHolding[], domain: SpecialistDomain): string {
    if (funds.length === 0) return '';
    const use =
        domain === 'expense'
            ? 'A top-up or buy into one of these → invest_in_fund (it also logs the Investment expense, so never log_expense it too); money taken out → withdraw_from_fund. Pass the name as holding.'
            : domain === 'financeConfig'
              ? 'A recurring contribution into one of these → add_fixed_expense with category Investment and holding set to its name.'
              : '';
    if (!use) return '';
    const names = funds.map((fund) => `"${fund.name}" (${fund.accountName})`).join(', ');
    return `\n[HOLDINGS] Active unit trusts (name, investment account): ${names}.\n${use}`;
}

/**
 * [HOLDINGS] hint per specialist that uses it (expense, financeConfig), like the [TRIPS] hint.
 * One query for the whole turn; a failed query only drops the hint.
 */
export async function buildHoldingsContextHints(
    domains: SpecialistDomain[]
): Promise<Partial<Record<SpecialistDomain, string>>> {
    const wanted = domains.filter((d) => d === 'expense' || d === 'financeConfig');
    if (wanted.length === 0) return {};
    let funds: FundHolding[];
    try {
        funds = await listActiveFundHoldings();
    } catch (error) {
        console.warn('[HOLDINGS] hint skipped:', error);
        return {};
    }
    return Object.fromEntries(wanted.map((d) => [d, formatHoldingsHint(funds, d)]));
}

// --- Fixed bills --------------------------------------------------------------------------------

type FixedBill = Awaited<ReturnType<typeof getActiveFixedExpenses>>[number];

function isDayOfMonth(day: number): boolean {
    return Number.isInteger(day) && day >= 1 && day <= 31;
}

function frequencyWord(frequency: number): string {
    if (frequency === 1) return 'monthly';
    if (frequency === 3) return 'quarterly';
    if (frequency === 12) return 'yearly';
    return `every ${frequency} months`;
}

function billLabel(bill: FixedBill): string {
    const accounts =
        (bill.paymentMethod ? `, ${bill.paymentMethod}` : '') +
        (bill.toInvestmentAccount ? ` → ${bill.toInvestmentAccount}` : '');
    return `#${bill.id} ${bill.description} (${bill.category}, ${bill.currency} ${bill.amount}, day ${bill.dayOfMonth}${accounts})`;
}

/**
 * The active bill to change: by id when given, else by description (exact, case-insensitive,
 * then "contains"). Several matches are returned as candidates (two "StashAway" bills exist).
 */
export function pickFixedBill<T extends { id: number; description: string }>(
    bills: T[],
    id: unknown,
    description: unknown
): { bill: T } | { status: 'missing' | 'not_found' | 'ambiguous'; candidates: T[] } {
    const wantedId = typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null;
    if (wantedId != null) {
        const bill = bills.find((b) => b.id === wantedId);
        return bill ? { bill } : { status: 'not_found', candidates: [] };
    }
    const query = textArg(description).toLowerCase();
    if (!query) return { status: 'missing', candidates: [] };
    const exact = bills.filter((b) => b.description.trim().toLowerCase() === query);
    const hits =
        exact.length > 0 ? exact : bills.filter((b) => b.description.toLowerCase().includes(query));
    if (hits.length === 1) return { bill: hits[0] };
    return { status: hits.length === 0 ? 'not_found' : 'ambiguous', candidates: hits };
}

/** What an Investment / Other bill still lacks, as the user would name it. */
function missingFundingAccounts(from: string | null, to: string | null): string[] {
    const missing: string[] = [];
    if (!from) missing.push('the account it is paid from');
    if (!to) missing.push('the unit trust or investment account it goes to');
    return missing;
}

export interface AddFixedExpenseArgs {
    dayOfMonth?: number;
    amount: number;
    frequencyInMonths?: number;
    currency?: string;
    category?: string;
    description?: string;
    paymentMethod?: string;
    toInvestmentAccount?: string;
    holding?: string;
}

export async function addFixedExpenseTool(
    args: AddFixedExpenseArgs,
    chat: ChatSession,
    ctx: Context
): Promise<ToolCallResult> {
    const name = 'add_fixed_expense';
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
        return respond(chat, ctx, name, { status: 'invalid_amount' }, '⚠️ The bill amount must be a positive number.');
    }
    const finalDay = Number(args.dayOfMonth || 1);
    if (!isDayOfMonth(finalDay)) {
        return respond(chat, ctx, name, { status: 'invalid_day' }, '⚠️ The day of the month must be a whole number from 1 to 31.');
    }
    const frequency = Number(args.frequencyInMonths || 1);
    if (!Number.isInteger(frequency) || frequency < 1) {
        return respond(chat, ctx, name, { status: 'invalid_frequency' }, '⚠️ How often it repeats must be a whole number of months.');
    }
    const startMonth = parseInt(
        new Date().toLocaleString('en-US', {
            timeZone: 'Asia/Kuala_Lumpur',
            month: 'numeric',
        })
    );
    const currency = args.currency || 'MYR';
    const holdingInput = textArg(args.holding);
    // A unit trust holding is only valid on an Investment bill, so it implies that category.
    const category = resolveCategory(args.category || (holdingInput ? 'Investment' : undefined));
    const description = args.description || `Recurring ${category}`;

    const from = await resolveAccountArg(args.paymentMethod);
    if (!from.ok) {
        const problem = accountProblem(from, 'paymentMethod', getExpensePaymentAccountNames());
        return respond(chat, ctx, name, problem.response, problem.text, 'awaiting_input');
    }
    const to = await resolveAccountArg(args.toInvestmentAccount);
    if (!to.ok) {
        const problem = accountProblem(to, 'toInvestmentAccount', getPaymentAccountNames());
        return respond(chat, ctx, name, problem.response, problem.text, 'awaiting_input');
    }

    let paymentMethod = from.name;
    let toInvestmentAccount = to.name;
    let instrumentId: number | null = null;
    let holdingName: string | null = null;
    if (holdingInput) {
        if (!isInvestmentCategory(category)) {
            return respond(
                chat,
                ctx,
                name,
                { status: 'holding_needs_investment', category },
                `⚠️ A unit trust holding only goes on an Investment bill, but this one is ${category}. Should it be an Investment bill?`,
                'awaiting_input'
            );
        }
        const picked = await resolveFundArg(holdingInput);
        if (!('fund' in picked)) {
            return respond(chat, ctx, name, picked.response, picked.text, 'awaiting_input');
        }
        // Same rule as the Dashboard: the holding's investment account is the destination.
        const holding = await resolveContributionHolding(picked.fund.id);
        if ('error' in holding) {
            return respond(chat, ctx, name, { status: 'error', error: holding.error }, `⚠️ ${holding.error}.`);
        }
        instrumentId = holding.instrumentId;
        toInvestmentAccount = holding.parentName;
        holdingName = picked.fund.name;
    }

    let ignoredDestination: string | null = null;
    if (isOtherCategory(category)) {
        ({ paymentMethod, toInvestmentAccount } = normalizeOtherAccounts(paymentMethod, toInvestmentAccount));
    } else if (!isInvestmentCategory(category) && toInvestmentAccount) {
        ignoredDestination = toInvestmentAccount;
        toInvestmentAccount = null;
    }

    const fundingError = validateFundingAccounts(category, paymentMethod, toInvestmentAccount, 'fixed');
    if (fundingError) {
        const missing = missingFundingAccounts(paymentMethod, toInvestmentAccount);
        return respond(
            chat,
            ctx,
            name,
            { status: 'needs_accounts', error: fundingError, paymentMethod, toInvestmentAccount },
            missing.length > 0 && isInvestmentCategory(category)
                ? `⚠️ An Investment bill needs the account it is paid from and the unit trust or investment account it goes to. What is ${missing.join(' and ')}?`
                : `⚠️ ${fundingError}.`,
            missing.length > 0 ? 'awaiting_input' : 'complete'
        );
    }

    try {
        await addFixedExpense(
            finalDay,
            amount,
            currency,
            category,
            description,
            frequency,
            startMonth,
            paymentMethod,
            toInvestmentAccount,
            null,
            instrumentId
        );
    } catch (err) {
        return respond(chat, ctx, name, { status: 'error', error: errorText(err) }, `⚠️ Couldn't save the bill: ${errorText(err)}`);
    }

    const destination = fundingDestination(category, paymentMethod, toInvestmentAccount);
    await chat.sendMessage([
        {
            functionResponse: {
                name,
                response: {
                    status: 'success',
                    category,
                    paymentMethod,
                    toInvestmentAccount: destination,
                    holding: holdingName,
                },
            },
        },
    ]);
    const parts = [
        `🔄 Done! I've set up a ${frequencyWord(frequency)} rule to log ${currency} ${amount} for ${description} on the ${finalDay} of the month.`,
    ];
    if (paymentMethod) parts.push(`Paid via: ${paymentMethod}.`);
    if (destination) parts.push(`Goes to: ${destination}${holdingName ? ` · ${holdingName}` : ''}.`);
    if (ignoredDestination) {
        parts.push(`(No transfer to ${ignoredDestination}: only Investment and Other bills move money to another account.)`);
    }
    if (category.toLowerCase() === 'loan') {
        parts.push('Loan terms (balance, rate, tenure) are set up in the Dashboard Setup tab.');
    }
    await ctx.reply(parts.join(' '));
    return 'complete';
}

export interface UpdateFixedExpenseArgs {
    id?: number;
    description?: string;
    newAmount?: number;
    dayOfMonth?: number;
    paymentMethod?: string;
    toInvestmentAccount?: string;
}

export async function updateFixedExpenseTool(
    args: UpdateFixedExpenseArgs,
    chat: ChatSession,
    ctx: Context
): Promise<ToolCallResult> {
    const name = 'update_fixed_expense';
    const picked = pickFixedBill(await getActiveFixedExpenses(), args.id, args.description);
    if (!('bill' in picked)) {
        const candidates = picked.candidates.map(billLabel);
        const text =
            picked.status === 'missing'
                ? 'Which recurring bill should I change? Give its name or #id.'
                : picked.status === 'ambiguous'
                  ? `Several recurring bills match "${textArg(args.description)}":\n${candidates.join('\n')}\nWhich one (#id)?`
                  : `⚠️ I couldn't find a recurring bill matching ${args.id ? `#${args.id}` : `"${textArg(args.description)}"`}.`;
        return respond(
            chat,
            ctx,
            name,
            { status: picked.status, ...(candidates.length > 0 ? { candidates } : {}) },
            text,
            picked.status === 'not_found' ? 'complete' : 'awaiting_input'
        );
    }
    const bill = picked.bill;
    const fields: Parameters<typeof updateFixedExpenseById>[1] = {};
    const changes: string[] = [];

    if (args.newAmount != null) {
        const amount = Number(args.newAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
            return respond(chat, ctx, name, { status: 'invalid_amount' }, '⚠️ The new amount must be a positive number.');
        }
        fields.amount = amount;
        changes.push(
            `amount ${bill.currency} ${bill.amount} → ${bill.currency} ${amount}` +
                (bill.loanMethod ? ' (the monthly installment; the loan balance is unchanged)' : '')
        );
    }
    if (args.dayOfMonth != null) {
        const day = Number(args.dayOfMonth);
        if (!isDayOfMonth(day)) {
            return respond(chat, ctx, name, { status: 'invalid_day' }, '⚠️ The day of the month must be a whole number from 1 to 31.');
        }
        fields.dayOfMonth = day;
        changes.push(`day ${bill.dayOfMonth} → ${day}`);
    }

    const fromGiven = textArg(args.paymentMethod) !== '';
    const toGiven = textArg(args.toInvestmentAccount) !== '';
    const from = await resolveAccountArg(args.paymentMethod);
    if (!from.ok) {
        const problem = accountProblem(from, 'paymentMethod', getExpensePaymentAccountNames());
        return respond(chat, ctx, name, problem.response, problem.text, 'awaiting_input');
    }
    const to = await resolveAccountArg(args.toInvestmentAccount);
    if (!to.ok) {
        const problem = accountProblem(to, 'toInvestmentAccount', getPaymentAccountNames());
        return respond(chat, ctx, name, problem.response, problem.text, 'awaiting_input');
    }

    const investment = isInvestmentCategory(bill.category);
    const other = isOtherCategory(bill.category);
    if (toGiven && !investment && !other) {
        return respond(
            chat,
            ctx,
            name,
            { status: 'not_applicable', category: bill.category },
            `⚠️ Only Investment and Other bills send money to another account; "${bill.description}" is ${bill.category}.`
        );
    }
    if (fromGiven || toGiven) {
        let nextFrom = fromGiven ? from.name : bill.paymentMethod;
        let nextTo = toGiven ? to.name : bill.toInvestmentAccount;
        if (investment && bill.instrumentId != null) {
            // Same rule as the Dashboard: a holding-linked bill's money goes to the holding's account.
            const holding = await resolveContributionHolding(bill.instrumentId);
            if ('error' in holding) {
                return respond(
                    chat,
                    ctx,
                    name,
                    { status: 'error', error: holding.error },
                    `⚠️ ${holding.error} (the unit trust on bill #${bill.id}). Fix the bill's holding in the Dashboard Setup tab.`
                );
            }
            if (toGiven && nextTo?.toLowerCase() !== holding.parentName.toLowerCase()) {
                return respond(
                    chat,
                    ctx,
                    name,
                    { status: 'destination_follows_holding', holdingAccount: holding.parentName },
                    `⚠️ Bill #${bill.id} buys into a unit trust held in ${holding.parentName}, so its money goes to ${holding.parentName}. To send it elsewhere, change the bill's holding in the Dashboard Setup tab.`
                );
            }
            nextTo = holding.parentName;
        }
        if (other) {
            ({ paymentMethod: nextFrom, toInvestmentAccount: nextTo } = normalizeOtherAccounts(nextFrom, nextTo));
        }
        const fundingError = validateFundingAccounts(bill.category, nextFrom, nextTo, 'fixed');
        if (fundingError) {
            const missing = investment ? missingFundingAccounts(nextFrom, nextTo) : [];
            return respond(
                chat,
                ctx,
                name,
                { status: 'needs_accounts', error: fundingError },
                missing.length > 0 ? `⚠️ ${fundingError}. What is ${missing.join(' and ')}?` : `⚠️ ${fundingError}.`,
                missing.length > 0 ? 'awaiting_input' : 'complete'
            );
        }
        if (other) {
            fields.paymentMethod = nextFrom;
            fields.toInvestmentAccount = fundingDestination(bill.category, nextFrom, nextTo);
        } else {
            if (fromGiven) fields.paymentMethod = nextFrom;
            if (toGiven) fields.toInvestmentAccount = nextTo;
        }
        const changed = (a: string | null | undefined, b: string | null) =>
            (a ?? '').toLowerCase() !== (b ?? '').toLowerCase();
        if (fields.paymentMethod !== undefined && changed(fields.paymentMethod, bill.paymentMethod)) {
            changes.push(`paid via ${bill.paymentMethod ?? 'no account'} → ${fields.paymentMethod ?? 'no account'}`);
        }
        if (fields.toInvestmentAccount !== undefined && changed(fields.toInvestmentAccount, bill.toInvestmentAccount)) {
            changes.push(`goes to ${bill.toInvestmentAccount ?? 'no account'} → ${fields.toInvestmentAccount ?? 'no account'}`);
        }
    }

    if (Object.keys(fields).length === 0) {
        return respond(
            chat,
            ctx,
            name,
            { status: 'nothing_to_update', bill: billLabel(bill) },
            `What should I change on ${billLabel(bill)}: the amount, day of month, paying account or destination?`,
            'awaiting_input'
        );
    }

    let ok: boolean;
    try {
        ok = await updateFixedExpenseById(bill.id, fields);
    } catch (err) {
        return respond(chat, ctx, name, { status: 'error', error: errorText(err) }, `⚠️ ${errorText(err)}`);
    }
    if (!ok) {
        return respond(chat, ctx, name, { status: 'not_found' }, `⚠️ Recurring bill #${bill.id} no longer exists.`);
    }

    const lines = [
        `✅ Updated recurring bill #${bill.id} ${bill.description}: ${changes.length > 0 ? changes.join('; ') : 'no visible change'}.`,
    ];
    // An Investment bill with no from / to account logs no transfer at 9am and is refused on Dashboard edits.
    if (investment && !fromGiven && !toGiven) {
        const missing = missingFundingAccounts(bill.paymentMethod, bill.toInvestmentAccount);
        if (missing.length > 0) {
            lines.push(`⚠️ This Investment bill still lacks ${missing.join(' and ')}, so its monthly transfer is not logged. Tell me which account to use.`);
        }
    }
    return respond(chat, ctx, name, { status: 'success', id: bill.id, changed: fields }, lines.join('\n'));
}

/** get_all_fixed_expenses: the Dashboard Fixed table's view of each active bill. */
export async function listFixedExpensesTool(chat: ChatSession, ctx: Context): Promise<ToolCallResult> {
    const bills = await attachHoldingContributionStatus(await getActiveFixedExpenses());
    const expenses = bills
        .sort((a, b) => a.dayOfMonth - b.dayOfMonth || a.id - b.id)
        .map((bill) => ({
            id: bill.id,
            description: bill.description,
            category: bill.category,
            amount: bill.amount,
            currency: bill.currency,
            dayOfMonth: bill.dayOfMonth,
            frequencyMonths: bill.frequencyMonths,
            paymentMethod: bill.paymentMethod,
            toInvestmentAccount: bill.toInvestmentAccount,
            instrumentName: bill.instrumentName,
            contributedThisMonth: bill.instrumentId != null ? bill.contributedThisMonth : null,
            loanMethod: bill.loanMethod,
            remainingPrincipal: bill.remainingPrincipal,
        }));
    const toolResult = await chat.sendMessage([
        {
            functionResponse: {
                name: 'get_all_fixed_expenses',
                response: {
                    expenses,
                    note:
                        'Show each bill with its #id. paymentMethod = paid from; toInvestmentAccount = where the money goes (Investment/Other). ' +
                        'contributedThisMonth applies only to unit trust bills (instrumentName set): true = this month\'s buy is recorded, false = not yet. ' +
                        'remainingPrincipal is the loan balance for Loan bills with loan terms; their amount is the monthly installment.',
                },
            },
        },
    ]);
    const text = toolResult.response.text();
    await ctx.reply(
        text.trim()
            ? text
            : expenses.length > 0
              ? expenses
                    .map((e) => `#${e.id} ${e.description}: ${e.currency} ${e.amount}, day ${e.dayOfMonth}`)
                    .join('\n')
              : 'You have no active recurring bills.'
    );
    return 'complete';
}

// --- Unit trust top-ups and withdrawals ---------------------------------------------------------

export interface FundMoveArgs {
    holding?: string;
    amount?: number;
    date?: string;
    fromPaymentMethod?: string;
    toPaymentMethod?: string;
}

/** invest_in_fund: one transaction writes the Investment expense, the buy and the new principal. */
export async function investInFundTool(
    args: FundMoveArgs,
    date: string,
    chat: ChatSession,
    ctx: Context
): Promise<ToolCallResult> {
    const name = 'invest_in_fund';
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
        return respond(chat, ctx, name, { status: 'invalid_amount' }, '⚠️ The amount must be a positive number.');
    }
    const picked = await resolveFundArg(args.holding);
    if (!('fund' in picked)) return respond(chat, ctx, name, picked.response, picked.text, 'awaiting_input');
    const fund = picked.fund;

    const from = await resolveAccountArg(args.fromPaymentMethod);
    if (!from.ok) {
        const problem = accountProblem(from, 'fromPaymentMethod', getPaymentAccountNames());
        return respond(chat, ctx, name, problem.response, problem.text, 'awaiting_input');
    }
    if (!from.name) {
        return respond(
            chat,
            ctx,
            name,
            { status: 'needs_from_account', holding: fund.name },
            `Which account did the RM ${money(amount)} for ${fund.name} come from? (Say "${fund.accountName}" if it was paid from cash already on that platform.)`,
            'awaiting_input'
        );
    }

    let linkedExpenseId: number;
    try {
        ({ linkedExpenseId } = await recordFundInvest({
            instrumentId: fund.id,
            date,
            amount,
            fromPaymentMethod: from.name,
        }));
    } catch (err) {
        return respond(chat, ctx, name, { status: 'error', error: errorText(err) }, `⚠️ Couldn't record the top-up: ${errorText(err)}`);
    }
    // The top-up is committed: a failed re-read must not turn it into an error (or a retried, doubled top-up).
    const investedNow = (await getInstrumentById(fund.id).catch(() => null))?.principal ?? fund.principal + amount;
    return respond(
        chat,
        ctx,
        name,
        {
            status: 'success',
            holding: fund.name,
            account: fund.accountName,
            amount,
            date,
            fromPaymentMethod: from.name,
            expenseId: linkedExpenseId,
            investedNow,
        },
        [
            `📈 Invested RM ${money(amount)} into ${fundLabel(fund)}`,
            `📅 Date: ${date}`,
            `💳 From: ${from.name}`,
            `💼 Invested now: RM ${money(investedNow)}`,
            `🧾 Investment expense #${linkedExpenseId} (change or undo it from the holding on the Dashboard)`,
        ].join('\n')
    );
}

/** withdraw_from_fund: lowers the principal and logs the money received in the to-account. */
export async function withdrawFromFundTool(
    args: FundMoveArgs,
    date: string,
    chat: ChatSession,
    ctx: Context
): Promise<ToolCallResult> {
    const name = 'withdraw_from_fund';
    const amount = Number(args.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
        return respond(chat, ctx, name, { status: 'invalid_amount' }, '⚠️ The amount must be a positive number.');
    }
    const picked = await resolveFundArg(args.holding);
    if (!('fund' in picked)) return respond(chat, ctx, name, picked.response, picked.text, 'awaiting_input');
    const fund = picked.fund;

    const to = await resolveAccountArg(args.toPaymentMethod);
    if (!to.ok) {
        const problem = accountProblem(to, 'toPaymentMethod', getPaymentAccountNames());
        return respond(chat, ctx, name, problem.response, problem.text, 'awaiting_input');
    }
    if (!to.name) {
        return respond(
            chat,
            ctx,
            name,
            { status: 'needs_to_account', holding: fund.name },
            `Which account did the RM ${money(amount)} from ${fund.name} go to? (Say "${fund.accountName}" if it stayed as cash on that platform.)`,
            'awaiting_input'
        );
    }

    try {
        await recordFundWithdraw({ instrumentId: fund.id, date, amount, toPaymentMethod: to.name });
    } catch (err) {
        return respond(chat, ctx, name, { status: 'error', error: errorText(err) }, `⚠️ Couldn't record the withdrawal: ${errorText(err)}`);
    }
    const investedNow =
        (await getInstrumentById(fund.id).catch(() => null))?.principal ?? Math.max(0, fund.principal - amount);
    return respond(
        chat,
        ctx,
        name,
        {
            status: 'success',
            holding: fund.name,
            account: fund.accountName,
            amount,
            date,
            toPaymentMethod: to.name,
            investedNow,
        },
        [
            `📉 Withdrew RM ${money(amount)} from ${fundLabel(fund)}`,
            `📅 Date: ${date}`,
            `🏦 To: ${to.name}`,
            `💼 Invested now: RM ${money(investedNow)}`,
        ].join('\n')
    );
}

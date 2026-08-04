import { SchemaType } from '@google/generative-ai';
import { buildPlannerInstruction, buildDomainInstruction, SpecialistDomain } from './index';
import { getDomainDeclarations, getPlannerDeclarations, routeRequestDeclaration } from '../../tools/tools';
import { getExpenseCategoryNames } from '../expenseCategories';

const DOMAINS: SpecialistDomain[] = ['expense', 'meal', 'calendar', 'workout'];

function assert(condition: boolean, message: string) {
    if (!condition) throw new Error(message);
}

const planner = buildPlannerInstruction();
assert(planner.length > 0, 'plannerPrompt must be non-empty');

for (const domain of DOMAINS) {
    const instruction = buildDomainInstruction(domain, getExpenseCategoryNames());
    assert(instruction.length > 0, `${domain} prompt must be non-empty`);
}

const plannerTools = getPlannerDeclarations();
assert(plannerTools.length === 1, 'planner should have one tool');
assert(plannerTools[0].name === 'route_request', 'planner tool must be route_request');

const routeDomains = routeRequestDeclaration.parameters?.properties?.domains;
assert(routeDomains?.type === SchemaType.ARRAY, 'route_request.domains must be an array');

const namesByDomain = Object.fromEntries(
    DOMAINS.map((d) => [d, getDomainDeclarations(d).map((t: { name: string }) => t.name)])
) as Record<SpecialistDomain, string[]>;

for (let i = 0; i < DOMAINS.length; i++) {
    for (let j = i + 1; j < DOMAINS.length; j++) {
        const a = DOMAINS[i];
        const b = DOMAINS[j];
        const overlap = namesByDomain[a].filter(
            (n) => namesByDomain[b].includes(n) && n !== 'update_user_settings'
        );
        assert(overlap.length === 0, `tool overlap between ${a} and ${b}: ${overlap.join(', ')}`);
    }
}

assert(
    planner.includes('Restaurant') && planner.includes('expense AND meal'),
    'planner must route restaurant receipts to expense AND meal'
);
assert(
    planner.includes('payment caption') && planner.includes('never chat alone'),
    'planner must not chat-only on receipt images with payment captions'
);
assert(
    planner.includes('statement') && planner.toLowerCase().includes('expense only'),
    'planner must keep bank statements expense-only'
);

const expensePrompt = buildDomainInstruction('expense', getExpenseCategoryNames());
assert(
    expensePrompt.includes('grand total') || expensePrompt.includes('RESTAURANT RECEIPT'),
    'expense prompt must log restaurant grand total only'
);

const mealDomainPrompt = buildDomainInstruction('meal', getExpenseCategoryNames());
assert(
    mealDomainPrompt.includes('RESTAURANT RECEIPT') &&
        mealDomainPrompt.includes('Which items are yours?'),
    'meal prompt must support receipt item selection'
);

const calendarTools = namesByDomain.calendar;
assert(
    calendarTools.includes('reschedule_calendar_event') &&
        calendarTools.includes('cancel_calendar_event'),
    'calendar must include reschedule_calendar_event and cancel_calendar_event'
);

console.log('prompts/_check: ok');

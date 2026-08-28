import { basePrompt } from './base';
import { plannerPrompt } from './planner';
import { buildExpensePrompt, documentExpensePrompt } from './expense';
import { buildFinanceConfigPrompt } from './financeConfig';
import { mealPrompt } from './meal';
import { calendarPrompt } from './calendar';
import { workoutPrompt } from './workout';

export type SpecialistDomain = 'expense' | 'financeConfig' | 'meal' | 'calendar' | 'workout';
export type RouteDomain = SpecialistDomain | 'chat';

export {
    plannerPrompt,
    buildExpensePrompt,
    buildFinanceConfigPrompt,
    documentExpensePrompt,
    mealPrompt,
    calendarPrompt,
    workoutPrompt,
};

export function buildPlannerInstruction(): string {
    return plannerPrompt;
}

export function buildDomainInstruction(
    domain: SpecialistDomain,
    categoryNames: string[]
): string {
    const domainPart =
        domain === 'expense'
            ? buildExpensePrompt(categoryNames)
            : domain === 'financeConfig'
              ? buildFinanceConfigPrompt(categoryNames)
              : domain === 'meal'
                ? mealPrompt
                : domain === 'calendar'
                  ? calendarPrompt
                  : workoutPrompt;
    return `${basePrompt}\n\n${domainPart}`;
}

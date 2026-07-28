import { buildDomainInstruction } from './prompts';

/** @deprecated Use buildDomainInstruction or buildPlannerInstruction */
export function buildSystemInstruction(categoryNames: string[]): string {
    return buildDomainInstruction('expense', categoryNames);
}

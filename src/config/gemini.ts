import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { buildPlannerInstruction, buildDomainInstruction, SpecialistDomain } from './prompts';
import { getExpenseCategoryNames } from './expenseCategories';
import { getDomainDeclarations, getPlannerDeclarations } from '../tools/tools';

export const GEMINI_MODEL_DEFAULT =
    process.env.GEMINI_MODEL_DEFAULT || 'gemini-2.5-flash-lite';
export const GEMINI_MODEL_HEAVY =
    process.env.GEMINI_MODEL_HEAVY || 'gemini-2.5-flash';

/** Skip Gemini planner; route with keyword heuristics instead. */
export const SKIP_PLANNER = /^(1|true|yes)$/i.test(
    (process.env.SKIP_PLANNER || '').trim()
);

const generationConfig = {
    maxOutputTokens: 2048,
    temperature: 0.1,
};

export function createPlannerModel(genAI: GoogleGenerativeAI): GenerativeModel {
    return genAI.getGenerativeModel({
        model: GEMINI_MODEL_DEFAULT,
        generationConfig,
        tools: [{ functionDeclarations: getPlannerDeclarations() }],
        systemInstruction: buildPlannerInstruction(),
    });
}

export function createDomainModel(
    genAI: GoogleGenerativeAI,
    domain: SpecialistDomain,
    options?: { heavy?: boolean }
): GenerativeModel {
    const categoryNames = getExpenseCategoryNames();
    const modelName =
        options?.heavy && domain === 'expense' ? GEMINI_MODEL_HEAVY : GEMINI_MODEL_DEFAULT;
    return genAI.getGenerativeModel({
        model: modelName,
        generationConfig,
        tools: [{ functionDeclarations: getDomainDeclarations(domain) }],
        systemInstruction: buildDomainInstruction(domain, categoryNames),
    });
}

/** @deprecated Use createPlannerModel or createDomainModel */
export function createGeminiModel(
    genAI: GoogleGenerativeAI,
    modelName: string
): GenerativeModel {
    const categoryNames = getExpenseCategoryNames();
    const domain: SpecialistDomain = 'expense';
    return genAI.getGenerativeModel({
        model: modelName,
        generationConfig,
        tools: [{ functionDeclarations: getDomainDeclarations(domain) }],
        systemInstruction: buildDomainInstruction(domain, categoryNames),
    });
}

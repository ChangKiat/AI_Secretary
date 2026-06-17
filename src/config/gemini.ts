import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { buildSystemInstruction } from './config';
import { getExpenseCategoryNames } from './expenseCategories';
import { getAllFunctionDeclarations } from '../tools/tools';

export const GEMINI_MODEL_DEFAULT =
    process.env.GEMINI_MODEL_DEFAULT || 'gemini-2.5-flash-lite';
export const GEMINI_MODEL_HEAVY =
    process.env.GEMINI_MODEL_HEAVY || 'gemini-2.5-flash';

export function createGeminiModel(
    genAI: GoogleGenerativeAI,
    modelName: string
): GenerativeModel {
    const categoryNames = getExpenseCategoryNames();
    return genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.1,
        },
        tools: [{ functionDeclarations: getAllFunctionDeclarations() }],
        systemInstruction: buildSystemInstruction(categoryNames),
    });
}

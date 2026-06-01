import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { SYSTEM_INSTRUCTION } from './config';
import { allFunctionDeclarations } from '../tools/tools';

export const GEMINI_MODEL_DEFAULT =
    process.env.GEMINI_MODEL_DEFAULT || 'gemini-2.5-flash-lite';
export const GEMINI_MODEL_HEAVY =
    process.env.GEMINI_MODEL_HEAVY || 'gemini-2.5-flash';

export function createGeminiModel(
    genAI: GoogleGenerativeAI,
    modelName: string
): GenerativeModel {
    return genAI.getGenerativeModel({
        model: modelName,
        generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.1,
        },
        tools: [{ functionDeclarations: allFunctionDeclarations }],
        systemInstruction: SYSTEM_INSTRUCTION,
    });
}

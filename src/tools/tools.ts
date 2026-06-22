import { FunctionDeclaration, SchemaType } from '@google/generative-ai';
import { getExpenseCategoryDescription } from '../config/expenseCategories';

function categoryParam(prefix = ''): { type: SchemaType.STRING; description: string } {
    const base = getExpenseCategoryDescription();
    return { type: SchemaType.STRING, description: prefix ? `${prefix} ${base}` : base };
}

function buildLogExpenseDeclaration(): FunctionDeclaration {
    return {
        name: 'log_expense',
        description:
            'Logs a SINGLE expense from a standard receipt or text message. DO NOT use this tool if the user uploads a bank statement, credit card statement, or list of multiple expenses. Use log_bulk_expenses instead.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                amount: { type: SchemaType.NUMBER, description: 'The cost or amount spent.' },
                currency: { type: SchemaType.STRING, description: 'The currency code, e.g., MYR or USD.' },
                category: categoryParam(),
                description: { type: SchemaType.STRING, description: 'Brief description of what was purchased.' },
                date: {
                    type: SchemaType.STRING,
                    description:
                        'Format: YYYY-MM-DD. MUST be the exact date the transaction occurred. Look at the receipt date to determine the correct year. NEVER use the current system date.',
                },
            },
            required: ['amount', 'currency', 'category', 'description'],
        },
    };
}

function buildGetSummaryDeclaration(): FunctionDeclaration {
    return {
        name: 'get_spending_summary',
        description:
            'Retrieves total spending, category breakdown, and budget vs spent per category. Defaults to current month. Can filter by category, description, and date range.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                category: categoryParam('Optional filter.'),
                description: { type: SchemaType.STRING, description: 'Optional. A specific keyword like "coffee".' },
                startDate: { type: SchemaType.STRING, description: 'Optional. YYYY-MM-DD' },
                endDate: { type: SchemaType.STRING, description: 'Optional. YYYY-MM-DD' },
            },
        },
    };
}

function buildAddFixedExpenseDeclaration(): FunctionDeclaration {
    return {
        name: 'add_fixed_expense',
        description:
            'Saves a new RECURRING or FIXED bill. Use this ANY TIME the user says "every month", "fixed", "recurring", "quarterly", or "yearly".',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                dayOfMonth: {
                    type: SchemaType.NUMBER,
                    description: 'The exact day of the month as an integer (1-31). If the user says "30th", output 30.',
                },
                amount: { type: SchemaType.NUMBER, description: 'The cost.' },
                frequencyInMonths: { type: SchemaType.NUMBER, description: 'How often it occurs in months. Monthly = 1, Every 2 months = 2, Quarterly = 3, Yearly = 12.',
                },
                currency: { type: SchemaType.STRING, description: 'Default to MYR if not specified.' },
                category: categoryParam( 'Recurring bill category. Use Loan, Insurance, Utility, or Investment for bills.'
                ),
                description: { type: SchemaType.STRING, description: 'Auto-generate a brief description.' },
            },
            required: ['dayOfMonth', 'amount'],
        },
    };
}

function buildLogBulkExpensesDeclaration(): FunctionDeclaration {
    return {
        name: 'log_bulk_expenses',
        description:
            'Use this when extracting multiple transactions from a bank statement or long list. It logs an array of expenses all at once.',
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                expenses: {
                    type: SchemaType.ARRAY,
                    description: 'A list of all the outgoing expenses found in the document.',
                    items: {
                        type: SchemaType.OBJECT,
                        properties: {
                            amount: { type: SchemaType.NUMBER, description: 'The cost or amount spent.' },
                            currency: { type: SchemaType.STRING, description: 'The currency code, e.g., MYR or USD.' },
                            category: categoryParam(),
                            description: { type: SchemaType.STRING, description: 'Brief description of what was purchased.' },
                            date: {
                                type: SchemaType.STRING,
                                description:
                                    "Format: YYYY-MM-DD. MUST be the exact date the transaction occurred. Look at the statement's billing period or statement date to determine the correct year. NEVER use the current system date.",
                            },
                        },
                        required: ['amount', 'currency', 'category', 'description'],
                    },
                },
            },
            required: ['expenses'],
        },
    };
}

export const updateFixedExpenseDeclaration: FunctionDeclaration = {
    name: 'update_fixed_expense',
    description:
        'Updates the price or amount of an existing recurring monthly bill (e.g., changing Netflix from 55 to 60).',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            description: { type: SchemaType.STRING, description: 'The name of the subscription or bill to update (e.g., "Netflix", "Gym").',
            },
            newAmount: { type: SchemaType.NUMBER, description: 'The new cost or amount.' },
        },
        required: ['description', 'newAmount'],
    },
};

export const getAllFixedExpensesDeclaration: FunctionDeclaration = {
    name: 'get_all_fixed_expenses',
    description: 'Retrieves a list of all currently active recurring/fixed bills. Use this when the user asks "what are my fixed expenses" or "show me my subscriptions".',
    parameters: { type: SchemaType.OBJECT, properties: {} },
};

export const deleteFixedExpenseDeclaration: FunctionDeclaration = {
    name: 'delete_fixed_expense',
    description: 'Deletes or cancels an existing recurring bill.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            description: { type: SchemaType.STRING, description: 'The name of the bill to cancel (e.g., "Netflix").' },
        },
        required: ['description'],
    },
};

export const createCalendarEventDeclaration: FunctionDeclaration = {
    name: 'create_calendar_event',
    description: 'Use this tool WHENEVER the user mentions scheduling, booking, or POSTPONING a meeting. Triggers on conversational updates like "I postponed the meeting to...". Only call when you have a specific startDateTime. If time is missing, ask the user first.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            title: { type: SchemaType.STRING, description: 'Short title of the event.' },
            startDateTime: { 
    type: SchemaType.STRING, 
    description: 'Start time in ISO 8601. If it is an all-day event or date range, set the time to 00:00:00 (e.g., 2026-04-24T00:00:00+08:00).' 
},
endDateTime: { 
    type: SchemaType.STRING, 
    description: 'End time. For a multi-day event like "24-26", this should be the end date at 23:59:59 (e.g., 2026-04-26T23:59:59+08:00).' 
},
            description: { type: SchemaType.STRING, description: 'Extra details.' },
        },
        required: ['title', 'startDateTime'],
    },
};

export const checkScheduleDeclaration: FunctionDeclaration = {
    name: 'check_schedule',
    description:
        "Retrieves the user's schedule for a specific day. Use this when the user asks \"Am I free?\", \"What do I have planned?\", or \"Check my schedule\".",
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            expenses: {
                type: SchemaType.ARRAY,
                description: 'A list of all the outgoing expenses found in the document.',
                items: {
                    type: SchemaType.OBJECT,
                    properties: {
                      amount: { type: SchemaType.NUMBER, description: 'The cost or amount spent.' },
                        currency: { type: SchemaType.STRING, description: 'The currency code, e.g., MYR or USD.' },
                        category: { type: SchemaType.STRING, description: 'Category of expense, e.g., Food, Transport.' },
                        description: { type: SchemaType.STRING, description: 'Brief description of what was purchased.' },
                        date: { 
                            type: SchemaType.STRING, 
                            description: "Format: YYYY-MM-DD. MUST be the exact date the transaction occurred. Look at the statement's billing period or statement date to determine the correct year. NEVER use the current system date." 
                        },
                    },
                    required: ['amount', 'currency', 'category', 'description'],
                }
            }
        },
        required: ['expenses'],
    },
};

export const logWorkoutDeclaration: FunctionDeclaration = {
    name: 'log_workout',
    description: 'Logs a gym exercise session. Use when the user reports workouts, sets, reps, or weights.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            date: { type: SchemaType.STRING, description: 'YYYY-MM-DD. Use receipt/context date, not today unless specified.' },
            exercise: { type: SchemaType.STRING, description: 'Exercise name e.g. Bench Press, Squat.' },
            sets: { type: SchemaType.NUMBER, description: 'Number of sets.' },
            reps: { type: SchemaType.NUMBER, description: 'Reps per set.' },
            weightKg: { type: SchemaType.NUMBER, description: 'Weight in kg.' },
            durationMin: { type: SchemaType.NUMBER, description: 'Duration in minutes. Use decimals for sub-minute holds (e.g. 0.5 for 30 sec plank).' },
            notes: { type: SchemaType.STRING, description: 'Optional notes.' },
        },
        required: ['exercise'],
    },
};

export const getWorkoutHistoryDeclaration: FunctionDeclaration = {
    name: 'get_workout_history',
    description: 'Retrieves workout history for a date range or exercise filter.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            startDate: { type: SchemaType.STRING, description: 'YYYY-MM-DD' },
            endDate: { type: SchemaType.STRING, description: 'YYYY-MM-DD' },
            exercise: { type: SchemaType.STRING, description: 'Optional exercise name filter.' },
        },
    },
};

export const suggestWorkoutDeclaration: FunctionDeclaration = {
    name: 'suggest_workout',
    description: 'Fetches recent workout history and suggests the next training session based on patterns.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            focus: { type: SchemaType.STRING, description: 'Optional focus: push, pull, legs, cardio, full body.' },
        },
    },
};

export const logMealDeclaration: FunctionDeclaration = {
    name: 'log_meal',
    description:
        'Logs a meal with full estimated macros. For text or photo input, YOU must estimate and supply proteinG, carbsG, fatG, and calories—never ask the user for them. Scale estimates by quantity ("2 pcs", "one plate"). User-provided numbers override estimates only when explicitly stated. Values are approximate.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            date: { type: SchemaType.STRING, description: 'YYYY-MM-DD' },
            mealType: { type: SchemaType.STRING, description: 'breakfast, lunch, dinner, snack.' },
            description: { type: SchemaType.STRING, description: 'What was eaten.' },
            proteinG: { type: SchemaType.NUMBER, description: 'Estimated protein in grams.' },
            carbsG: { type: SchemaType.NUMBER, description: 'Estimated carbs in grams.' },
            fatG: { type: SchemaType.NUMBER, description: 'Estimated fat in grams.' },
            calories: { type: SchemaType.NUMBER, description: 'Estimated calories.' },
        },
        required: ['description', 'proteinG', 'carbsG', 'fatG', 'calories'],
    },
};

export const getNutritionSummaryDeclaration: FunctionDeclaration = {
    name: 'get_nutrition_summary',
    description:
        'Gets calories, protein, carbs, and fat totals vs daily targets for a date range. Use for "how am I doing today" questions.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            startDate: { type: SchemaType.STRING, description: 'YYYY-MM-DD' },
            endDate: { type: SchemaType.STRING, description: 'YYYY-MM-DD' },
        },
        required: ['startDate', 'endDate'],
    },
};

export const suggestMealDeclaration: FunctionDeclaration = {
    name: 'suggest_meal',
    description: 'Suggests foods based on remaining daily protein, calorie, carb, and fat targets.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            date: { type: SchemaType.STRING, description: 'YYYY-MM-DD. Defaults to today if omitted.' },
        },
    },
};

export const getMealHistoryDeclaration: FunctionDeclaration = {
    name: 'get_meal_history',
    description:
        'Lists logged meals with ids for a date range. Use before edit_meal or delete_meal when the user corrects or removes a meal.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            startDate: { type: SchemaType.STRING, description: 'YYYY-MM-DD' },
            endDate: { type: SchemaType.STRING, description: 'YYYY-MM-DD' },
        },
        required: ['startDate', 'endDate'],
    },
};

export const editMealDeclaration: FunctionDeclaration = {
    name: 'edit_meal',
    description:
        'Updates an existing meal by id. Use when the user corrects food identification (e.g. chicken → pork) or macro estimates. Re-estimate all macros for the corrected food and portion.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            id: { type: SchemaType.NUMBER, description: 'Meal id from get_meal_history or log_meal response.' },
            description: { type: SchemaType.STRING, description: 'Corrected food description.' },
            mealType: { type: SchemaType.STRING, description: 'breakfast, lunch, dinner, snack.' },
            proteinG: { type: SchemaType.NUMBER, description: 'Re-estimated protein in grams.' },
            carbsG: { type: SchemaType.NUMBER, description: 'Re-estimated carbs in grams.' },
            fatG: { type: SchemaType.NUMBER, description: 'Re-estimated fat in grams.' },
            calories: { type: SchemaType.NUMBER, description: 'Re-estimated calories.' },
        },
        required: ['id', 'description', 'proteinG', 'carbsG', 'fatG', 'calories'],
    },
};

export const deleteMealDeclaration: FunctionDeclaration = {
    name: 'delete_meal',
    description: 'Deletes a logged meal by id. Use when the user wants to remove a wrong entry entirely.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            id: { type: SchemaType.NUMBER, description: 'Meal id from get_meal_history.' },
        },
        required: ['id'],
    },
};

export const getWorkoutSummaryDeclaration: FunctionDeclaration = {
    name: 'get_workout_summary',
    description:
        'Gets workout sessions and total calories/fat burned for a date range. Use for "how many calories did I burn today" questions.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            startDate: { type: SchemaType.STRING, description: 'YYYY-MM-DD' },
            endDate: { type: SchemaType.STRING, description: 'YYYY-MM-DD' },
        },
        required: ['startDate', 'endDate'],
    },
};

export const updateUserSettingsDeclaration: FunctionDeclaration = {
    name: 'update_user_settings',
    description: 'Updates daily nutrition targets and/or body weight for calorie burn estimates.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            dailyProteinTargetG: { type: SchemaType.NUMBER, description: 'Daily protein goal in grams.' },
            dailyCalorieTarget: { type: SchemaType.NUMBER, description: 'Daily calorie goal.' },
            dailyCarbsTargetG: { type: SchemaType.NUMBER, description: 'Daily carbs goal in grams.' },
            dailyFatTargetG: { type: SchemaType.NUMBER, description: 'Daily fat goal in grams.' },
            bodyWeightKg: { type: SchemaType.NUMBER, description: 'User body weight in kg for workout burn calculations.' },
        },
    },
};

export function getAllFunctionDeclarations(): FunctionDeclaration[] {
    return [
        buildLogExpenseDeclaration(),
        buildGetSummaryDeclaration(),
        buildAddFixedExpenseDeclaration(),
        updateFixedExpenseDeclaration,
        getAllFixedExpensesDeclaration,
        deleteFixedExpenseDeclaration,
        createCalendarEventDeclaration,
        checkScheduleDeclaration,
        buildLogBulkExpensesDeclaration(),
        logWorkoutDeclaration,
        getWorkoutHistoryDeclaration,
        suggestWorkoutDeclaration,
        logMealDeclaration,
        getMealHistoryDeclaration,
        editMealDeclaration,
        deleteMealDeclaration,
        getNutritionSummaryDeclaration,
        suggestMealDeclaration,
        updateUserSettingsDeclaration,
        getWorkoutSummaryDeclaration,
    ];
}

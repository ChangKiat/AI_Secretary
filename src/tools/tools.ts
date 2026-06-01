import { FunctionDeclaration, SchemaType } from '@google/generative-ai';

export const logExpenseDeclaration: FunctionDeclaration = {
    name: 'log_expense',
    description: 'Logs a SINGLE expense from a standard receipt or text message. DO NOT use this tool if the user uploads a bank statement, credit card statement, or list of multiple expenses. Use log_bulk_expenses instead.',   
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            amount: { type: SchemaType.NUMBER, description: 'The cost or amount spent.' },
            currency: { type: SchemaType.STRING, description: 'The currency code, e.g., MYR or USD.' },
            category: { type: SchemaType.STRING, description: 'Category of expense, e.g., Food, Transport.' },
            description: { type: SchemaType.STRING, description: 'Brief description of what was purchased.' },
            date: { 
                type: SchemaType.STRING, 
                 description: "Format: YYYY-MM-DD. MUST be the exact date the transaction occurred. Look at the receipt date to determine the correct year. NEVER use the current system date." 
            },
        },
        required: ['amount', 'currency', 'category', 'description'],
    },
};

export const getSummaryDeclaration: FunctionDeclaration = {
    name: 'get_spending_summary',
    description: 'Retrieves total spending AND a category breakdown. Can filter by category, description, and date range.', 
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            category: { type: SchemaType.STRING, description: 'Optional. E.g., Food, Transport.' },
            description: { type: SchemaType.STRING, description: 'Optional. A specific keyword like "coffee".' },
            startDate: { type: SchemaType.STRING, description: 'Optional. YYYY-MM-DD' },
            endDate: { type: SchemaType.STRING, description: 'Optional. YYYY-MM-DD' },
        },
    },
};

export const addFixedExpenseDeclaration: FunctionDeclaration = {
    name: 'add_fixed_expense',
    description: 'Saves a new RECURRING or FIXED bill. Use this ANY TIME the user says "every month", "fixed", "recurring", "quarterly", or "yearly".',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            dayOfMonth: { type: SchemaType.NUMBER, description: 'The exact day of the month as an integer (1-31). If the user says "30th", output 30.' },
            amount: { type: SchemaType.NUMBER, description: 'The cost.' },
            // NEW INSTRUCTION FOR THE AI
            frequencyInMonths: { type: SchemaType.NUMBER, description: 'How often it occurs in months. Monthly = 1, Every 2 months = 2, Quarterly = 3, Yearly = 12.' },
            currency: { type: SchemaType.STRING, description: 'Default to MYR if not specified.' },
            category: { type: SchemaType.STRING, description: 'E.g., Insurance, Housing. Default to General.' },
            description: { type: SchemaType.STRING, description: 'Auto-generate a brief description.' },
        },
        required: ['dayOfMonth', 'amount'], 
    },
};

export const updateFixedExpenseDeclaration: FunctionDeclaration = {
    name: 'update_fixed_expense',
    description: 'Updates the price or amount of an existing recurring monthly bill (e.g., changing Netflix from 55 to 60).',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            description: { type: SchemaType.STRING, description: 'The name of the subscription or bill to update (e.g., "Netflix", "Gym").' },
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
    description: 'Use this tool WHENEVER the user mentions scheduling, booking, or POSTPONING a meeting. Triggers on conversational updates like "I postponed the meeting to..."',
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
    description: 'Retrieves the user\'s schedule for a specific day. Use this when the user asks "Am I free?", "What do I have planned?", or "Check my schedule".',
    parameters: {
        type: SchemaType.OBJECT, 
        properties: {
            date: { 
                type: SchemaType.STRING,
                description: 'The exact date to check in YYYY-MM-DD format (e.g., "2026-04-26"). Calculate this based on the current date in the System Note.' 
            }
        },
        required: ['date'],
    },
};

export const logBulkExpensesDeclaration: FunctionDeclaration = {
    name: 'log_bulk_expenses',
    description: 'Use this when extracting multiple transactions from a bank statement or long list. It logs an array of expenses all at once.',
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
            durationMin: { type: SchemaType.NUMBER, description: 'Cardio duration in minutes.' },
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
    description: 'Logs a meal with estimated protein and macros. Use after analyzing food photos or text descriptions.',
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
        required: ['description', 'proteinG'],
    },
};

export const getNutritionSummaryDeclaration: FunctionDeclaration = {
    name: 'get_nutrition_summary',
    description: 'Gets protein and macro totals vs daily target for a date range.',
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
    description: 'Suggests high-protein foods based on remaining daily protein target.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            date: { type: SchemaType.STRING, description: 'YYYY-MM-DD. Defaults to today if omitted.' },
        },
    },
};

export const updateUserSettingsDeclaration: FunctionDeclaration = {
    name: 'update_user_settings',
    description: 'Updates user preferences such as daily protein target in grams.',
    parameters: {
        type: SchemaType.OBJECT,
        properties: {
            dailyProteinTargetG: { type: SchemaType.NUMBER, description: 'Daily protein goal in grams.' },
        },
    },
};

export const allFunctionDeclarations: FunctionDeclaration[] = [
    logExpenseDeclaration,
    getSummaryDeclaration,
    addFixedExpenseDeclaration,
    updateFixedExpenseDeclaration,
    getAllFixedExpensesDeclaration,
    deleteFixedExpenseDeclaration,
    createCalendarEventDeclaration,
    checkScheduleDeclaration,
    logBulkExpensesDeclaration,
    logWorkoutDeclaration,
    getWorkoutHistoryDeclaration,
    suggestWorkoutDeclaration,
    logMealDeclaration,
    getNutritionSummaryDeclaration,
    suggestMealDeclaration,
    updateUserSettingsDeclaration,
];
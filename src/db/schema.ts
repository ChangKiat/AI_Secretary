import { pgTable, serial, text, numeric, integer, boolean, timestamp, bigint } from 'drizzle-orm/pg-core';

export const expenses = pgTable('expenses', {
    id: serial('id').primaryKey(),
    date: text('date').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').default('MYR').notNull(),
    category: text('category').default('Other').notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const incomes = pgTable('incomes', {
    id: serial('id').primaryKey(),
    date: text('date').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').default('MYR').notNull(),
    category: text('category').default('Other').notNull(),
    description: text('description').notNull(),
    source: text('source'),
    expenseId: integer('expense_id').references(() => expenses.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const budgets = pgTable('budgets', {
    id: serial('id').primaryKey(),
    category: text('category').notNull().unique(),
    monthlyBudget: numeric('monthly_budget', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').default('MYR').notNull(),
});

export const fixedExpenses = pgTable('fixed_expenses', {
    id: serial('id').primaryKey(),
    dayOfMonth: integer('day_of_month').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    frequencyMonths: integer('frequency_months').default(1).notNull(),
    currency: text('currency').default('MYR').notNull(),
    category: text('category').default('Other').notNull(),
    description: text('description').notNull(),
    startMonth: integer('start_month').notNull(),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const workouts = pgTable('workouts', {
    id: serial('id').primaryKey(),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(),
    exercise: text('exercise').notNull(),
    sets: integer('sets'),
    reps: integer('reps'),
    weightKg: numeric('weight_kg', { precision: 8, scale: 2 }),
    durationMin: numeric('duration_min', { precision: 8, scale: 2 }),
    notes: text('notes'),
    caloriesBurned: numeric('calories_burned', { precision: 8, scale: 2 }),
    fatBurnedG: numeric('fat_burned_g', { precision: 8, scale: 2 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const meals = pgTable('meals', {
    id: serial('id').primaryKey(),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(),
    mealType: text('meal_type'),
    description: text('description').notNull(),
    proteinG: numeric('protein_g', { precision: 8, scale: 2 }).notNull(),
    carbsG: numeric('carbs_g', { precision: 8, scale: 2 }),
    fatG: numeric('fat_g', { precision: 8, scale: 2 }),
    calories: numeric('calories', { precision: 8, scale: 2 }),
    photoPath: text('photo_path'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const userSettings = pgTable('user_settings', {
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).primaryKey(),
    dailyProteinTargetG: numeric('daily_protein_target_g', { precision: 8, scale: 2 }).default('150').notNull(),
    dailyCalorieTarget: numeric('daily_calorie_target', { precision: 8, scale: 2 }).default('2200').notNull(),
    dailyCarbsTargetG: numeric('daily_carbs_target_g', { precision: 8, scale: 2 }).default('250').notNull(),
    dailyFatTargetG: numeric('daily_fat_target_g', { precision: 8, scale: 2 }).default('70').notNull(),
    timezone: text('timezone').default('Asia/Kuala_Lumpur').notNull(),
    salaryAfterTax: numeric('salary_after_tax', { precision: 12, scale: 2 }).default('0').notNull(),
    bodyWeightKg: numeric('body_weight_kg', { precision: 6, scale: 2 }),
});

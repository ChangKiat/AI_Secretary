import { pgTable, serial, text, numeric, integer, boolean, timestamp, bigint, jsonb, unique, primaryKey } from 'drizzle-orm/pg-core';

export const telegramMessageClaims = pgTable('telegram_message_claims', {
    botId: bigint('bot_id', { mode: 'number' }).notNull(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    status: text('status').default('processing').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (table) => [primaryKey({ columns: [table.botId, table.chatId, table.messageId] })]);

export const trips = pgTable('trips', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    name: text('name').notNull(),
    startDate: text('start_date'),
    endDate: text('end_date'),
    tripCurrency: text('trip_currency').default('USD').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const expenses = pgTable('expenses', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    date: text('date').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').default('MYR').notNull(),
    category: text('category').default('Other').notNull(),
    description: text('description').notNull(),
    paymentMethod: text('payment_method'),
    tripId: integer('trip_id').references(() => trips.id),
    tripLeg: text('trip_leg'),
    fxAmount: numeric('fx_amount', { precision: 12, scale: 2 }),
    fxCurrency: text('fx_currency'),
    /** numeric(20,12) after AI Agent/scripts/migrate-fx-rate-precision.sql (small rates such as VND to MYR need the extra digits). */
    fxRate: numeric('fx_rate', { precision: 20, scale: 12 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const incomes = pgTable('incomes', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    date: text('date').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').default('MYR').notNull(),
    category: text('category').default('Other').notNull(),
    description: text('description').notNull(),
    source: text('source'),
    expenseId: integer('expense_id').references(() => expenses.id),
    paymentMethod: text('payment_method'),
    fromPaymentMethod: text('from_payment_method'),
    /** Extra debited from from_payment_method on Account transfer (fee on top of amount). */
    transferFee: numeric('transfer_fee', { precision: 12, scale: 2 }),
    rebateAccountId: integer('rebate_account_id').references(() => paymentAccounts.id),
    rebatePeriodMonth: text('rebate_period_month'),
    rebateCategory: text('rebate_category'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const budgets = pgTable('budgets', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    category: text('category').notNull().unique(),
    monthlyBudget: numeric('monthly_budget', { precision: 12, scale: 2 }).notNull(),
    currency: text('currency').default('MYR').notNull(),
});

export const fixedExpenses = pgTable('fixed_expenses', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    dayOfMonth: integer('day_of_month').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    frequencyMonths: integer('frequency_months').default(1).notNull(),
    currency: text('currency').default('MYR').notNull(),
    category: text('category').default('Other').notNull(),
    description: text('description').notNull(),
    startMonth: integer('start_month').notNull(),
    /** Set for a bill that repeats every N days from intervalStartDate; day/frequency/start month are then unused. */
    intervalDays: integer('interval_days'),
    intervalStartDate: text('interval_start_date'),
    active: boolean('active').default(true).notNull(),
    paymentMethod: text('payment_method'),
    toInvestmentAccount: text('to_investment_account'),
    instrumentId: integer('instrument_id').references(() => investmentInstruments.id, {
        onDelete: 'set null',
    }),
    /** reducing | flat | included */
    loanMethod: text('loan_method'),
    originalPrincipal: numeric('original_principal', { precision: 12, scale: 2 }),
    remainingPrincipal: numeric('remaining_principal', { precision: 12, scale: 2 }),
    annualRatePct: numeric('annual_rate_pct', { precision: 8, scale: 4 }),
    tenureMonths: integer('tenure_months'),
    loanStartDate: text('loan_start_date'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const loanPayments = pgTable('loan_payments', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    fixedExpenseId: integer('fixed_expense_id')
        .notNull()
        .references(() => fixedExpenses.id),
    expenseId: integer('expense_id').references(() => expenses.id),
    date: text('date').notNull(),
    installment: numeric('installment', { precision: 12, scale: 2 }).notNull(),
    interestAmount: numeric('interest_amount', { precision: 12, scale: 2 }).notNull(),
    principalAmount: numeric('principal_amount', { precision: 12, scale: 2 }).notNull(),
    remainingAfter: numeric('remaining_after', { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** daily | monthly */
export const interestSchedules = pgTable('interest_schedules', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    paymentMethod: text('payment_method').notNull(),
    frequency: text('frequency').notNull(),
    dayOfMonth: integer('day_of_month'),
    annualRatePct: numeric('annual_rate_pct', { precision: 8, scale: 4 }),
    fixedAmount: numeric('fixed_amount', { precision: 12, scale: 2 }),
    currency: text('currency').default('MYR').notNull(),
    description: text('description').notNull(),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const paymentAccounts = pgTable('payment_accounts', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    name: text('name').notNull().unique(),
    accountType: text('account_type').default('account').notNull(),
    initialBalance: numeric('initial_balance', { precision: 12, scale: 2 }).default('0').notNull(),
    balanceBaselineDate: text('balance_baseline_date').notNull(),
    creditLimit: numeric('credit_limit', { precision: 12, scale: 2 }),
    statementDay: integer('statement_day'),
    rebateConfig: jsonb('rebate_config'),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const workouts = pgTable('workouts', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
    date: text('date').notNull(),
    exercise: text('exercise').notNull(),
    sets: integer('sets'),
    reps: integer('reps'),
    weightKg: numeric('weight_kg', { precision: 8, scale: 2 }),
    weightsKg: text('weights_kg'),
    durationMin: numeric('duration_min', { precision: 8, scale: 2 }),
    notes: text('notes'),
    caloriesBurned: numeric('calories_burned', { precision: 8, scale: 2 }),
    fatBurnedG: numeric('fat_burned_g', { precision: 8, scale: 2 }),
    sessionId: text('session_id'),
    sessionLabel: text('session_label'),
    supersetGroup: integer('superset_group'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const meals = pgTable('meals', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
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
    userId: integer('user_id').references(() => users.id),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).primaryKey(),
    dailyProteinTargetG: numeric('daily_protein_target_g', { precision: 8, scale: 2 }).default('150').notNull(),
    dailyCalorieTarget: numeric('daily_calorie_target', { precision: 8, scale: 2 }).default('2200').notNull(),
    dailyCarbsTargetG: numeric('daily_carbs_target_g', { precision: 8, scale: 2 }).default('250').notNull(),
    dailyFatTargetG: numeric('daily_fat_target_g', { precision: 8, scale: 2 }).default('70').notNull(),
    timezone: text('timezone').default('Asia/Kuala_Lumpur').notNull(),
    salaryAfterTax: numeric('salary_after_tax', { precision: 12, scale: 2 }).default('0').notNull(),
    bodyWeightKg: numeric('body_weight_kg', { precision: 6, scale: 2 }),
    heightCm: numeric('height_cm', { precision: 6, scale: 2 }),
    age: integer('age'),
    /** 'male' | 'female', used for BMR calculation. */
    sex: text('sex'),
});

export const bodyWeightLogs = pgTable(
    'body_weight_logs',
    {
        id: serial('id').primaryKey(),
        userId: integer('user_id').references(() => users.id),
        telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
        date: text('date').notNull(),
        weightKg: numeric('weight_kg', { precision: 6, scale: 2 }).notNull(),
        createdAt: timestamp('created_at').defaultNow().notNull(),
    },
    (t) => [unique('body_weight_logs_user_date').on(t.telegramUserId, t.date)]
);

export const dailyActivityLogs = pgTable(
    'daily_activity_logs',
    {
        id: serial('id').primaryKey(),
        userId: integer('user_id').references(() => users.id),
        telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
        date: text('date').notNull(),
        steps: integer('steps').notNull(),
        createdAt: timestamp('created_at').defaultNow().notNull(),
    },
    (t) => [unique('daily_activity_logs_user_date').on(t.telegramUserId, t.date)]
);

/** equity | fund | fd | other */
export const investmentInstruments = pgTable('investment_instruments', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    paymentAccountId: integer('payment_account_id')
        .notNull()
        .references(() => paymentAccounts.id),
    kind: text('kind').notNull(),
    symbol: text('symbol'),
    name: text('name').notNull(),
    currency: text('currency').default('MYR').notNull(),
    lastPrice: numeric('last_price', { precision: 12, scale: 6 }),
    lastPriceAt: text('last_price_at'),
    principal: numeric('principal', { precision: 12, scale: 2 }),
    annualRatePct: numeric('annual_rate_pct', { precision: 8, scale: 4 }),
    startDate: text('start_date'),
    maturityDate: text('maturity_date'),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** buy | sell | dividend | interest | fee | price_mark */
export const investmentEvents = pgTable('investment_events', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    instrumentId: integer('instrument_id')
        .notNull()
        .references(() => investmentInstruments.id),
    eventType: text('event_type').notNull(),
    date: text('date').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 8 }),
    unitPrice: numeric('unit_price', { precision: 12, scale: 6 }),
    amount: numeric('amount', { precision: 12, scale: 2 }),
    realizedGain: numeric('realized_gain', { precision: 12, scale: 2 }),
    notes: text('notes'),
    linkedIncomeId: integer('linked_income_id').references(() => incomes.id),
    linkedExpenseId: integer('linked_expense_id').references(() => expenses.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const investmentLots = pgTable('investment_lots', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    instrumentId: integer('instrument_id')
        .notNull()
        .references(() => investmentInstruments.id),
    openedAt: text('opened_at').notNull(),
    quantity: numeric('quantity', { precision: 18, scale: 8 }).notNull(),
    remainingQty: numeric('remaining_qty', { precision: 18, scale: 8 }).notNull(),
    unitCost: numeric('unit_cost', { precision: 12, scale: 6 }).notNull(),
    buyEventId: integer('buy_event_id').references(() => investmentEvents.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Material | Lubricants | Labour | Other */
export const carServiceVisits = pgTable('car_service_visits', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    date: text('date').notNull(),
    odometerKm: integer('odometer_km').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const carServiceItems = pgTable('car_service_items', {
    id: serial('id').primaryKey(),
    userId: integer('user_id').references(() => users.id),
    visitId: integer('visit_id')
        .notNull()
        .references(() => carServiceVisits.id, { onDelete: 'cascade' }),
    category: text('category').default('Material').notNull(),
    description: text('description').notNull(),
    amount: numeric('amount', { precision: 12, scale: 2 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** One row per Google account that has signed in to the Dashboard. */
export const users = pgTable('users', {
    id: serial('id').primaryKey(),
    /** Lowercased Google email. */
    email: text('email').notNull().unique(),
    /** Set by the bot's /link command; null until the user connects Telegram. */
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).unique(),
    /** One-time code shown on the profile page, cleared once used. */
    telegramLinkCode: text('telegram_link_code').unique(),
    telegramLinkCodeExpiresAt: timestamp('telegram_link_code_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
});

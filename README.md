# AI Secretary Telegram Bot

A proactive personal assistant built with Node.js and TypeScript. Uses Google Gemini function calling to manage finances, Google Calendar, gym workouts, and nutrition tracking—all stored in Supabase PostgreSQL.

## Features

- **Conversational UI** via Telegram (text, voice, photos, PDFs)
- **Cost-optimized AI**: `gemini-3.5-flash-lite` by default, `gemini-3.5-flash` for heavy PDF extraction
- **Finances**: Log expenses, recurring bills, spending summaries (Supabase)
- **Trips**: Expenses dated inside a trip (created in the Dashboard) land on its trip board. Trip-currency amounts (`32k`, `1.2m`) are converted to MYR at the trip's latest exchange rate: cash is logged as spending from exchanged trip cash, a card or e-wallet as a card charge. RM items the model marks as trip spending are grouped into the trip. A dated list (`26/09/2026` lines followed by items) is logged in one go, with a per-day breakdown and possible-duplicate warnings.
- **Calendar**: Create events and check schedule (Google Calendar)
- **Gym**: Log workouts, view history, get suggestions
- **Nutrition**: Log meals from photos with protein estimates, daily summaries, meal suggestions
- **Automated billing**: Fixed expenses at 9:00 AM, interest accrual and an 8:00 AM weigh-in reminder (Asia/Kuala_Lumpur). These run on the Dashboard server (`Dashboard/server/dailyJobs.ts`) and report here through this bot; the bot itself no longer schedules anything.

## Prerequisites

- Node.js v18+
- Telegram Bot Token ([@BotFather](https://t.me/botfather))
- Google Gemini API Key
- Supabase project (Postgres + optional Storage bucket)
- Google Cloud service account with **Calendar API** enabled

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Environment variables

Copy `env.example` to `.env` and fill in your values.

For `DATABASE_URL`, open Supabase → **Project Settings → Database** and copy the **Session pooler** or **Transaction pooler** connection string (IPv4-friendly). Avoid the direct `db.<project-ref>.supabase.co:5432` URI on home networks without working IPv6.

### 3. Create database tables

The bot and the Dashboard share one database, and all of its SQL lives in `scripts/` in this repo. Run it in the Supabase SQL Editor.

- **New database:** run [`scripts/init-db.sql`](scripts/init-db.sql). It creates every table, column, index and default row that the bot and the Dashboard use, and is safe to run twice.
- **Upgrading an existing database:** run only the `scripts/migrate-*.sql` files you are missing, in the order below.
- **Never run `drizzle-kit push` against the shared database.** It drops columns, tables and indexes that the Dashboard relies on (the Agent and Dashboard share one DB).

#### Upgrading an existing database

Back up first (Supabase → Database → Backups, or `pg_dump`). Check which columns and tables already exist, then run only the missing scripts, top to bottom. Most use `IF NOT EXISTS` and are harmless to repeat; the notes in bold mark the ones that are not.

1. `migrate-nutrition-targets.sql`: calorie, carb and fat targets on `user_settings`.
2. `migrate-duration-min.sql`: fractional `workouts.duration_min`. **No guard:** run it only if `duration_min` is still `integer`.
3. `migrate-budgets-categories.sql`: **LEGACY / DESTRUCTIVE.** Drops and recreates `budgets`, resetting every budget. Only for a DB whose `budgets` table still has `month/amount` columns; the script does nothing otherwise. Must run before 17 and 24.
4. `migrate-salary-after-tax.sql`: `user_settings.salary_after_tax`.
5. `migrate-workout-burn.sql`: workout calories and fat burned, `user_settings.body_weight_kg`.
6. `migrate-incomes.sql`: `incomes` table.
7. `migrate-workout-sessions.sql`: workout session columns.
8. `migrate-payment-method.sql`: `expenses.payment_method`.
9. `migrate-fixed-expense-payment-method.sql`: `fixed_expenses.payment_method`.
10. `migrate-income-payment-accounts.sql`: payment accounts on `incomes`. Needs 6.
11. `migrate-payment-accounts.sql`: `payment_accounts` table. **Not repeatable:** it seeds 9 default accounts, so a re-run re-adds any default you renamed or deleted.
12. `migrate-account-balances.sql`: opening balance, credit limit, baseline date. Needs 11.
13. `migrate-fixed-expense-to-investment.sql`: `fixed_expenses.to_investment_account`.
14. `migrate-workout-progressive.sql`: per-set weights and superset groups.
15. `migrate-statement-day.sql`: credit card statement day. Needs 11.
16. `migrate-rebate.sql`: cashback config and rebate income columns. Needs 6 and 11.
17. `migrate-trips.sql`: `trips` table and FX columns on `expenses`. Needs the per-category `budgets` (3). **Not repeatable:** it re-adds the Travel budget if you deleted or renamed it.
18. `migrate-investment-portfolio.sql`: investment instruments, events and lots. Needs 6 and 11.
19. `migrate-interest-schedules.sql`: `interest_schedules` table.
20. `migrate-loan-installments.sql`: loan columns on `fixed_expenses`, `loan_payments` and its unique index.
21. `migrate-fixed-expense-instrument.sql`: `fixed_expenses.instrument_id` (read by the 9am fixed-bill cron). Needs 18.
22. `migrate-body-weight-logs.sql`: `body_weight_logs` (used by `log_body_weight`). Needs 5. **Not repeatable:** it inserts today's weigh-in from `user_settings.body_weight_kg` unless today already has one.
23. `migrate-car-service.sql`: `car_service_visits` and `car_service_items` (Dashboard Car tab).
24. `migrate-transfer-fee.sql`: `incomes.transfer_fee`. Needs 3. **Not repeatable:** it re-adds the Bank charges budget if no budget of that name exists (in any letter case).
25. `migrate-daily-activity.sql`: `user_settings.height_cm/age/sex` and `daily_activity_logs`.
26. `migrate-fx-rate-precision.sql`: widens `expenses.fx_rate` to `numeric(20,12)`. Needs 17. **Run it manually before deploying** any build whose `schema.ts` declares the wider `fx_rate`.
27. `migrate-scheduled-job-runs.sql`: `scheduled_job_runs`, the Dashboard scheduler's record of which days each daily job ran. Run it before deploying a Dashboard with `SCHEDULER_ENABLED=1`.

The Dashboard repo keeps one optional personal seed, `Dashboard/scripts/seed-car-service-visits.sql`. Run it once, after 23; a re-run skips visits that already exist.

If a script inserted rows (accounts or budgets), restart the bot and the Dashboard, because they load accounts and categories at startup.

### 4. Supabase Storage (optional, for meal photos)

1. Create a public bucket named `meal-photos` (or match `SUPABASE_STORAGE_BUCKET`)
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`

Without Storage, meal photos are stored as Telegram `file_id` references.

### 5. Google credentials

Place `google-credentials.json` in the project root, or set `GOOGLE_CREDENTIALS_JSON` (stringified JSON) for cloud hosting.

**Calendar events land in the wrong place if you skip this:** the service account has its own private calendar — `calendarId: 'primary'` in `calendarService.ts` points to *that*, not your Google Calendar. To make events show up where you can see them:

1. In Google Calendar, share the calendar you want the bot to use with the service account's email (`...@<project>.iam.gserviceaccount.com`), permission **"Make changes to events"**.
2. Get that calendar's ID: **Settings → [calendar name] → Integrate calendar → Calendar ID** (looks like `xxxx@group.calendar.google.com`).
3. Set `GOOGLE_CALENDAR_ID` in `.env` to that ID.

### 6. Migrate from Google Sheets (one-time)

If you have existing data in Google Sheets:

```bash
# Temporarily re-enable Sheets read scope on service account
# Set SPREADSHEET_ID in .env
npm run migrate:sheets
```

Compare row counts in Supabase before removing `SPREADSHEET_ID`.

## Running

**Development:**

```bash
npm run dev
```

**Production:**

```bash
npm run build
npm start
```

## Commands

| Command | Description |
|---------|-------------|
| `/setprotein 180` | Set daily protein target (grams) |

## Photo captions

Send photos with captions to route intent:

- **Receipt** (default): expense logging
- **food / lunch / protein / meal**: nutrition + `log_meal`
- **gym / workout / bench**: workout logging

## Project structure

```
src/
  config/       # System prompt, Gemini model factory
  db/           # Drizzle schema + Postgres client
  services/     # expense, gym, nutrition, calendar
  tools/        # Gemini function declarations + handlers
  index.ts      # Telegram bot entry point
scripts/
  init-db.sql               # Full schema for a new DB (bot + Dashboard)
  migrate-*.sql             # Upgrades for an existing DB (full list and run order in step 3)
  migrate-sheets-to-db.ts   # One-time Google Sheets import
```

## Cloud deployment

Deploy to Render/Koyeb with:

- Build: `npm install && npm run build`
- Start: `npm start`
- Env vars: all values from `env.example` (use `GOOGLE_CREDENTIALS_JSON` instead of a file)

## Model cost tips

- Default model is Flash-Lite (~6x cheaper output than full Flash)
- PDF bank statements use the heavy model automatically
- Adjust via `GEMINI_MODEL_DEFAULT` and `GEMINI_MODEL_HEAVY`
- **Image tokens**: photos are downscaled to `GEMINI_IMAGE_MAX_PX` (default 768) before Gemini — typically **258 tokens/image** vs thousands for full phone photos. Meal photos stored in Supabase stay full resolution. Raise `GEMINI_IMAGE_MAX_PX` (e.g. 1024) if receipt OCR misses small text.

## Troubleshooting

### `403 CONSUMER_SUSPENDED` on every Gemini call
The API key (or its whole Google Cloud project) got suspended — not a code bug. Check [Google Cloud Billing](https://console.cloud.google.com/billing) for that project for a suspension notice. Fastest fix: create a fresh key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) choosing **"Create API key in new project"** (avoids inheriting the same suspension), then update `GEMINI_API_KEY` in `.env` and restart. Gemini's free tier doesn't require billing to be set up.

### `404 ... no longer available to new users`
Google deprecates model names over time. The error message tells you the replacement model name — update `GEMINI_MODEL_DEFAULT` / `GEMINI_MODEL_HEAVY` in `.env` (and the fallback defaults in `src/config/gemini.ts`) to match. Note: `ListModels` (`GET /v1beta/models`) can still *list* a deprecated model as available even though calling it 404s for new keys — don't trust the listing, test the actual model name with a real `generateContent` call.

New model generations can also be much slower per-call (extended "thinking" by default) — if requests start taking 20–90+ seconds, try the `-lite` variant of the newest generation, or compare a few candidate model names with a quick timed test script before committing.

### `400 Bad Request: Role 'function' is not supported`
The installed SDK (`@google/generative-ai`, deprecated by Google) hardcodes `role: "function"` when sending tool/function results back to the model. Newer model generations reject that role. This is patched via `patch-package` (see `patches/@google+generative-ai+*.patch`, changes the role to `"user"`) — the patch reapplies automatically on `npm install` via the `postinstall` script. If you ever run `npm install` and this error comes back, check that `patches/` still exists and `postinstall` ran (look for "patch-package" output during install).

### Calendar events return "success" but never show up
See the calendar sharing + `GOOGLE_CALENDAR_ID` setup under **Google credentials** above — without it, events are created on the service account's own invisible calendar, not yours.

### Rotating a leaked credential
If a service account key or `GOOGLE_CREDENTIALS_JSON` ever gets exposed (e.g. pasted somewhere it shouldn't be): delete the key (not necessarily the whole service account — deleting the account itself requires recreating it and re-sharing your calendar with the new email, since Cloud Console doesn't offer an easy "undelete" without the account's numeric unique ID from audit logs). Prefer **Service Accounts → [account] → Keys → delete key → add new key** over deleting the account.

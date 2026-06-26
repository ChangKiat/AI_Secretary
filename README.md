# AI Secretary Telegram Bot

A proactive personal assistant built with Node.js and TypeScript. Uses Google Gemini function calling to manage finances, Google Calendar, gym workouts, and nutrition tracking—all stored in Supabase PostgreSQL.

## Features

- **Conversational UI** via Telegram (text, voice, photos, PDFs)
- **Cost-optimized AI**: `gemini-2.5-flash-lite` by default, `gemini-2.5-flash` for heavy PDF extraction
- **Finances**: Log expenses, recurring bills, spending summaries (Supabase)
- **Calendar**: Create events and check schedule (Google Calendar)
- **Gym**: Log workouts, view history, get suggestions
- **Nutrition**: Log meals from photos with protein estimates, daily summaries, meal suggestions
- **Automated billing**: Cron logs fixed expenses at 9:00 AM (Asia/Kuala_Lumpur)

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

In the Supabase SQL Editor, run the contents of [`scripts/init-db.sql`](scripts/init-db.sql).

Or with Drizzle Kit (requires `DATABASE_URL`):

```bash
npm run db:push
```

### 4. Supabase Storage (optional, for meal photos)

1. Create a public bucket named `meal-photos` (or match `SUPABASE_STORAGE_BUCKET`)
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`

Without Storage, meal photos are stored as Telegram `file_id` references.

### 5. Google credentials

Place `google-credentials.json` in the project root, or set `GOOGLE_CREDENTIALS_JSON` (stringified JSON) for cloud hosting.

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
  init-db.sql
  migrate-sheets-to-db.ts
```

## Cloud deployment

Deploy to Render/Koyeb with:

- Build: `npm install && npm run build`
- Start: `npm start`
- Env vars: all values from `env.example` (use `GOOGLE_CREDENTIALS_JSON` instead of a file)

## Model cost tips

- Default model is Flash-Lite (~6x cheaper output than 2.5 Flash)
- PDF bank statements use the heavy model automatically
- Adjust via `GEMINI_MODEL_DEFAULT` and `GEMINI_MODEL_HEAVY`
- **Image tokens**: photos are downscaled to `GEMINI_IMAGE_MAX_PX` (default 768) before Gemini — typically **258 tokens/image** vs thousands for full phone photos. Meal photos stored in Supabase stay full resolution. Raise `GEMINI_IMAGE_MAX_PX` (e.g. 1024) if receipt OCR misses small text.

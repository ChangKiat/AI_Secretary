# AI Secretary Telegram Bot

A proactive personal assistant built with Node.js and TypeScript. Uses Google Gemini function calling to manage finances, Google Calendar, gym workouts, and nutrition tracking—all stored in Supabase PostgreSQL.

## Features

- **Conversational UI** via Telegram (text, voice, photos, PDFs)
- **Cost-optimized AI**: `gemini-3.5-flash-lite` by default, `gemini-3.5-flash` for heavy PDF extraction
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
  init-db.sql
  migrate-sheets-to-db.ts
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

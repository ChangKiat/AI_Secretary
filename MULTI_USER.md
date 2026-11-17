# Multi-user rollout

Current stage: Google sign-up and Telegram linking exist. Data access and normal
bot messages remain owner-only. Do not remove those gates yet.

## Ownership foundation

`scripts/migrate-data-ownership.sql` adds nullable `user_id` foreign keys and
indexes. The corresponding Drizzle fields are present in both repositories.
Run `migrate-users.sql` first, then sign in and link the original owner's account.
On the same database connection, set `app.legacy_owner_email` to that account's
email before running the ownership migration. The migration is transactional,
rerunnable, and preserves rows with an existing owner assignment.

Legacy finance/car/tax claims belong to the explicitly selected original owner.
Health rows are matched by Telegram ID; tax documents are matched by email.
Unmatched health/documents remain unassigned for manual review, never silently
assigned to another person. Optional tax tables are skipped if absent.

This is a transition schema: old writes still leave `user_id` null. Re-run the
backfill under a write freeze before the final cutover. Do not run this backfill
after enabling multiple writers. Do not add a default that assigns new rows to
the original owner.

## Remaining before enabling other users

1. Pass the immutable `users.id` through Dashboard requests, bot tools and jobs.
   Telegram linking is an identity connection; unlinking must not transfer data.
2. Scope every read/update/delete and supply `user_id` on every insert, including
   finance caches, account balance queries, receipts, exports and background jobs.
   Check ownership of referenced IDs (trip, account, holding, claim, etc.).
3. Replace global account-name and budget-category uniqueness with per-user
   uniqueness; add composite foreign keys to prevent cross-user relationships.
4. Backfill under a write freeze, resolve unassigned rows, enforce NOT NULL, and
   test two users with identical account/category names and concurrent requests.
5. Only then enable new users in Dashboard and the bot, with per-user finance
   models/caches and per-user scheduled billing and notification destinations.

Local migration regression test (requires the existing local Postgres on 5433):
`node scripts/test-data-ownership.mjs`. It uses an isolated schema and synthetic
data; it does not connect to the production database.

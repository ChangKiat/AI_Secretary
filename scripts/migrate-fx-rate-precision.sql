-- Widen expenses.fx_rate from NUMERIC(12, 6) to NUMERIC(20, 12) so small trip exchange
-- rates keep their digits (a VND rate of 0.000163265 was being stored as 0.000163).
--
-- RUN THIS MANUALLY, BEFORE DEPLOYING the bot or Dashboard build whose schema.ts declares
-- fx_rate as { precision: 20, scale: 12 }. Take a database backup first.
--
-- Safe to re-run: NUMERIC(20, 12) holds every NUMERIC(12, 6) value without rounding
-- (6 integer digits fit in 8), and running it again on a column that is already
-- NUMERIC(20, 12) leaves the data unchanged. It briefly locks the expenses table.
ALTER TABLE expenses ALTER COLUMN fx_rate TYPE NUMERIC(20, 12);

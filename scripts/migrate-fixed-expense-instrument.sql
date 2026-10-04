ALTER TABLE fixed_expenses
  ADD COLUMN IF NOT EXISTS instrument_id integer REFERENCES investment_instruments(id) ON DELETE SET NULL;

-- Daily job ledger for the Dashboard scheduler (Dashboard/server/dailyJobs.ts): one row per job
-- per KL day. The primary key is the lock that stops a day from running twice; a missing day is
-- caught up on the next run. Safe to run twice.
CREATE TABLE IF NOT EXISTS scheduled_job_runs (
    job TEXT NOT NULL,
    run_date TEXT NOT NULL,
    status TEXT NOT NULL,
    triggered_by TEXT,
    attempts INTEGER NOT NULL DEFAULT 1,
    summary TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    PRIMARY KEY (job, run_date)
);

-- Only the server's own connection (the table owner) reads it; keep it off the Supabase API.
ALTER TABLE scheduled_job_runs ENABLE ROW LEVEL SECURITY;

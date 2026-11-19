-- Run before deploying the bot. Claims deliberately have no automatic expiry:
-- a crashed handler may already have committed part of a message.
CREATE TABLE IF NOT EXISTS telegram_message_claims (
    bot_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'handled', 'failed')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    PRIMARY KEY (bot_id, chat_id, message_id)
);

-- Server connection only; no receipt content or credentials are stored.
ALTER TABLE telegram_message_claims ENABLE ROW LEVEL SECURITY;

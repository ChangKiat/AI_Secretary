-- Persistent uploaded receipt context. Run before deploying the bot; safe to rerun.
CREATE TABLE IF NOT EXISTS telegram_receipts (
    id SERIAL PRIMARY KEY,
    bot_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    telegram_user_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    file_id TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    UNIQUE (bot_id, chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS telegram_receipt_messages (
    bot_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    receipt_id INTEGER NOT NULL REFERENCES telegram_receipts(id),
    PRIMARY KEY (bot_id, chat_id, message_id)
);
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES telegram_receipts(id);
ALTER TABLE meals ADD COLUMN IF NOT EXISTS receipt_id INTEGER REFERENCES telegram_receipts(id);
CREATE INDEX IF NOT EXISTS expenses_receipt_id_idx ON expenses(receipt_id);
CREATE INDEX IF NOT EXISTS meals_receipt_id_idx ON meals(receipt_id);
ALTER TABLE telegram_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_receipt_messages ENABLE ROW LEVEL SECURITY;

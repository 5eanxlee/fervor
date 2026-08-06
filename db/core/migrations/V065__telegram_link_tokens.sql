-- Bind Telegram chats to authenticated users with expiring, single-use secrets.
-- stride: destructive-review=telegram-link-token-v65

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
SET LOCAL idle_in_transaction_session_timeout = '60s';
SET LOCAL search_path = public;

CREATE TABLE telegram_link_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    used BOOLEAN NOT NULL DEFAULT FALSE,
    used_at TIMESTAMPTZ,
    chat_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX telegram_link_tokens_user_idx
    ON telegram_link_tokens (user_id, created_at DESC);

CREATE UNIQUE INDEX telegram_link_tokens_active_idx
    ON telegram_link_tokens (user_id)
    WHERE used = FALSE;

CREATE INDEX telegram_link_tokens_expiry_idx
    ON telegram_link_tokens (expires_at)
    WHERE used = FALSE;

-- 001_auth.sql — idempotent auth migration.
-- Safe to run on both fresh and existing databases.

-- Auth columns on users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS username      VARCHAR;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_id    UUID;

-- FK from users.account_id → retailer_accounts (skip if already exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_users_account'
          AND table_name = 'users'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT fk_users_account
            FOREIGN KEY (account_id) REFERENCES retailer_accounts(account_id);
    END IF;
END $$;

-- Case-insensitive unique index on username
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
    ON users (LOWER(username)) WHERE username IS NOT NULL;

-- Refresh token store: one row per live token (hash only, never plain)
CREATE TABLE IF NOT EXISTS refresh_tokens (
    token_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash  VARCHAR     NOT NULL UNIQUE,
    user_id     UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_rft_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_rft_user ON refresh_tokens(user_id);

-- Login attempt log used for rate-limiting
CREATE TABLE IF NOT EXISTS login_attempts (
    id           BIGSERIAL   PRIMARY KEY,
    username     VARCHAR     NOT NULL,
    attempted_at TIMESTAMPTZ DEFAULT NOW(),
    success      BOOLEAN     NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lat_user_time
    ON login_attempts(username, attempted_at DESC);

-- Link the demo seed user to the demo account and assign a username
UPDATE users
SET    username   = 'demo',
       account_id = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
WHERE  user_id   = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
  AND  username  IS NULL;

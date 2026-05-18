-- 001_auth.sql — idempotent auth migration.
-- Safe to run on both fresh and existing databases.

-- Auth columns on users table (retailer_account_id is NOT on users — use user_accounts)
ALTER TABLE users ADD COLUMN IF NOT EXISTS username      VARCHAR;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR;

-- Drop retailer_account_id from users if it exists (moved to user_accounts junction table)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_users_retailer_account'
          AND table_name = 'users'
    ) THEN
        ALTER TABLE users DROP CONSTRAINT fk_users_retailer_account;
    END IF;
END $$;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'users_retailer_account_id_fkey'
          AND table_name = 'users'
    ) THEN
        ALTER TABLE users DROP CONSTRAINT users_retailer_account_id_fkey;
    END IF;
END $$;

ALTER TABLE users DROP COLUMN IF EXISTS retailer_account_id;

-- Drop old account_id column if it exists (legacy)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_users_account'
          AND table_name = 'users'
    ) THEN
        ALTER TABLE users DROP CONSTRAINT fk_users_account;
    END IF;
END $$;

ALTER TABLE users DROP COLUMN IF EXISTS account_id;

-- Case-insensitive unique index on username
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
    ON users (LOWER(username)) WHERE username IS NOT NULL;

-- Refresh token store
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

-- user_accounts: many-to-many users ↔ retailer_accounts (source of truth for membership)
CREATE TABLE IF NOT EXISTS user_accounts (
    user_id             UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    retailer_account_id UUID NOT NULL REFERENCES retailer_accounts(retailer_account_id) ON DELETE CASCADE,
    role                VARCHAR DEFAULT 'ADMIN',
    joined_at           TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, retailer_account_id)
);

CREATE INDEX IF NOT EXISTS idx_ua_user    ON user_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_ua_account ON user_accounts(retailer_account_id);

-- Seed demo user username
UPDATE users SET username = 'demo'
WHERE user_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' AND username IS NULL;

-- Link demo user to demo account
INSERT INTO user_accounts (user_id, retailer_account_id, role)
VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'ADMIN')
ON CONFLICT DO NOTHING;

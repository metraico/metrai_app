-- 001_auth.sql — idempotent auth migration.
-- Safe to run on both fresh and existing databases.

-- Auth columns on users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS username           VARCHAR;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash      VARCHAR;
ALTER TABLE users ADD COLUMN IF NOT EXISTS retailer_account_id UUID;

-- Drop old account_id column and FK if it exists (for schema migration)
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

-- FK from users.retailer_account_id → retailer_accounts
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_users_retailer_account'
          AND table_name = 'users'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT fk_users_retailer_account
            FOREIGN KEY (retailer_account_id) REFERENCES retailer_accounts(retailer_account_id);
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

-- Create user_accounts junction table (many-to-many users ↔ retailer_accounts)
CREATE TABLE IF NOT EXISTS user_accounts (
    user_id             UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    retailer_account_id UUID NOT NULL REFERENCES retailer_accounts(retailer_account_id) ON DELETE CASCADE,
    role                VARCHAR DEFAULT 'USER',
    added_at            TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, retailer_account_id)
);

CREATE INDEX IF NOT EXISTS idx_ua_user ON user_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_ua_account ON user_accounts(retailer_account_id);

-- Link the demo seed user to the demo account and assign a username
UPDATE users
SET    username   = 'demo',
       retailer_account_id = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
WHERE  user_id   = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
  AND  username  IS NULL;

-- Link demo user to demo account in junction table
INSERT INTO user_accounts (user_id, retailer_account_id, role)
VALUES ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'ADMIN')
ON CONFLICT DO NOTHING;

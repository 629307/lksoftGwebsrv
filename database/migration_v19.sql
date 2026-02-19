-- ============================================================
-- Migration v19: readonly users scope by owner
-- Adds optional users.owner_id (FK -> owners)
-- ============================================================

BEGIN;

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS owner_id INTEGER;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'fk_users_owner_id'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT fk_users_owner_id
            FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_owner_id ON users(owner_id);

COMMIT;


-- ============================================================
-- Миграция v4.0 - Статус для направлений каналов
-- ============================================================

ALTER TABLE IF EXISTS channel_directions
    ADD COLUMN IF NOT EXISTS status_id INTEGER REFERENCES object_status(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_channel_directions_status ON channel_directions(status_id);


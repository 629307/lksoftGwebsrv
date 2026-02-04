-- ============================================================
-- Миграция v8.0 - Собственники: цвет
-- ============================================================

ALTER TABLE IF EXISTS owners
    ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT '#3b82f6';

-- Заполняем пустые значения дефолтом
UPDATE owners SET color = '#3b82f6' WHERE color IS NULL OR color = '';


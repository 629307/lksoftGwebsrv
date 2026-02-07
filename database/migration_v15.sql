-- ============================================================
-- Миграция v15.0 - Remove owners numbering ranges (range_from/range_to)
-- ============================================================

-- Удаляем constraints (если были)
ALTER TABLE owners DROP CONSTRAINT IF EXISTS owners_range_nonneg;
ALTER TABLE owners DROP CONSTRAINT IF EXISTS owners_range_order;

-- Удаляем колонки диапазона
ALTER TABLE owners DROP COLUMN IF EXISTS range_from;
ALTER TABLE owners DROP COLUMN IF EXISTS range_to;


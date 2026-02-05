-- ============================================================
-- Миграция v13.0 - object_types.reference_table ("Справочная таблица")
-- ============================================================

-- Виды объектов: добавляем указание, из какого справочника брать "справочные данные" (тип/каталог и т.п.)
ALTER TABLE object_types
    ADD COLUMN IF NOT EXISTS reference_table VARCHAR(100);

COMMENT ON COLUMN object_types.reference_table IS
    'Справочная таблица (код справочника из /api/references), содержащая справочные данные для данного вида объектов. Например: object_kinds, cable_types.';

-- Дефолтные значения для системных видов объектов (если поле ещё не заполнено)
UPDATE object_types
SET reference_table = 'object_kinds'
WHERE code IN ('well', 'channel', 'marker')
  AND (reference_table IS NULL OR reference_table = '');

UPDATE object_types
SET reference_table = 'cable_types'
WHERE code IN ('cable_ground', 'cable_aerial', 'cable_duct')
  AND (reference_table IS NULL OR reference_table = '');


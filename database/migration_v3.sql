-- ============================================================
-- Миграция v3.0 - Значения "По умолчанию" в справочниках
-- ============================================================

-- Добавляем флаг "по умолчанию" в справочники
ALTER TABLE IF EXISTS object_types ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS object_kinds ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS object_status ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS owners ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS contracts ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS cable_types ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS cable_catalog ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- Уникальность дефолта в рамках справочника
CREATE UNIQUE INDEX IF NOT EXISTS uq_object_types_default ON object_types ((is_default)) WHERE is_default = true;

-- Для object_kinds дефолт задаётся в рамках вида объекта (object_type_id)
CREATE UNIQUE INDEX IF NOT EXISTS uq_object_kinds_default_per_type ON object_kinds (object_type_id) WHERE is_default = true;

CREATE UNIQUE INDEX IF NOT EXISTS uq_object_status_default ON object_status ((is_default)) WHERE is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS uq_owners_default ON owners ((is_default)) WHERE is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS uq_contracts_default ON contracts ((is_default)) WHERE is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cable_types_default ON cable_types ((is_default)) WHERE is_default = true;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cable_catalog_default ON cable_catalog ((is_default)) WHERE is_default = true;


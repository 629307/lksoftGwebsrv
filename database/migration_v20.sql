-- ============================================================
-- Migration v20: wells.coords_needs_refine
-- Флаг "требуется уточнить координаты" для колодцев
-- ============================================================

BEGIN;

ALTER TABLE wells
    ADD COLUMN IF NOT EXISTS coords_needs_refine BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_wells_coords_needs_refine ON wells(coords_needs_refine);

COMMIT;


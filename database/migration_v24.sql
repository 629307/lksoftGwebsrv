-- ============================================================
-- Migration v24: Imported layers extra options + PROJ presets
-- ============================================================

BEGIN;

-- Extend imported_layers with visibility/filters and zoom cap
ALTER TABLE imported_layers
    ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE,
    -- Минимальный зум: если текущий зум меньше этого значения — слой не показывается
    ADD COLUMN IF NOT EXISTS min_zoom INTEGER NULL,
    ADD COLUMN IF NOT EXISTS show_points BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS show_lines BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS show_polygons BOOLEAN NOT NULL DEFAULT TRUE;

-- PROJ presets for coordinate conversion (admin-managed)
CREATE TABLE IF NOT EXISTS imported_layer_proj_presets (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    proj4 TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_imported_layer_proj_presets_name ON imported_layer_proj_presets(name);

COMMIT;


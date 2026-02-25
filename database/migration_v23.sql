-- ============================================================
-- Migration v23: Imported MapInfo layers (PostGIS tables + styles)
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS imported_layers (
    id SERIAL PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,               -- stable key (slug)
    name TEXT NOT NULL,                      -- user-facing name
    table_name TEXT NOT NULL UNIQUE,         -- PostGIS table name (mi_<code>)
    geometry_column TEXT NOT NULL DEFAULT 'geom',
    srid INTEGER NOT NULL DEFAULT 4326,
    files_json JSONB NOT NULL DEFAULT '{}'::jsonb,   -- { tab:{name,sha256,size}, dat:..., map:..., id:... }
    version TEXT NOT NULL DEFAULT '',               -- derived from file hashes
    uploaded_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    style_json JSONB NOT NULL DEFAULT '{}'::jsonb    -- { point:{symbol,size,color}, line:{style,weight,color} }
);

CREATE INDEX IF NOT EXISTS idx_imported_layers_code ON imported_layers(code);

COMMIT;


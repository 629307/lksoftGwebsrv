-- ============================================================
-- Migration v22: Assumed cable routes (multi-segment)
-- Теперь "предполагаемый кабель" = маршрут по нескольким направлениям
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS assumed_cable_routes (
    id SERIAL PRIMARY KEY,
    scenario_id INTEGER NOT NULL REFERENCES assumed_cable_scenarios(id) ON DELETE CASCADE,
    owner_id INTEGER REFERENCES owners(id) ON DELETE SET NULL,
    confidence NUMERIC(4,3) NOT NULL DEFAULT 0.000 CHECK (confidence >= 0 AND confidence <= 1),
    start_well_id INTEGER REFERENCES wells(id) ON DELETE SET NULL,
    end_well_id INTEGER REFERENCES wells(id) ON DELETE SET NULL,
    length_m NUMERIC(12,2) NOT NULL DEFAULT 0,
    geom_wgs84 GEOMETRY(LINESTRING, 4326),
    evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assumed_cable_routes_scenario_id ON assumed_cable_routes(scenario_id);
CREATE INDEX IF NOT EXISTS idx_assumed_cable_routes_owner_id ON assumed_cable_routes(owner_id);
CREATE INDEX IF NOT EXISTS idx_assumed_cable_routes_start_well_id ON assumed_cable_routes(start_well_id);
CREATE INDEX IF NOT EXISTS idx_assumed_cable_routes_end_well_id ON assumed_cable_routes(end_well_id);

CREATE TABLE IF NOT EXISTS assumed_cable_route_directions (
    id SERIAL PRIMARY KEY,
    route_id INTEGER NOT NULL REFERENCES assumed_cable_routes(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL CHECK (seq >= 1),
    direction_id INTEGER NOT NULL REFERENCES channel_directions(id) ON DELETE CASCADE,
    length_m NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_assumed_cable_route_directions_route_seq UNIQUE(route_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_assumed_cable_route_directions_route_id ON assumed_cable_route_directions(route_id);
CREATE INDEX IF NOT EXISTS idx_assumed_cable_route_directions_direction_id ON assumed_cable_route_directions(direction_id);

COMMIT;


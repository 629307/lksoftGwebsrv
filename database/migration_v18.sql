-- ============================================================
-- Migration v18: Inventory cards + summary layer
-- ============================================================

-- Инвентарные карточки (привязаны к колодцу)
CREATE SEQUENCE IF NOT EXISTS inventory_cards_seq START 1;

CREATE TABLE IF NOT EXISTS inventory_cards (
    id SERIAL PRIMARY KEY,
    well_id INTEGER NOT NULL REFERENCES wells(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL UNIQUE DEFAULT nextval('inventory_cards_seq'),
    number TEXT UNIQUE NOT NULL,
    filled_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_cards_well_id ON inventory_cards(well_id);
CREATE INDEX IF NOT EXISTS idx_inventory_cards_filled_date ON inventory_cards(filled_date);

-- Генерация номера: ИНВ-<CODE owner>-<seq>
CREATE OR REPLACE FUNCTION inventory_cards_set_number()
RETURNS trigger AS $$
DECLARE
    owner_code TEXT;
BEGIN
    IF NEW.seq IS NULL OR NEW.seq <= 0 THEN
        NEW.seq := nextval('inventory_cards_seq');
    END IF;

    IF NEW.filled_date IS NULL THEN
        NEW.filled_date := CURRENT_DATE;
    END IF;

    IF NEW.number IS NULL OR btrim(NEW.number) = '' THEN
        SELECT o.code INTO owner_code
        FROM wells w
        LEFT JOIN owners o ON w.owner_id = o.id
        WHERE w.id = NEW.well_id
        LIMIT 1;
        owner_code := COALESCE(NULLIF(btrim(owner_code), ''), 'NA');
        NEW.number := 'ИНВ-' || owner_code || '-' || NEW.seq::TEXT;
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inventory_cards_set_number ON inventory_cards;
CREATE TRIGGER trg_inventory_cards_set_number
BEFORE INSERT ON inventory_cards
FOR EACH ROW
EXECUTE FUNCTION inventory_cards_set_number();

-- Обнаруженные бирки (владельцы бирок)
CREATE TABLE IF NOT EXISTS inventory_tags (
    id SERIAL PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES inventory_cards(id) ON DELETE CASCADE,
    owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inventory_tags_card_id ON inventory_tags(card_id);

-- Обнаруженные кабели в направлениях колодца (уникально по card+direction)
CREATE TABLE IF NOT EXISTS inventory_direction_cables (
    id SERIAL PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES inventory_cards(id) ON DELETE CASCADE,
    direction_id INTEGER NOT NULL REFERENCES channel_directions(id) ON DELETE RESTRICT,
    cable_count INTEGER NOT NULL DEFAULT 0 CHECK (cable_count >= 0 AND cable_count <= 100),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_inventory_direction_cables_card_dir UNIQUE(card_id, direction_id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_direction_cables_card_id ON inventory_direction_cables(card_id);
CREATE INDEX IF NOT EXISTS idx_inventory_direction_cables_direction_id ON inventory_direction_cables(direction_id);

-- Вложения инвентарной карточки
CREATE TABLE IF NOT EXISTS inventory_card_attachments (
    id SERIAL PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES inventory_cards(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255),
    file_path TEXT NOT NULL,
    file_size BIGINT,
    mime_type VARCHAR(255),
    description TEXT,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inventory_card_attachments_card_id ON inventory_card_attachments(card_id);

-- Сводная таблица инвентаризации по направлениям
CREATE TABLE IF NOT EXISTS inventory_summary (
    id SERIAL PRIMARY KEY,
    direction_id INTEGER NOT NULL UNIQUE REFERENCES channel_directions(id) ON DELETE CASCADE,
    max_inventory_cables INTEGER NOT NULL DEFAULT 0,
    unaccounted_cables INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_inventory_summary_unaccounted ON inventory_summary(unaccounted_cables);


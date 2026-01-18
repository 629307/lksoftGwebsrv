-- ============================================================
-- Миграция v2.0 - Новый функционал для ИГС lksoftGwebsrv
-- ============================================================

-- ============================================================
-- 1. Справочник Типы кабелей (ВОК, ТПП)
-- ============================================================
CREATE TABLE IF NOT EXISTS cable_types (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE cable_types IS 'Справочник типов кабелей (ВОК, ТПП и др.)';

-- Начальные данные типов кабелей
INSERT INTO cable_types (code, name, description) VALUES
('vok', 'ВОК', 'Волоконно-оптический кабель'),
('tpp', 'ТПП', 'Телефонный кабель с полиэтиленовой изоляцией')
ON CONFLICT (code) DO NOTHING;

-- Триггер для обновления updated_at
CREATE TRIGGER trg_cable_types_updated_at BEFORE UPDATE ON cable_types FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 2. Справочник Кабели (марки кабелей)
-- ============================================================
CREATE TABLE IF NOT EXISTS cable_catalog (
    id SERIAL PRIMARY KEY,
    cable_type_id INTEGER NOT NULL REFERENCES cable_types(id) ON DELETE RESTRICT,
    fiber_count INTEGER NOT NULL,
    marking VARCHAR(255) NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE cable_catalog IS 'Справочник кабелей (марки, характеристики)';
COMMENT ON COLUMN cable_catalog.cable_type_id IS 'FK на тип кабеля (ВОК/ТПП)';
COMMENT ON COLUMN cable_catalog.fiber_count IS 'Количество жил/волокон';
COMMENT ON COLUMN cable_catalog.marking IS 'Маркировка кабеля';

CREATE INDEX idx_cable_catalog_type ON cable_catalog(cable_type_id);

-- Триггер для обновления updated_at
CREATE TRIGGER trg_cable_catalog_updated_at BEFORE UPDATE ON cable_catalog FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
-- 3. Виды объектов для кабелей (если не существуют)
-- ============================================================
INSERT INTO object_types (code, name, description, icon, color) VALUES
('well', 'Колодец', 'Колодец кабельной канализации', 'circle', '#fa00fa'),
('channel', 'Канал', 'Направление канала кабельной канализации', 'line', '#fa00fa'),
('marker', 'Столбик', 'Указательный столбик', 'marker', '#e67e22'),
('cable_ground', 'Кабель в грунте', 'Кабель проложенный в грунте', 'line', '#551b1b'),
('cable_aerial', 'Воздушный кабель', 'Кабель воздушными переходами', 'line', '#009dff'),
('cable_duct', 'Кабель в канализации', 'Кабель в кабельной канализации', 'line', '#00bd26')
ON CONFLICT (code) DO UPDATE SET 
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    icon = EXCLUDED.icon,
    color = EXCLUDED.color;

-- ============================================================
-- 9. Инциденты: связи с новыми объектами + документы
-- ============================================================

CREATE TABLE IF NOT EXISTS incident_cables (
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    cable_id INTEGER NOT NULL REFERENCES cables(id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, cable_id)
);

CREATE TABLE IF NOT EXISTS incident_cable_channels (
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    cable_channel_id INTEGER NOT NULL REFERENCES cable_channels(id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, cable_channel_id)
);

CREATE TABLE IF NOT EXISTS incident_documents (
    id SERIAL PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255),
    file_path TEXT NOT NULL,
    file_size INTEGER,
    mime_type VARCHAR(100),
    description TEXT,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================
-- 10. Удаление устаревшего справочника стилей отображения
-- ============================================================
DROP TABLE IF EXISTS display_styles CASCADE;

-- ============================================================
-- 4. Универсальная таблица кабелей
-- ============================================================
CREATE TABLE IF NOT EXISTS cables (
    id SERIAL PRIMARY KEY,
    number VARCHAR(100),
    
    -- FK на справочники
    cable_catalog_id INTEGER REFERENCES cable_catalog(id) ON DELETE RESTRICT,
    cable_type_id INTEGER REFERENCES cable_types(id) ON DELETE RESTRICT,
    owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
    object_type_id INTEGER NOT NULL REFERENCES object_types(id) ON DELETE RESTRICT,
    status_id INTEGER REFERENCES object_status(id) ON DELETE RESTRICT,
    contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
    
    -- Геометрия для кабелей в грунте и воздушных
    geom_wgs84 GEOMETRY(MULTILINESTRING, 4326),
    geom_msk86 GEOMETRY(MULTILINESTRING, 200004),
    
    -- Длина
    length_calculated DECIMAL(10,2),  -- Расчётная длина (из геометрии или суммы направлений)
    length_declared DECIMAL(10,2),    -- Заявленная длина (вручную)
    
    -- Дополнительные поля
    installation_date DATE,
    notes TEXT,
    
    -- Метаданные
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_cables_geom_wgs84 ON cables USING GIST (geom_wgs84);
CREATE INDEX idx_cables_geom_msk86 ON cables USING GIST (geom_msk86);
CREATE INDEX idx_cables_owner ON cables(owner_id);
CREATE INDEX idx_cables_object_type ON cables(object_type_id);
CREATE INDEX idx_cables_cable_catalog ON cables(cable_catalog_id);
CREATE INDEX idx_cables_cable_type ON cables(cable_type_id);

COMMENT ON TABLE cables IS 'Универсальная таблица кабелей (в грунте, воздушные, в канализации)';
COMMENT ON COLUMN cables.object_type_id IS 'Вид объекта: cable_ground, cable_aerial, cable_duct';
COMMENT ON COLUMN cables.length_calculated IS 'Расчётная длина из координат или суммы направлений';
COMMENT ON COLUMN cables.length_declared IS 'Заявленная длина (ввод вручную)';

-- Триггер для обновления updated_at
CREATE TRIGGER trg_cables_updated_at BEFORE UPDATE ON cables FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Триггер для трансформации координат
CREATE TRIGGER trg_cables_transform BEFORE INSERT OR UPDATE ON cables FOR EACH ROW EXECUTE FUNCTION transform_wgs84_to_msk86();

-- ============================================================
-- 5. Связь кабелей в канализации с колодцами и каналами
-- ============================================================
CREATE TABLE IF NOT EXISTS cable_route_wells (
    id SERIAL PRIMARY KEY,
    cable_id INTEGER NOT NULL REFERENCES cables(id) ON DELETE CASCADE,
    well_id INTEGER NOT NULL REFERENCES wells(id) ON DELETE RESTRICT,
    route_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_cable_route_well UNIQUE (cable_id, well_id)
);

COMMENT ON TABLE cable_route_wells IS 'Колодцы маршрута кабеля в канализации';

CREATE TABLE IF NOT EXISTS cable_route_channels (
    id SERIAL PRIMARY KEY,
    cable_id INTEGER NOT NULL REFERENCES cables(id) ON DELETE CASCADE,
    cable_channel_id INTEGER NOT NULL REFERENCES cable_channels(id) ON DELETE RESTRICT,
    route_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_cable_route_channel UNIQUE (cable_id, cable_channel_id)
);

COMMENT ON TABLE cable_route_channels IS 'Каналы маршрута кабеля в канализации';

-- ============================================================
-- 6. Добавляем связь групп с новой таблицей кабелей
-- ============================================================
CREATE TABLE IF NOT EXISTS group_cables (
    group_id INTEGER NOT NULL REFERENCES object_groups(id) ON DELETE CASCADE,
    cable_id INTEGER NOT NULL REFERENCES cables(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, cable_id)
);

-- ============================================================
-- 7. Функция расчёта длины кабеля в канализации
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_cable_duct_length(p_cable_id INTEGER)
RETURNS DECIMAL(10,2) AS $$
DECLARE
    total_length DECIMAL(10,2) := 0;
BEGIN
    SELECT COALESCE(SUM(cd.length_m), 0) INTO total_length
    FROM cable_route_channels crc
    JOIN cable_channels cc ON crc.cable_channel_id = cc.id
    JOIN channel_directions cd ON cc.direction_id = cd.id
    WHERE crc.cable_id = p_cable_id;
    
    RETURN total_length;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 8. Триггер для автоматического расчёта длины направления
-- ============================================================
CREATE OR REPLACE FUNCTION calculate_direction_length()
RETURNS TRIGGER AS $$
BEGIN
    -- Вычисляем длину в метрах через geography
    IF NEW.geom_wgs84 IS NOT NULL THEN
        NEW.length_m := ST_Length(NEW.geom_wgs84::geography);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Удаляем старый триггер если есть
DROP TRIGGER IF EXISTS trg_direction_calc_length ON channel_directions;

-- Создаём триггер
CREATE TRIGGER trg_direction_calc_length
    BEFORE INSERT OR UPDATE ON channel_directions
    FOR EACH ROW EXECUTE FUNCTION calculate_direction_length();

-- ============================================================
-- 9. Представление для кабелей с полной информацией
-- ============================================================
CREATE OR REPLACE VIEW v_cables AS
SELECT 
    c.id,
    c.number,
    ST_AsGeoJSON(c.geom_wgs84)::json as geom_wgs84_json,
    c.cable_catalog_id,
    cc.marking as cable_marking,
    cc.fiber_count,
    ct.code as cable_type_code,
    ct.name as cable_type_name,
    c.owner_id,
    o.name as owner_name,
    c.object_type_id,
    ot.code as object_type_code,
    ot.name as object_type_name,
    c.status_id,
    os.name as status_name,
    os.color as status_color,
    c.length_calculated,
    c.length_declared,
    c.installation_date,
    c.notes,
    c.created_at,
    c.updated_at
FROM cables c
LEFT JOIN cable_catalog cc ON c.cable_catalog_id = cc.id
LEFT JOIN cable_types ct ON c.cable_type_id = ct.id
LEFT JOIN owners o ON c.owner_id = o.id
LEFT JOIN object_types ot ON c.object_type_id = ot.id
LEFT JOIN object_status os ON c.status_id = os.id;

-- ============================================================
-- КОНЕЦ МИГРАЦИИ
-- ============================================================

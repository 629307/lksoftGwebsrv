-- ============================================================
-- ИГС (Информационная Географическая Система) - lksoftGwebsrv
-- DDL Schema для PostgreSQL с PostGIS
-- Версия: 1.0.0
-- ============================================================

-- Включение расширения PostGIS
CREATE EXTENSION IF NOT EXISTS postgis;

-- Определение пользовательской проекции МСК86-Зона 4
-- EPSG:2502 - Pulkovo 1942 / Gauss-Kruger zone 4
-- Если нужна специфическая МСК86, можно добавить через spatial_ref_sys
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM spatial_ref_sys WHERE srid = 200004) THEN
        INSERT INTO spatial_ref_sys (srid, auth_name, auth_srid, proj4text, srtext)
        VALUES (
            200004,
            'MSK86',
            4,
            '+proj=tmerc +lat_0=0 +lon_0=69 +k=1 +x_0=4500000 +y_0=0 +ellps=krass +towgs84=23.57,-140.95,-79.8,0,0.35,0.79,-0.22 +units=m +no_defs',
            'PROJCS["MSK86-Zone4",GEOGCS["Pulkovo 1942",DATUM["Pulkovo_1942",SPHEROID["Krassowsky 1940",6378245,298.3]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",69],PARAMETER["scale_factor",1],PARAMETER["false_easting",4500000],PARAMETER["false_northing",0],UNIT["metre",1]]'
        );
    END IF;
END $$;

-- ============================================================
-- РАЗДЕЛ 1: СПРАВОЧНЫЕ ТАБЛИЦЫ
-- ============================================================

-- 1.1 Роли пользователей
CREATE TABLE IF NOT EXISTS roles (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    permissions JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE roles IS 'Роли пользователей системы';
COMMENT ON COLUMN roles.code IS 'Уникальный код роли (admin, user, readonly)';
COMMENT ON COLUMN roles.permissions IS 'JSON с правами доступа';

-- 1.2 Пользователи
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    login VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    full_name VARCHAR(255),
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    is_active BOOLEAN DEFAULT TRUE,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_users_login ON users(login);
CREATE INDEX idx_users_role ON users(role_id);

COMMENT ON TABLE users IS 'Пользователи системы';

-- 1.3 Виды объектов (высокоуровневая категория)
CREATE TABLE IF NOT EXISTS object_types (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    icon VARCHAR(100),
    color VARCHAR(20),
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE object_types IS 'Виды объектов (колодец, кабель, столбик и т.д.)';

-- 1.4 Типы объектов (подкатегория)
CREATE TABLE IF NOT EXISTS object_kinds (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    object_type_id INTEGER REFERENCES object_types(id) ON DELETE CASCADE,
    description TEXT,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE object_kinds IS 'Типы объектов (подвиды)';

-- 1.5 Состояние объектов
CREATE TABLE IF NOT EXISTS object_status (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    color VARCHAR(20),
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE object_status IS 'Состояния объектов (активный, неактивный, повреждён и т.д.)';

-- 1.6 Собственники
CREATE TABLE IF NOT EXISTS owners (
    id SERIAL PRIMARY KEY,
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    short_name VARCHAR(100),
    color VARCHAR(20),
    inn VARCHAR(20),
    address TEXT,
    contact_person VARCHAR(255),
    contact_phone VARCHAR(50),
    contact_email VARCHAR(255),
    notes TEXT,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_owners_name ON owners(name);

COMMENT ON TABLE owners IS 'Собственники объектов';

-- 1.7 Контракты
CREATE TABLE IF NOT EXISTS contracts (
    id SERIAL PRIMARY KEY,
    number VARCHAR(100) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    -- Арендатор
    owner_id INTEGER REFERENCES owners(id) ON DELETE RESTRICT,
    -- Арендодатель
    landlord_id INTEGER REFERENCES owners(id) ON DELETE RESTRICT,
    start_date DATE,
    end_date DATE,
    status VARCHAR(50) DEFAULT 'active',
    amount DECIMAL(15,2),
    notes TEXT,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_contracts_owner ON contracts(owner_id);
CREATE INDEX idx_contracts_landlord ON contracts(landlord_id);
CREATE INDEX idx_contracts_number ON contracts(number);

COMMENT ON TABLE contracts IS 'Контракты на обслуживание';

-- 1.9 Системные настройки
CREATE TABLE IF NOT EXISTS app_settings (
    code VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
);

COMMENT ON TABLE app_settings IS 'Системные настройки приложения (key/value)';

-- 1.10 Персональные настройки пользователей
CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code VARCHAR(100) NOT NULL,
    value TEXT,
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, code)
);

CREATE INDEX idx_user_settings_user ON user_settings(user_id);
CREATE INDEX idx_user_settings_code ON user_settings(code);

COMMENT ON TABLE user_settings IS 'Персональные настройки пользователя (key/value)';

-- 1.8 Стили отображения (удалено, используем object_types + object_status)

-- ============================================================
-- РАЗДЕЛ 2: ОСНОВНЫЕ ТАБЛИЦЫ ОБЪЕКТОВ
-- ============================================================

-- 2.1 Колодцы кабельной канализации
CREATE TABLE IF NOT EXISTS wells (
    id SERIAL PRIMARY KEY,
    number VARCHAR(50) UNIQUE NOT NULL,
    geom_wgs84 GEOMETRY(POINT, 4326) NOT NULL,
    geom_msk86 GEOMETRY(POINT, 200004) NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
    type_id INTEGER NOT NULL REFERENCES object_types(id) ON DELETE RESTRICT,
    kind_id INTEGER NOT NULL REFERENCES object_kinds(id) ON DELETE RESTRICT,
    status_id INTEGER NOT NULL REFERENCES object_status(id) ON DELETE RESTRICT,
    depth DECIMAL(5,2),
    material VARCHAR(100),
    installation_date DATE,
    last_inspection DATE,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_wells_geom_wgs84 ON wells USING GIST (geom_wgs84);
CREATE INDEX idx_wells_geom_msk86 ON wells USING GIST (geom_msk86);
CREATE INDEX idx_wells_owner ON wells(owner_id);
CREATE INDEX idx_wells_type ON wells(type_id);
CREATE INDEX idx_wells_status ON wells(status_id);
CREATE INDEX idx_wells_number ON wells(number);

COMMENT ON TABLE wells IS 'Колодцы кабельной канализации';

-- 2.2 Направления каналов кабельной канализации
CREATE TABLE IF NOT EXISTS channel_directions (
    id SERIAL PRIMARY KEY,
    number VARCHAR(50) NOT NULL,
    geom_wgs84 GEOMETRY(LINESTRING, 4326),
    geom_msk86 GEOMETRY(LINESTRING, 200004),
    owner_id INTEGER REFERENCES owners(id) ON DELETE RESTRICT,
    type_id INTEGER REFERENCES object_types(id) ON DELETE RESTRICT,
    status_id INTEGER REFERENCES object_status(id) ON DELETE RESTRICT,
    start_well_id INTEGER NOT NULL REFERENCES wells(id) ON DELETE RESTRICT,
    end_well_id INTEGER NOT NULL REFERENCES wells(id) ON DELETE RESTRICT,
    length_m DECIMAL(10,2),
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT chk_different_wells CHECK (start_well_id != end_well_id)
);

CREATE INDEX idx_channel_directions_geom_wgs84 ON channel_directions USING GIST (geom_wgs84);
CREATE INDEX idx_channel_directions_geom_msk86 ON channel_directions USING GIST (geom_msk86);
CREATE INDEX idx_channel_directions_start_well ON channel_directions(start_well_id);
CREATE INDEX idx_channel_directions_end_well ON channel_directions(end_well_id);

COMMENT ON TABLE channel_directions IS 'Направления каналов кабельной канализации';

-- 2.3 Каналы кабельной канализации
CREATE TABLE IF NOT EXISTS cable_channels (
    id SERIAL PRIMARY KEY,
    channel_number INTEGER NOT NULL CHECK (channel_number BETWEEN 1 AND 16),
    direction_id INTEGER NOT NULL REFERENCES channel_directions(id) ON DELETE CASCADE,
    kind_id INTEGER REFERENCES object_kinds(id) ON DELETE RESTRICT,
    status_id INTEGER REFERENCES object_status(id) ON DELETE RESTRICT,
    diameter_mm INTEGER,
    material VARCHAR(100),
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_channel_direction UNIQUE (channel_number, direction_id)
);

CREATE INDEX idx_cable_channels_direction ON cable_channels(direction_id);

COMMENT ON TABLE cable_channels IS 'Каналы кабельной канализации (1-16 на направление)';

-- 2.4 Указательные столбики
CREATE TABLE IF NOT EXISTS marker_posts (
    id SERIAL PRIMARY KEY,
    number VARCHAR(50),
    geom_wgs84 GEOMETRY(POINT, 4326),
    geom_msk86 GEOMETRY(POINT, 200004),
    owner_id INTEGER REFERENCES owners(id) ON DELETE RESTRICT,
    type_id INTEGER REFERENCES object_types(id) ON DELETE RESTRICT,
    kind_id INTEGER REFERENCES object_kinds(id) ON DELETE RESTRICT,
    status_id INTEGER REFERENCES object_status(id) ON DELETE RESTRICT,
    height_m DECIMAL(4,2),
    material VARCHAR(100),
    installation_date DATE,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_marker_posts_geom_wgs84 ON marker_posts USING GIST (geom_wgs84);
CREATE INDEX idx_marker_posts_geom_msk86 ON marker_posts USING GIST (geom_msk86);
CREATE INDEX idx_marker_posts_owner ON marker_posts(owner_id);

COMMENT ON TABLE marker_posts IS 'Указательные столбики';

-- 2.5 Кабели в грунте
CREATE TABLE IF NOT EXISTS ground_cables (
    id SERIAL PRIMARY KEY,
    number VARCHAR(50),
    geom_wgs84 GEOMETRY(MULTILINESTRING, 4326),
    geom_msk86 GEOMETRY(MULTILINESTRING, 200004),
    owner_id INTEGER REFERENCES owners(id) ON DELETE RESTRICT,
    contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
    type_id INTEGER REFERENCES object_types(id) ON DELETE RESTRICT,
    kind_id INTEGER REFERENCES object_kinds(id) ON DELETE RESTRICT,
    status_id INTEGER REFERENCES object_status(id) ON DELETE RESTRICT,
    cable_type VARCHAR(100),
    fiber_count INTEGER,
    length_m DECIMAL(10,2),
    installation_date DATE,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_ground_cables_geom_wgs84 ON ground_cables USING GIST (geom_wgs84);
CREATE INDEX idx_ground_cables_geom_msk86 ON ground_cables USING GIST (geom_msk86);
CREATE INDEX idx_ground_cables_owner ON ground_cables(owner_id);
CREATE INDEX idx_ground_cables_contract ON ground_cables(contract_id);

COMMENT ON TABLE ground_cables IS 'Кабели в грунте';

-- 2.6 Кабели воздушными переходами
CREATE TABLE IF NOT EXISTS aerial_cables (
    id SERIAL PRIMARY KEY,
    number VARCHAR(50),
    geom_wgs84 GEOMETRY(MULTILINESTRING, 4326),
    geom_msk86 GEOMETRY(MULTILINESTRING, 200004),
    owner_id INTEGER REFERENCES owners(id) ON DELETE RESTRICT,
    contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
    type_id INTEGER REFERENCES object_types(id) ON DELETE RESTRICT,
    kind_id INTEGER REFERENCES object_kinds(id) ON DELETE RESTRICT,
    status_id INTEGER REFERENCES object_status(id) ON DELETE RESTRICT,
    cable_type VARCHAR(100),
    fiber_count INTEGER,
    length_m DECIMAL(10,2),
    height_m DECIMAL(5,2),
    installation_date DATE,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_aerial_cables_geom_wgs84 ON aerial_cables USING GIST (geom_wgs84);
CREATE INDEX idx_aerial_cables_geom_msk86 ON aerial_cables USING GIST (geom_msk86);
CREATE INDEX idx_aerial_cables_owner ON aerial_cables(owner_id);
CREATE INDEX idx_aerial_cables_contract ON aerial_cables(contract_id);

COMMENT ON TABLE aerial_cables IS 'Кабели воздушными переходами';

-- 2.7 Кабели в кабельной канализации
CREATE TABLE IF NOT EXISTS duct_cables (
    id SERIAL PRIMARY KEY,
    number VARCHAR(50),
    geom_wgs84 GEOMETRY(MULTILINESTRING, 4326),
    geom_msk86 GEOMETRY(MULTILINESTRING, 200004),
    owner_id INTEGER REFERENCES owners(id) ON DELETE RESTRICT,
    contract_id INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
    type_id INTEGER REFERENCES object_types(id) ON DELETE RESTRICT,
    kind_id INTEGER REFERENCES object_kinds(id) ON DELETE RESTRICT,
    status_id INTEGER REFERENCES object_status(id) ON DELETE RESTRICT,
    cable_type VARCHAR(100),
    fiber_count INTEGER,
    length_m DECIMAL(10,2),
    installation_date DATE,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_duct_cables_geom_wgs84 ON duct_cables USING GIST (geom_wgs84);
CREATE INDEX idx_duct_cables_geom_msk86 ON duct_cables USING GIST (geom_msk86);
CREATE INDEX idx_duct_cables_owner ON duct_cables(owner_id);
CREATE INDEX idx_duct_cables_contract ON duct_cables(contract_id);

COMMENT ON TABLE duct_cables IS 'Кабели в кабельной канализации';

-- Связь кабелей канализации с каналами
CREATE TABLE IF NOT EXISTS duct_cable_channels (
    id SERIAL PRIMARY KEY,
    duct_cable_id INTEGER NOT NULL REFERENCES duct_cables(id) ON DELETE CASCADE,
    cable_channel_id INTEGER NOT NULL REFERENCES cable_channels(id) ON DELETE RESTRICT,
    segment_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT uq_duct_cable_channel UNIQUE (duct_cable_id, cable_channel_id)
);

COMMENT ON TABLE duct_cable_channels IS 'Связь кабелей с каналами канализации';

-- ============================================================
-- РАЗДЕЛ 3: ИНЦИДЕНТЫ
-- ============================================================

-- 3.1 Инциденты
CREATE TABLE IF NOT EXISTS incidents (
    id SERIAL PRIMARY KEY,
    number VARCHAR(50) UNIQUE NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    incident_date TIMESTAMP NOT NULL,
    status VARCHAR(50) DEFAULT 'open',
    priority VARCHAR(20) DEFAULT 'normal',
    culprit VARCHAR(255),
    resolution TEXT,
    resolved_at TIMESTAMP,
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_incidents_number ON incidents(number);
CREATE INDEX idx_incidents_status ON incidents(status);
CREATE INDEX idx_incidents_date ON incidents(incident_date);

COMMENT ON TABLE incidents IS 'Инциденты';

-- 3.2 История инцидентов
CREATE TABLE IF NOT EXISTS incident_history (
    id SERIAL PRIMARY KEY,
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    number VARCHAR(50),
    action_type VARCHAR(50) NOT NULL,
    description TEXT,
    action_date TIMESTAMP DEFAULT NOW(),
    created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_incident_history_incident ON incident_history(incident_id);

COMMENT ON TABLE incident_history IS 'История изменений инцидентов';

-- 3.3 Связь инцидентов с объектами (многие-ко-многим)
CREATE TABLE IF NOT EXISTS incident_wells (
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    well_id INTEGER NOT NULL REFERENCES wells(id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, well_id)
);

CREATE TABLE IF NOT EXISTS incident_channel_directions (
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    channel_direction_id INTEGER NOT NULL REFERENCES channel_directions(id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, channel_direction_id)
);

CREATE TABLE IF NOT EXISTS incident_ground_cables (
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    ground_cable_id INTEGER NOT NULL REFERENCES ground_cables(id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, ground_cable_id)
);

CREATE TABLE IF NOT EXISTS incident_aerial_cables (
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    aerial_cable_id INTEGER NOT NULL REFERENCES aerial_cables(id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, aerial_cable_id)
);

CREATE TABLE IF NOT EXISTS incident_duct_cables (
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    duct_cable_id INTEGER NOT NULL REFERENCES duct_cables(id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, duct_cable_id)
);

CREATE TABLE IF NOT EXISTS incident_marker_posts (
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    marker_post_id INTEGER NOT NULL REFERENCES marker_posts(id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, marker_post_id)
);

-- Связь инцидентов с унифицированными кабелями (таблица cables)
CREATE TABLE IF NOT EXISTS incident_cables (
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    cable_id INTEGER NOT NULL REFERENCES cables(id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, cable_id)
);

-- Связь инцидентов с каналами (cable_channels)
CREATE TABLE IF NOT EXISTS incident_cable_channels (
    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    cable_channel_id INTEGER NOT NULL REFERENCES cable_channels(id) ON DELETE CASCADE,
    PRIMARY KEY (incident_id, cable_channel_id)
);

-- Документы инцидентов
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
-- РАЗДЕЛ 4: ГРУППЫ ОБЪЕКТОВ
-- ============================================================

CREATE TABLE IF NOT EXISTS object_groups (
    id SERIAL PRIMARY KEY,
    number VARCHAR(50),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    group_type VARCHAR(50),
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_object_groups_name ON object_groups(name);

COMMENT ON TABLE object_groups IS 'Группы объектов';

-- Связи групп с объектами
CREATE TABLE IF NOT EXISTS group_wells (
    group_id INTEGER NOT NULL REFERENCES object_groups(id) ON DELETE CASCADE,
    well_id INTEGER NOT NULL REFERENCES wells(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, well_id)
);

CREATE TABLE IF NOT EXISTS group_channel_directions (
    group_id INTEGER NOT NULL REFERENCES object_groups(id) ON DELETE CASCADE,
    channel_direction_id INTEGER NOT NULL REFERENCES channel_directions(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, channel_direction_id)
);

CREATE TABLE IF NOT EXISTS group_ground_cables (
    group_id INTEGER NOT NULL REFERENCES object_groups(id) ON DELETE CASCADE,
    ground_cable_id INTEGER NOT NULL REFERENCES ground_cables(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, ground_cable_id)
);

CREATE TABLE IF NOT EXISTS group_aerial_cables (
    group_id INTEGER NOT NULL REFERENCES object_groups(id) ON DELETE CASCADE,
    aerial_cable_id INTEGER NOT NULL REFERENCES aerial_cables(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, aerial_cable_id)
);

CREATE TABLE IF NOT EXISTS group_duct_cables (
    group_id INTEGER NOT NULL REFERENCES object_groups(id) ON DELETE CASCADE,
    duct_cable_id INTEGER NOT NULL REFERENCES duct_cables(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, duct_cable_id)
);

CREATE TABLE IF NOT EXISTS group_marker_posts (
    group_id INTEGER NOT NULL REFERENCES object_groups(id) ON DELETE CASCADE,
    marker_post_id INTEGER NOT NULL REFERENCES marker_posts(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, marker_post_id)
);

-- ============================================================
-- РАЗДЕЛ 5: ФОТОГРАФИИ ОБЪЕКТОВ
-- ============================================================

CREATE TABLE IF NOT EXISTS object_photos (
    id SERIAL PRIMARY KEY,
    -- Полиморфная связь
    object_table VARCHAR(50) NOT NULL,
    object_id INTEGER NOT NULL,
    -- Данные фото
    filename VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255),
    file_path VARCHAR(500) NOT NULL,
    file_size INTEGER,
    mime_type VARCHAR(100),
    width INTEGER,
    height INTEGER,
    thumbnail_path VARCHAR(500),
    description TEXT,
    sort_order INTEGER DEFAULT 0,
    -- Метаданные
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_object_photos_object ON object_photos(object_table, object_id);

COMMENT ON TABLE object_photos IS 'Фотографии объектов (до 10 на объект)';

-- Триггер для ограничения количества фото
CREATE OR REPLACE FUNCTION check_photo_limit()
RETURNS TRIGGER AS $$
BEGIN
    IF (SELECT COUNT(*) FROM object_photos 
        WHERE object_table = NEW.object_table AND object_id = NEW.object_id) >= 10 THEN
        RAISE EXCEPTION 'Максимальное количество фотографий для объекта - 10';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_photo_limit
    BEFORE INSERT ON object_photos
    FOR EACH ROW EXECUTE FUNCTION check_photo_limit();

-- ============================================================
-- РАЗДЕЛ 6: СЕССИИ И ЛОГИРОВАНИЕ
-- ============================================================

CREATE TABLE IF NOT EXISTS user_sessions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_token VARCHAR(255) UNIQUE NOT NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_user_sessions_token ON user_sessions(session_token);
CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);

CREATE TABLE IF NOT EXISTS audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    table_name VARCHAR(100),
    record_id INTEGER,
    old_values JSONB,
    new_values JSONB,
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_table ON audit_log(table_name, record_id);
CREATE INDEX idx_audit_log_date ON audit_log(created_at);

-- ============================================================
-- РАЗДЕЛ 7: ФУНКЦИИ И ТРИГГЕРЫ
-- ============================================================

-- Функция обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Триггеры для обновления updated_at
CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_roles_updated_at BEFORE UPDATE ON roles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_object_types_updated_at BEFORE UPDATE ON object_types FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_object_kinds_updated_at BEFORE UPDATE ON object_kinds FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_object_status_updated_at BEFORE UPDATE ON object_status FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_owners_updated_at BEFORE UPDATE ON owners FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_contracts_updated_at BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_wells_updated_at BEFORE UPDATE ON wells FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_channel_directions_updated_at BEFORE UPDATE ON channel_directions FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_cable_channels_updated_at BEFORE UPDATE ON cable_channels FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_marker_posts_updated_at BEFORE UPDATE ON marker_posts FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_ground_cables_updated_at BEFORE UPDATE ON ground_cables FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_aerial_cables_updated_at BEFORE UPDATE ON aerial_cables FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_duct_cables_updated_at BEFORE UPDATE ON duct_cables FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_incidents_updated_at BEFORE UPDATE ON incidents FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_object_groups_updated_at BEFORE UPDATE ON object_groups FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Функция автоматической трансформации координат WGS84 -> МСК86
CREATE OR REPLACE FUNCTION transform_wgs84_to_msk86()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.geom_wgs84 IS NOT NULL AND NEW.geom_msk86 IS NULL THEN
        NEW.geom_msk86 = ST_Transform(NEW.geom_wgs84, 200004);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Функция автоматической трансформации координат МСК86 -> WGS84
CREATE OR REPLACE FUNCTION transform_msk86_to_wgs84()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.geom_msk86 IS NOT NULL AND NEW.geom_wgs84 IS NULL THEN
        NEW.geom_wgs84 = ST_Transform(NEW.geom_msk86, 4326);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Триггеры для автотрансформации
CREATE TRIGGER trg_wells_transform BEFORE INSERT OR UPDATE ON wells FOR EACH ROW EXECUTE FUNCTION transform_wgs84_to_msk86();
CREATE TRIGGER trg_marker_posts_transform BEFORE INSERT OR UPDATE ON marker_posts FOR EACH ROW EXECUTE FUNCTION transform_wgs84_to_msk86();
CREATE TRIGGER trg_channel_directions_transform BEFORE INSERT OR UPDATE ON channel_directions FOR EACH ROW EXECUTE FUNCTION transform_wgs84_to_msk86();
CREATE TRIGGER trg_ground_cables_transform BEFORE INSERT OR UPDATE ON ground_cables FOR EACH ROW EXECUTE FUNCTION transform_wgs84_to_msk86();
CREATE TRIGGER trg_aerial_cables_transform BEFORE INSERT OR UPDATE ON aerial_cables FOR EACH ROW EXECUTE FUNCTION transform_wgs84_to_msk86();
CREATE TRIGGER trg_duct_cables_transform BEFORE INSERT OR UPDATE ON duct_cables FOR EACH ROW EXECUTE FUNCTION transform_wgs84_to_msk86();

-- ============================================================
-- РАЗДЕЛ 8: ПРЕДСТАВЛЕНИЯ (VIEWS)
-- ============================================================

-- Представление для колодцев с полной информацией
CREATE OR REPLACE VIEW v_wells AS
SELECT 
    w.id,
    w.number,
    ST_AsGeoJSON(w.geom_wgs84)::json as geom_wgs84_json,
    ST_X(w.geom_wgs84) as longitude,
    ST_Y(w.geom_wgs84) as latitude,
    ST_X(w.geom_msk86) as x_msk86,
    ST_Y(w.geom_msk86) as y_msk86,
    o.name as owner_name,
    ot.name as type_name,
    ok.name as kind_name,
    os.name as status_name,
    os.color as status_color,
    w.depth,
    w.material,
    w.installation_date,
    w.notes,
    w.created_at,
    w.updated_at
FROM wells w
LEFT JOIN owners o ON w.owner_id = o.id
LEFT JOIN object_types ot ON w.type_id = ot.id
LEFT JOIN object_kinds ok ON w.kind_id = ok.id
LEFT JOIN object_status os ON w.status_id = os.id;

-- Представление для направлений каналов
CREATE OR REPLACE VIEW v_channel_directions AS
SELECT 
    cd.id,
    cd.number,
    ST_AsGeoJSON(cd.geom_wgs84)::json as geom_wgs84_json,
    ST_Length(cd.geom_wgs84::geography) as calculated_length_m,
    o.name as owner_name,
    ot.name as type_name,
    sw.number as start_well_number,
    ew.number as end_well_number,
    cd.length_m,
    cd.notes,
    cd.created_at
FROM channel_directions cd
LEFT JOIN owners o ON cd.owner_id = o.id
LEFT JOIN object_types ot ON cd.type_id = ot.id
LEFT JOIN wells sw ON cd.start_well_id = sw.id
LEFT JOIN wells ew ON cd.end_well_id = ew.id;

-- Представление для всех кабелей
CREATE OR REPLACE VIEW v_all_cables AS
SELECT 
    'ground' as cable_type,
    gc.id,
    gc.number,
    ST_AsGeoJSON(gc.geom_wgs84)::json as geom_wgs84_json,
    o.name as owner_name,
    c.number as contract_number,
    ot.name as type_name,
    os.name as status_name,
    gc.fiber_count,
    gc.length_m,
    gc.created_at
FROM ground_cables gc
LEFT JOIN owners o ON gc.owner_id = o.id
LEFT JOIN contracts c ON gc.contract_id = c.id
LEFT JOIN object_types ot ON gc.type_id = ot.id
LEFT JOIN object_status os ON gc.status_id = os.id
UNION ALL
SELECT 
    'aerial' as cable_type,
    ac.id,
    ac.number,
    ST_AsGeoJSON(ac.geom_wgs84)::json as geom_wgs84_json,
    o.name as owner_name,
    c.number as contract_number,
    ot.name as type_name,
    os.name as status_name,
    ac.fiber_count,
    ac.length_m,
    ac.created_at
FROM aerial_cables ac
LEFT JOIN owners o ON ac.owner_id = o.id
LEFT JOIN contracts c ON ac.contract_id = c.id
LEFT JOIN object_types ot ON ac.type_id = ot.id
LEFT JOIN object_status os ON ac.status_id = os.id
UNION ALL
SELECT 
    'duct' as cable_type,
    dc.id,
    dc.number,
    ST_AsGeoJSON(dc.geom_wgs84)::json as geom_wgs84_json,
    o.name as owner_name,
    c.number as contract_number,
    ot.name as type_name,
    os.name as status_name,
    dc.fiber_count,
    dc.length_m,
    dc.created_at
FROM duct_cables dc
LEFT JOIN owners o ON dc.owner_id = o.id
LEFT JOIN contracts c ON dc.contract_id = c.id
LEFT JOIN object_types ot ON dc.type_id = ot.id
LEFT JOIN object_status os ON dc.status_id = os.id;

-- ============================================================
-- РАЗДЕЛ 9: НАЧАЛЬНЫЕ ДАННЫЕ
-- ============================================================

-- Роли
INSERT INTO roles (code, name, description, permissions) VALUES
('admin', 'Администратор', 'Полный доступ ко всем функциям системы', '{"all": true}'),
('user', 'Пользователь', 'Просмотр и редактирование объектов', '{"read": true, "write": true, "delete": false}'),
('readonly', 'Только чтение', 'Только просмотр объектов', '{"read": true, "write": false, "delete": false}')
ON CONFLICT (code) DO NOTHING;

-- Администратор по умолчанию (пароль: Kolobaha00!)
-- bcrypt hash для 'Kolobaha00!': $2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi
INSERT INTO users (login, password_hash, email, full_name, role_id) 
SELECT 'root', '$2y$10$MZzcEloBq.ehczL4./cRU.8XYt.NEVPmJBopVITkRZYjmHoB/19DG', 'admin@lksoftg.local', 'Системный администратор', r.id
FROM roles r WHERE r.code = 'admin'
ON CONFLICT (login) DO NOTHING;

-- Виды объектов
INSERT INTO object_types (code, name, description, icon, color) VALUES
('well', 'Колодец', 'Колодец кабельной канализации', 'circle', '#3498db'),
('channel', 'Канал', 'Направление канала кабельной канализации', 'line', '#9b59b6'),
('marker', 'Столбик', 'Указательный столбик', 'marker', '#e67e22'),
('ground_cable', 'Кабель в грунте', 'Кабель проложенный в грунте', 'line', '#27ae60'),
('aerial_cable', 'Воздушный кабель', 'Кабель воздушными переходами', 'line', '#f39c12'),
('duct_cable', 'Кабель в канализации', 'Кабель в кабельной канализации', 'line', '#1abc9c')
ON CONFLICT (code) DO NOTHING;

-- Типы объектов (подвиды)
INSERT INTO object_kinds (code, name, object_type_id, description) 
SELECT 'well_kks', 'ККС', id, 'Колодец кабельной канализации связи' FROM object_types WHERE code = 'well'
ON CONFLICT (code) DO NOTHING;
INSERT INTO object_kinds (code, name, object_type_id, description) 
SELECT 'well_kkst', 'ККСТ', id, 'Колодец кабельной канализации телефонный' FROM object_types WHERE code = 'well'
ON CONFLICT (code) DO NOTHING;
INSERT INTO object_kinds (code, name, object_type_id, description) 
SELECT 'well_kk', 'КК', id, 'Колодец кабельный' FROM object_types WHERE code = 'well'
ON CONFLICT (code) DO NOTHING;
INSERT INTO object_kinds (code, name, object_type_id, description) 
SELECT 'channel_asbestos', 'Асбестоцемент', id, 'Асбестоцементный канал' FROM object_types WHERE code = 'channel'
ON CONFLICT (code) DO NOTHING;
INSERT INTO object_kinds (code, name, object_type_id, description) 
SELECT 'channel_pvc', 'ПВХ', id, 'ПВХ канал' FROM object_types WHERE code = 'channel'
ON CONFLICT (code) DO NOTHING;
INSERT INTO object_kinds (code, name, object_type_id, description) 
SELECT 'channel_hdpe', 'ПНД', id, 'ПНД канал' FROM object_types WHERE code = 'channel'
ON CONFLICT (code) DO NOTHING;
INSERT INTO object_kinds (code, name, object_type_id, description) 
SELECT 'marker_concrete', 'Бетонный', id, 'Бетонный столбик' FROM object_types WHERE code = 'marker'
ON CONFLICT (code) DO NOTHING;
INSERT INTO object_kinds (code, name, object_type_id, description) 
SELECT 'marker_plastic', 'Пластиковый', id, 'Пластиковый столбик' FROM object_types WHERE code = 'marker'
ON CONFLICT (code) DO NOTHING;

-- Состояния объектов
INSERT INTO object_status (code, name, color, description, sort_order) VALUES
('active', 'Активный', '#27ae60', 'Объект в рабочем состоянии', 1),
('inactive', 'Неактивный', '#95a5a6', 'Объект не используется', 2),
('damaged', 'Повреждён', '#e74c3c', 'Объект повреждён', 3),
('repair', 'На ремонте', '#f39c12', 'Объект на ремонте', 4),
('planned', 'Планируемый', '#3498db', 'Планируемый объект', 5),
('decommissioned', 'Выведен', '#7f8c8d', 'Объект выведен из эксплуатации', 6)
ON CONFLICT (code) DO NOTHING;

-- Тестовый собственник
INSERT INTO owners (code, name, short_name, notes) VALUES
('default', 'Не указан', 'Н/У', 'Собственник по умолчанию')
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- КОНЕЦ СХЕМЫ
-- ============================================================

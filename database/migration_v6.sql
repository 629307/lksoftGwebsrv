-- ============================================================
-- Миграция v6.0 - Системные настройки приложения
-- ============================================================

CREATE TABLE IF NOT EXISTS app_settings (
    code VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Значения по умолчанию (если ещё не заданы)
INSERT INTO app_settings (code, value)
VALUES
    ('map_default_zoom', '14'),
    ('map_default_lat', '66.10231'),
    ('map_default_lng', '76.68617'),
    ('cable_in_well_length_m', '3'),
    ('url_geoproj', 'https://geoproj.ru/'),
    ('url_cadastre', 'https://nspd.gov.ru/map?zoom=16.801685060501118&theme_id=1&coordinate_x=8535755.537972113&coordinate_y=9908336.650357058&baseLayerId=235&is_copy_url=true')
ON CONFLICT (code) DO NOTHING;


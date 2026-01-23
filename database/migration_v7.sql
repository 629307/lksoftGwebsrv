-- ============================================================
-- Миграция v7.0 - Персональные настройки пользователей
-- ============================================================

CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code VARCHAR(100) NOT NULL,
    value TEXT,
    updated_at TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, code)
);

CREATE INDEX IF NOT EXISTS idx_user_settings_user ON user_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_user_settings_code ON user_settings(code);

-- Глобальные значения по умолчанию (fallback)
INSERT INTO app_settings (code, value)
VALUES
    ('map_default_zoom', '14'),
    ('map_default_lat', '66.10231'),
    ('map_default_lng', '76.68617'),
    ('line_weight_direction', '2'),
    ('line_weight_cable', '1'),
    ('icon_size_well_marker', '12'),
    ('font_size_well_number_label', '12'),
    ('font_size_direction_length_label', '12'),
    ('url_geoproj', 'https://geoproj.ru/'),
    ('url_cadastre', 'https://nspd.gov.ru/map?zoom=16.801685060501118&theme_id=1&coordinate_x=8535755.537972113&coordinate_y=9908336.650357058&baseLayerId=235&is_copy_url=true'),
    ('well_entry_point_kind_code', 'input'),
    ('hotkey_add_direction', 'a'),
    ('hotkey_add_well', 's'),
    ('hotkey_add_marker', 'd'),
    ('hotkey_add_duct_cable', 'z'),
    ('hotkey_add_ground_cable', 'x'),
    ('hotkey_add_aerial_cable', 'c')
ON CONFLICT (code) DO NOTHING;

-- По ТЗ: глобальная длина кабеля в колодце (м) = 2 (меняет только root)
-- Не затираем кастомные значения, меняем только если было 3 (старый дефолт)
UPDATE app_settings SET value = '2', updated_at = NOW()
WHERE code = 'cable_in_well_length_m' AND value = '3';


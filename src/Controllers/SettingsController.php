<?php
/**
 * Контроллер системных настроек приложения
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class SettingsController extends BaseController
{
    private function defaultSettings(): array
    {
        return [
            // defaults (как в ТЗ)
            'map_default_zoom' => '14',
            'map_default_lat' => '66.10231',
            'map_default_lng' => '76.68617',
            'cable_in_well_length_m' => '2', // глобально для всех, меняет только root
            'input_well_number_start' => '1', // глобально: начало нумерации для "вводных" колодцев
            'line_weight_direction' => '2',
            'line_weight_cable' => '1',
            'icon_size_well_marker' => '12',
            'font_size_well_number_label' => '12',
            'font_size_direction_length_label' => '12',
            // Персональная подсветка выбранного объекта (точка/линия)
            'selected_object_highlight_color' => '#ffff00',
            // Магнитные пиксели для попадания/наведения на объекты карты
            'magnet_pixels' => '0',
            // Ресурс пересчёта координат (по умолчанию)
            'url_geoproj' => 'https://wgs-msk.soilbox.app/',
            'url_cadastre' => 'https://nspd.gov.ru/map?zoom=16.801685060501118&theme_id=1&coordinate_x=8535755.537972113&coordinate_y=9908336.650357058&baseLayerId=235&is_copy_url=true',
            // Персональные слои карты (CSV: wells,channels,markers,groundCables,aerialCables,ductCables)
            'map_layers' => 'wells,channels,markers',
            // Персональная ширина левого сайдбара (px)
            'sidebar_width' => '280',
            // WMTS (спутник) настройки
            'wmts_url_template' => 'https://karta.yanao.ru/ags1/rest/services/basemap/ags1_Imagery_bpla/MapServer/WMTS/tile/1.0.0/basemap_ags1_Imagery_bpla/{Style}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}',
            'wmts_style' => 'default',
            'wmts_tilematrixset' => 'GoogleMapsCompatible',
            'wmts_tilematrix' => '{z}',
            'wmts_tilerow' => '{y}',
            'wmts_tilecol' => '{x}',
            // Персональные значения по умолчанию (карта)
            'default_type_id_direction' => '',
            'default_type_id_well' => '',
            'default_type_id_marker' => '',
            // Персональные "Типы объектов" (object_kinds) по умолчанию (карта)
            'default_kind_id_direction' => '',
            'default_kind_id_well' => '',
            'default_kind_id_marker' => '',
            'default_status_id' => '',
            'default_owner_id' => '',
            'default_contract_id' => '',
            'default_cable_type_id' => '',
            'default_cable_catalog_id' => '',
            'well_entry_point_kind_code' => 'input',
            'well_pole_kind_code' => 'pole',
            // hotkeys
            'hotkey_add_direction' => 'a',
            'hotkey_add_well' => 's',
            'hotkey_add_marker' => 'd',
            'hotkey_add_duct_cable' => 'z',
            'hotkey_add_ground_cable' => 'x',
            'hotkey_add_aerial_cable' => 'c',
        ];
    }

    /**
     * GET /api/settings
     * Получить настройки (map/defaults/urls)
     */
    public function index(): void
    {
        $user = Auth::user();
        if (!$user) {
            Response::error('Требуется авторизация', 401);
        }

        try {
            // 1) defaults
            $out = $this->defaultSettings();

            // 2) global app_settings (fallbacks)
            $rows = $this->db->fetchAll("SELECT code, value FROM app_settings");
            foreach ($rows as $r) {
                if (!isset($r['code'])) continue;
                $out[(string) $r['code']] = (string) ($r['value'] ?? '');
            }

            // 3) per-user overrides (кроме cable_in_well_length_m)
            try {
                $urows = $this->db->fetchAll(
                    "SELECT code, value FROM user_settings WHERE user_id = :uid",
                    ['uid' => (int) $user['id']]
                );
                foreach ($urows as $r) {
                    $code = (string) ($r['code'] ?? '');
                    if ($code === '' || $code === 'cable_in_well_length_m') continue;
                    $out[$code] = (string) ($r['value'] ?? '');
                }
            } catch (\PDOException $e) {
                // user_settings может отсутствовать до применения миграции — игнорируем
            }

            Response::success($out);
        } catch (\PDOException $e) {
            // Миграция может быть не применена
            Response::error('Таблица настроек не создана. Примените миграцию database/migration_v6.sql', 500);
        }
    }

    /**
     * PUT /api/settings
     * Обновить настройки:
     * - все пользователи могут сохранять персональные настройки
     * - cable_in_well_length_m: глобальная настройка, меняет только root
     */
    public function update(): void
    {
        $user = Auth::user();
        if (!$user) {
            Response::error('Требуется авторизация', 401);
        }

        // JSON body уже распарсен в Request::parseBody() при Content-Type: application/json
        $data = $this->request->input(null, []);
        if (!is_array($data)) {
            Response::error('Некорректные данные', 422);
        }

        $isAdmin = Auth::isAdmin();

        // По ТЗ:
        // - администратор: все настройки
        // - пользователь/только чтение: только персональные настройки (без системных разделов данных/интерфейса/WMTS)
        $allowed = $isAdmin ? [
            'map_default_zoom',
            'map_default_lat',
            'map_default_lng',
            'cable_in_well_length_m',
            'input_well_number_start',
            'url_geoproj',
            'url_cadastre',
            'map_layers',
            'sidebar_width',
            // WMTS (спутник)
            'wmts_url_template',
            'wmts_style',
            'wmts_tilematrixset',
            'wmts_tilematrix',
            'wmts_tilerow',
            'wmts_tilecol',
            // Персональные значения по умолчанию (карта)
            'default_type_id_direction',
            'default_type_id_well',
            'default_type_id_marker',
            // Персональные "Типы объектов" (object_kinds) по умолчанию (карта)
            'default_kind_id_direction',
            'default_kind_id_well',
            'default_kind_id_marker',
            'default_status_id',
            'default_owner_id',
            'default_contract_id',
            'default_cable_type_id',
            'default_cable_catalog_id',
            // Hotkeys: Alt + <символ> для инструментов карты
            'hotkey_add_direction',
            'hotkey_add_well',
            'hotkey_add_marker',
            'hotkey_add_duct_cable',
            'hotkey_add_ground_cable',
            'hotkey_add_aerial_cable',
            // Колодцы: тип (object_kinds.code) для "точки ввода"
            'well_entry_point_kind_code',
            // Колодцы: тип (object_kinds.code) для "опора-мачта"
            'well_pole_kind_code',
            // Стили карты
            'line_weight_direction',
            'line_weight_cable',
            'icon_size_well_marker',
            'font_size_well_number_label',
            'font_size_direction_length_label',
            'selected_object_highlight_color',
            'magnet_pixels',
        ] : [
            // Разрешаем только персональные настройки
            'map_layers',
            'sidebar_width',
            'default_type_id_direction',
            'default_type_id_well',
            'default_type_id_marker',
            'default_kind_id_direction',
            'default_kind_id_well',
            'default_kind_id_marker',
            'default_status_id',
            'default_owner_id',
            'default_contract_id',
            'default_cable_type_id',
            'default_cable_catalog_id',
            'hotkey_add_direction',
            'hotkey_add_well',
            'hotkey_add_marker',
            'hotkey_add_duct_cable',
            'hotkey_add_ground_cable',
            'hotkey_add_aerial_cable',
            'well_entry_point_kind_code',
            'well_pole_kind_code',
            'selected_object_highlight_color',
            'magnet_pixels',
        ];

        // Роль "Пользователь": разрешаем персональную настройку ссылок меню
        if (!$isAdmin && Auth::hasRole('user')) {
            $allowed[] = 'url_geoproj';
            $allowed[] = 'url_cadastre';
        }

        $toSave = array_intersect_key($data, array_flip($allowed));

        // Динамические персональные дефолты по видам объектов (ключи вида default_ref_<object_type_code>)
        // Например: default_ref_well, default_ref_channel, default_ref_marker, default_ref_cable_ground
        foreach ($data as $k => $v) {
            if (!is_string($k)) continue;
            if (substr($k, 0, 12) === 'default_ref_') {
                // ограничим длину ключа, чтобы не принимать мусор
                if (strlen($k) > 80) continue;
                $toSave[$k] = $v;
            }
        }

        foreach ($toSave as $k => $v) {
            if ($v === null) $toSave[$k] = '';
            if (is_bool($v) || is_int($v) || is_float($v)) $toSave[$k] = (string) $v;
            if (is_array($v) || is_object($v)) {
                Response::error('Некорректное значение настройки: ' . $k, 422);
            }
        }

        $saved = [];
        try {
            $this->db->beginTransaction();

            foreach ($toSave as $code => $value) {
            if ($code === 'cable_in_well_length_m' || $code === 'input_well_number_start') {
                    if (!Auth::isRoot()) {
                    if ($code === 'cable_in_well_length_m') {
                        Response::error('Доступ запрещён: изменить "Учитываемая длина кабеля в колодце (м)" может только пользователь root', 403);
                    }
                    Response::error('Доступ запрещён: изменить "Начало нумерации Объектов колодец вводной" может только пользователь root', 403);
                    }
                    $this->db->query(
                        "INSERT INTO app_settings(code, value, updated_at)
                         VALUES (:code, :value, NOW())
                         ON CONFLICT (code) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
                        ['code' => $code, 'value' => $value]
                    );
                    $saved[$code] = $value;
                    continue;
                }

                // персональные настройки
                $this->db->query(
                    "INSERT INTO user_settings(user_id, code, value, updated_at)
                     VALUES (:uid, :code, :value, NOW())
                     ON CONFLICT (user_id, code) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
                    ['uid' => (int) $user['id'], 'code' => $code, 'value' => $value]
                );
                $saved[$code] = $value;
            }

            $this->db->commit();
        } catch (\PDOException $e) {
            $this->db->rollback();
            Response::error('Таблица настроек не создана. Примените миграцию database/migration_v6.sql и database/migration_v7.sql', 500);
        } catch (\Throwable $e) {
            $this->db->rollback();
            throw $e;
        }

        Response::success($saved, 'Настройки сохранены');
    }
}


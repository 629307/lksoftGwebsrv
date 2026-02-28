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
            // Импортированные слои: персональная активация (CSV codes)
            'imported_layers_enabled' => '',
            'cable_in_well_length_m' => '2', // глобально для всех, меняет только root
            'input_well_number_start' => '1', // глобально: начало нумерации для "вводных" колодцев
            'well_pole_number_start' => '100000', // глобально: начало нумерации для "опора-мачта"
            'line_weight_direction' => '2',
            'line_weight_cable' => '1',
            'icon_size_well_marker' => '12',
            'font_size_well_number_label' => '12',
            'font_size_direction_length_label' => '12',
            // Персональная подсветка выбранного объекта (точка/линия)
            'selected_object_highlight_color' => '#ffff00',
            // Персональный фон карты (#map background)
            'map_background_color' => '',
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
            // Направления: код статуса "по зданию" (для спец-правил и отображения)
            'direction_inbuilding_status_code' => 'inbuilding',
            // ========================
            // Настройка данных ГИС: параметры отображения/алгоритмов (глобальные)
            // (дефолты соответствуют ранее "зашитым" значениям)
            // ========================
            // Подсказки: минимальный зум
            'min_zoom_well_labels' => '14',
            'min_zoom_object_coordinates' => '14',
            // Инвентаризация: цвета/толщина
            'inventory_color_negative' => '#0098ff',
            'inventory_color_zero' => '#01b73f',
            'inventory_color_one' => '#f9adad',
            'inventory_color_max' => '#ff0000',
            'inventory_color_no_data' => '#777777',
            'inventory_weight_multiplier_has_value' => '2',
            'inventory_weight_multiplier_no_value' => '0.5',
            // Предполагаемые кабели: стиль
            'assumed_routes_color' => '#8300ff',
            'assumed_routes_opacity' => '0.1',
            'assumed_base_grid_color' => '#777777',
            'assumed_base_grid_opacity' => '0.75',
            'assumed_base_grid_weight_multiplier' => '0.5',
            // Подсветка кабеля
            'cable_highlight_color' => '#ff0000',
            'cable_highlight_weight' => '5',
            'cable_highlight_opacity' => '0.95',
            // Линии: пунктир
            'inbuilding_dash_array' => '6, 6',
            'aerial_cable_dash_array' => '5, 5',
            // Лимиты
            'inventory_max_cable_count_per_direction' => '100',
            'photos_max_per_object' => '10',
            // Вложения: расширения/лимиты размера (байт)
            'group_attachments_allowed_extensions' => 'jpg,jpeg,png,gif,webp,pdf,doc,docx,xls,xlsx,txt,csv',
            'group_attachments_max_upload_bytes' => (string) (10 * 1024 * 1024),
            'incident_documents_allowed_extensions' => 'pdf,doc,docx,xls,xlsx,txt,csv,zip,rar',
            'incident_documents_max_upload_bytes' => (string) (10 * 1024 * 1024),
            'inventory_attachments_allowed_extensions' => 'jpg,jpeg,png,gif,webp,pdf,doc,docx,xls,xlsx,txt,csv,zip,rar',
            'inventory_attachments_max_upload_bytes' => (string) (50 * 1024 * 1024),
            // Предполагаемые кабели: коэффициенты/лимиты алгоритма
            'assumed_lambda_tag_m' => '25',
            'assumed_mu_bottleneck_m' => '50',
            'assumed_max_routes' => '20000',
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
                    // Глобальные настройки не должны переопределяться user_settings
                    if ($code === '') continue;
                    if (in_array($code, [
                        'cable_in_well_length_m',
                        'input_well_number_start',
                        'well_pole_number_start',
                        'well_entry_point_kind_code',
                        'well_pole_kind_code',
                        'direction_inbuilding_status_code',
                        'min_zoom_well_labels',
                        'min_zoom_object_coordinates',
                        'inventory_color_negative',
                        'inventory_color_zero',
                        'inventory_color_one',
                        'inventory_color_max',
                        'inventory_color_no_data',
                        'inventory_weight_multiplier_has_value',
                        'inventory_weight_multiplier_no_value',
                        'assumed_routes_color',
                        'assumed_routes_opacity',
                        'assumed_base_grid_color',
                        'assumed_base_grid_opacity',
                        'assumed_base_grid_weight_multiplier',
                        'cable_highlight_color',
                        'cable_highlight_weight',
                        'cable_highlight_opacity',
                        'inbuilding_dash_array',
                        'aerial_cable_dash_array',
                        'inventory_max_cable_count_per_direction',
                        'photos_max_per_object',
                        'group_attachments_allowed_extensions',
                        'group_attachments_max_upload_bytes',
                        'incident_documents_allowed_extensions',
                        'incident_documents_max_upload_bytes',
                        'inventory_attachments_allowed_extensions',
                        'inventory_attachments_max_upload_bytes',
                        'assumed_lambda_tag_m',
                        'assumed_mu_bottleneck_m',
                        'assumed_max_routes',
                    ], true)) {
                        continue;
                    }
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
        if (Auth::hasRole('readonly')) {
            Response::error('Настройки недоступны для роли "Только чтение"', 403);
        }

        // JSON body уже распарсен в Request::parseBody() при Content-Type: application/json
        $data = $this->request->input(null, []);
        if (!is_array($data)) {
            Response::error('Некорректные данные', 422);
        }

        $isAdmin = Auth::isAdmin();
        $isUser = Auth::hasRole('user');
        $isAdminLike = $isAdmin || Auth::isRoot();

        // По ТЗ:
        // - администратор: все настройки
        // - пользователь: только персональные настройки (интерфейс карты + ссылки меню + hotkeys) + персональные "настройки по умолчанию" (панель карты)
        $allowed = $isAdminLike ? [
            'map_default_zoom',
            'map_default_lat',
            'map_default_lng',
            'cable_in_well_length_m',
            'input_well_number_start',
            'well_pole_number_start',
            'direction_inbuilding_status_code',
            // Настройка данных ГИС: параметры отображения/алгоритмов (глобальные)
            'min_zoom_well_labels',
            'min_zoom_object_coordinates',
            'inventory_color_negative',
            'inventory_color_zero',
            'inventory_color_one',
            'inventory_color_max',
            'inventory_color_no_data',
            'inventory_weight_multiplier_has_value',
            'inventory_weight_multiplier_no_value',
            'assumed_routes_color',
            'assumed_routes_opacity',
            'assumed_base_grid_color',
            'assumed_base_grid_opacity',
            'assumed_base_grid_weight_multiplier',
            'cable_highlight_color',
            'cable_highlight_weight',
            'cable_highlight_opacity',
            'inbuilding_dash_array',
            'aerial_cable_dash_array',
            'inventory_max_cable_count_per_direction',
            'photos_max_per_object',
            'group_attachments_allowed_extensions',
            'group_attachments_max_upload_bytes',
            'incident_documents_allowed_extensions',
            'incident_documents_max_upload_bytes',
            'inventory_attachments_allowed_extensions',
            'inventory_attachments_max_upload_bytes',
            'assumed_lambda_tag_m',
            'assumed_mu_bottleneck_m',
            'assumed_max_routes',
            'url_geoproj',
            'url_cadastre',
            'map_layers',
            'imported_layers_enabled',
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
            'map_background_color',
            'magnet_pixels',
        ] : [
            // Разрешаем только персональные настройки
            'map_layers',
            'imported_layers_enabled',
            'sidebar_width',
            // Персональные значения по умолчанию (панель карты)
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
            // Стили карты (персонально)
            'line_weight_direction',
            'line_weight_cable',
            'icon_size_well_marker',
            'font_size_well_number_label',
            'font_size_direction_length_label',
            'hotkey_add_direction',
            'hotkey_add_well',
            'hotkey_add_marker',
            'hotkey_add_duct_cable',
            'hotkey_add_ground_cable',
            'hotkey_add_aerial_cable',
            'selected_object_highlight_color',
            'map_background_color',
            'magnet_pixels',
        ];

        // Роль "Пользователь": разрешаем персональную настройку ссылок меню
        if (!$isAdmin && $isUser) {
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

            $requireAdminLikeFor = function(string $code) use ($isAdminLike) {
                if (!$isAdminLike) {
                    Response::error('Доступ запрещён: изменить глобальные настройки может только администратор', 403);
                }
            };

            $validateColor = function(string $code, $value): string {
                $v = trim((string) ($value ?? ''));
                if (!preg_match('/^#[0-9a-f]{6}$/i', $v)) {
                    Response::error('Некорректное значение настройки: ' . $code, 422);
                }
                return strtolower($v);
            };

            $validateNumber = function(string $code, $value, float $min, float $max, bool $allowFloat = true): string {
                $raw = trim((string) ($value ?? ''));
                if ($raw === '') Response::error('Некорректное значение настройки: ' . $code, 422);
                if (!is_numeric($raw)) Response::error('Некорректное значение настройки: ' . $code, 422);
                $n = $allowFloat ? (float) $raw : (int) $raw;
                if (!is_finite($n) || $n < $min || $n > $max) {
                    Response::error('Некорректное значение настройки: ' . $code, 422);
                }
                return (string) $n;
            };

            $validateDashArray = function(string $code, $value): string {
                $v = trim((string) ($value ?? ''));
                if ($v === '') Response::error('Некорректное значение настройки: ' . $code, 422);
                // Ожидаем формат "6, 6" (число, запятая, число), допускаем пробелы/десятичные.
                if (!preg_match('/^\d+(\.\d+)?\s*,\s*\d+(\.\d+)?$/', $v)) {
                    Response::error('Некорректное значение настройки: ' . $code, 422);
                }
                return $v;
            };

            $validateExtList = function(string $code, $value): string {
                $raw = trim((string) ($value ?? ''));
                if ($raw === '') Response::error('Некорректное значение настройки: ' . $code, 422);
                $parts = preg_split('/[,\s]+/', $raw) ?: [];
                $out = [];
                foreach ($parts as $p) {
                    $e = strtolower(trim((string) $p));
                    if ($e === '') continue;
                    if (!preg_match('/^[a-z0-9]{1,10}$/', $e)) {
                        Response::error('Некорректное значение настройки: ' . $code, 422);
                    }
                    $out[$e] = true;
                }
                if (!$out) Response::error('Некорректное значение настройки: ' . $code, 422);
                return implode(',', array_keys($out));
            };

            foreach ($toSave as $code => $value) {
                // Глобальные настройки
                if (in_array($code, ['well_entry_point_kind_code', 'well_pole_kind_code', 'direction_inbuilding_status_code'], true)) {
                    $requireAdminLikeFor($code);
                    if ($code === 'direction_inbuilding_status_code') {
                        $v = strtolower(trim((string) $value));
                        if ($v === '') {
                            Response::error('Некорректное значение настройки: direction_inbuilding_status_code', 422);
                        }
                        $exists = $this->db->fetch("SELECT id FROM object_status WHERE code = :c LIMIT 1", ['c' => $v]);
                        if (!$exists) {
                            Response::error('Некорректное состояние: такого кода нет в справочнике "Состояния"', 422);
                        }
                        $value = $v;
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

                // Настройка данных ГИС: глобальные параметры отображения/алгоритмов
                if (in_array($code, [
                    'min_zoom_well_labels',
                    'min_zoom_object_coordinates',
                    'inventory_color_negative',
                    'inventory_color_zero',
                    'inventory_color_one',
                    'inventory_color_max',
                    'inventory_color_no_data',
                    'inventory_weight_multiplier_has_value',
                    'inventory_weight_multiplier_no_value',
                    'assumed_routes_color',
                    'assumed_routes_opacity',
                    'assumed_base_grid_color',
                    'assumed_base_grid_opacity',
                    'assumed_base_grid_weight_multiplier',
                    'cable_highlight_color',
                    'cable_highlight_weight',
                    'cable_highlight_opacity',
                    'inbuilding_dash_array',
                    'aerial_cable_dash_array',
                    'inventory_max_cable_count_per_direction',
                    'photos_max_per_object',
                    'group_attachments_allowed_extensions',
                    'group_attachments_max_upload_bytes',
                    'incident_documents_allowed_extensions',
                    'incident_documents_max_upload_bytes',
                    'inventory_attachments_allowed_extensions',
                    'inventory_attachments_max_upload_bytes',
                    'assumed_lambda_tag_m',
                    'assumed_mu_bottleneck_m',
                    'assumed_max_routes',
                ], true)) {
                    $requireAdminLikeFor($code);

                    // Валидация по типу
                    if (in_array($code, [
                        'inventory_color_negative',
                        'inventory_color_zero',
                        'inventory_color_one',
                        'inventory_color_max',
                        'inventory_color_no_data',
                        'assumed_routes_color',
                        'assumed_base_grid_color',
                        'cable_highlight_color',
                    ], true)) {
                        $value = $validateColor($code, $value);
                    } elseif (in_array($code, ['inbuilding_dash_array', 'aerial_cable_dash_array'], true)) {
                        $value = $validateDashArray($code, $value);
                    } elseif (in_array($code, [
                        'group_attachments_allowed_extensions',
                        'incident_documents_allowed_extensions',
                        'inventory_attachments_allowed_extensions',
                    ], true)) {
                        $value = $validateExtList($code, $value);
                    } elseif (in_array($code, [
                        'min_zoom_well_labels',
                        'min_zoom_object_coordinates',
                    ], true)) {
                        $value = $validateNumber($code, $value, 0, 30, false);
                    } elseif (in_array($code, [
                        'inventory_max_cable_count_per_direction',
                        'photos_max_per_object',
                        'assumed_max_routes',
                    ], true)) {
                        $value = $validateNumber($code, $value, 0, 1000000, false);
                    } elseif (in_array($code, [
                        'group_attachments_max_upload_bytes',
                        'incident_documents_max_upload_bytes',
                        'inventory_attachments_max_upload_bytes',
                    ], true)) {
                        $value = $validateNumber($code, $value, 0, 1024 * 1024 * 1024, false);
                    } elseif (in_array($code, [
                        'inventory_weight_multiplier_has_value',
                        'inventory_weight_multiplier_no_value',
                        'assumed_routes_opacity',
                        'assumed_base_grid_opacity',
                        'assumed_base_grid_weight_multiplier',
                        'cable_highlight_opacity',
                        'assumed_lambda_tag_m',
                        'assumed_mu_bottleneck_m',
                    ], true)) {
                        // float ranges
                        $max = 1000000;
                        $min = 0;
                        if ($code === 'assumed_routes_opacity' || $code === 'assumed_base_grid_opacity' || $code === 'cable_highlight_opacity') {
                            $min = 0; $max = 1;
                        }
                        $value = $validateNumber($code, $value, $min, $max, true);
                    } elseif ($code === 'cable_highlight_weight') {
                        $value = $validateNumber($code, $value, 0.5, 50, true);
                    }

                    $this->db->query(
                        "INSERT INTO app_settings(code, value, updated_at)
                         VALUES (:code, :value, NOW())
                         ON CONFLICT (code) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
                        ['code' => $code, 'value' => (string) $value]
                    );
                    $saved[$code] = (string) $value;
                    continue;
                }

                if ($code === 'cable_in_well_length_m' || $code === 'input_well_number_start' || $code === 'well_pole_number_start') {
                    if (!Auth::isRoot()) {
                    if ($code === 'cable_in_well_length_m') {
                        Response::error('Доступ запрещён: изменить "Учитываемая длина кабеля в колодце (м)" может только пользователь root', 403);
                    }
                    if ($code === 'input_well_number_start') {
                        Response::error('Доступ запрещён: изменить "Начало нумерации Объектов колодец вводной" может только пользователь root', 403);
                    }
                    Response::error('Доступ запрещён: изменить "Начало нумерации Объектов Опора-Мачта" может только пользователь root', 403);
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


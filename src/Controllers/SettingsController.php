<?php
/**
 * Контроллер системных настроек приложения
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class SettingsController extends BaseController
{
    /**
     * GET /api/settings
     * Получить настройки (map/defaults/urls)
     */
    public function index(): void
    {
        try {
            $rows = $this->db->fetchAll("SELECT code, value FROM app_settings");
            $out = [];
            foreach ($rows as $r) {
                $out[$r['code']] = $r['value'];
            }
            Response::success($out);
        } catch (\PDOException $e) {
            // Миграция может быть не применена
            Response::error('Таблица настроек не создана. Примените миграцию database/migration_v6.sql', 500);
        }
    }

    /**
     * PUT /api/settings
     * Обновить настройки (только админ)
     */
    public function update(): void
    {
        if (!Auth::isAdmin()) {
            Response::error('Доступ запрещён', 403);
        }

        // JSON body уже распарсен в Request::parseBody() при Content-Type: application/json
        $data = $this->request->input(null, []);
        if (!is_array($data)) {
            Response::error('Некорректные данные', 422);
        }

        $allowed = [
            'map_default_zoom',
            'map_default_lat',
            'map_default_lng',
            'cable_in_well_length_m',
            'url_geoproj',
            'url_cadastre',
            // Hotkeys: Alt + <символ> для инструментов карты
            'hotkey_add_direction',
            'hotkey_add_well',
            'hotkey_add_marker',
            'hotkey_add_duct_cable',
            'hotkey_add_ground_cable',
            'hotkey_add_aerial_cable',
            // Колодцы: тип (object_kinds.code) для "точки ввода"
            'well_entry_point_kind_code',
            // Стили карты
            'line_weight_direction',
            'line_weight_cable',
            'icon_size_well_marker',
        ];

        $toSave = array_intersect_key($data, array_flip($allowed));

        foreach ($toSave as $k => $v) {
            if ($v === null) $toSave[$k] = '';
            if (is_bool($v) || is_int($v) || is_float($v)) $toSave[$k] = (string) $v;
            if (is_array($v) || is_object($v)) {
                Response::error('Некорректное значение настройки: ' . $k, 422);
            }
        }

        try {
            $this->db->beginTransaction();
            foreach ($toSave as $code => $value) {
                $this->db->query(
                    "INSERT INTO app_settings(code, value, updated_at)
                     VALUES (:code, :value, NOW())
                     ON CONFLICT (code) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
                    ['code' => $code, 'value' => $value]
                );
            }
            $this->db->commit();
        } catch (\PDOException $e) {
            $this->db->rollback();
            Response::error('Таблица настроек не создана. Примените миграцию database/migration_v6.sql', 500);
        } catch (\Throwable $e) {
            $this->db->rollback();
            throw $e;
        }

        Response::success($toSave, 'Настройки сохранены');
    }
}


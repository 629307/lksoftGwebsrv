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
        $rows = $this->db->fetchAll("SELECT code, value FROM app_settings");
        $out = [];
        foreach ($rows as $r) {
            $out[$r['code']] = $r['value'];
        }
        Response::success($out);
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

        $data = $this->request->json() ?? [];
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
        } catch (\Throwable $e) {
            $this->db->rollback();
            throw $e;
        }

        Response::success($toSave, 'Настройки сохранены');
    }
}


<?php
/**
 * Преднастройки пересчёта координат (PROJ строки) для импорта MapInfo слоёв
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class ImportedLayerProjPresetController extends BaseController
{
    private function requireAdminLike(): void
    {
        if (!Auth::isAdmin() && !Auth::isRoot()) {
            Response::error('Доступ запрещён', 403);
        }
    }

    private function normalizeName(string $raw): string
    {
        $s = trim($raw);
        if ($s === '') Response::error('Не задано наименование', 422);
        if (strlen($s) > 240) Response::error('Слишком длинное наименование', 422);
        return $s;
    }

    private function normalizeProj4(string $raw): string
    {
        $s = trim($raw);
        if ($s === '') Response::error('Не задана PROJ строка', 422);
        // По ТЗ: обязательно в двойных кавычках
        if (!preg_match('/^"([^"\\r\\n]{3,480})"$/', $s)) {
            Response::error('PROJ строка должна быть в двойных кавычках', 422);
        }
        return $s;
    }

    /**
     * GET /api/imported-layer-proj-presets
     */
    public function index(): void
    {
        $this->requireAdminLike();
        try {
            $rows = $this->db->fetchAll(
                "SELECT id, name, proj4, created_at, updated_at
                 FROM imported_layer_proj_presets
                 ORDER BY name ASC, id ASC"
            );
        } catch (\PDOException $e) {
            Response::error('Таблица преднастроек не создана. Примените миграцию database/migration_v24.sql', 500);
        }
        Response::success($rows);
    }

    /**
     * POST /api/imported-layer-proj-presets
     * JSON: { name, proj4 }
     */
    public function store(): void
    {
        $this->requireAdminLike();
        $data = $this->request->input(null, []);
        if (!is_array($data)) Response::error('Некорректные данные', 422);

        $name = $this->normalizeName((string) ($data['name'] ?? ''));
        $proj4 = $this->normalizeProj4((string) ($data['proj4'] ?? ''));

        try {
            $id = (int) $this->db->insert('imported_layer_proj_presets', [
                'name' => $name,
                'proj4' => $proj4,
                'updated_at' => date('Y-m-d H:i:s'),
            ]);
            $row = $this->db->fetch("SELECT id, name, proj4, created_at, updated_at FROM imported_layer_proj_presets WHERE id = :id", ['id' => $id]);
        } catch (\PDOException $e) {
            // unique name
            Response::error('Преднастройка с таким наименованием уже существует', 409);
        }

        try { $this->log('create_imported_layer_proj_preset', 'imported_layer_proj_presets', (int) ($row['id'] ?? 0), null, $row); } catch (\Throwable $e) {}
        Response::success($row, 'Преднастройка сохранена');
    }

    /**
     * PUT /api/imported-layer-proj-presets/{id}
     * JSON: { name, proj4 }
     */
    public function update(string $id): void
    {
        $this->requireAdminLike();
        $pid = (int) $id;
        if ($pid <= 0) Response::error('Некорректный id', 422);
        $data = $this->request->input(null, []);
        if (!is_array($data)) Response::error('Некорректные данные', 422);

        $name = $this->normalizeName((string) ($data['name'] ?? ''));
        $proj4 = $this->normalizeProj4((string) ($data['proj4'] ?? ''));

        try {
            $old = $this->db->fetch("SELECT * FROM imported_layer_proj_presets WHERE id = :id", ['id' => $pid]);
            if (!$old) Response::error('Преднастройка не найдена', 404);
            $this->db->update('imported_layer_proj_presets', [
                'name' => $name,
                'proj4' => $proj4,
                'updated_at' => date('Y-m-d H:i:s'),
            ], 'id = :id', ['id' => $pid]);
            $row = $this->db->fetch("SELECT id, name, proj4, created_at, updated_at FROM imported_layer_proj_presets WHERE id = :id", ['id' => $pid]);
        } catch (\PDOException $e) {
            Response::error('Преднастройка с таким наименованием уже существует', 409);
        }

        try { $this->log('update_imported_layer_proj_preset', 'imported_layer_proj_presets', $pid, $old, $row); } catch (\Throwable $e) {}
        Response::success($row, 'Преднастройка обновлена');
    }

    /**
     * DELETE /api/imported-layer-proj-presets/{id}
     */
    public function destroy(string $id): void
    {
        $this->requireAdminLike();
        $pid = (int) $id;
        if ($pid <= 0) Response::error('Некорректный id', 422);

        try {
            $old = $this->db->fetch("SELECT * FROM imported_layer_proj_presets WHERE id = :id", ['id' => $pid]);
            if (!$old) Response::error('Преднастройка не найдена', 404);
            $this->db->delete('imported_layer_proj_presets', 'id = :id', ['id' => $pid]);
        } catch (\PDOException $e) {
            Response::error('Ошибка удаления преднастройки', 500);
        }

        try { $this->log('delete_imported_layer_proj_preset', 'imported_layer_proj_presets', $pid, $old, null); } catch (\Throwable $e) {}
        Response::success(null, 'Преднастройка удалена');
    }
}


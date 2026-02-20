<?php
/**
 * Контроллер инвентарных карточек (привязка к колодцу)
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class InventoryCardController extends BaseController
{
    /**
     * GET /api/inventory-cards?well_id=..
     */
    public function index(): void
    {
        $pagination = $this->getPagination();
        $filters = $this->buildFilters([
            'well_id' => 'ic.well_id',
        ]);
        $where = $filters['where'];
        $params = $filters['params'];

        $totalSql = "SELECT COUNT(*) as cnt FROM inventory_cards ic";
        if ($where) $totalSql .= " WHERE {$where}";
        $total = (int) ($this->db->fetch($totalSql, $params)['cnt'] ?? 0);

        $sql = "SELECT ic.id, ic.well_id, ic.number, ic.filled_date, ic.created_at, ic.updated_at,
                       w.number as well_number,
                       w.owner_id as well_owner_id,
                       o.code as well_owner_code, o.name as well_owner_name
                FROM inventory_cards ic
                JOIN wells w ON ic.well_id = w.id
                LEFT JOIN owners o ON w.owner_id = o.id";
        if ($where) $sql .= " WHERE {$where}";
        $sql .= " ORDER BY ic.filled_date DESC, ic.id DESC LIMIT :limit OFFSET :offset";
        $params['limit'] = $pagination['limit'];
        $params['offset'] = $pagination['offset'];

        $rows = $this->db->fetchAll($sql, $params);
        Response::paginated($rows, $total, $pagination['page'], $pagination['limit']);
    }

    /**
     * GET /api/inventory-cards/well/{id}
     * Все карточки колодца (без пагинации, для UI переключателя)
     */
    public function byWell(string $id): void
    {
        $wellId = (int) $id;
        $well = $this->db->fetch("SELECT id FROM wells WHERE id = :id", ['id' => $wellId]);
        if (!$well) Response::error('Колодец не найден', 404);

        $rows = $this->db->fetchAll(
            "SELECT ic.id, ic.well_id, ic.number, ic.filled_date, ic.created_at, ic.updated_at
             FROM inventory_cards ic
             WHERE ic.well_id = :id
             ORDER BY ic.filled_date DESC, ic.id DESC",
            ['id' => $wellId]
        );
        Response::success($rows);
    }

    /**
     * GET /api/inventory-cards/well/{id}/directions
     * Список направлений колодца (start/end), уникально по id.
     */
    public function wellDirections(string $id): void
    {
        $wellId = (int) $id;
        $well = $this->db->fetch("SELECT id FROM wells WHERE id = :id", ['id' => $wellId]);
        if (!$well) Response::error('Колодец не найден', 404);

        $rows = $this->db->fetchAll(
            "SELECT cd.id, cd.number, cd.start_well_id, cd.end_well_id,
                    sw.number as start_well_number,
                    ew.number as end_well_number
             FROM channel_directions cd
             LEFT JOIN wells sw ON cd.start_well_id = sw.id
             LEFT JOIN wells ew ON cd.end_well_id = ew.id
             WHERE cd.start_well_id = :id OR cd.end_well_id = :id
             ORDER BY cd.number",
            ['id' => $wellId]
        );
        Response::success($rows);
    }

    /**
     * GET /api/inventory-cards/{id}
     */
    public function show(string $id): void
    {
        $cardId = (int) $id;
        $card = $this->db->fetch(
            "SELECT ic.id, ic.well_id, ic.seq, ic.number, ic.filled_date, ic.created_at, ic.updated_at,
                    w.number as well_number, w.owner_id as well_owner_id,
                    o.code as well_owner_code, o.name as well_owner_name
             FROM inventory_cards ic
             JOIN wells w ON ic.well_id = w.id
             LEFT JOIN owners o ON w.owner_id = o.id
             WHERE ic.id = :id",
            ['id' => $cardId]
        );
        if (!$card) Response::error('Инвентарная карточка не найдена', 404);

        $dirRows = $this->db->fetchAll(
            "SELECT idc.id, idc.card_id, idc.direction_id, idc.cable_count,
                    cd.number as direction_number,
                    cd.start_well_id, cd.end_well_id
             FROM inventory_direction_cables idc
             JOIN channel_directions cd ON idc.direction_id = cd.id
             WHERE idc.card_id = :id
             ORDER BY cd.number",
            ['id' => $cardId]
        );

        $tags = $this->db->fetchAll(
            "SELECT it.id, it.card_id, it.owner_id, o.code as owner_code, o.name as owner_name
             FROM inventory_tags it
             JOIN owners o ON it.owner_id = o.id
             WHERE it.card_id = :id
             ORDER BY o.name",
            ['id' => $cardId]
        );

        $atts = [];
        try {
            $atts = $this->db->fetchAll(
                "SELECT a.*, u.login as uploaded_by_login
                 FROM inventory_card_attachments a
                 LEFT JOIN users u ON a.uploaded_by = u.id
                 WHERE a.card_id = :id
                 ORDER BY a.created_at DESC",
                ['id' => $cardId]
            );
            foreach ($atts as &$a) {
                $a['url'] = '/uploads/' . basename(dirname($a['file_path'])) . '/' . $a['filename'];
            }
        } catch (\Throwable $e) {
            $atts = [];
        }

        $card['direction_cables'] = $dirRows;
        $card['tags'] = $tags;
        $card['attachments'] = $atts;
        Response::success($card);
    }

    /**
     * POST /api/inventory-cards
     */
    public function store(): void
    {
        $this->checkWriteAccess();

        $user = Auth::user();
        $data = $this->request->input(null, []);
        if (!is_array($data)) Response::error('Некорректные данные', 422);

        $wellId = (int) ($data['well_id'] ?? 0);
        if ($wellId <= 0) Response::error('Не задан well_id', 422);
        $well = $this->db->fetch("SELECT id FROM wells WHERE id = :id", ['id' => $wellId]);
        if (!$well) Response::error('Колодец не найден', 404);

        $filledDate = (string) ($data['filled_date'] ?? '');
        $filledDate = trim($filledDate) !== '' ? $filledDate : null;

        $dirCables = $data['direction_cables'] ?? [];
        if (!is_array($dirCables)) Response::error('direction_cables должен быть массивом', 422);

        $tags = $data['tags'] ?? [];
        if (!is_array($tags)) Response::error('tags должен быть массивом', 422);

        $this->db->beginTransaction();
        try {
            $cardId = (int) $this->db->insert('inventory_cards', [
                'well_id' => $wellId,
                'number' => null, // выставит триггер
                'filled_date' => $filledDate,
            ]);

            // направления: сохраняем даже если cable_count пустой/0
            foreach ($dirCables as $row) {
                if (!is_array($row)) continue;
                $did = (int) ($row['direction_id'] ?? 0);
                $cnt = (int) ($row['cable_count'] ?? 0);
                if ($did <= 0) continue;
                if ($cnt < 0) $cnt = 0;
                if ($cnt > 100) $cnt = 100;

                $this->db->insert('inventory_direction_cables', [
                    'card_id' => $cardId,
                    'direction_id' => $did,
                    'cable_count' => $cnt,
                ]);
            }

            // бирки: owner_id list or objects
            foreach ($tags as $t) {
                $oid = is_array($t) ? (int) ($t['owner_id'] ?? 0) : (int) $t;
                if ($oid <= 0) continue;
                $this->db->insert('inventory_tags', [
                    'card_id' => $cardId,
                    'owner_id' => $oid,
                ]);
            }

            $this->rebuildInventorySummary();
            $this->db->commit();

            try { $this->log('create_inventory_card', 'inventory_cards', $cardId, null, ['well_id' => $wellId]); } catch (\Throwable $e) {}
            // вернуть полную карточку
            $this->show((string) $cardId);
        } catch (\Throwable $e) {
            $this->db->rollBack();
            Response::error('Ошибка создания инвентарной карточки', 500);
        }
    }

    /**
     * PUT /api/inventory-cards/{id}
     */
    public function update(string $id): void
    {
        $this->checkWriteAccess();
        $cardId = (int) $id;

        $card = $this->db->fetch("SELECT * FROM inventory_cards WHERE id = :id", ['id' => $cardId]);
        if (!$card) Response::error('Инвентарная карточка не найдена', 404);

        $data = $this->request->input(null, []);
        if (!is_array($data)) Response::error('Некорректные данные', 422);

        $filledDate = (string) ($data['filled_date'] ?? '');
        $filledDate = trim($filledDate) !== '' ? $filledDate : null;

        $dirCables = $data['direction_cables'] ?? [];
        if (!is_array($dirCables)) Response::error('direction_cables должен быть массивом', 422);

        $tags = $data['tags'] ?? [];
        if (!is_array($tags)) Response::error('tags должен быть массивом', 422);

        $this->db->beginTransaction();
        try {
            $this->db->update('inventory_cards', [
                'filled_date' => $filledDate,
                'updated_at' => date('Y-m-d H:i:s'),
            ], 'id = :id', ['id' => $cardId]);

            // пересоберём связи целиком
            $this->db->delete('inventory_direction_cables', 'card_id = :id', ['id' => $cardId]);
            foreach ($dirCables as $row) {
                if (!is_array($row)) continue;
                $did = (int) ($row['direction_id'] ?? 0);
                $cnt = (int) ($row['cable_count'] ?? 0);
                if ($did <= 0) continue;
                if ($cnt < 0) $cnt = 0;
                if ($cnt > 100) $cnt = 100;
                $this->db->insert('inventory_direction_cables', [
                    'card_id' => $cardId,
                    'direction_id' => $did,
                    'cable_count' => $cnt,
                ]);
            }

            $this->db->delete('inventory_tags', 'card_id = :id', ['id' => $cardId]);
            foreach ($tags as $t) {
                $oid = is_array($t) ? (int) ($t['owner_id'] ?? 0) : (int) $t;
                if ($oid <= 0) continue;
                $this->db->insert('inventory_tags', [
                    'card_id' => $cardId,
                    'owner_id' => $oid,
                ]);
            }

            $this->rebuildInventorySummary();
            $this->db->commit();

            try { $this->log('update_inventory_card', 'inventory_cards', $cardId, null, ['filled_date' => $filledDate]); } catch (\Throwable $e) {}
            $this->show((string) $cardId);
        } catch (\Throwable $e) {
            $this->db->rollBack();
            Response::error('Ошибка обновления инвентарной карточки', 500);
        }
    }

    /**
     * DELETE /api/inventory-cards/{id}
     */
    public function destroy(string $id): void
    {
        $this->checkDeleteAccess();
        $cardId = (int) $id;

        $card = $this->db->fetch("SELECT * FROM inventory_cards WHERE id = :id", ['id' => $cardId]);
        if (!$card) Response::error('Инвентарная карточка не найдена', 404);

        $this->db->beginTransaction();
        try {
            // вложения: удалим файлы
            try {
                $atts = $this->db->fetchAll("SELECT * FROM inventory_card_attachments WHERE card_id = :id", ['id' => $cardId]);
                foreach ($atts as $a) {
                    $p = (string) ($a['file_path'] ?? '');
                    if ($p !== '' && file_exists($p)) @unlink($p);
                }
            } catch (\Throwable $e) {}

            $this->db->delete('inventory_cards', 'id = :id', ['id' => $cardId]);
            $this->rebuildInventorySummary();
            $this->db->commit();

            try { $this->log('delete_inventory_card', 'inventory_cards', $cardId, $card, null); } catch (\Throwable $e) {}
            Response::success(null, 'Инвентарная карточка удалена');
        } catch (\Throwable $e) {
            $this->db->rollBack();
            Response::error('Ошибка удаления инвентарной карточки', 500);
        }
    }

    /**
     * GET /api/inventory/geojson
     * GeoJSON направлений для слоя "Инвентаризация"
     */
    public function directionsGeojson(): void
    {
        // берём все направления с геометрией и левым джойном на сводную таблицу
        $rows = $this->db->fetchAll(
            "SELECT cd.id, cd.number,
                    ST_AsGeoJSON(cd.geom_wgs84) as geometry,
                    cd.start_well_id, cd.end_well_id,
                    COALESCE(s.max_inventory_cables, NULL) as inv_max_cables,
                    COALESCE(s.unaccounted_cables, NULL) as inv_unaccounted
             FROM channel_directions cd
             LEFT JOIN inventory_summary s ON s.direction_id = cd.id
             WHERE cd.geom_wgs84 IS NOT NULL"
        );

        $maxInv = (int) ($this->db->fetch("SELECT COALESCE(MAX(max_inventory_cables),0) as m FROM inventory_summary")['m'] ?? 0);

        $features = [];
        foreach ($rows as $r) {
            $geom = is_string($r['geometry']) ? json_decode($r['geometry'], true) : $r['geometry'];
            if (!$geom || !isset($geom['type'])) continue;
            unset($r['geometry']);
            $features[] = ['type' => 'Feature', 'geometry' => $geom, 'properties' => $r];
        }

        Response::geojson($features, [
            'layer' => 'inventory',
            'max_inv_cables' => $maxInv,
            'count' => count($features),
        ]);
    }

    /**
     * POST /api/inventory/recalculate-unaccounted
     * Пересчёт поля inventory_summary.unaccounted_cables по текущим кабелям (без пересборки max_inventory_cables).
     */
    public function recalculateUnaccounted(): void
    {
        if (!(Auth::isAdmin() || Auth::canWrite())) {
            Response::error('Недостаточно прав', 403);
        }

        try {
            $updated = $this->recalculateUnaccountedInternal();
            try { $this->log('inventory_recalc_unaccounted', 'inventory_summary', null, null, ['updated' => $updated]); } catch (\Throwable $e) {}
            Response::success(['updated' => $updated], 'Неучтенные кабели пересчитаны');
        } catch (\Throwable $e) {
            Response::error('Ошибка пересчёта неучтенных кабелей', 500);
        }
    }

    private function recalculateUnaccountedInternal(): int
    {
        try {
            $stmt = $this->db->query(
                "WITH actual AS (
                    SELECT cd.id as direction_id, COUNT(DISTINCT crc.cable_id)::int as actual_cables
                    FROM channel_directions cd
                    LEFT JOIN cable_channels cc ON cc.direction_id = cd.id
                    LEFT JOIN cable_route_channels crc ON crc.cable_channel_id = cc.id
                    GROUP BY cd.id
                )
                UPDATE inventory_summary s
                SET unaccounted_cables = (s.max_inventory_cables - COALESCE(a.actual_cables, 0))::int,
                    updated_at = NOW()
                FROM actual a
                WHERE a.direction_id = s.direction_id"
            );
            return (int) ($stmt ? $stmt->rowCount() : 0);
        } catch (\Throwable $e) {
            // если таблицы нет или миграции не применены — обновлять нечего
            return 0;
        }
    }

    private function rebuildInventorySummary(): void
    {
        // Полная пересборка: truncate + insert
        try {
            $this->db->query("TRUNCATE TABLE inventory_summary RESTART IDENTITY");
        } catch (\Throwable $e) {
            // если таблицы ещё нет/миграции не применены — просто выходим
            return;
        }

        $this->db->query(
            "WITH latest_cards AS (
                SELECT DISTINCT ON (well_id) id, well_id, filled_date
                FROM inventory_cards
                ORDER BY well_id, filled_date DESC, id DESC
            ),
            src AS (
                SELECT idc.direction_id, idc.cable_count
                FROM inventory_direction_cables idc
                JOIN latest_cards lc ON lc.id = idc.card_id
            ),
            maxes AS (
                SELECT direction_id, MAX(cable_count)::int as max_inventory_cables
                FROM src
                GROUP BY direction_id
            ),
            actual AS (
                SELECT cd.id as direction_id, COUNT(DISTINCT crc.cable_id)::int as actual_cables
                FROM channel_directions cd
                LEFT JOIN cable_channels cc ON cc.direction_id = cd.id
                LEFT JOIN cable_route_channels crc ON crc.cable_channel_id = cc.id
                GROUP BY cd.id
            )
            INSERT INTO inventory_summary(direction_id, max_inventory_cables, unaccounted_cables, updated_at)
            SELECT m.direction_id,
                   m.max_inventory_cables,
                   (m.max_inventory_cables - COALESCE(a.actual_cables, 0))::int as unaccounted_cables,
                   NOW()
            FROM maxes m
            LEFT JOIN actual a ON a.direction_id = m.direction_id
            ORDER BY m.direction_id"
        );
    }
}


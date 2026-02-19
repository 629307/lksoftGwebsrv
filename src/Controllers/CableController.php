<?php
/**
 * Контроллер кабелей (в грунте, воздушные, в канализации)
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class CableController extends BaseController
{
    // Конфигурация типов кабелей
    private array $cableTypes = [
        'ground' => ['table' => 'ground_cables', 'name' => 'Кабель в грунте'],
        'aerial' => ['table' => 'aerial_cables', 'name' => 'Воздушный кабель'],
        'duct' => ['table' => 'duct_cables', 'name' => 'Кабель в канализации'],
    ];

    /**
     * GET /api/cables/{type}
     * Список кабелей определённого типа
     */
    public function index(string $type): void
    {
        $config = $this->getCableConfig($type);
        $table = $config['table'];

        $pagination = $this->getPagination();
        
        $filters = $this->buildFilters([
            'owner_id' => 'c.owner_id',
            'contract_id' => 'c.contract_id',
            'type_id' => 'c.type_id',
            'status_id' => 'c.status_id',
            '_search' => ['c.number', 'c.notes'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];
        $this->applyReadonlyCableOwnerScope($where, $params, 'c');

        // Общее количество
        $totalSql = "SELECT COUNT(*) as cnt FROM {$table} c";
        if ($where) {
            $totalSql .= " WHERE {$where}";
        }
        $total = (int) $this->db->fetch($totalSql, $params)['cnt'];

        // Данные
        $sql = "SELECT c.id, c.number, 
                       ST_AsGeoJSON(c.geom_wgs84)::json as geometry,
                       ST_Length(c.geom_wgs84::geography) as calculated_length,
                       c.owner_id, c.contract_id, c.type_id, c.kind_id, c.status_id,
                       c.cable_type, c.fiber_count, c.length_m, c.installation_date, c.notes,
                       o.name as owner_name,
                       ct.number as contract_number, ct.name as contract_name,
                       ot.name as type_name, ot.color as type_color,
                       ok.name as kind_name,
                       os.name as status_name, os.color as status_color,
                       c.created_at, c.updated_at
                FROM {$table} c
                LEFT JOIN owners o ON c.owner_id = o.id
                LEFT JOIN contracts ct ON c.contract_id = ct.id
                LEFT JOIN object_types ot ON c.type_id = ot.id
                LEFT JOIN object_kinds ok ON c.kind_id = ok.id
                LEFT JOIN object_status os ON c.status_id = os.id";
        
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY c.number LIMIT :limit OFFSET :offset";
        
        $params['limit'] = $pagination['limit'];
        $params['offset'] = $pagination['offset'];
        
        $data = $this->db->fetchAll($sql, $params);

        Response::paginated($data, $total, $pagination['page'], $pagination['limit']);
    }

    /**
     * GET /api/cables/{type}/geojson
     * GeoJSON кабелей для карты
     */
    public function geojson(string $type): void
    {
        $config = $this->getCableConfig($type);
        $table = $config['table'];

        $filters = $this->buildFilters([
            'owner_id' => 'c.owner_id',
            'contract_id' => 'c.contract_id',
            'status_id' => 'c.status_id',
        ]);

        $where = $filters['where'];
        $params = $filters['params'];
        $this->applyReadonlyCableOwnerScope($where, $params, 'c');

        // Обязательно фильтруем по наличию геометрии
        $geomCondition = 'c.geom_wgs84 IS NOT NULL';
        if ($where) {
            $where = "{$geomCondition} AND ({$where})";
        } else {
            $where = $geomCondition;
        }

        $sql = "SELECT c.id, c.number, 
                       ST_AsGeoJSON(c.geom_wgs84)::json as geometry,
                       c.owner_id, c.status_id,
                       o.name as owner_name,
                       ot.name as type_name, ot.color as type_color,
                       os.name as status_name, os.color as status_color,
                       c.fiber_count, c.cable_type
                FROM {$table} c
                LEFT JOIN owners o ON c.owner_id = o.id
                LEFT JOIN object_types ot ON c.type_id = ot.id
                LEFT JOIN object_status os ON c.status_id = os.id
                WHERE {$where}";
        
        $data = $this->db->fetchAll($sql, $params);

        $features = [];
        foreach ($data as $row) {
            $geometry = is_string($row['geometry']) ? json_decode($row['geometry'], true) : $row['geometry'];
            unset($row['geometry']);
            $row['cable_category'] = $type;
            
            // Пропускаем записи с невалидной геометрией
            if (empty($geometry) || !isset($geometry['type'])) {
                continue;
            }
            
            $features[] = [
                'type' => 'Feature',
                'geometry' => $geometry,
                'properties' => $row,
            ];
        }

        Response::geojson($features, ['layer' => $table, 'count' => count($features)]);
    }

    /**
     * GET /api/cables/all/geojson
     * GeoJSON всех кабелей
     */
    public function allGeojson(): void
    {
        $filters = $this->buildFilters([
            'owner_id' => 'c.owner_id',
            'status_id' => 'c.status_id',
        ]);

        $where = $filters['where'];
        $params = $filters['params'];
        $this->applyReadonlyCableOwnerScope($where, $params, 'c');

        // Обязательно фильтруем по наличию геометрии
        $geomCondition = 'c.geom_wgs84 IS NOT NULL';
        if ($where) {
            $where = "{$geomCondition} AND ({$where})";
        } else {
            $where = $geomCondition;
        }

        $features = [];

        foreach ($this->cableTypes as $type => $config) {
            $sql = "SELECT c.id, c.number, 
                           ST_AsGeoJSON(c.geom_wgs84)::json as geometry,
                           c.owner_id, c.status_id,
                           o.name as owner_name,
                           ot.color as type_color,
                           os.name as status_name, os.color as status_color,
                           c.fiber_count
                    FROM {$config['table']} c
                    LEFT JOIN owners o ON c.owner_id = o.id
                    LEFT JOIN object_types ot ON c.type_id = ot.id
                    LEFT JOIN object_status os ON c.status_id = os.id
                    WHERE {$where}";

            $data = $this->db->fetchAll($sql, $params);

            foreach ($data as $row) {
                $geometry = is_string($row['geometry']) ? json_decode($row['geometry'], true) : $row['geometry'];
                unset($row['geometry']);
                
                // Пропускаем записи с невалидной геометрией
                if (empty($geometry) || !isset($geometry['type'])) {
                    continue;
                }
                
                $row['cable_category'] = $type;
                $row['cable_category_name'] = $config['name'];

                $features[] = [
                    'type' => 'Feature',
                    'geometry' => $geometry,
                    'properties' => $row,
                ];
            }
        }

        Response::geojson($features, ['layer' => 'all_cables', 'count' => count($features)]);
    }

    /**
     * GET /api/cables/{type}/{id}
     * Получение кабеля
     */
    public function show(string $type, string $id): void
    {
        $config = $this->getCableConfig($type);
        $table = $config['table'];

        $cable = $this->db->fetch(
            "SELECT c.*, 
                    ST_AsGeoJSON(c.geom_wgs84)::json as geometry,
                    ST_Length(c.geom_wgs84::geography) as calculated_length,
                    o.name as owner_name,
                    ct.number as contract_number, ct.name as contract_name,
                    ot.name as type_name,
                    ok.name as kind_name,
                    os.name as status_name, os.color as status_color
             FROM {$table} c
             LEFT JOIN owners o ON c.owner_id = o.id
             LEFT JOIN contracts ct ON c.contract_id = ct.id
             LEFT JOIN object_types ot ON c.type_id = ot.id
             LEFT JOIN object_kinds ok ON c.kind_id = ok.id
             LEFT JOIN object_status os ON c.status_id = os.id
             WHERE c.id = :id",
            ['id' => (int) $id]
        );

        if (!$cable) {
            Response::error('Кабель не найден', 404);
        }

        // Фотографии
        $photos = $this->db->fetchAll(
            "SELECT id, filename, original_filename, description, created_at 
             FROM object_photos 
             WHERE object_table = :table AND object_id = :id 
             ORDER BY sort_order",
            ['table' => $table, 'id' => (int) $id]
        );
        $cable['photos'] = $photos;

        // Для кабелей в канализации - связанные каналы
        if ($type === 'duct') {
            $channels = $this->db->fetchAll(
                "SELECT dcc.*, cc.channel_number, cd.number as direction_number
                 FROM duct_cable_channels dcc
                 JOIN cable_channels cc ON dcc.cable_channel_id = cc.id
                 JOIN channel_directions cd ON cc.direction_id = cd.id
                 WHERE dcc.duct_cable_id = :id
                 ORDER BY dcc.segment_order",
                ['id' => (int) $id]
            );
            $cable['channels'] = $channels;
        }

        Response::success($cable);
    }

    /**
     * POST /api/cables/{type}
     * Создание кабеля
     */
    public function store(string $type): void
    {
        $this->checkWriteAccess();
        $config = $this->getCableConfig($type);
        $table = $config['table'];

        $data = $this->request->only([
            'number', 'owner_id', 'contract_id', 'type_id', 'kind_id', 'status_id',
            'cable_type', 'fiber_count', 'length_m', 'installation_date', 'notes'
        ]);

        // Убедиться, что все необязательные поля присутствуют (даже если null)
        $optionalFields = ['contract_id', 'cable_type', 'fiber_count', 'length_m', 'installation_date', 'notes'];
        foreach ($optionalFields as $field) {
            if (!array_key_exists($field, $data)) {
                $data[$field] = null;
            }
        }

        // Получаем координаты линии
        $coordinates = $this->request->input('coordinates');
        $coordinateSystem = $this->request->input('coordinate_system', 'wgs84');

        if (empty($coordinates) || !is_array($coordinates) || count($coordinates) < 2) {
            Response::error('Необходимо указать минимум 2 точки для линии', 422);
        }

        $user = Auth::user();
        $data['created_by'] = $user['id'];
        $data['updated_by'] = $user['id'];

        try {
            $this->db->beginTransaction();

            // Создаём геометрию
            $coordsStr = implode(', ', array_map(fn($p) => "{$p[0]} {$p[1]}", $coordinates));

            if ($coordinateSystem === 'wgs84') {
                $sql = "INSERT INTO {$table} (number, geom_wgs84, geom_msk86, owner_id, contract_id, type_id, kind_id, status_id,
                                              cable_type, fiber_count, length_m, installation_date, notes, created_by, updated_by)
                        VALUES (:number,
                                ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 4326),
                                ST_Transform(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 4326), 200004),
                                :owner_id, :contract_id, :type_id, :kind_id, :status_id,
                                :cable_type, :fiber_count, :length_m, :installation_date, :notes, :created_by, :updated_by)
                        RETURNING id";
            } else {
                $sql = "INSERT INTO {$table} (number, geom_wgs84, geom_msk86, owner_id, contract_id, type_id, kind_id, status_id,
                                              cable_type, fiber_count, length_m, installation_date, notes, created_by, updated_by)
                        VALUES (:number,
                                ST_Transform(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 200004), 4326),
                                ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 200004),
                                :owner_id, :contract_id, :type_id, :kind_id, :status_id,
                                :cable_type, :fiber_count, :length_m, :installation_date, :notes, :created_by, :updated_by)
                        RETURNING id";
            }

            $stmt = $this->db->query($sql, $data);
            $id = $stmt->fetchColumn();

            $this->db->commit();

            $cable = $this->db->fetch(
                "SELECT *, ST_AsGeoJSON(geom_wgs84)::json as geometry FROM {$table} WHERE id = :id",
                ['id' => $id]
            );

            $this->log('create', $table, $id, null, $cable);

            Response::success($cable, 'Кабель создан', 201);
        } catch (\PDOException $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /**
     * PUT /api/cables/{type}/{id}
     * Обновление кабеля
     */
    public function update(string $type, string $id): void
    {
        $this->checkWriteAccess();
        $config = $this->getCableConfig($type);
        $table = $config['table'];
        $cableId = (int) $id;

        $oldCable = $this->db->fetch("SELECT * FROM {$table} WHERE id = :id", ['id' => $cableId]);
        if (!$oldCable) {
            Response::error('Кабель не найден', 404);
        }

        $data = $this->request->only([
            'number', 'owner_id', 'contract_id', 'type_id', 'kind_id', 'status_id',
            'cable_type', 'fiber_count', 'length_m', 'installation_date', 'notes'
        ]);
        $data = array_filter($data, fn($v) => $v !== null);

        $user = Auth::user();
        $data['updated_by'] = $user['id'];

        // Обновляем координаты если переданы
        $coordinates = $this->request->input('coordinates');
        if ($coordinates && is_array($coordinates) && count($coordinates) >= 2) {
            $coordsStr = implode(', ', array_map(fn($p) => "{$p[0]} {$p[1]}", $coordinates));
            $coordinateSystem = $this->request->input('coordinate_system', 'wgs84');

            if ($coordinateSystem === 'wgs84') {
                $this->db->query(
                    "UPDATE {$table} SET 
                        geom_wgs84 = ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 4326),
                        geom_msk86 = ST_Transform(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 4326), 200004)
                     WHERE id = :id",
                    ['id' => $cableId]
                );
            } else {
                $this->db->query(
                    "UPDATE {$table} SET 
                        geom_msk86 = ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 200004),
                        geom_wgs84 = ST_Transform(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 200004), 4326)
                     WHERE id = :id",
                    ['id' => $cableId]
                );
            }
        }

        if (!empty($data)) {
            $this->db->update($table, $data, 'id = :id', ['id' => $cableId]);
        }

        $cable = $this->db->fetch(
            "SELECT *, ST_AsGeoJSON(geom_wgs84)::json as geometry FROM {$table} WHERE id = :id",
            ['id' => $cableId]
        );

        $this->log('update', $table, $cableId, $oldCable, $cable);

        Response::success($cable, 'Кабель обновлён');
    }

    /**
     * DELETE /api/cables/{type}/{id}
     * Удаление кабеля
     */
    public function destroy(string $type, string $id): void
    {
        $this->checkDeleteAccess();
        $config = $this->getCableConfig($type);
        $table = $config['table'];
        $cableId = (int) $id;

        $cable = $this->db->fetch("SELECT * FROM {$table} WHERE id = :id", ['id' => $cableId]);
        if (!$cable) {
            Response::error('Кабель не найден', 404);
        }

        try {
            $this->db->delete('object_photos', "object_table = :table AND object_id = :id", ['table' => $table, 'id' => $cableId]);
            $this->db->delete($table, 'id = :id', ['id' => $cableId]);

            $this->log('delete', $table, $cableId, $cable, null);

            Response::success(null, 'Кабель удалён');
        } catch (\PDOException $e) {
            if (strpos($e->getMessage(), 'foreign key') !== false) {
                Response::error('Нельзя удалить кабель, так как он связан с другими объектами', 400);
            }
            throw $e;
        }
    }

    /**
     * GET /api/cables/{type}/export
     * Экспорт кабелей в CSV
     */
    public function export(string $type): void
    {
        $config = $this->getCableConfig($type);
        $table = $config['table'];

        $filters = $this->buildFilters([
            'owner_id' => 'c.owner_id',
            'contract_id' => 'c.contract_id',
            'status_id' => 'c.status_id',
        ]);

        $where = $filters['where'];
        $params = $filters['params'];
        $this->applyReadonlyCableOwnerScope($where, $params, 'c');

        $sql = "SELECT c.number,
                       o.name as owner, ct.number as contract,
                       ot.name as type, os.name as status,
                       c.cable_type, c.fiber_count, c.length_m, c.installation_date, c.notes
                FROM {$table} c
                LEFT JOIN owners o ON c.owner_id = o.id
                LEFT JOIN contracts ct ON c.contract_id = ct.id
                LEFT JOIN object_types ot ON c.type_id = ot.id
                LEFT JOIN object_status os ON c.status_id = os.id";
        
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY c.number";
        
        $data = $this->db->fetchAll($sql, $params);

        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $type . '_cables_' . date('Y-m-d') . '.csv"');

        $output = fopen('php://output', 'w');
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));
        
        fputcsv($output, ['Номер', 'Собственник', 'Контракт', 'Вид', 'Состояние', 
                         'Тип кабеля', 'Кол-во волокон', 'Длина (м)', 'Дата установки', 'Примечания'], ';');
        
        foreach ($data as $row) {
            fputcsv($output, array_values($row), ';');
        }
        
        fclose($output);
        exit;
    }

    private function applyReadonlyCableOwnerScope(string &$where, array &$params, string $alias = 'c'): void
    {
        if (!Auth::hasRole('readonly')) return;
        $user = Auth::user() ?: [];
        $ownerId = (int) ($user['owner_id'] ?? 0);

        if ($ownerId <= 0) {
            $cond = "1=0";
        } else {
            $cond = "{$alias}.owner_id = :ro_owner_id";
            $params['ro_owner_id'] = $ownerId;
        }

        if (trim($where) !== '') {
            $where = "{$cond} AND ({$where})";
        } else {
            $where = $cond;
        }
    }

    /**
     * Получить конфигурацию типа кабеля
     */
    private function getCableConfig(string $type): array
    {
        if (!isset($this->cableTypes[$type])) {
            Response::error('Неизвестный тип кабеля', 404);
        }
        return $this->cableTypes[$type];
    }
}

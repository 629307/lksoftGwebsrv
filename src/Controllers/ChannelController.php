<?php
/**
 * Контроллер направлений и каналов кабельной канализации
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class ChannelController extends BaseController
{
    /**
     * GET /api/channel-directions
     * Список направлений каналов
     */
    public function index(): void
    {
        $pagination = $this->getPagination();
        
        $filters = $this->buildFilters([
            'owner_id' => 'cd.owner_id',
            'type_id' => 'cd.type_id',
            'start_well_id' => 'cd.start_well_id',
            'end_well_id' => 'cd.end_well_id',
            '_search' => ['cd.number', 'cd.notes'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        // Общее количество
        $totalSql = "SELECT COUNT(*) as cnt FROM channel_directions cd";
        if ($where) {
            $totalSql .= " WHERE {$where}";
        }
        $total = (int) $this->db->fetch($totalSql, $params)['cnt'];

        // Данные с джойнами
        $sql = "SELECT cd.id, cd.number, 
                       ST_AsGeoJSON(cd.geom_wgs84)::json as geometry,
                       ST_Length(cd.geom_wgs84::geography) as calculated_length,
                       cd.owner_id, cd.type_id, cd.start_well_id, cd.end_well_id,
                       cd.length_m, cd.notes,
                       (SELECT COUNT(*) FROM object_photos op WHERE op.object_table = 'channel_directions' AND op.object_id = cd.id) as photo_count,
                       o.name as owner_name,
                       ot.name as type_name,
                       sw.number as start_well_number,
                       ew.number as end_well_number,
                       (SELECT COUNT(*) FROM cable_channels WHERE direction_id = cd.id) as channel_count,
                       cd.created_at, cd.updated_at
                FROM channel_directions cd
                LEFT JOIN owners o ON cd.owner_id = o.id
                LEFT JOIN object_types ot ON cd.type_id = ot.id
                LEFT JOIN wells sw ON cd.start_well_id = sw.id
                LEFT JOIN wells ew ON cd.end_well_id = ew.id";
        
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY cd.number LIMIT :limit OFFSET :offset";
        
        $params['limit'] = $pagination['limit'];
        $params['offset'] = $pagination['offset'];
        
        $data = $this->db->fetchAll($sql, $params);

        Response::paginated($data, $total, $pagination['page'], $pagination['limit']);
    }

    /**
     * GET /api/channel-directions/geojson
     * GeoJSON всех направлений для карты
     */
    public function geojson(): void
    {
        $filters = $this->buildFilters([
            'owner_id' => 'cd.owner_id',
            'type_id' => 'cd.type_id',
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        // Обязательно фильтруем по наличию геометрии
        $geomCondition = 'cd.geom_wgs84 IS NOT NULL';
        if ($where) {
            $where = "{$geomCondition} AND ({$where})";
        } else {
            $where = $geomCondition;
        }

        $sql = "SELECT cd.id, cd.number, 
                       ST_AsGeoJSON(cd.geom_wgs84)::json as geometry,
                       cd.owner_id, cd.type_id, cd.length_m,
                       o.name as owner_name,
                       ot.name as type_name, ot.color as type_color,
                       sw.number as start_well,
                       ew.number as end_well,
                       (SELECT COUNT(*) FROM cable_channels WHERE direction_id = cd.id) as channels
                FROM channel_directions cd
                LEFT JOIN owners o ON cd.owner_id = o.id
                LEFT JOIN object_types ot ON cd.type_id = ot.id
                LEFT JOIN wells sw ON cd.start_well_id = sw.id
                LEFT JOIN wells ew ON cd.end_well_id = ew.id
                WHERE {$where}";
        
        $data = $this->db->fetchAll($sql, $params);

        $features = [];
        foreach ($data as $row) {
            $geometry = is_string($row['geometry']) ? json_decode($row['geometry'], true) : $row['geometry'];
            unset($row['geometry']);
            
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

        Response::geojson($features, ['layer' => 'channel_directions', 'count' => count($features)]);
    }

    /**
     * GET /api/channel-directions/{id}
     * Получение направления
     */
    public function show(string $id): void
    {
        $direction = $this->db->fetch(
            "SELECT cd.*, 
                    ST_AsGeoJSON(cd.geom_wgs84)::json as geometry,
                    ST_Length(cd.geom_wgs84::geography) as calculated_length,
                    o.name as owner_name,
                    ot.name as type_name,
                    sw.number as start_well_number,
                    ew.number as end_well_number
             FROM channel_directions cd
             LEFT JOIN owners o ON cd.owner_id = o.id
             LEFT JOIN object_types ot ON cd.type_id = ot.id
             LEFT JOIN wells sw ON cd.start_well_id = sw.id
             LEFT JOIN wells ew ON cd.end_well_id = ew.id
             WHERE cd.id = :id",
            ['id' => (int) $id]
        );

        if (!$direction) {
            Response::error('Направление не найдено', 404);
        }

        // Получаем каналы
        $channels = $this->db->fetchAll(
            "SELECT cc.*, ok.name as kind_name, os.name as status_name, os.color as status_color
             FROM cable_channels cc
             LEFT JOIN object_kinds ok ON cc.kind_id = ok.id
             LEFT JOIN object_status os ON cc.status_id = os.id
             WHERE cc.direction_id = :id
             ORDER BY cc.channel_number",
            ['id' => (int) $id]
        );
        $direction['channels'] = $channels;

        // Фотографии
        $photos = $this->db->fetchAll(
            "SELECT id, filename, original_filename, description, created_at 
             FROM object_photos 
             WHERE object_table = 'channel_directions' AND object_id = :id 
             ORDER BY sort_order",
            ['id' => (int) $id]
        );
        $direction['photos'] = $photos;

        Response::success($direction);
    }

    /**
     * POST /api/channel-directions
     * Создание направления
     */
    public function store(): void
    {
        $this->checkWriteAccess();

        $errors = $this->request->validate([
            'number' => 'required|string|max:50',
            'start_well_id' => 'required|integer',
            'end_well_id' => 'required|integer',
        ]);

        if (!empty($errors)) {
            Response::error('Ошибка валидации', 422, $errors);
        }

        $startWellId = $this->request->input('start_well_id');
        $endWellId = $this->request->input('end_well_id');

        if ($startWellId === $endWellId) {
            Response::error('Начальный и конечный колодцы должны быть разными', 422);
        }

        // Проверяем существование колодцев
        $wells = $this->db->fetchAll(
            "SELECT id, ST_AsText(geom_wgs84) as geom FROM wells WHERE id IN (:start_id, :end_id)",
            ['start_id' => $startWellId, 'end_id' => $endWellId]
        );

        if (count($wells) !== 2) {
            Response::error('Один или оба колодца не найдены', 404);
        }

        $data = $this->request->only(['number', 'owner_id', 'type_id', 'start_well_id', 'end_well_id', 'length_m', 'notes']);
        
        // Убедиться, что все необязательные поля присутствуют (даже если null)
        $optionalFields = ['owner_id', 'type_id', 'notes'];
        foreach ($optionalFields as $field) {
            if (!array_key_exists($field, $data)) {
                $data[$field] = null;
            }
        }
        
        $user = Auth::user();
        $data['created_by'] = $user['id'];
        $data['updated_by'] = $user['id'];

        try {
            $this->db->beginTransaction();

            // Создаём линию между колодцами с автоматическим расчётом длины
            // PostgreSQL PDO не поддерживает повторное использование именованных параметров,
            // поэтому используем CTE для выборки колодцев один раз
            $sql = "WITH well_geoms AS (
                        SELECT 
                            sw.geom_wgs84 as start_wgs84, sw.geom_msk86 as start_msk86,
                            ew.geom_wgs84 as end_wgs84, ew.geom_msk86 as end_msk86
                        FROM wells sw, wells ew
                        WHERE sw.id = :start_well_id AND ew.id = :end_well_id
                    )
                    INSERT INTO channel_directions (number, geom_wgs84, geom_msk86, owner_id, type_id, 
                                                    start_well_id, end_well_id, length_m, notes, created_by, updated_by)
                    SELECT :number,
                           ST_MakeLine(start_wgs84, end_wgs84),
                           ST_MakeLine(start_msk86, end_msk86),
                           :owner_id, :type_id, :start_well_id2, :end_well_id2, 
                           ROUND(ST_Length(ST_MakeLine(start_wgs84, end_wgs84)::geography)::numeric, 2),
                           :notes, :created_by, :updated_by
                    FROM well_geoms
                    RETURNING id";

            // Дублируем параметры для INSERT части запроса
            $data['start_well_id2'] = $data['start_well_id'];
            $data['end_well_id2'] = $data['end_well_id'];
            
            // Убираем length_m из данных, т.к. он теперь рассчитывается автоматически
            unset($data['length_m']);
            
            $stmt = $this->db->query($sql, $data);
            $id = $stmt->fetchColumn();

            // Автоматически создаём 1 канал по умолчанию (диаметр 110)
            $this->db->insert('cable_channels', [
                'direction_id' => $id,
                'channel_number' => 1,
                'diameter_mm' => 110,
                'created_by' => $user['id'],
                'updated_by' => $user['id'],
            ]);

            $this->db->commit();

            $direction = $this->db->fetch(
                "SELECT *, ST_AsGeoJSON(geom_wgs84)::json as geometry FROM channel_directions WHERE id = :id",
                ['id' => $id]
            );

            $this->log('create', 'channel_directions', $id, null, $direction);

            Response::success($direction, 'Направление создано', 201);
        } catch (\PDOException $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /**
     * PUT /api/channel-directions/{id}
     * Обновление направления
     */
    public function update(string $id): void
    {
        $this->checkWriteAccess();
        $directionId = (int) $id;

        $oldDirection = $this->db->fetch("SELECT * FROM channel_directions WHERE id = :id", ['id' => $directionId]);
        if (!$oldDirection) {
            Response::error('Направление не найдено', 404);
        }

        $data = $this->request->only(['number', 'owner_id', 'type_id', 'length_m', 'notes']);
        $data = array_filter($data, fn($v) => $v !== null);

        $user = Auth::user();
        $data['updated_by'] = $user['id'];

        $this->db->update('channel_directions', $data, 'id = :id', ['id' => $directionId]);

        $direction = $this->db->fetch(
            "SELECT *, ST_AsGeoJSON(geom_wgs84)::json as geometry FROM channel_directions WHERE id = :id",
            ['id' => $directionId]
        );

        $this->log('update', 'channel_directions', $directionId, $oldDirection, $direction);

        Response::success($direction, 'Направление обновлено');
    }

    /**
     * DELETE /api/channel-directions/{id}
     * Удаление направления
     */
    public function destroy(string $id): void
    {
        $this->checkDeleteAccess();
        $directionId = (int) $id;

        $direction = $this->db->fetch("SELECT * FROM channel_directions WHERE id = :id", ['id' => $directionId]);
        if (!$direction) {
            Response::error('Направление не найдено', 404);
        }

        // Если есть каналы — не даём удалить направление
        $channels = $this->db->fetch(
            "SELECT COUNT(*) as cnt FROM cable_channels WHERE direction_id = :id",
            ['id' => $directionId]
        );
        if (!empty($channels['cnt']) && (int) $channels['cnt'] > 0) {
            Response::error('Направление используется', 400);
        }

        try {
            $this->db->delete('object_photos', "object_table = 'channel_directions' AND object_id = :id", ['id' => $directionId]);
            $this->db->delete('channel_directions', 'id = :id', ['id' => $directionId]);

            $this->log('delete', 'channel_directions', $directionId, $direction, null);

            Response::success(null, 'Направление удалено');
        } catch (\PDOException $e) {
            if (strpos($e->getMessage(), 'foreign key') !== false) {
                Response::error('Нельзя удалить направление, так как оно используется', 400);
            }
            throw $e;
        }
    }

    /**
     * POST /api/channel-directions/{id}/channels
     * Добавление канала к направлению
     */
    public function addChannel(string $id): void
    {
        $this->checkWriteAccess();
        $directionId = (int) $id;

        $direction = $this->db->fetch("SELECT * FROM channel_directions WHERE id = :id", ['id' => $directionId]);
        if (!$direction) {
            Response::error('Направление не найдено', 404);
        }

        // Проверяем количество каналов
        $count = $this->db->fetch(
            "SELECT COUNT(*) as cnt FROM cable_channels WHERE direction_id = :id",
            ['id' => $directionId]
        );
        if ($count['cnt'] >= 16) {
            Response::error('Максимальное количество каналов - 16', 400);
        }

        $data = $this->request->only(['channel_number', 'kind_id', 'status_id', 'diameter_mm', 'notes']);
        
        if (empty($data['channel_number'])) {
            // Автоматически присваиваем следующий номер
            $data['channel_number'] = $count['cnt'] + 1;
        }

        $data['direction_id'] = $directionId;
        
        $user = Auth::user();
        $data['created_by'] = $user['id'];
        $data['updated_by'] = $user['id'];

        try {
            $channelId = $this->db->insert('cable_channels', $data);

            $channel = $this->db->fetch("SELECT * FROM cable_channels WHERE id = :id", ['id' => $channelId]);

            $this->log('create', 'cable_channels', $channelId, null, $channel);

            Response::success($channel, 'Канал добавлен', 201);
        } catch (\PDOException $e) {
            if (strpos($e->getMessage(), 'unique') !== false || strpos($e->getMessage(), 'duplicate') !== false) {
                Response::error('Канал с таким номером уже существует в этом направлении', 400);
            }
            throw $e;
        }
    }

    /**
     * GET /api/cable-channels
     * Список всех каналов
     */
    public function listChannels(): void
    {
        $pagination = $this->getPagination();
        
        $filters = $this->buildFilters([
            'direction_id' => 'cc.direction_id',
            'kind_id' => 'cc.kind_id',
            'status_id' => 'cc.status_id',
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        $total = $this->getTotal('cable_channels', $where, $params, 'cc');

        $sql = "SELECT cc.id, cc.channel_number, cc.direction_id, cc.kind_id, cc.status_id,
                       cc.diameter_mm, cc.material, cc.notes,
                       (SELECT COUNT(*) FROM object_photos op WHERE op.object_table = 'cable_channels' AND op.object_id = cc.id) as photo_count,
                       cd.number as direction_number,
                       ok.name as kind_name,
                       os.name as status_name, os.color as status_color,
                       cc.created_at, cc.updated_at
                FROM cable_channels cc
                LEFT JOIN channel_directions cd ON cc.direction_id = cd.id
                LEFT JOIN object_kinds ok ON cc.kind_id = ok.id
                LEFT JOIN object_status os ON cc.status_id = os.id";
        
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY cd.number, cc.channel_number LIMIT :limit OFFSET :offset";
        
        $params['limit'] = $pagination['limit'];
        $params['offset'] = $pagination['offset'];
        
        $data = $this->db->fetchAll($sql, $params);

        Response::paginated($data, $total, $pagination['page'], $pagination['limit']);
    }

    /**
     * GET /api/cable-channels/{id}
     * Получение канала
     */
    public function showChannel(string $id): void
    {
        $channel = $this->db->fetch(
            "SELECT cc.*, 
                    cd.number as direction_number,
                    ok.name as kind_name,
                    os.name as status_name, os.color as status_color
             FROM cable_channels cc
             LEFT JOIN channel_directions cd ON cc.direction_id = cd.id
             LEFT JOIN object_kinds ok ON cc.kind_id = ok.id
             LEFT JOIN object_status os ON cc.status_id = os.id
             WHERE cc.id = :id",
            ['id' => (int) $id]
        );

        if (!$channel) {
            Response::error('Канал не найден', 404);
        }

        Response::success($channel);
    }

    /**
     * PUT /api/cable-channels/{id}
     * Обновление канала
     */
    public function updateChannel(string $id): void
    {
        $this->checkWriteAccess();
        $channelId = (int) $id;

        $oldChannel = $this->db->fetch("SELECT * FROM cable_channels WHERE id = :id", ['id' => $channelId]);
        if (!$oldChannel) {
            Response::error('Канал не найден', 404);
        }

        $data = $this->request->only(['kind_id', 'status_id', 'diameter_mm', 'notes']);
        $data = array_filter($data, fn($v) => $v !== null);

        $user = Auth::user();
        $data['updated_by'] = $user['id'];

        $this->db->update('cable_channels', $data, 'id = :id', ['id' => $channelId]);

        $channel = $this->db->fetch("SELECT * FROM cable_channels WHERE id = :id", ['id' => $channelId]);

        $this->log('update', 'cable_channels', $channelId, $oldChannel, $channel);

        Response::success($channel, 'Канал обновлён');
    }

    /**
     * DELETE /api/cable-channels/{id}
     * Удаление канала
     */
    public function deleteChannel(string $id): void
    {
        $this->checkDeleteAccess();
        $channelId = (int) $id;

        $channel = $this->db->fetch("SELECT * FROM cable_channels WHERE id = :id", ['id' => $channelId]);
        if (!$channel) {
            Response::error('Канал не найден', 404);
        }

        try {
            $this->db->delete('cable_channels', 'id = :id', ['id' => $channelId]);

            $this->log('delete', 'cable_channels', $channelId, $channel, null);

            Response::success(null, 'Канал удалён');
        } catch (\PDOException $e) {
            if (strpos($e->getMessage(), 'foreign key') !== false) {
                Response::error('Направление используется', 400);
            }
            throw $e;
        }
    }
}

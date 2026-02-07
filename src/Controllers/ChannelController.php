<?php
/**
 * Контроллер направлений и каналов кабельной канализации
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class ChannelController extends BaseController
{
    private function getDefaultChannelKindId(?int $userId = null): ?int
    {
        try {
            // 1) Персональный дефолт из "Настройки по умолчанию" (map-defaults)
            if (!empty($userId)) {
                $rowU = $this->db->fetch(
                    "SELECT value FROM user_settings WHERE user_id = :uid AND code = 'default_ref_channel' LIMIT 1",
                    ['uid' => (int) $userId]
                );
                $raw = $rowU ? (string) ($rowU['value'] ?? '') : '';
                $id = (int) $raw;
                if ($id > 0) {
                    $ok = $this->db->fetch(
                        "SELECT ok.id
                         FROM object_kinds ok
                         JOIN object_types ot ON ok.object_type_id = ot.id
                         WHERE ok.id = :id AND ot.code = 'channel'
                         LIMIT 1",
                        ['id' => $id]
                    );
                    if ($ok) return (int) $ok['id'];
                }
            }

            // 2) Системный дефолт (is_default=1) для вида объекта channel
            $row = $this->db->fetch(
                "SELECT ok.id
                 FROM object_kinds ok
                 JOIN object_types ot ON ok.object_type_id = ot.id
                 WHERE ot.code = 'channel' AND ok.is_default = true
                 ORDER BY ok.id
                 LIMIT 1"
            );
            return $row ? (int) $row['id'] : null;
        } catch (\Throwable $e) {
            // Если колонка is_default ещё не добавлена миграцией — просто не используем дефолт.
            return null;
        }
    }

    private function getDefaultStatusId(): ?int
    {
        try {
            $row = $this->db->fetch(
                "SELECT id
                 FROM object_status
                 WHERE is_default = true
                 ORDER BY sort_order, id
                 LIMIT 1"
            );
            return $row ? (int) $row['id'] : null;
        } catch (\Throwable $e) {
            return null;
        }
    }

    private function updateDuctCableLength(int $cableId): void
    {
        // Длина кабеля в канализации: сумма длин направлений + 3 * количество уникальных колодцев маршрута
        $this->db->query(
            "UPDATE cables SET length_calculated = (
                (SELECT COALESCE(SUM(DISTINCT cd.length_m), 0)
                 FROM cable_route_channels crc
                 JOIN cable_channels cc ON crc.cable_channel_id = cc.id
                 JOIN channel_directions cd ON cc.direction_id = cd.id
                 WHERE crc.cable_id = :cable_id)
                +
                (SELECT 3 * COALESCE(COUNT(DISTINCT crw.well_id), 0)
                 FROM cable_route_wells crw
                 WHERE crw.cable_id = :cable_id)
            )
            WHERE id = :cable_id",
            ['cable_id' => $cableId]
        );
    }
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
            'status_id' => 'cd.status_id',
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
                       cd.owner_id, cd.type_id, cd.status_id, cd.start_well_id, cd.end_well_id,
                       cd.length_m, cd.notes,
                       (SELECT COUNT(*) FROM object_photos op WHERE op.object_table = 'channel_directions' AND op.object_id = cd.id) as photo_count,
                       o.name as owner_name,
                       ot.name as type_name,
                       os.code as status_code, os.name as status_name, os.color as status_color,
                       sw.number as start_well_number,
                       ew.number as end_well_number,
                       (SELECT COUNT(*) FROM cable_channels WHERE direction_id = cd.id) as channel_count,
                       cd.created_at, cd.updated_at
                FROM channel_directions cd
                LEFT JOIN owners o ON cd.owner_id = o.id
                LEFT JOIN object_types ot ON cd.type_id = ot.id
                LEFT JOIN object_status os ON cd.status_id = os.id
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
        $user = Auth::user();
        $uid = (int) ($user['id'] ?? 0);
        $filters = $this->buildFilters([
            'owner_id' => 'cd.owner_id',
            'type_id' => 'cd.type_id',
            'status_id' => 'cd.status_id',
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
                       cd.owner_id, cd.type_id, cd.status_id, cd.length_m,
                       o.name as owner_name, o.short_name as owner_short_name, COALESCE(uoc.color, o.color) as owner_color,
                       ot.name as type_name, ot.color as type_color,
                       os.code as status_code, os.name as status_name, os.color as status_color,
                       sw.number as start_well,
                       ew.number as end_well,
                       (SELECT COUNT(*) FROM cable_channels WHERE direction_id = cd.id) as channels
                FROM channel_directions cd
                LEFT JOIN owners o ON cd.owner_id = o.id
                LEFT JOIN user_owner_colors uoc ON uoc.owner_id = o.id AND uoc.user_id = :uid
                LEFT JOIN object_types ot ON cd.type_id = ot.id
                LEFT JOIN object_status os ON cd.status_id = os.id
                LEFT JOIN wells sw ON cd.start_well_id = sw.id
                LEFT JOIN wells ew ON cd.end_well_id = ew.id
                WHERE {$where}";
        
        $params['uid'] = $uid;
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
                    os.code as status_code, os.name as status_name, os.color as status_color,
                    sw.number as start_well_number,
                    ew.number as end_well_number
             FROM channel_directions cd
             LEFT JOIN owners o ON cd.owner_id = o.id
             LEFT JOIN object_types ot ON cd.type_id = ot.id
             LEFT JOIN object_status os ON cd.status_id = os.id
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

        $channelCount = (int) ($this->request->input('channel_count') ?? 1);
        if ($channelCount < 1) $channelCount = 1;
        if ($channelCount > 16) {
            Response::error('Максимальное количество каналов - 16', 422);
        }

        // Проверяем существование колодцев
        $wells = $this->db->fetchAll(
            "SELECT id, ST_AsText(geom_wgs84) as geom FROM wells WHERE id IN (:start_id, :end_id)",
            ['start_id' => $startWellId, 'end_id' => $endWellId]
        );

        if (count($wells) !== 2) {
            Response::error('Один или оба колодца не найдены', 404);
        }

        $data = $this->request->only(['number', 'owner_id', 'type_id', 'status_id', 'start_well_id', 'end_well_id', 'length_m', 'notes']);
        
        // Убедиться, что все необязательные поля присутствуют (даже если null)
        $optionalFields = ['owner_id', 'type_id', 'status_id', 'notes'];
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
                    INSERT INTO channel_directions (number, geom_wgs84, geom_msk86, owner_id, type_id, status_id,
                                                    start_well_id, end_well_id, length_m, notes, created_by, updated_by)
                    SELECT :number,
                           ST_MakeLine(start_wgs84, end_wgs84),
                           ST_MakeLine(start_msk86, end_msk86),
                           :owner_id, :type_id, :status_id, :start_well_id2, :end_well_id2, 
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

            // Автоматически создаём каналы (1..N) по умолчанию (диаметр 110)
            $defaultKindId = $this->getDefaultChannelKindId((int) ($user['id'] ?? 0));
            $defaultStatusId = $this->getDefaultStatusId();
            for ($i = 1; $i <= $channelCount; $i++) {
                $this->db->insert('cable_channels', [
                    'direction_id' => $id,
                    'channel_number' => $i,
                    'kind_id' => $defaultKindId,
                    'status_id' => $defaultStatusId,
                    'diameter_mm' => 110,
                    'created_by' => $user['id'],
                    'updated_by' => $user['id'],
                ]);
            }

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

        // number и length_m рассчитываются/задаются автоматически (редактирование запрещено)
        $data = $this->request->only(['owner_id', 'type_id', 'status_id', 'notes']);
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
        if (empty($data['kind_id'])) {
            $user = Auth::user();
            $data['kind_id'] = $this->getDefaultChannelKindId((int) ($user['id'] ?? 0));
        }
        if (empty($data['status_id'])) {
            $data['status_id'] = $this->getDefaultStatusId();
        }
        if (empty($data['diameter_mm'])) {
            $data['diameter_mm'] = 110;
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
     * POST /api/channel-directions/{id}/channels/ensure
     * Увеличение количества каналов до target_count (только увеличение)
     */
    public function ensureChannelCount(string $id): void
    {
        $this->checkWriteAccess();
        $directionId = (int) $id;

        $direction = $this->db->fetch("SELECT * FROM channel_directions WHERE id = :id", ['id' => $directionId]);
        if (!$direction) {
            Response::error('Направление не найдено', 404);
        }

        $target = (int) ($this->request->input('target_count') ?? 0);
        if ($target < 1) {
            Response::error('Некорректное значение количества каналов', 422);
        }
        if ($target > 16) {
            Response::error('Максимальное количество каналов - 16', 422);
        }

        $countRow = $this->db->fetch(
            "SELECT COUNT(*) as cnt FROM cable_channels WHERE direction_id = :id",
            ['id' => $directionId]
        );
        $current = (int) ($countRow['cnt'] ?? 0);

        if ($target <= $current) {
            Response::error('Можно только увеличить количество каналов', 400);
        }

        $user = Auth::user();
        $defaultKindId = $this->getDefaultChannelKindId((int) ($user['id'] ?? 0));
        $defaultStatusId = $this->getDefaultStatusId();

        try {
            $this->db->beginTransaction();

            for ($i = $current + 1; $i <= $target; $i++) {
                $this->db->insert('cable_channels', [
                    'direction_id' => $directionId,
                    'channel_number' => $i,
                    'kind_id' => $defaultKindId,
                    'status_id' => $defaultStatusId,
                    'diameter_mm' => 110,
                    'created_by' => $user['id'],
                    'updated_by' => $user['id'],
                ]);
            }

            $this->db->commit();

            Response::success([
                'direction_id' => $directionId,
                'before' => $current,
                'after' => $target,
                'added' => $target - $current,
            ], 'Каналы добавлены');
        } catch (\Throwable $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /**
     * POST /api/channel-directions/{id}/stuff-well
     * "Набить колодец": создать колодец внутри существующего направления и заменить направление на два новых.
     */
    public function stuffWell(string $id): void
    {
        $this->checkWriteAccess();
        $directionId = (int) $id;

        $direction = $this->db->fetch(
            "SELECT * FROM channel_directions WHERE id = :id",
            ['id' => $directionId]
        );
        if (!$direction) {
            Response::error('Направление не найдено', 404);
        }

        // Данные нового колодца (как в стандартном создании)
        $wellData = $this->request->only([
            'owner_id', 'type_id', 'kind_id', 'status_id',
            'depth', 'material', 'installation_date', 'notes'
        ]);
        $wellData = array_filter($wellData, fn($v) => $v !== null);

        $errors = $this->request->validate([
            'owner_id' => 'required|integer',
            'type_id' => 'required|integer',
            'kind_id' => 'required|integer',
            'status_id' => 'required|integer',
        ]);
        if (!empty($errors)) {
            Response::error('Ошибка валидации', 422, $errors);
        }

        $longitude = $this->request->input('longitude');
        $latitude = $this->request->input('latitude');
        $xMsk86 = $this->request->input('x_msk86');
        $yMsk86 = $this->request->input('y_msk86');
        if (!$longitude && !$xMsk86) {
            Response::error('Необходимо указать координаты колодца (WGS84)', 422);
        }

        $user = Auth::user();
        $uid = (int) ($user['id'] ?? 0);

        try {
            $this->db->beginTransaction();

            // 1) Создаём новый колодец
            $suffix = $this->request->input('number_suffix');
            $wellData['number'] = $this->buildAutoNumber(
                'wells',
                (int) ($wellData['type_id'] ?? 0),
                (int) ($wellData['owner_id'] ?? 0),
                null,
                ($suffix !== null) ? (string) $suffix : null
            );
            $wellData['created_by'] = $uid;
            $wellData['updated_by'] = $uid;

            if ($longitude && $latitude) {
                $sqlWell = "INSERT INTO wells (number, geom_wgs84, owner_id, type_id, kind_id, status_id,
                                               depth, material, installation_date, notes, created_by, updated_by)
                            VALUES (:number, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326),
                                    :owner_id, :type_id, :kind_id, :status_id,
                                    :depth, :material, :installation_date, :notes, :created_by, :updated_by)
                            RETURNING id";
                $wellData['lon'] = $longitude;
                $wellData['lat'] = $latitude;
            } else {
                $sqlWell = "WITH geom_point AS (
                                SELECT ST_SetSRID(ST_MakePoint(:x, :y), 200004) as msk86_point
                            )
                            INSERT INTO wells (number, geom_wgs84, geom_msk86, owner_id, type_id, kind_id, status_id,
                                               depth, material, installation_date, notes, created_by, updated_by)
                            SELECT :number,
                                   ST_Transform(msk86_point, 4326),
                                   msk86_point,
                                   :owner_id, :type_id, :kind_id, :status_id,
                                   :depth, :material, :installation_date, :notes, :created_by, :updated_by
                            FROM geom_point
                            RETURNING id";
                $wellData['x'] = $xMsk86;
                $wellData['y'] = $yMsk86;
            }

            $stmt = $this->db->query($sqlWell, $wellData);
            $newWellId = (int) $stmt->fetchColumn();

            $newWell = $this->db->fetch("SELECT id, number FROM wells WHERE id = :id", ['id' => $newWellId]);
            if (!$newWell) {
                Response::error('Не удалось создать колодец', 500);
            }

            // 2) Создаём два новых направления с теми же полями, что у исходного
            $startWellId = (int) ($direction['start_well_id'] ?? 0);
            $endWellId = (int) ($direction['end_well_id'] ?? 0);

            $startWell = $this->db->fetch("SELECT id, number FROM wells WHERE id = :id", ['id' => $startWellId]);
            $endWell = $this->db->fetch("SELECT id, number FROM wells WHERE id = :id", ['id' => $endWellId]);
            if (!$startWell || !$endWell) {
                Response::error('Начальный/конечный колодец направления не найден', 404);
            }

            $dirBase = [
                'owner_id' => $direction['owner_id'] ?? null,
                'type_id' => $direction['type_id'] ?? null,
                'status_id' => $direction['status_id'] ?? null,
                'notes' => $direction['notes'] ?? null,
                'created_by' => $uid,
                'updated_by' => $uid,
            ];

            // Направление 1: start -> newWell
            $sqlDir = "WITH well_geoms AS (
                            SELECT
                                sw.geom_wgs84 as start_wgs84, sw.geom_msk86 as start_msk86,
                                ew.geom_wgs84 as end_wgs84, ew.geom_msk86 as end_msk86
                            FROM wells sw, wells ew
                            WHERE sw.id = :start_well_id AND ew.id = :end_well_id
                        )
                        INSERT INTO channel_directions (number, geom_wgs84, geom_msk86, owner_id, type_id, status_id,
                                                        start_well_id, end_well_id, length_m, notes, created_by, updated_by)
                        SELECT :number,
                               ST_MakeLine(start_wgs84, end_wgs84),
                               ST_MakeLine(start_msk86, end_msk86),
                               :owner_id, :type_id, :status_id, :start_well_id2, :end_well_id2,
                               ROUND(ST_Length(ST_MakeLine(start_wgs84, end_wgs84)::geography)::numeric, 2),
                               :notes, :created_by, :updated_by
                        FROM well_geoms
                        RETURNING id";

            $dir1 = $dirBase;
            $dir1['number'] = $startWell['number'] . '-' . $newWell['number'];
            $dir1['start_well_id'] = $startWellId;
            $dir1['end_well_id'] = $newWellId;
            $dir1['start_well_id2'] = $startWellId;
            $dir1['end_well_id2'] = $newWellId;
            $stmt1 = $this->db->query($sqlDir, $dir1);
            $newDir1Id = (int) $stmt1->fetchColumn();

            // Направление 2: newWell -> end
            $dir2 = $dirBase;
            $dir2['number'] = $newWell['number'] . '-' . $endWell['number'];
            $dir2['start_well_id'] = $newWellId;
            $dir2['end_well_id'] = $endWellId;
            $dir2['start_well_id2'] = $newWellId;
            $dir2['end_well_id2'] = $endWellId;
            $stmt2 = $this->db->query($sqlDir, $dir2);
            $newDir2Id = (int) $stmt2->fetchColumn();

            // 3) Копируем каналы исходного направления в оба новых направления
            $channels = $this->db->fetchAll(
                "SELECT channel_number, kind_id, status_id, diameter_mm, material, notes
                 FROM cable_channels
                 WHERE direction_id = :id
                 ORDER BY channel_number",
                ['id' => $directionId]
            );
            foreach ([$newDir1Id, $newDir2Id] as $did) {
                foreach ($channels as $ch) {
                    $this->db->insert('cable_channels', [
                        'direction_id' => $did,
                        'channel_number' => (int) ($ch['channel_number'] ?? 1),
                        'kind_id' => $ch['kind_id'] ?? null,
                        'status_id' => $ch['status_id'] ?? null,
                        'diameter_mm' => $ch['diameter_mm'] ?? 110,
                        'material' => $ch['material'] ?? null,
                        'notes' => $ch['notes'] ?? null,
                        'created_by' => $uid,
                        'updated_by' => $uid,
                    ]);
                }
            }

            // Берём 1-й канал у новых направлений
            $newDir1Ch1 = $this->db->fetch(
                "SELECT id FROM cable_channels WHERE direction_id = :id AND channel_number = 1 LIMIT 1",
                ['id' => $newDir1Id]
            );
            $newDir2Ch1 = $this->db->fetch(
                "SELECT id FROM cable_channels WHERE direction_id = :id AND channel_number = 1 LIMIT 1",
                ['id' => $newDir2Id]
            );
            $newCh1Id = (int) ($newDir1Ch1['id'] ?? 0);
            $newCh2Id = (int) ($newDir2Ch1['id'] ?? 0);

            // 4) Кабели в канализации: заменяем участки маршрута на два новых 1-х канала
            if ($newCh1Id > 0 && $newCh2Id > 0) {
                $cableIds = $this->db->fetchAll(
                    "SELECT DISTINCT crc.cable_id
                     FROM cable_route_channels crc
                     JOIN cable_channels cc ON crc.cable_channel_id = cc.id
                     WHERE cc.direction_id = :dir_id",
                    ['dir_id' => $directionId]
                );
                foreach ($cableIds as $cr) {
                    $cid = (int) ($cr['cable_id'] ?? 0);
                    if ($cid <= 0) continue;

                    $route = $this->db->fetchAll(
                        "SELECT crc.cable_channel_id
                         FROM cable_route_channels crc
                         WHERE crc.cable_id = :cid
                         ORDER BY crc.route_order",
                        ['cid' => $cid]
                    );
                    $routeIds = array_map(fn($r) => (int) ($r['cable_channel_id'] ?? 0), $route);
                    $routeIds = array_values(array_filter($routeIds, fn($v) => $v > 0));
                    if (!$routeIds) continue;

                    // определим какие из них относятся к исходному направлению
                    $mapRows = $this->db->fetchAll(
                        "SELECT id, direction_id FROM cable_channels WHERE id IN (" . implode(',', array_map('intval', $routeIds)) . ")"
                    );
                    $dirByCh = [];
                    foreach ($mapRows as $mr) {
                        $dirByCh[(int) $mr['id']] = (int) $mr['direction_id'];
                    }

                    $newRoute = [];
                    $inserted = false;
                    foreach ($routeIds as $chid) {
                        $d = $dirByCh[$chid] ?? null;
                        if ($d === $directionId) {
                            if (!$inserted) {
                                $newRoute[] = $newCh1Id;
                                $newRoute[] = $newCh2Id;
                                $inserted = true;
                            }
                            // пропускаем все каналы исходного направления
                            continue;
                        }
                        $newRoute[] = $chid;
                    }

                    // Перезаписываем маршрут
                    $this->db->delete('cable_route_channels', 'cable_id = :id', ['id' => $cid]);
                    foreach (array_values($newRoute) as $order => $channelId) {
                        $this->db->insert('cable_route_channels', [
                            'cable_id' => $cid,
                            'cable_channel_id' => (int) $channelId,
                            'route_order' => (int) $order,
                        ]);
                    }

                    // Пересобираем колодцы маршрута
                    $this->db->delete('cable_route_wells', 'cable_id = :id', ['id' => $cid]);
                    $rows = $this->db->fetchAll(
                        "SELECT cd.start_well_id, cd.end_well_id
                         FROM cable_channels cc
                         JOIN channel_directions cd ON cc.direction_id = cd.id
                         WHERE cc.id IN (" . implode(',', array_map('intval', $newRoute)) . ")"
                    );
                    $routeWells = [];
                    foreach ($rows as $r) {
                        foreach ([(int) $r['start_well_id'], (int) $r['end_well_id']] as $wid) {
                            if ($wid > 0 && !in_array($wid, $routeWells, true)) {
                                $routeWells[] = $wid;
                            }
                        }
                    }
                    foreach ($routeWells as $order => $wid) {
                        $this->db->insert('cable_route_wells', [
                            'cable_id' => $cid,
                            'well_id' => $wid,
                            'route_order' => (int) $order,
                        ]);
                    }
                    $this->updateDuctCableLength($cid);
                }
            }

            // 5) Удаляем исходное направление (заменено на два новых)
            $this->db->delete('object_photos', "object_table = 'channel_directions' AND object_id = :id", ['id' => $directionId]);
            $this->db->delete('channel_directions', 'id = :id', ['id' => $directionId]);

            $this->db->commit();

            Response::success([
                'new_well_id' => $newWellId,
                'new_direction_1_id' => $newDir1Id,
                'new_direction_2_id' => $newDir2Id,
                'deleted_direction_id' => $directionId,
            ], 'Колодец набит');
        } catch (\Throwable $e) {
            $this->db->rollback();
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
            '_search' => ['cc.channel_number::text', 'cc.notes', 'cd.number'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        // COUNT должен учитывать JOIN-ы, т.к. _search включает поля cd.number
        $totalSql = "SELECT COUNT(*) as total
                     FROM cable_channels cc
                     LEFT JOIN channel_directions cd ON cc.direction_id = cd.id";
        if ($where) {
            $totalSql .= " WHERE {$where}";
        }
        $totalRow = $this->db->fetch($totalSql, $params);
        $total = (int) ($totalRow['total'] ?? 0);

        $sql = "SELECT cc.id, cc.channel_number, cc.direction_id,
                       MAX(cc.channel_number) OVER (PARTITION BY cc.direction_id) as max_channel_number,
                       cc.kind_id, cc.status_id,
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
     * GET /api/channel-directions/export
     * Экспорт направлений в CSV
     */
    public function exportDirections(): void
    {
        $filters = $this->buildFilters([
            'owner_id' => 'cd.owner_id',
            'type_id' => 'cd.type_id',
            'start_well_id' => 'cd.start_well_id',
            'end_well_id' => 'cd.end_well_id',
            '_search' => ['cd.number', 'cd.notes'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];
        $delimiter = $this->normalizeCsvDelimiter($this->request->query('delimiter'), ';');

        $sql = "SELECT cd.number,
                       sw.number as start_well,
                       ew.number as end_well,
                       o.name as owner,
                       ot.name as type,
                       cd.length_m,
                       ST_Length(cd.geom_wgs84::geography) as calculated_length,
                       (SELECT COUNT(*) FROM cable_channels WHERE direction_id = cd.id) as channel_count,
                       cd.notes
                FROM channel_directions cd
                LEFT JOIN owners o ON cd.owner_id = o.id
                LEFT JOIN object_types ot ON cd.type_id = ot.id
                LEFT JOIN wells sw ON cd.start_well_id = sw.id
                LEFT JOIN wells ew ON cd.end_well_id = ew.id";

        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY cd.number";

        $data = $this->db->fetchAll($sql, $params);

        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="channel_directions_' . date('Y-m-d') . '.csv"');

        $output = fopen('php://output', 'w');
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));

        fputcsv($output, ['Номер', 'Начальный колодец', 'Конечный колодец', 'Собственник', 'Вид', 'Длина (м)', 'Длина расч. (м)', 'Каналов', 'Примечания'], $delimiter);
        foreach ($data as $row) {
            fputcsv($output, array_values($row), $delimiter);
        }
        fclose($output);
        exit;
    }

    /**
     * GET /api/cable-channels/export
     * Экспорт каналов в CSV
     */
    public function exportChannels(): void
    {
        $filters = $this->buildFilters([
            'direction_id' => 'cc.direction_id',
            'kind_id' => 'cc.kind_id',
            'status_id' => 'cc.status_id',
            '_search' => ['cc.channel_number::text', 'cc.notes', 'cd.number'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];
        $delimiter = $this->normalizeCsvDelimiter($this->request->query('delimiter'), ';');

        $sql = "SELECT cd.number as direction_number,
                       cc.channel_number,
                       ok.name as kind,
                       os.name as status,
                       cc.diameter_mm,
                       cc.material,
                       cc.notes
                FROM cable_channels cc
                LEFT JOIN channel_directions cd ON cc.direction_id = cd.id
                LEFT JOIN object_kinds ok ON cc.kind_id = ok.id
                LEFT JOIN object_status os ON cc.status_id = os.id";

        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY cd.number, cc.channel_number";

        $data = $this->db->fetchAll($sql, $params);

        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="cable_channels_' . date('Y-m-d') . '.csv"');

        $output = fopen('php://output', 'w');
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));

        fputcsv($output, ['Направление', '№ канала', 'Тип', 'Состояние', 'Диаметр (мм)', 'Материал', 'Примечания'], $delimiter);
        foreach ($data as $row) {
            fputcsv($output, array_values($row), $delimiter);
        }
        fclose($output);
        exit;
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

        $directionId = (int) ($channel['direction_id'] ?? 0);
        $channelNumber = (int) ($channel['channel_number'] ?? 0);

        // Удалять можно только последний (по номеру) канал в направлении
        if ($directionId > 0) {
            $maxRow = $this->db->fetch(
                "SELECT MAX(channel_number) as mx FROM cable_channels WHERE direction_id = :did",
                ['did' => $directionId]
            );
            $max = (int) ($maxRow['mx'] ?? 0);
            if ($max > 0 && $channelNumber !== $max) {
                Response::error('Можно удалить только последний канал в направлении', 400);
            }
        }

        // Проверяем, используется ли канал в маршрутах кабелей
        try {
            $used = $this->db->fetchAll(
                "SELECT cb.id, cb.number
                 FROM cable_route_channels crc
                 JOIN cables cb ON crc.cable_id = cb.id
                 WHERE crc.cable_channel_id = :cid
                 ORDER BY cb.number
                 LIMIT 50",
                ['cid' => $channelId]
            );
            if (!empty($used)) {
                $nums = array_values(array_filter(array_map(fn($r) => $r['number'] ?? null, $used)));
                $list = implode(', ', $nums);
                Response::error("Нельзя удалить канал: в нём находятся кабели: {$list}", 400);
            }
        } catch (\Throwable $e) {
            // Если таблиц нет/ошибка — безопасно запрещаем удаление (чтобы не потерять целостность)
            Response::error('Нельзя проверить использование канала кабелями', 400);
        }

        try {
            $this->db->delete('object_photos', "object_table = 'cable_channels' AND object_id = :id", ['id' => $channelId]);
            $this->db->delete('cable_channels', 'id = :id', ['id' => $channelId]);

            $this->log('delete', 'cable_channels', $channelId, $channel, null);

            Response::success(null, 'Канал удалён');
        } catch (\PDOException $e) {
            if (strpos($e->getMessage(), 'foreign key') !== false) {
                Response::error('Нельзя удалить канал, так как он используется', 400);
            }
            throw $e;
        }
    }
}

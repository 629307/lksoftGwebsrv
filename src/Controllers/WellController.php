<?php
/**
 * Контроллер колодцев кабельной канализации
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class WellController extends BaseController
{
    /**
     * GET /api/wells
     * Список колодцев
     */
    public function index(): void
    {
        $pagination = $this->getPagination();
        
        $filters = $this->buildFilters([
            'owner_id' => 'w.owner_id',
            'type_id' => 'w.type_id',
            'kind_id' => 'w.kind_id',
            'status_id' => 'w.status_id',
            '_search' => ['w.number', 'w.notes'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        // Общее количество (передаём алиас 'w' для корректной работы с WHERE)
        $total = $this->getTotal('wells', $where, $params, 'w');

        // Данные с джойнами
        $sql = "SELECT w.id, w.number, 
                       ST_X(w.geom_wgs84) as longitude, ST_Y(w.geom_wgs84) as latitude,
                       ST_X(w.geom_msk86) as x_msk86, ST_Y(w.geom_msk86) as y_msk86,
                       w.owner_id, w.type_id, w.kind_id, w.status_id,
                       w.depth, w.material, w.installation_date, w.notes,
                       (SELECT COUNT(*) FROM object_photos op WHERE op.object_table = 'wells' AND op.object_id = w.id) as photo_count,
                       o.name as owner_name, o.short_name as owner_short,
                       ot.name as type_name, ot.icon as type_icon, ot.color as type_color,
                       ok.name as kind_name,
                       os.name as status_name, os.color as status_color,
                       w.created_at, w.updated_at
                FROM wells w
                LEFT JOIN owners o ON w.owner_id = o.id
                LEFT JOIN object_types ot ON w.type_id = ot.id
                LEFT JOIN object_kinds ok ON w.kind_id = ok.id
                LEFT JOIN object_status os ON w.status_id = os.id";
        
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $order = strtolower((string) $this->request->query('order', 'asc'));
        if (!in_array($order, ['asc', 'desc'], true)) $order = 'asc';
        $sql .= " ORDER BY w.number {$order} LIMIT :limit OFFSET :offset";
        
        $params['limit'] = $pagination['limit'];
        $params['offset'] = $pagination['offset'];
        
        $data = $this->db->fetchAll($sql, $params);

        Response::paginated($data, $total, $pagination['page'], $pagination['limit']);
    }

    /**
     * GET /api/wells/clones
     * Найти "клоны" колодцев: одинаковые Latitude/Longitude (WGS84).
     * Возвращает список колодцев, которые попали в группы с count > 1.
     */
    public function clones(): void
    {
        // доступ только для авторизованных пользователей обеспечивается middleware 'auth'
        try {
            $sql = "
                WITH d AS (
                    SELECT
                        ST_X(geom_wgs84) AS longitude,
                        ST_Y(geom_wgs84) AS latitude,
                        COUNT(*)::int AS clone_count
                    FROM wells
                    WHERE geom_wgs84 IS NOT NULL
                    GROUP BY longitude, latitude
                    HAVING COUNT(*) > 1
                )
                SELECT
                    w.id,
                    w.number,
                    ST_X(w.geom_wgs84) AS longitude,
                    ST_Y(w.geom_wgs84) AS latitude,
                    d.clone_count,
                    w.owner_id,
                    w.type_id,
                    w.kind_id,
                    w.status_id,
                    o.short_name AS owner_short,
                    o.name AS owner_name,
                    ot.name AS type_name,
                    ok.name AS kind_name,
                    os.name AS status_name
                FROM wells w
                JOIN d
                  ON ST_X(w.geom_wgs84) = d.longitude
                 AND ST_Y(w.geom_wgs84) = d.latitude
                LEFT JOIN owners o ON w.owner_id = o.id
                LEFT JOIN object_types ot ON w.type_id = ot.id
                LEFT JOIN object_kinds ok ON w.kind_id = ok.id
                LEFT JOIN object_status os ON w.status_id = os.id
                ORDER BY d.clone_count DESC, latitude, longitude, w.number
            ";

            $rows = $this->db->fetchAll($sql);
            Response::success($rows);
        } catch (\PDOException $e) {
            Response::error('Ошибка поиска клонов', 500);
        }
    }

    /**
     * GET /api/wells/geojson
     * GeoJSON всех колодцев для карты
     */
    public function geojson(): void
    {
        $user = Auth::user();
        $uid = (int) ($user['id'] ?? 0);
        $filters = $this->buildFilters([
            'owner_id' => 'w.owner_id',
            'type_id' => 'w.type_id',
            'kind_id' => 'w.kind_id',
            'status_id' => 'w.status_id',
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        // Обязательно фильтруем по наличию геометрии
        $geomCondition = 'w.geom_wgs84 IS NOT NULL';
        if ($where) {
            $where = "{$geomCondition} AND ({$where})";
        } else {
            $where = $geomCondition;
        }

        $sql = "SELECT w.id, w.number, 
                       ST_AsGeoJSON(w.geom_wgs84)::json as geometry,
                       w.owner_id, w.type_id, w.kind_id, w.status_id,
                       o.name as owner_name, o.short_name as owner_short_name, COALESCE(uoc.color, o.color) as owner_color,
                       ot.name as type_name, ot.color as type_color,
                       ok.code as kind_code, ok.name as kind_name,
                       os.code as status_code, os.name as status_name, os.color as status_color
                FROM wells w
                LEFT JOIN owners o ON w.owner_id = o.id
                LEFT JOIN user_owner_colors uoc ON uoc.owner_id = o.id AND uoc.user_id = :uid
                LEFT JOIN object_types ot ON w.type_id = ot.id
                LEFT JOIN object_kinds ok ON w.kind_id = ok.id
                LEFT JOIN object_status os ON w.status_id = os.id
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

        Response::geojson($features, ['layer' => 'wells', 'count' => count($features)]);
    }

    /**
     * GET /api/wells/{id}
     * Получение колодца
     */
    public function show(string $id): void
    {
        $well = $this->db->fetch(
            "SELECT w.*, 
                    ST_X(w.geom_wgs84) as longitude, ST_Y(w.geom_wgs84) as latitude,
                    ST_X(w.geom_msk86) as x_msk86, ST_Y(w.geom_msk86) as y_msk86,
                    o.name as owner_name,
                    ot.name as type_name,
                    ok.name as kind_name,
                    os.name as status_name, os.color as status_color,
                    uc.login as created_by_login,
                    uu.login as updated_by_login
             FROM wells w
             LEFT JOIN owners o ON w.owner_id = o.id
             LEFT JOIN object_types ot ON w.type_id = ot.id
             LEFT JOIN object_kinds ok ON w.kind_id = ok.id
             LEFT JOIN object_status os ON w.status_id = os.id
             LEFT JOIN users uc ON w.created_by = uc.id
             LEFT JOIN users uu ON w.updated_by = uu.id
             WHERE w.id = :id",
            ['id' => (int) $id]
        );

        if (!$well) {
            Response::error('Колодец не найден', 404);
        }

        // Получаем фотографии
        $photos = $this->db->fetchAll(
            "SELECT id, filename, original_filename, file_path, description, created_at 
             FROM object_photos 
             WHERE object_table = 'wells' AND object_id = :id 
             ORDER BY sort_order",
            ['id' => (int) $id]
        );
        $well['photos'] = $photos;

        // Получаем связанные направления
        $directions = $this->db->fetchAll(
            "SELECT cd.id, cd.number, 
                    CASE WHEN cd.start_well_id = :id THEN 'start' ELSE 'end' END as connection_type,
                    CASE WHEN cd.start_well_id = :id THEN ew.number ELSE sw.number END as connected_well_number
             FROM channel_directions cd
             LEFT JOIN wells sw ON cd.start_well_id = sw.id
             LEFT JOIN wells ew ON cd.end_well_id = ew.id
             WHERE cd.start_well_id = :id OR cd.end_well_id = :id",
            ['id' => (int) $id]
        );
        $well['directions'] = $directions;

        Response::success($well);
    }

    /**
     * POST /api/wells
     * Создание колодца
     */
    public function store(): void
    {
        $this->checkWriteAccess();

        $errors = $this->request->validate([
            'owner_id' => 'required|integer',
            'type_id' => 'required|integer',
            'kind_id' => 'required|integer',
            'status_id' => 'required|integer',
        ]);

        if (!empty($errors)) {
            Response::error('Ошибка валидации', 422, $errors);
        }

        $data = $this->request->only([
            'owner_id', 'type_id', 'kind_id', 'status_id',
            'depth', 'material', 'installation_date', 'notes'
        ]);

        // Формирование номера:
        // <Код номера>-<Код собственника>-<seq>(-суффикс)
        // Исключение: для "вводных" колодцев (kind.code = 'input') seq начинается с настройки input_well_number_start
        $suffix = $this->request->input('number_suffix');
        $minSeq = 1;
        try {
            $kindCode = $this->getObjectKindCodeById((int) ($data['kind_id'] ?? 0));
            if (strtolower(trim($kindCode)) === 'input') {
                $minSeq = max(1, (int) $this->getAppSetting('input_well_number_start', 1));
            }
        } catch (\Throwable $e) {
            // если не удалось определить kind — используем дефолт
            $minSeq = 1;
        }
        $data['number'] = $this->buildAutoNumber(
            'wells',
            (int) ($data['type_id'] ?? 0),
            (int) ($data['owner_id'] ?? 0),
            null,
            ($suffix !== null) ? (string) $suffix : null,
            null,
            $minSeq
        );

        // Убедиться, что все необязательные поля присутствуют (даже если null)
        $optionalFields = ['depth', 'material', 'installation_date', 'notes'];
        foreach ($optionalFields as $field) {
            if (!array_key_exists($field, $data)) {
                $data[$field] = null;
            }
        }

        // Координаты - либо WGS84, либо МСК86
        $longitude = $this->request->input('longitude');
        $latitude = $this->request->input('latitude');
        $xMsk86 = $this->request->input('x_msk86');
        $yMsk86 = $this->request->input('y_msk86');

        if (!$longitude && !$xMsk86) {
            Response::error('Необходимо указать координаты (WGS84 или МСК86)', 422);
        }

        $user = Auth::user();
        $data['created_by'] = $user['id'];
        $data['updated_by'] = $user['id'];

        try {
            $this->db->beginTransaction();

            // Создаём геометрию
            if ($longitude && $latitude) {
                // WGS84 -> автоматически пересчитается в МСК86 триггером
                $sql = "INSERT INTO wells (number, geom_wgs84, owner_id, type_id, kind_id, status_id, 
                                           depth, material, installation_date, notes, created_by, updated_by)
                        VALUES (:number, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326), 
                                :owner_id, :type_id, :kind_id, :status_id,
                                :depth, :material, :installation_date, :notes, :created_by, :updated_by)
                        RETURNING id";
                $data['lon'] = $longitude;
                $data['lat'] = $latitude;
            } else {
                // МСК86 -> WGS84
                // PostgreSQL PDO не поддерживает повторное использование именованных параметров,
                // поэтому используем подзапрос с CTE для создания геометрии один раз
                $sql = "WITH geom_point AS (
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
                $data['x'] = $xMsk86;
                $data['y'] = $yMsk86;
            }

            $stmt = $this->db->query($sql, $data);
            $id = $stmt->fetchColumn();

            $this->db->commit();

            $well = $this->db->fetch(
                "SELECT *, ST_X(geom_wgs84) as longitude, ST_Y(geom_wgs84) as latitude,
                        ST_X(geom_msk86) as x_msk86, ST_Y(geom_msk86) as y_msk86
                 FROM wells WHERE id = :id",
                ['id' => $id]
            );

            $this->log('create', 'wells', $id, null, $well);

            Response::success($well, 'Колодец создан', 201);
        } catch (\PDOException $e) {
            $this->db->rollback();
            if (strpos($e->getMessage(), 'unique') !== false) {
                Response::error('Колодец с таким номером уже существует', 400);
            }
            throw $e;
        }
    }

    /**
     * GET /api/wells/exists?number=...&exclude_id=...
     * Проверка уникальности номера колодца (для UI)
     */
    public function existsNumber(): void
    {
        $number = trim((string) $this->request->query('number', ''));
        $excludeId = (int) $this->request->query('exclude_id', 0);

        if ($number === '') {
            Response::success(['exists' => false]);
        }

        $sql = "SELECT id FROM wells WHERE number = :number";
        $params = ['number' => $number];
        if ($excludeId > 0) {
            $sql .= " AND id <> :exclude_id";
            $params['exclude_id'] = $excludeId;
        }
        $sql .= " LIMIT 1";

        $row = $this->db->fetch($sql, $params);
        Response::success(['exists' => (bool) $row]);
    }

    /**
     * PUT /api/wells/{id}
     * Обновление колодца
     */
    public function update(string $id): void
    {
        $this->checkWriteAccess();
        $wellId = (int) $id;

        $oldWell = $this->db->fetch("SELECT * FROM wells WHERE id = :id", ['id' => $wellId]);
        if (!$oldWell) {
            Response::error('Колодец не найден', 404);
        }

        // При редактировании допускается изменение owner/type и суффикса номера.
        // Требование: при смене собственника должен меняться код собственника в номере.
        $data = $this->request->only([
            'owner_id', 'type_id', 'kind_id', 'status_id',
            'depth', 'material', 'installation_date', 'notes'
        ]);
        $data = array_filter($data, fn($v) => $v !== null);

        // Пересобираем номер при необходимости (owner/type/suffix)
        $oldNumber = (string) ($oldWell['number'] ?? '');
        $oldParts = $this->parseNumberSeqAndSuffix($oldNumber);
        $oldSeq = $oldParts['seq'] ?? null;
        $oldSuffix = $this->sanitizeNumberSuffix((string) ($oldParts['suffix'] ?? ''));

        $requestedSuffix = $this->request->input('number_suffix'); // может отсутствовать
        $newSuffix = ($requestedSuffix !== null) ? $this->sanitizeNumberSuffix((string) $requestedSuffix) : $oldSuffix;

        $newOwnerId = array_key_exists('owner_id', $data) ? (int) $data['owner_id'] : (int) ($oldWell['owner_id'] ?? 0);
        $newTypeId  = array_key_exists('type_id', $data) ? (int) $data['type_id'] : (int) ($oldWell['type_id'] ?? 0);
        $newKindId  = array_key_exists('kind_id', $data) ? (int) $data['kind_id'] : (int) ($oldWell['kind_id'] ?? 0);

        $needRenumber =
            ($newOwnerId !== (int) ($oldWell['owner_id'] ?? 0)) ||
            ($newTypeId  !== (int) ($oldWell['type_id'] ?? 0)) ||
            ($newSuffix  !== $oldSuffix);

        if ($needRenumber) {
            // "вводной" колодец: нумерация может начинаться с настройки
            $minSeq = 1;
            try {
                $kindCode = $this->getObjectKindCodeById($newKindId);
                if (strtolower(trim($kindCode)) === 'input') {
                    $minSeq = max(1, (int) $this->getAppSetting('input_well_number_start', 1));
                }
            } catch (\Throwable $e) {
                $minSeq = 1;
            }

            $manualSeq = (is_int($oldSeq) && $oldSeq >= $minSeq) ? (int) $oldSeq : null;
            $data['number'] = $this->buildAutoNumber(
                'wells',
                $newTypeId,
                $newOwnerId,
                $manualSeq,
                ($newSuffix !== '') ? $newSuffix : null,
                $wellId,
                $minSeq
            );
        }
        $numberChanged = ($needRenumber && array_key_exists('number', $data) && (string) $data['number'] !== (string) $oldNumber);

        $user = Auth::user();
        $data['updated_by'] = $user['id'];

        try {
            $this->db->beginTransaction();

            // Обновляем координаты если переданы
            $longitude = $this->request->input('longitude');
            $latitude = $this->request->input('latitude');
            $xMsk86 = $this->request->input('x_msk86');
            $yMsk86 = $this->request->input('y_msk86');

            $coordsChanged = false;
            if ($longitude && $latitude) {
                // PostgreSQL PDO не поддерживает повторное использование именованных параметров
                $this->db->query(
                    "UPDATE wells SET 
                        geom_wgs84 = wgs_point.geom,
                        geom_msk86 = ST_Transform(wgs_point.geom, 200004)
                     FROM (SELECT ST_SetSRID(ST_MakePoint(:lon, :lat), 4326) as geom) as wgs_point
                     WHERE wells.id = :id",
                    ['lon' => $longitude, 'lat' => $latitude, 'id' => $wellId]
                );
                $coordsChanged = true;
            } elseif ($xMsk86 && $yMsk86) {
                // PostgreSQL PDO не поддерживает повторное использование именованных параметров
                $this->db->query(
                    "UPDATE wells SET 
                        geom_msk86 = msk_point.geom,
                        geom_wgs84 = ST_Transform(msk_point.geom, 4326)
                     FROM (SELECT ST_SetSRID(ST_MakePoint(:x, :y), 200004) as geom) as msk_point
                     WHERE wells.id = :id",
                    ['x' => $xMsk86, 'y' => $yMsk86, 'id' => $wellId]
                );
                $coordsChanged = true;
            }

            // Обновляем остальные поля
            if (!empty($data)) {
                $this->db->update('wells', $data, 'id = :id', ['id' => $wellId]);
            }

            // Если изменился номер колодца — обновляем номера связанных направлений
            // (номер направления формируется как "<номер начального колодца>-<номер конечного колодца>")
            if (!empty($numberChanged)) {
                $this->db->query(
                    "UPDATE channel_directions cd
                     SET number = (sw.number || '-' || ew.number),
                         updated_by = :uid,
                         updated_at = NOW()
                     FROM wells sw, wells ew
                     WHERE cd.start_well_id = sw.id
                       AND cd.end_well_id = ew.id
                       AND (cd.start_well_id = :wid OR cd.end_well_id = :wid)",
                    ['uid' => (int) ($user['id'] ?? 0), 'wid' => $wellId]
                );
            }

            // Если изменились координаты колодца — пересчитываем геометрию и длину направлений, которые на него ссылаются
            if (!empty($coordsChanged)) {
                $this->db->query(
                    "UPDATE channel_directions cd
                     SET geom_wgs84 = ST_MakeLine(sw.geom_wgs84, ew.geom_wgs84),
                         geom_msk86 = ST_MakeLine(sw.geom_msk86, ew.geom_msk86),
                         length_m = ROUND(ST_Length(ST_MakeLine(sw.geom_wgs84, ew.geom_wgs84)::geography)::numeric, 2),
                         updated_by = :uid,
                         updated_at = NOW()
                     FROM wells sw, wells ew
                     WHERE cd.start_well_id = sw.id
                       AND cd.end_well_id = ew.id
                       AND (cd.start_well_id = :wid OR cd.end_well_id = :wid)",
                    ['uid' => (int) ($user['id'] ?? 0), 'wid' => $wellId]
                );

                // Пересчитываем "Длина расч. (м)" для duct-кабелей, маршрут которых содержит затронутые направления.
                // Формула: SUM(длин направлений) + K * COUNT(уникальных направлений), K = настройка cable_in_well_length_m
                $k = (float) $this->getAppSetting('cable_in_well_length_m', 2);
                $this->db->query(
                    "WITH affected_cables AS (
                        SELECT DISTINCT crc.cable_id
                        FROM channel_directions cd
                        JOIN cable_channels ch ON ch.direction_id = cd.id
                        JOIN cable_route_channels crc ON crc.cable_channel_id = ch.id
                        WHERE (cd.start_well_id = :wid OR cd.end_well_id = :wid)
                    ),
                    dirs AS (
                        SELECT DISTINCT crc.cable_id,
                               cd.id as dir_id,
                               COALESCE(cd.length_m, 0) as len_m
                        FROM affected_cables ac
                        JOIN cable_route_channels crc ON crc.cable_id = ac.cable_id
                        JOIN cable_channels ch ON crc.cable_channel_id = ch.id
                        JOIN channel_directions cd ON ch.direction_id = cd.id
                    ),
                    agg AS (
                        SELECT cable_id,
                               COALESCE(SUM(len_m), 0) as sum_len,
                               COALESCE(COUNT(*), 0) as cnt_dirs
                        FROM dirs
                        GROUP BY cable_id
                    )
                    UPDATE cables c
                    SET length_calculated = (a.sum_len + (:k * a.cnt_dirs))
                    FROM agg a
                    WHERE c.id = a.cable_id",
                    ['wid' => $wellId, 'k' => $k]
                );
            }

            $this->db->commit();

            $well = $this->db->fetch(
                "SELECT *, ST_X(geom_wgs84) as longitude, ST_Y(geom_wgs84) as latitude,
                        ST_X(geom_msk86) as x_msk86, ST_Y(geom_msk86) as y_msk86
                 FROM wells WHERE id = :id",
                ['id' => $wellId]
            );

            $this->log('update', 'wells', $wellId, $oldWell, $well);

            Response::success($well, 'Колодец обновлён');
        } catch (\PDOException $e) {
            $this->db->rollback();
            if (strpos($e->getMessage(), 'unique') !== false) {
                Response::error('Колодец с таким номером уже существует', 400);
            }
            throw $e;
        }
    }

    /**
     * DELETE /api/wells/{id}
     * Удаление колодца
     */
    public function destroy(string $id): void
    {
        $this->checkDeleteAccess();
        $wellId = (int) $id;

        $well = $this->db->fetch("SELECT * FROM wells WHERE id = :id", ['id' => $wellId]);
        if (!$well) {
            Response::error('Колодец не найден', 404);
        }

        // Проверяем связанные направления
        $directions = $this->db->fetch(
            "SELECT COUNT(*) as cnt FROM channel_directions WHERE start_well_id = :id OR end_well_id = :id",
            ['id' => $wellId]
        );
        if ($directions['cnt'] > 0) {
            Response::error('Нельзя удалить колодец, так как он связан с направлениями каналов', 400);
        }

        try {
            // Удаляем фотографии
            $this->db->delete('object_photos', "object_table = 'wells' AND object_id = :id", ['id' => $wellId]);
            
            // Удаляем колодец
            $this->db->delete('wells', 'id = :id', ['id' => $wellId]);

            $this->log('delete', 'wells', $wellId, $well, null);

            Response::success(null, 'Колодец удалён');
        } catch (\PDOException $e) {
            if (strpos($e->getMessage(), 'foreign key') !== false) {
                Response::error('Нельзя удалить колодец, так как он используется в других объектах', 400);
            }
            throw $e;
        }
    }

    /**
     * POST /api/wells/{id}/dismantle
     * "Демонтаж колодца": удалить колодец, связанный ровно с 2 направлениями,
     * заменить два направления одним, перенося маршруты duct-кабелей на новое направление.
     */
    public function dismantle(string $id): void
    {
        $this->checkWriteAccess();
        $wellId = (int) $id;

        $well = $this->db->fetch("SELECT id, number FROM wells WHERE id = :id", ['id' => $wellId]);
        if (!$well) {
            Response::error('Колодец не найден', 404);
        }

        $dirs = $this->db->fetchAll(
            "SELECT * FROM channel_directions
             WHERE start_well_id = :id OR end_well_id = :id
             ORDER BY id",
            ['id' => $wellId]
        );

        if (count($dirs) !== 2) {
            Response::error('Демонтаж возможен только для колодца, у которого ровно 2 связанных направления', 422);
        }

        $d1 = $dirs[0];
        $d2 = $dirs[1];

        $dir1Id = (int) ($d1['id'] ?? 0);
        $dir2Id = (int) ($d2['id'] ?? 0);
        if ($dir1Id <= 0 || $dir2Id <= 0) {
            Response::error('Некорректные связанные направления', 422);
        }

        $other1 = ((int) ($d1['start_well_id'] ?? 0) === $wellId) ? (int) ($d1['end_well_id'] ?? 0) : (int) ($d1['start_well_id'] ?? 0);
        $other2 = ((int) ($d2['start_well_id'] ?? 0) === $wellId) ? (int) ($d2['end_well_id'] ?? 0) : (int) ($d2['start_well_id'] ?? 0);
        if ($other1 <= 0 || $other2 <= 0 || $other1 === $other2) {
            Response::error('Некорректные конечные колодцы направлений для демонтажа', 422);
        }

        // Для корректного демонтажа ожидаем одинаковые базовые атрибуты направлений
        foreach (['owner_id', 'type_id', 'status_id'] as $k) {
            $a = (string) ($d1[$k] ?? '');
            $b = (string) ($d2[$k] ?? '');
            if ($a !== $b) {
                Response::error('Нельзя демонтировать: связанные направления имеют разные параметры (owner/type/status)', 422);
            }
        }

        $wStart = $this->db->fetch("SELECT id, number FROM wells WHERE id = :id", ['id' => $other1]);
        $wEnd = $this->db->fetch("SELECT id, number FROM wells WHERE id = :id", ['id' => $other2]);
        if (!$wStart || !$wEnd) {
            Response::error('Связанные колодцы направлений не найдены', 404);
        }

        // Кол-во каналов у направлений
        $cnt1Row = $this->db->fetch("SELECT COUNT(*) as cnt FROM cable_channels WHERE direction_id = :id", ['id' => $dir1Id]) ?: ['cnt' => 0];
        $cnt2Row = $this->db->fetch("SELECT COUNT(*) as cnt FROM cable_channels WHERE direction_id = :id", ['id' => $dir2Id]) ?: ['cnt' => 0];
        $cnt1 = (int) ($cnt1Row['cnt'] ?? 0);
        $cnt2 = (int) ($cnt2Row['cnt'] ?? 0);
        $maxChannels = max($cnt1, $cnt2);
        if ($maxChannels < 1) $maxChannels = 1;

        // Каналы направлений: для переноса свойств и для маппинга (channel_number -> new_channel_id)
        $ch1 = $this->db->fetchAll(
            "SELECT id, channel_number, kind_id, status_id, diameter_mm, material, notes
             FROM cable_channels WHERE direction_id = :id ORDER BY channel_number",
            ['id' => $dir1Id]
        );
        $ch2 = $this->db->fetchAll(
            "SELECT id, channel_number, kind_id, status_id, diameter_mm, material, notes
             FROM cable_channels WHERE direction_id = :id ORDER BY channel_number",
            ['id' => $dir2Id]
        );

        $byNum = [];
        foreach ($ch1 as $r) $byNum[(int) $r['channel_number']] = $r;
        foreach ($ch2 as $r) {
            $n = (int) $r['channel_number'];
            if (!isset($byNum[$n])) $byNum[$n] = $r;
        }

        // Затронутые кабели (duct)
        $affected = $this->db->fetchAll(
            "SELECT DISTINCT crc.cable_id
             FROM cable_route_channels crc
             JOIN cable_channels cc ON crc.cable_channel_id = cc.id
             WHERE cc.direction_id IN (" . (int) $dir1Id . ", " . (int) $dir2Id . ")"
        );
        $affectedCableIds = array_values(array_unique(array_map(fn($r) => (int) ($r['cable_id'] ?? 0), $affected)));
        $affectedCableIds = array_values(array_filter($affectedCableIds, fn($v) => $v > 0));

        // Пред-валидация: для каждого кабеля канал-номер по демонтируемым направлениям должен быть одинаковым
        if ($affectedCableIds) {
            // карта old_channel_id -> [direction_id, channel_number]
            $oldChRows = $this->db->fetchAll(
                "SELECT id, direction_id, channel_number
                 FROM cable_channels
                 WHERE direction_id IN (" . (int) $dir1Id . ", " . (int) $dir2Id . ")"
            );
            $oldChMap = [];
            foreach ($oldChRows as $r) {
                $oldChMap[(int) $r['id']] = ['direction_id' => (int) $r['direction_id'], 'channel_number' => (int) $r['channel_number']];
            }

            foreach ($affectedCableIds as $cid) {
                $route = $this->db->fetchAll(
                    "SELECT crc.cable_channel_id
                     FROM cable_route_channels crc
                     WHERE crc.cable_id = :id
                     ORDER BY crc.route_order",
                    ['id' => $cid]
                );
                $nums = [];
                foreach ($route as $rr) {
                    $chid = (int) ($rr['cable_channel_id'] ?? 0);
                    $info = $oldChMap[$chid] ?? null;
                    if (!$info) continue;
                    $nums[] = (int) $info['channel_number'];
                }
                $nums = array_values(array_unique(array_filter($nums, fn($v) => $v > 0)));
                if (count($nums) > 1) {
                    Response::error('Нельзя демонтировать: найден кабель с разными номерами каналов на демонтируемых направлениях (cable_id=' . $cid . ')', 422);
                }
            }
        }

        $user = Auth::user();
        $uid = (int) ($user['id'] ?? 0);

        try {
            $this->db->beginTransaction();

            // 1) Создаём новое направление: other1 -> other2
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

            $dirBase = [
                'number' => (string) ($wStart['number'] ?? $other1) . '-' . (string) ($wEnd['number'] ?? $other2),
                'owner_id' => $d1['owner_id'] ?? null,
                'type_id' => $d1['type_id'] ?? null,
                'status_id' => $d1['status_id'] ?? null,
                'notes' => $d1['notes'] ?? null,
                'created_by' => $uid,
                'updated_by' => $uid,
                'start_well_id' => $other1,
                'end_well_id' => $other2,
                'start_well_id2' => $other1,
                'end_well_id2' => $other2,
            ];
            $stmt = $this->db->query($sqlDir, $dirBase);
            $newDirId = (int) $stmt->fetchColumn();
            if ($newDirId <= 0) {
                Response::error('Не удалось создать новое направление', 500);
            }

            // 2) Создаём каналы нового направления (1..maxChannels)
            for ($i = 1; $i <= $maxChannels; $i++) {
                $src = $byNum[$i] ?? null;
                $this->db->insert('cable_channels', [
                    'direction_id' => $newDirId,
                    'channel_number' => $i,
                    'kind_id' => $src['kind_id'] ?? null,
                    'status_id' => $src['status_id'] ?? null,
                    'diameter_mm' => $src['diameter_mm'] ?? 110,
                    'material' => $src['material'] ?? null,
                    'notes' => $src['notes'] ?? null,
                    'created_by' => $uid,
                    'updated_by' => $uid,
                ]);
            }

            $newChRows = $this->db->fetchAll(
                "SELECT id, channel_number FROM cable_channels WHERE direction_id = :id",
                ['id' => $newDirId]
            );
            $newChByNum = [];
            foreach ($newChRows as $r) {
                $newChByNum[(int) $r['channel_number']] = (int) $r['id'];
            }

            // карта old_channel_id -> channel_number (для замены в маршрутах)
            $oldChRows = $this->db->fetchAll(
                "SELECT id, channel_number
                 FROM cable_channels
                 WHERE direction_id IN (" . (int) $dir1Id . ", " . (int) $dir2Id . ")"
            );
            $oldNumById = [];
            foreach ($oldChRows as $r) {
                $oldNumById[(int) $r['id']] = (int) $r['channel_number'];
            }

            // 3) Перенос маршрутов кабелей (route_channels -> каналы нового направления)
            foreach ($affectedCableIds as $cid) {
                $route = $this->db->fetchAll(
                    "SELECT crc.cable_channel_id
                     FROM cable_route_channels crc
                     WHERE crc.cable_id = :id
                     ORDER BY crc.route_order",
                    ['id' => $cid]
                );
                $routeIds = array_map(fn($r) => (int) ($r['cable_channel_id'] ?? 0), $route);
                $routeIds = array_values(array_filter($routeIds, fn($v) => $v > 0));

                $newRoute = [];
                $prev = null;
                foreach ($routeIds as $chid) {
                    $num = $oldNumById[$chid] ?? null;
                    if ($num !== null) {
                        $rep = $newChByNum[(int) $num] ?? null;
                        if (!$rep) {
                            Response::error('Не удалось сопоставить канал маршрута (channel_number=' . (int) $num . ')', 500);
                        }
                        // убираем подряд идущие дубликаты
                        if ($prev !== $rep) $newRoute[] = (int) $rep;
                        $prev = $rep;
                        continue;
                    }
                    if ($prev !== $chid) $newRoute[] = $chid;
                    $prev = $chid;
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
                if (!empty($newRoute)) {
                    $rows = $this->db->fetchAll(
                        "SELECT cd.start_well_id, cd.end_well_id
                         FROM cable_channels cc
                         JOIN channel_directions cd ON cc.direction_id = cd.id
                         WHERE cc.id IN (" . implode(',', array_map('intval', $newRoute)) . ")"
                    );
                    $routeWells = [];
                    foreach ($rows as $r) {
                        foreach ([(int) $r['start_well_id'], (int) $r['end_well_id']] as $wid) {
                            if ($wid > 0 && !in_array($wid, $routeWells, true)) $routeWells[] = $wid;
                        }
                    }
                    foreach ($routeWells as $order => $wid) {
                        $this->db->insert('cable_route_wells', [
                            'cable_id' => $cid,
                            'well_id' => $wid,
                            'route_order' => (int) $order,
                        ]);
                    }
                }

                $this->updateDuctCableLength($cid);
            }

            // 4) Удаляем старые направления + демонтируемый колодец
            $this->db->delete('object_photos', "object_table = 'channel_directions' AND object_id IN (" . (int) $dir1Id . ", " . (int) $dir2Id . ")");
            $this->db->delete('channel_directions', 'id IN (' . (int) $dir1Id . ', ' . (int) $dir2Id . ')');

            $this->db->delete('object_photos', "object_table = 'wells' AND object_id = :id", ['id' => $wellId]);
            $this->db->delete('wells', 'id = :id', ['id' => $wellId]);

            $this->db->commit();

            Response::success([
                'new_direction_id' => $newDirId,
                'deleted_well_id' => $wellId,
                'deleted_direction_ids' => [$dir1Id, $dir2Id],
                'updated_cable_ids' => $affectedCableIds,
            ], 'Колодец демонтирован');
        } catch (\Throwable $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    private function updateDuctCableLength(int $cableId): void
    {
        // Длина кабеля в канализации:
        // сумма длин всех направлений маршрута + (кол-во уникальных направлений) * K,
        // где K = настройка "cable_in_well_length_m" (учитываемая длина кабеля в колодце)
        $k = (float) $this->getAppSetting('cable_in_well_length_m', 2);
        $this->db->query(
            "UPDATE cables
             SET length_calculated = (
                WITH dirs AS (
                    SELECT DISTINCT cd.id as dir_id,
                           COALESCE(cd.length_m, 0) as len_m
                    FROM cable_route_channels crc
                    JOIN cable_channels cc ON crc.cable_channel_id = cc.id
                    JOIN channel_directions cd ON cc.direction_id = cd.id
                    WHERE crc.cable_id = :cable_id
                )
                SELECT COALESCE(SUM(len_m), 0) + (:k * COALESCE(COUNT(*), 0))
                FROM dirs
             )
             WHERE id = :cable_id",
            ['cable_id' => $cableId, 'k' => $k]
        );
    }

    /**
     * GET /api/wells/export
     * Экспорт колодцев в CSV
     */
    public function export(): void
    {
        try { $this->log('export', 'wells', null, null, ['type' => 'wells']); } catch (\Throwable $e) {}
        $filters = $this->buildFilters([
            'owner_id' => 'w.owner_id',
            'type_id' => 'w.type_id',
            'kind_id' => 'w.kind_id',
            'status_id' => 'w.status_id',
            '_search' => ['w.number', 'w.notes'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];
        $delimiter = $this->normalizeCsvDelimiter($this->request->query('delimiter'), ';');

        $sql = "SELECT w.number, 
                       ST_X(w.geom_wgs84) as longitude, ST_Y(w.geom_wgs84) as latitude,
                       ST_X(w.geom_msk86) as x_msk86, ST_Y(w.geom_msk86) as y_msk86,
                       o.name as owner, ot.name as type, ok.name as kind, os.name as status,
                       w.depth, w.material, w.installation_date, w.notes
                FROM wells w
                LEFT JOIN owners o ON w.owner_id = o.id
                LEFT JOIN object_types ot ON w.type_id = ot.id
                LEFT JOIN object_kinds ok ON w.kind_id = ok.id
                LEFT JOIN object_status os ON w.status_id = os.id";
        
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY w.number";
        
        $data = $this->db->fetchAll($sql, $params);

        // Формируем CSV
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="wells_' . date('Y-m-d') . '.csv"');

        $output = fopen('php://output', 'w');
        
        // BOM для UTF-8
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));
        
        // Заголовки
        fputcsv($output, ['Номер', 'Долгота', 'Широта', 'X (МСК86)', 'Y (МСК86)', 
                         'Собственник', 'Вид', 'Тип', 'Состояние', 'Глубина', 'Материал', 
                         'Дата установки', 'Примечания'], $delimiter);
        
        // Данные
        foreach ($data as $row) {
            fputcsv($output, array_values($row), $delimiter);
        }
        
        fclose($output);
        exit;
    }

    /**
     * POST /api/wells/import-text/preview
     * Предпросмотр импорта колодцев из многострочного текста
     */
    public function importTextPreview(): void
    {
        $this->checkWriteAccess();
        try { $this->log('import', 'wells', null, null, ['stage' => 'preview']); } catch (\Throwable $e) {}

        $text = (string) $this->request->input('text', '');
        $delimiterRaw = (string) $this->request->input('delimiter', ';');
        $delimiter = $this->normalizeCsvDelimiter($delimiterRaw, ';');

        $lines = preg_split("/\r\n|\n|\r/", $text);
        $lines = array_values(array_filter(array_map('trim', $lines), fn($l) => $l !== ''));

        $previewRows = [];
        $maxCols = 0;
        foreach (array_slice($lines, 0, 20) as $line) {
            $row = str_getcsv($line, $delimiter);
            $row = array_map(fn($v) => trim((string) $v), $row ?: []);
            $maxCols = max($maxCols, count($row));
            $previewRows[] = $row;
        }

        Response::success([
            'total_lines' => count($lines),
            'max_columns' => $maxCols,
            'preview' => $previewRows,
            'fields' => [
                'number',
                'longitude',
                'latitude',
            ],
        ]);
    }

    /**
     * POST /api/wells/import-text
     * Импорт колодцев из многострочного текста с сопоставлением колонок
     */
    public function importText(): void
    {
        $this->checkWriteAccess();
        try { $this->log('import', 'wells', null, null, ['stage' => 'apply']); } catch (\Throwable $e) {}

        $text = (string) $this->request->input('text', '');
        $delimiterRaw = (string) $this->request->input('delimiter', ';');
        $delimiter = $this->normalizeCsvDelimiter($delimiterRaw, ';');
        $mapping = $this->request->input('mapping', []);
        // По ТЗ: только WGS84
        $coordinateSystem = 'wgs84';

        if (!is_array($mapping)) {
            Response::error('Некорректное сопоставление колонок', 422);
        }

        // Значения по умолчанию (выбираются пользователем в шапке)
        $defaultOwnerId = (int) $this->request->input('default_owner_id', 0);
        $defaultKindId = (int) $this->request->input('default_kind_id', 0);
        $defaultStatusId = (int) $this->request->input('default_status_id', 0);
        if ($defaultOwnerId <= 0 || $defaultKindId <= 0 || $defaultStatusId <= 0) {
            Response::error('Необходимо выбрать собственника, тип и состояние', 422);
        }

        // Разрешённые поля сопоставления колонок
        $allowedMapFields = ['number', 'longitude', 'latitude'];
        foreach ($mapping as $k => $v) {
            if ($v === null || $v === '' || $v === 'ignore') continue;
            if (!in_array($v, $allowedMapFields, true)) {
                Response::error('Недопустимое поле сопоставления: ' . (string) $v, 422);
            }
        }

        // type_id для колодцев определяем по системному коду object_types.code='well'
        $wellTypeRow = $this->db->fetch("SELECT id FROM object_types WHERE code = 'well' LIMIT 1");
        $wellTypeId = (int) ($wellTypeRow['id'] ?? 0);
        if ($wellTypeId <= 0) {
            Response::error('Не удалось определить вид объекта "well" (object_types)', 500);
        }

        // Код собственника нужен для формирования номера
        $ownerRow = $this->db->fetch("SELECT code FROM owners WHERE id = :id", ['id' => $defaultOwnerId]);
        $ownerCode = trim((string) ($ownerRow['code'] ?? ''));
        if ($ownerCode === '') {
            Response::error('Не удалось определить код собственника', 422);
        }
        $numberPrefix = "ККС-{$ownerCode}-";

        $lines = preg_split("/\r\n|\n|\r/", $text);
        $lines = array_values(array_filter(array_map('trim', $lines), fn($l) => $l !== ''));

        if (count($lines) === 0) {
            Response::error('Пустой текст для импорта', 422);
        }

        $user = Auth::user();

        // Кэши справочников (поиск id по коду/имени)
        $ownersByKey = [];
        $typesByKey = [];
        $kindsByKey = [];
        $statusByKey = [];

        $resolve = function (string $field, string $value) use (&$ownersByKey, &$typesByKey, &$kindsByKey, &$statusByKey) {
            $v = trim($value);
            if ($v === '') return null;
            if (is_numeric($v)) return (int) $v;

            $key = function_exists('mb_strtolower') ? mb_strtolower($v) : strtolower($v);
            $cache = null;
            $table = null;
            $sql = null;

            if ($field === 'owner_id') {
                $cache = &$ownersByKey;
                $table = 'owners';
                $sql = "SELECT id FROM owners WHERE LOWER(code) = :k OR LOWER(name) = :k OR LOWER(COALESCE(short_name, '')) = :k LIMIT 1";
            } elseif ($field === 'type_id') {
                $cache = &$typesByKey;
                $table = 'object_types';
                $sql = "SELECT id FROM object_types WHERE LOWER(code) = :k OR LOWER(name) = :k LIMIT 1";
            } elseif ($field === 'kind_id') {
                $cache = &$kindsByKey;
                $table = 'object_kinds';
                $sql = "SELECT id FROM object_kinds WHERE LOWER(code) = :k OR LOWER(name) = :k LIMIT 1";
            } elseif ($field === 'status_id') {
                $cache = &$statusByKey;
                $table = 'object_status';
                $sql = "SELECT id FROM object_status WHERE LOWER(code) = :k OR LOWER(name) = :k LIMIT 1";
            } else {
                return $v;
            }

            if (isset($cache[$key])) return $cache[$key];

            $db = $this->db;
            $row = $db->fetch($sql, ['k' => $key]);
            $cache[$key] = $row ? (int) $row['id'] : null;
            return $cache[$key];
        };

        $created = [];
        $errors = [];
        $imported = 0;

        try {
            $this->db->beginTransaction();

            foreach ($lines as $idx => $line) {
                $lineNo = $idx + 1;
                try {
                    $cols = str_getcsv($line, $delimiter);
                    $cols = array_map(fn($v) => trim((string) $v), $cols ?: []);

                    $data = [];
                    foreach ($mapping as $colIndex => $fieldName) {
                        if ($fieldName === null || $fieldName === '' || $fieldName === 'ignore') continue;
                        $i = (int) $colIndex;
                        $val = $cols[$i] ?? '';
                        $val = is_string($val) ? trim($val) : $val;
                        $data[$fieldName] = ($val === '' ? null : $val);
                    }

                    // Номер колодца: ККС-<код собственника>-<суффикс из колонки number>
                    $suffix = trim((string) ($data['number'] ?? ''));
                    if ($suffix === '') {
                        throw new \RuntimeException('Не указан суффикс номера (колонка "Номер")');
                    }
                    $number = str_starts_with($suffix, $numberPrefix) ? $suffix : ($numberPrefix . $suffix);
                    $len = function_exists('mb_strlen') ? mb_strlen($number) : strlen($number);
                    if ($len > 50) {
                        throw new \RuntimeException('Номер слишком длинный (max 50)');
                    }

                    // Справочники (type_id фиксированный для колодцев)
                    $data['type_id'] = $wellTypeId;

                    // owner/kind/status только из шапки
                    $data['owner_id'] = $defaultOwnerId;
                    $data['kind_id'] = $defaultKindId;
                    $data['status_id'] = $defaultStatusId;

                    // Координаты
                    $lon = $data['longitude'] ?? null;
                    $lat = $data['latitude'] ?? null;
                    if ($lon === null || $lat === null || !is_numeric($lon) || !is_numeric($lat)) {
                        throw new \RuntimeException('Не указаны корректные координаты Долгота/Широта (WGS84)');
                    }

                    // Опциональные поля
                    $optional = [
                        'depth' => 'numeric',
                        'material' => 'string',
                        'installation_date' => 'date',
                        'notes' => 'string',
                    ];
                    foreach ($optional as $field => $kind) {
                        if (!array_key_exists($field, $data)) continue;
                        if ($data[$field] === null) continue;
                        if ($kind === 'numeric' && !is_numeric($data[$field])) {
                            throw new \RuntimeException("Некорректное значение {$field}");
                        }
                        if ($kind === 'date') {
                            $ts = strtotime((string) $data[$field]);
                            if ($ts === false) {
                                throw new \RuntimeException("Некорректная дата {$field}");
                            }
                            $data[$field] = date('Y-m-d', $ts);
                        }
                    }

                    // created/updated
                    $data['created_by'] = $user['id'];
                    $data['updated_by'] = $user['id'];
                    $data['number'] = $number;

                    // Вставка
                    $sql = "INSERT INTO wells (number, geom_wgs84, owner_id, type_id, kind_id, status_id, depth, material, installation_date, notes, created_by, updated_by)
                            VALUES (:number, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326),
                                    :owner_id, :type_id, :kind_id, :status_id, :depth, :material, :installation_date, :notes, :created_by, :updated_by)
                            RETURNING id";
                    $params = [
                        'number' => $data['number'],
                        'lon' => (float) $lon,
                        'lat' => (float) $lat,
                        'owner_id' => $data['owner_id'],
                        'type_id' => $wellTypeId,
                        'kind_id' => $data['kind_id'],
                        'status_id' => $data['status_id'],
                        'depth' => $data['depth'] ?? null,
                        'material' => $data['material'] ?? null,
                        'installation_date' => $data['installation_date'] ?? null,
                        'notes' => $data['notes'] ?? null,
                        'created_by' => $data['created_by'],
                        'updated_by' => $data['updated_by'],
                    ];

                    $stmt = $this->db->query($sql, $params);
                    $newId = (int) $stmt->fetchColumn();
                    $imported++;
                    $created[] = ['line' => $lineNo, 'id' => $newId, 'number' => $data['number']];
                } catch (\Throwable $e) {
                    $errors[] = ['line' => $lineNo, 'error' => $e->getMessage()];
                }
            }

            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollback();
            Response::error('Ошибка импорта: ' . $e->getMessage(), 500);
        }

        Response::success([
            'imported' => $imported,
            'created' => $created,
            'errors' => $errors,
        ], "Импортировано {$imported} записей");
    }
}

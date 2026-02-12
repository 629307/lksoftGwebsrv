<?php
/**
 * Контроллер унифицированных кабелей
 * Поддерживает: Кабель в грунте, Воздушный кабель, Кабель в канализации
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class UnifiedCableController extends BaseController
{
    // Коды видов объектов для кабелей
    private array $allowedObjectTypes = ['cable_ground', 'cable_aerial', 'cable_duct'];

    /**
     * GET /api/unified-cables
     * Список всех кабелей
     */
    public function index(): void
    {
        $pagination = $this->getPagination();
        
        $filters = $this->buildFilters([
            'owner_id' => 'c.owner_id',
            'object_type_id' => 'c.object_type_id',
            'cable_type_id' => 'c.cable_type_id',
            'status_id' => 'c.status_id',
            'contract_id' => 'c.contract_id',
            '_search' => ['c.number', 'c.notes', 'cc.marking'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        // total с JOIN'ами, чтобы работал поиск по cc.marking
        $totalSql = "SELECT COUNT(*) as cnt
                     FROM cables c
                     LEFT JOIN cable_catalog cc ON c.cable_catalog_id = cc.id";
        if ($where) {
            $totalSql .= " WHERE {$where}";
        }
        $total = (int) ($this->db->fetch($totalSql, $params)['cnt'] ?? 0);

        $sql = "SELECT c.id, c.number, 
                       c.cable_catalog_id, cc.marking as cable_marking, cc.fiber_count,
                       c.cable_type_id, ct.name as cable_type_name,
                       c.owner_id, o.name as owner_name,
                       c.object_type_id, ot.code as object_type_code, ot.name as object_type_name,
                       c.status_id, os.name as status_name,
                       (SELECT COUNT(*) FROM object_photos op WHERE op.object_table = 'cables' AND op.object_id = c.id) as photo_count,
                       c.length_calculated, c.length_declared,
                       c.installation_date, c.notes,
                       c.created_at, c.updated_at
                FROM cables c
                LEFT JOIN cable_catalog cc ON c.cable_catalog_id = cc.id
                LEFT JOIN cable_types ct ON c.cable_type_id = ct.id
                LEFT JOIN owners o ON c.owner_id = o.id
                LEFT JOIN object_types ot ON c.object_type_id = ot.id
                LEFT JOIN object_status os ON c.status_id = os.id";
        
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $order = strtolower((string) $this->request->query('order', 'asc'));
        if (!in_array($order, ['asc', 'desc'], true)) $order = 'asc';
        $sql .= " ORDER BY c.number {$order} LIMIT :limit OFFSET :offset";
        
        $params['limit'] = $pagination['limit'];
        $params['offset'] = $pagination['offset'];
        
        $data = $this->db->fetchAll($sql, $params);

        Response::paginated($data, $total, $pagination['page'], $pagination['limit']);
    }

    /**
     * GET /api/unified-cables/export
     * Экспорт унифицированных кабелей в CSV (с учётом фильтров и поиска)
     */
    public function export(): void
    {
        $filters = $this->buildFilters([
            'owner_id' => 'c.owner_id',
            'object_type_id' => 'c.object_type_id',
            'cable_type_id' => 'c.cable_type_id',
            'status_id' => 'c.status_id',
            'contract_id' => 'c.contract_id',
            '_search' => ['c.number', 'c.notes', 'cc.marking'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];
        $delimiter = $this->normalizeCsvDelimiter($this->request->query('delimiter'), ';');

        $sql = "SELECT c.number,
                       ot.name as object_type,
                       ct.name as cable_type,
                       cc.marking as cable_marking,
                       cc.fiber_count,
                       o.name as owner,
                       con.number as contract_number,
                       con.name as contract_name,
                       os.name as status,
                       c.length_calculated,
                       c.length_declared,
                       c.installation_date,
                       c.notes
                FROM cables c
                LEFT JOIN cable_catalog cc ON c.cable_catalog_id = cc.id
                LEFT JOIN cable_types ct ON c.cable_type_id = ct.id
                LEFT JOIN owners o ON c.owner_id = o.id
                LEFT JOIN object_types ot ON c.object_type_id = ot.id
                LEFT JOIN object_status os ON c.status_id = os.id
                LEFT JOIN contracts con ON c.contract_id = con.id";

        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY c.number";

        $data = $this->db->fetchAll($sql, $params);

        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="cables_' . date('Y-m-d') . '.csv"');

        $output = fopen('php://output', 'w');
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));

        fputcsv($output, [
            'Номер', 'Вид объекта', 'Тип кабеля', 'Маркировка', 'Волокон',
            'Собственник', 'Контракт №', 'Контракт', 'Состояние',
            'Длина расч. (м)', 'Длина заявл. (м)', 'Дата установки', 'Примечания'
        ], $delimiter);

        foreach ($data as $row) {
            fputcsv($output, array_values($row), $delimiter);
        }
        fclose($output);
        exit;
    }

    /**
     * GET /api/unified-cables/stats
     * Агрегации по текущему фильтру (кол-во и сумма длины)
     */
    public function stats(): void
    {
        $filters = $this->buildFilters([
            'owner_id' => 'c.owner_id',
            'object_type_id' => 'c.object_type_id',
            'cable_type_id' => 'c.cable_type_id',
            'status_id' => 'c.status_id',
            'contract_id' => 'c.contract_id',
            '_search' => ['c.number', 'c.notes', 'cc.marking'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        $sql = "SELECT COUNT(*) as cnt,
                       COALESCE(SUM(c.length_calculated), 0) as length_sum
                FROM cables c
                LEFT JOIN cable_catalog cc ON c.cable_catalog_id = cc.id";
        if ($where) {
            $sql .= " WHERE {$where}";
        }

        $row = $this->db->fetch($sql, $params) ?: ['cnt' => 0, 'length_sum' => 0];

        Response::success([
            'count' => (int) ($row['cnt'] ?? 0),
            'length_sum' => (float) ($row['length_sum'] ?? 0),
        ]);
    }

    /**
     * GET /api/unified-cables/geojson
     * GeoJSON кабелей для карты (только для кабелей с геометрией)
     */
    public function geojson(): void
    {
        $filters = $this->buildFilters([
            'owner_id' => 'c.owner_id',
            'object_type_id' => 'c.object_type_id',
            'status_id' => 'c.status_id',
            'contract_id' => 'c.contract_id',
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        // Кабели с геометрией: грунт/воздух — из geom_wgs84, канализация — собираем из направлений маршрута
        $geomCondition = "(c.geom_wgs84 IS NOT NULL OR ot.code = 'cable_duct')";
        if ($where) {
            $where = "{$geomCondition} AND ({$where})";
        } else {
            $where = $geomCondition;
        }

        $sql = "SELECT c.id, c.number, c.length_calculated,
                       CASE 
                           WHEN ot.code = 'cable_duct' THEN (
                               SELECT ST_AsGeoJSON(ST_Collect(cd.geom_wgs84))::json
                               FROM cable_route_channels crc
                               JOIN cable_channels cc2 ON crc.cable_channel_id = cc2.id
                               JOIN channel_directions cd ON cc2.direction_id = cd.id
                               WHERE crc.cable_id = c.id AND cd.geom_wgs84 IS NOT NULL
                           )
                           ELSE ST_AsGeoJSON(c.geom_wgs84)::json
                       END as geometry,
                       c.owner_id, o.name as owner_name,
                       ot.code as object_type_code, ot.name as object_type_name, ot.color as object_type_color,
                       ct.name as cable_type_name,
                       os.code as status_code, os.name as status_name, os.color as status_color,
                       cc.fiber_count, cc.marking
                FROM cables c
                LEFT JOIN cable_catalog cc ON c.cable_catalog_id = cc.id
                LEFT JOIN cable_types ct ON c.cable_type_id = ct.id
                LEFT JOIN owners o ON c.owner_id = o.id
                LEFT JOIN object_types ot ON c.object_type_id = ot.id
                LEFT JOIN object_status os ON c.status_id = os.id
                WHERE {$where}";
        
        $data = $this->db->fetchAll($sql, $params);

        $features = [];
        foreach ($data as $row) {
            $geometry = is_string($row['geometry']) ? json_decode($row['geometry'], true) : $row['geometry'];
            unset($row['geometry']);
            
            if (empty($geometry) || !isset($geometry['type'])) {
                continue;
            }
            
            $features[] = [
                'type' => 'Feature',
                'geometry' => $geometry,
                'properties' => $row,
            ];
        }

        Response::geojson($features, ['layer' => 'cables', 'count' => count($features)]);
    }

    /**
     * GET /api/unified-cables/{id}
     * Получение кабеля
     */
    public function show(string $id): void
    {
        $cable = $this->db->fetch(
            "SELECT c.*, 
                    CASE
                        WHEN ot.code = 'cable_duct' THEN (
                            SELECT ST_AsGeoJSON(ST_Collect(cd.geom_wgs84))::json
                            FROM cable_route_channels crc
                            JOIN cable_channels cc2 ON crc.cable_channel_id = cc2.id
                            JOIN channel_directions cd ON cc2.direction_id = cd.id
                            WHERE crc.cable_id = c.id AND cd.geom_wgs84 IS NOT NULL
                        )
                        ELSE ST_AsGeoJSON(c.geom_wgs84)::json
                    END as geometry,
                    cc.marking as cable_marking, cc.fiber_count,
                    ct.code as cable_type_code, ct.name as cable_type_name,
                    o.name as owner_name,
                    ot.code as object_type_code, ot.name as object_type_name,
                    os.name as status_name, os.color as status_color,
                    con.number as contract_number, con.name as contract_name
             FROM cables c
             LEFT JOIN cable_catalog cc ON c.cable_catalog_id = cc.id
             LEFT JOIN cable_types ct ON c.cable_type_id = ct.id
             LEFT JOIN owners o ON c.owner_id = o.id
             LEFT JOIN object_types ot ON c.object_type_id = ot.id
             LEFT JOIN object_status os ON c.status_id = os.id
             LEFT JOIN contracts con ON c.contract_id = con.id
             WHERE c.id = :id",
            ['id' => (int) $id]
        );

        if (!$cable) {
            Response::error('Кабель не найден', 404);
        }

        // Для кабелей в канализации загружаем маршрут (колодцы и каналы)
        if ($cable['object_type_code'] === 'cable_duct') {
            $cable['route_wells'] = $this->db->fetchAll(
                "SELECT crw.*, w.number as well_number 
                 FROM cable_route_wells crw
                 JOIN wells w ON crw.well_id = w.id
                 WHERE crw.cable_id = :id
                 ORDER BY crw.route_order",
                ['id' => (int) $id]
            );
            
            $cable['route_channels'] = $this->db->fetchAll(
                "SELECT crc.*, cc.channel_number, cc.direction_id, cd.number as direction_number,
                        cd.length_m as direction_length
                 FROM cable_route_channels crc
                 JOIN cable_channels cc ON crc.cable_channel_id = cc.id
                 JOIN channel_directions cd ON cc.direction_id = cd.id
                 WHERE crc.cable_id = :id
                 ORDER BY crc.route_order",
                ['id' => (int) $id]
            );
        }

        // Фотографии
        $photos = $this->db->fetchAll(
            "SELECT id, filename, original_filename, description, created_at 
             FROM object_photos 
             WHERE object_table = 'cables' AND object_id = :id 
             ORDER BY sort_order",
            ['id' => (int) $id]
        );
        $cable['photos'] = $photos;

        Response::success($cable);
    }

    /**
     * POST /api/unified-cables
     * Создание кабеля
     */
    public function store(): void
    {
        $this->checkWriteAccess();

        $errors = $this->request->validate([
            'object_type_id' => 'required|integer',
            'owner_id' => 'required|integer',
        ]);

        if (!empty($errors)) {
            Response::error('Ошибка валидации', 422, $errors);
        }

        // Проверяем, что вид объекта допустимый
        $objectTypeId = (int) $this->request->input('object_type_id');
        $objectType = $this->db->fetch(
            "SELECT code FROM object_types WHERE id = :id",
            ['id' => $objectTypeId]
        );

        if (!$objectType || !in_array($objectType['code'], $this->allowedObjectTypes)) {
            Response::error('Недопустимый вид объекта. Разрешены: Кабель в грунте, Воздушный кабель, Кабель в канализации', 422);
        }

        $data = $this->request->only([
            'number', 'cable_catalog_id', 'cable_type_id', 'owner_id', 'object_type_id',
            'status_id', 'contract_id', 'length_declared', 'installation_date', 'notes'
        ]);

        // Контракт может быть пустым (NULL)
        if (array_key_exists('contract_id', $data)) {
            $v = $data['contract_id'];
            if ($v === '' || $v === '0' || $v === 0) {
                $data['contract_id'] = null;
            }
        }

        // Формирование номера (авто по диапазону собственника + опциональный суффикс)
        $suffix = $this->request->input('number_suffix');
        $data['number'] = $this->buildAutoNumber(
            'cables',
            (int) ($data['object_type_id'] ?? 0),
            (int) ($data['owner_id'] ?? 0),
            null,
            ($suffix !== null) ? (string) $suffix : null
        );

        // Убедиться, что все необязательные поля присутствуют (даже если null)
        $optionalFields = ['contract_id', 'length_declared', 'installation_date', 'notes'];
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

            // Для кабелей в грунте и воздушных - создаём геометрию из координат
            if (in_array($objectType['code'], ['cable_ground', 'cable_aerial'])) {
                $coordinates = $this->request->input('coordinates');
                
                if (empty($coordinates) || !is_array($coordinates) || count($coordinates) < 2) {
                    Response::error('Для кабеля в грунте или воздушного необходимо указать минимум 2 точки координат', 422);
                }

                $coordinateSystem = $this->request->input('coordinate_system', 'wgs84');
                // Проверяем корректность координат и формируем строку
                $cleanCoords = [];
                foreach ($coordinates as $p) {
                    if (!is_array($p) || count($p) < 2 || !is_numeric($p[0]) || !is_numeric($p[1])) {
                        Response::error('Некорректные координаты кабеля', 422);
                    }
                    $cleanCoords[] = [(float) $p[0], (float) $p[1]];
                }
                $coordsStr = implode(', ', array_map(fn($p) => "{$p[0]} {$p[1]}", $cleanCoords));

                if ($coordinateSystem === 'wgs84') {
                    $sql = "INSERT INTO cables (number, geom_wgs84, geom_msk86, cable_catalog_id, cable_type_id, 
                                               owner_id, object_type_id, status_id, contract_id,
                                               length_calculated, length_declared, installation_date, notes, 
                                               created_by, updated_by)
                            VALUES (:number,
                                    ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 4326),
                                    ST_Transform(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 4326), 200004),
                                    :cable_catalog_id, :cable_type_id, :owner_id, :object_type_id, :status_id, :contract_id,
                                    ROUND(ST_Length(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 4326)::geography)::numeric, 2),
                                    :length_declared, :installation_date, :notes, :created_by, :updated_by)
                            RETURNING id";
                } else {
                    $sql = "INSERT INTO cables (number, geom_wgs84, geom_msk86, cable_catalog_id, cable_type_id,
                                               owner_id, object_type_id, status_id, contract_id,
                                               length_calculated, length_declared, installation_date, notes,
                                               created_by, updated_by)
                            VALUES (:number,
                                    ST_Transform(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 200004), 4326),
                                    ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 200004),
                                    :cable_catalog_id, :cable_type_id, :owner_id, :object_type_id, :status_id, :contract_id,
                                    ROUND(ST_Length(ST_Transform(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 200004), 4326)::geography)::numeric, 2),
                                    :length_declared, :installation_date, :notes, :created_by, :updated_by)
                            RETURNING id";
                }

                $stmt = $this->db->query($sql, $data);
                $id = $stmt->fetchColumn();

            } else {
                // Кабель в канализации - без геометрии, но с маршрутом
                $id = $this->db->insert('cables', $data);
                
                // Добавляем каналы маршрута
                $routeChannels = $this->request->input('route_channels', []);
                if (!is_array($routeChannels)) {
                    Response::error('Некорректный маршрут каналов', 422);
                }
                $routeChannels = array_values(array_filter(array_map('intval', $routeChannels), fn($v) => $v > 0));
                if (count($routeChannels) !== count(array_unique($routeChannels))) {
                    Response::error('Маршрут кабеля не может содержать повтор одного и того же канала', 422);
                }
                if (!empty($routeChannels)) {
                    $rows = $this->db->fetchAll(
                        "SELECT cc.id, cc.direction_id
                         FROM cable_channels cc
                         WHERE cc.id IN (" . implode(',', array_map('intval', $routeChannels)) . ")"
                    );
                    $dirIds = array_map(fn($r) => (int) ($r['direction_id'] ?? 0), $rows);
                    $dirIds = array_values(array_filter($dirIds, fn($v) => $v > 0));
                    if (count($dirIds) !== count($routeChannels)) {
                        Response::error('Некорректный маршрут каналов', 422);
                    }
                    if (count($dirIds) !== count(array_unique($dirIds))) {
                        Response::error('Маршрут кабеля не может содержать повтор одного и того же направления', 422);
                    }
                }
                foreach ($routeChannels as $order => $channelId) {
                    $this->db->insert('cable_route_channels', [
                        'cable_id' => $id,
                        'cable_channel_id' => $channelId,
                        'route_order' => $order
                    ]);
                }

                // Автоматически добавляем колодцы маршрута по направлениям выбранных каналов
                $routeWells = [];
                if (!empty($routeChannels)) {
                    $rows = $this->db->fetchAll(
                        "SELECT cd.start_well_id, cd.end_well_id
                         FROM cable_channels cc
                         JOIN channel_directions cd ON cc.direction_id = cd.id
                         WHERE cc.id IN (" . implode(',', array_map('intval', $routeChannels)) . ")"
                    );
                    foreach ($rows as $r) {
                        foreach ([(int) $r['start_well_id'], (int) $r['end_well_id']] as $wid) {
                            if ($wid > 0 && !in_array($wid, $routeWells, true)) {
                                $routeWells[] = $wid;
                            }
                        }
                    }
                }
                foreach ($routeWells as $order => $wellId) {
                    $this->db->insert('cable_route_wells', [
                        'cable_id' => $id,
                        'well_id' => $wellId,
                        'route_order' => $order
                    ]);
                }
                
                // Рассчитываем длину на основе направлений
                $this->updateDuctCableLength($id);
            }

            $this->db->commit();

            $cable = $this->db->fetch(
                "SELECT *, ST_AsGeoJSON(geom_wgs84)::json as geometry FROM cables WHERE id = :id",
                ['id' => $id]
            );

            $this->log('create', 'cables', $id, null, $cable);

            Response::success($cable, 'Кабель создан', 201);
        } catch (\PDOException $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /**
     * PUT /api/unified-cables/{id}
     * Обновление кабеля
     */
    public function update(string $id): void
    {
        $this->checkWriteAccess();
        $cableId = (int) $id;

        $oldCable = $this->db->fetch(
            "SELECT c.*, ot.code as object_type_code FROM cables c 
             LEFT JOIN object_types ot ON c.object_type_id = ot.id
             WHERE c.id = :id",
            ['id' => $cableId]
        );
        
        if (!$oldCable) {
            Response::error('Кабель не найден', 404);
        }

        $data = $this->request->only([
            // number может пересобираться при смене собственника/суффикса
            'cable_catalog_id', 'cable_type_id', 'owner_id',
            'status_id', 'contract_id', 'length_declared', 'installation_date', 'notes'
        ]);

        // Контракт может быть очищен до NULL (в UI: "не указан")
        if (array_key_exists('contract_id', $data)) {
            $v = $data['contract_id'];
            if ($v === '' || $v === '0' || $v === 0) {
                $data['contract_id'] = null;
            }
        }

        // Фильтруем null значения, но сохраняем contract_id если он явно передан (чтобы можно было очистить)
        foreach (array_keys($data) as $k) {
            if ($data[$k] === null && $k !== 'contract_id') {
                unset($data[$k]);
            }
        }

        // Требование: при смене собственника должен меняться код собственника в номере.
        // Также разрешаем редактировать суффикс номера (number_suffix).
        $oldNumber = (string) ($oldCable['number'] ?? '');
        $oldParts = $this->parseNumberSeqAndSuffix($oldNumber);
        $oldSeq = $oldParts['seq'] ?? null;
        $oldSuffix = $this->sanitizeNumberSuffix((string) ($oldParts['suffix'] ?? ''));

        $requestedSuffix = $this->request->input('number_suffix'); // может отсутствовать
        $newSuffix = ($requestedSuffix !== null) ? $this->sanitizeNumberSuffix((string) $requestedSuffix) : $oldSuffix;

        $newOwnerId = array_key_exists('owner_id', $data) ? (int) $data['owner_id'] : (int) ($oldCable['owner_id'] ?? 0);
        $needRenumber =
            ($newOwnerId !== (int) ($oldCable['owner_id'] ?? 0)) ||
            ($newSuffix !== $oldSuffix);

        if ($needRenumber) {
            $typeId = (int) ($oldCable['object_type_id'] ?? 0);
            $manualSeq = (is_int($oldSeq) && $oldSeq >= 1) ? (int) $oldSeq : null;
            $data['number'] = $this->buildAutoNumber(
                'cables',
                $typeId,
                $newOwnerId,
                $manualSeq,
                ($newSuffix !== '') ? $newSuffix : null,
                $cableId,
                1
            );
        }

        $user = Auth::user();
        $data['updated_by'] = $user['id'];

        try {
            $this->db->beginTransaction();

            // Обновляем координаты если переданы (только для кабелей с геометрией)
            if (in_array($oldCable['object_type_code'], ['cable_ground', 'cable_aerial'])) {
                $coordinates = $this->request->input('coordinates');
                if ($coordinates && is_array($coordinates) && count($coordinates) >= 2) {
                    $coordsStr = implode(', ', array_map(fn($p) => "{$p[0]} {$p[1]}", $coordinates));
                    $coordinateSystem = $this->request->input('coordinate_system', 'wgs84');

                    if ($coordinateSystem === 'wgs84') {
                        $this->db->query(
                            "UPDATE cables SET 
                                geom_wgs84 = ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 4326),
                                geom_msk86 = ST_Transform(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 4326), 200004),
                                length_calculated = ROUND(ST_Length(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 4326)::geography)::numeric, 2)
                             WHERE id = :id",
                            ['id' => $cableId]
                        );
                    } else {
                        $this->db->query(
                            "UPDATE cables SET 
                                geom_msk86 = ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 200004),
                                geom_wgs84 = ST_Transform(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 200004), 4326),
                                length_calculated = ROUND(ST_Length(ST_Transform(ST_SetSRID(ST_GeomFromText('MULTILINESTRING(({$coordsStr}))'), 200004), 4326)::geography)::numeric, 2)
                             WHERE id = :id",
                            ['id' => $cableId]
                        );
                    }
                }
            }

            // Для кабелей в канализации - обновляем маршрут
            if ($oldCable['object_type_code'] === 'cable_duct') {
                $routeWells = $this->request->input('route_wells');
                $routeChannels = $this->request->input('route_channels');
                if ($routeChannels !== null) {
                    if (!is_array($routeChannels)) {
                        Response::error('Некорректный маршрут каналов', 422);
                    }
                    $routeChannels = array_values(array_filter(array_map('intval', $routeChannels), fn($v) => $v > 0));
                    if (count($routeChannels) !== count(array_unique($routeChannels))) {
                        Response::error('Маршрут кабеля не может содержать повтор одного и того же канала', 422);
                    }
                    if (!empty($routeChannels)) {
                        $rows = $this->db->fetchAll(
                            "SELECT cc.id, cc.direction_id
                             FROM cable_channels cc
                             WHERE cc.id IN (" . implode(',', array_map('intval', $routeChannels)) . ")"
                        );
                        $dirIds = array_map(fn($r) => (int) ($r['direction_id'] ?? 0), $rows);
                        $dirIds = array_values(array_filter($dirIds, fn($v) => $v > 0));
                        if (count($dirIds) !== count($routeChannels)) {
                            Response::error('Некорректный маршрут каналов', 422);
                        }
                        if (count($dirIds) !== count(array_unique($dirIds))) {
                            Response::error('Маршрут кабеля не может содержать повтор одного и того же направления', 422);
                        }
                    }
                    $this->db->delete('cable_route_channels', 'cable_id = :id', ['id' => $cableId]);
                    foreach ($routeChannels as $order => $channelId) {
                        $this->db->insert('cable_route_channels', [
                            'cable_id' => $cableId,
                            'cable_channel_id' => $channelId,
                            'route_order' => $order
                        ]);
                    }

                    // Пересобираем колодцы маршрута автоматически из направлений выбранных каналов
                    $this->db->delete('cable_route_wells', 'cable_id = :id', ['id' => $cableId]);
                    $routeWellsAuto = [];
                    if (!empty($routeChannels)) {
                        $rows = $this->db->fetchAll(
                            "SELECT cd.start_well_id, cd.end_well_id
                             FROM cable_channels cc
                             JOIN channel_directions cd ON cc.direction_id = cd.id
                             WHERE cc.id IN (" . implode(',', array_map('intval', $routeChannels)) . ")"
                        );
                        foreach ($rows as $r) {
                            foreach ([(int) $r['start_well_id'], (int) $r['end_well_id']] as $wid) {
                                if ($wid > 0 && !in_array($wid, $routeWellsAuto, true)) {
                                    $routeWellsAuto[] = $wid;
                                }
                            }
                        }
                    }
                    foreach ($routeWellsAuto as $order => $wellId) {
                        $this->db->insert('cable_route_wells', [
                            'cable_id' => $cableId,
                            'well_id' => $wellId,
                            'route_order' => $order
                        ]);
                    }
                    
                    // Пересчитываем длину
                    $this->updateDuctCableLength($cableId);
                }
            }

            if (!empty($data)) {
                $this->db->update('cables', $data, 'id = :id', ['id' => $cableId]);
            }

            $this->db->commit();

            $cable = $this->db->fetch(
                "SELECT *, ST_AsGeoJSON(geom_wgs84)::json as geometry FROM cables WHERE id = :id",
                ['id' => $cableId]
            );

            $this->log('update', 'cables', $cableId, $oldCable, $cable);

            Response::success($cable, 'Кабель обновлён');
        } catch (\PDOException $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /**
     * DELETE /api/unified-cables/{id}
     * Удаление кабеля
     */
    public function destroy(string $id): void
    {
        $this->checkDeleteAccess();
        $cableId = (int) $id;

        $cable = $this->db->fetch("SELECT * FROM cables WHERE id = :id", ['id' => $cableId]);
        if (!$cable) {
            Response::error('Кабель не найден', 404);
        }

        try {
            $this->db->beginTransaction();
            
            // Удаляем связанные данные
            $this->db->delete('cable_route_wells', 'cable_id = :id', ['id' => $cableId]);
            $this->db->delete('cable_route_channels', 'cable_id = :id', ['id' => $cableId]);
            $this->db->delete('object_photos', "object_table = 'cables' AND object_id = :id", ['id' => $cableId]);
            $this->db->delete('group_cables', 'cable_id = :id', ['id' => $cableId]);
            $this->db->delete('cables', 'id = :id', ['id' => $cableId]);

            $this->db->commit();

            $this->log('delete', 'cables', $cableId, $cable, null);

            Response::success(null, 'Кабель удалён');
        } catch (\PDOException $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /**
     * GET /api/unified-cables/object-types
     * Получение допустимых видов объектов для кабелей
     */
    public function objectTypes(): void
    {
        $types = $this->db->fetchAll(
            "SELECT id, code, name, color, is_default, COALESCE(NULLIF(number_code,''), code) as number_code
             FROM object_types
             WHERE code IN ('cable_ground', 'cable_aerial', 'cable_duct')
             ORDER BY is_default DESC, id"
        );
        Response::success($types);
    }

    /**
     * GET /api/unified-cables/exists?number=...&exclude_id=...
     * Проверка уникальности номера кабеля (для UI)
     */
    public function existsNumber(): void
    {
        $number = trim((string) $this->request->query('number', ''));
        $excludeId = (int) $this->request->query('exclude_id', 0);

        if ($number === '') {
            Response::success(['exists' => false]);
        }

        $sql = "SELECT id FROM cables WHERE number = :number";
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
     * GET /api/unified-cables/{id}/recalculate-length
     * Пересчёт длины кабеля в канализации
     */
    public function recalculateLength(string $id): void
    {
        $cableId = (int) $id;
        
        $cable = $this->db->fetch(
            "SELECT c.*, ot.code as object_type_code FROM cables c 
             LEFT JOIN object_types ot ON c.object_type_id = ot.id
             WHERE c.id = :id",
            ['id' => $cableId]
        );

        if (!$cable) {
            Response::error('Кабель не найден', 404);
        }

        if ($cable['object_type_code'] !== 'cable_duct') {
            Response::error('Пересчёт длины доступен только для кабелей в канализации', 400);
        }

        $this->updateDuctCableLength($cableId);

        $updatedCable = $this->db->fetch(
            "SELECT length_calculated FROM cables WHERE id = :id",
            ['id' => $cableId]
        );

        Response::success([
            'cable_id' => $cableId,
            'length_calculated' => $updatedCable['length_calculated']
        ], 'Длина пересчитана');
    }

    /**
     * POST /api/unified-cables/recalculate-lengths
     * Массовый пересчёт длины кабелей в канализации по маршрутам
     */
    public function recalculateLengths(): void
    {
        if (!(Auth::isAdmin() || Auth::canWrite())) {
            Response::error('Недостаточно прав', 403);
        }

        $row = $this->db->fetch("SELECT id FROM object_types WHERE code = 'cable_duct' LIMIT 1");
        $otId = (int) ($row['id'] ?? 0);
        if ($otId <= 0) {
            Response::error('Не найден вид объекта cable_duct', 500);
        }

        $k = (float) $this->getAppSetting('cable_in_well_length_m', 2);

        // Пересчитываем только duct-кабели: sum(length_m направлений маршрута) + K * count(distinct direction)
        $this->db->query(
            "WITH dirs AS (
                SELECT
                    crc.cable_id,
                    cd.id as dir_id,
                    COALESCE(cd.length_m, 0) as len_m
                FROM cable_route_channels crc
                JOIN cable_channels cc ON crc.cable_channel_id = cc.id
                JOIN channel_directions cd ON cc.direction_id = cd.id
                GROUP BY crc.cable_id, cd.id, cd.length_m
            ),
            agg AS (
                SELECT
                    cable_id,
                    COALESCE(SUM(len_m), 0) as sum_len,
                    COALESCE(COUNT(*), 0) as cnt_dirs
                FROM dirs
                GROUP BY cable_id
            )
            UPDATE cables c
            SET length_calculated = ROUND((COALESCE(a.sum_len, 0) + (:k * COALESCE(a.cnt_dirs, 0)))::numeric, 2)
            FROM agg a
            WHERE c.id = a.cable_id AND c.object_type_id = :ot_id",
            ['k' => $k, 'ot_id' => $otId]
        );

        // Кабели без маршрута — длина 0 (чтобы не оставалось старых значений)
        $this->db->query(
            "UPDATE cables c
             SET length_calculated = 0
             WHERE c.object_type_id = :ot_id
               AND NOT EXISTS (SELECT 1 FROM cable_route_channels crc WHERE crc.cable_id = c.id)",
            ['ot_id' => $otId]
        );

        $total = (int) ($this->db->fetch("SELECT COUNT(*) as cnt FROM cables WHERE object_type_id = :ot_id", ['ot_id' => $otId])['cnt'] ?? 0);

        Response::success(['cables_total' => $total], 'Длины пересчитаны');
    }

    /**
     * Обновление расчётной длины кабеля в канализации
     */
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
     * GET /api/unified-cables/by-well/{id}
     * Список кабелей, где колодец входит в маршрут
     */
    public function byWell(string $id): void
    {
        $wellId = (int) $id;
        $rows = $this->db->fetchAll(
            "SELECT DISTINCT c.id, c.number,
                    ct.name as cable_type_name,
                    ot.code as object_type_code, ot.name as object_type_name,
                    cc.marking as cable_marking,
                    o.name as owner_name,
                    os.name as status_name,
                    c.length_calculated
             FROM cable_route_wells crw
             JOIN cables c ON crw.cable_id = c.id
             LEFT JOIN cable_types ct ON c.cable_type_id = ct.id
             LEFT JOIN cable_catalog cc ON c.cable_catalog_id = cc.id
             LEFT JOIN owners o ON c.owner_id = o.id
             LEFT JOIN object_types ot ON c.object_type_id = ot.id
             LEFT JOIN object_status os ON c.status_id = os.id
             WHERE crw.well_id = :id
             ORDER BY c.number",
            ['id' => $wellId]
        );
        Response::success($rows);
    }

    /**
     * GET /api/unified-cables/by-direction/{id}
     * Список кабелей, где в маршруте есть каналы данного направления
     */
    public function byDirection(string $id): void
    {
        $directionId = (int) $id;
        $rows = $this->db->fetchAll(
            "SELECT DISTINCT c.id, c.number,
                    ct.name as cable_type_name,
                    ot.code as object_type_code, ot.name as object_type_name,
                    cc.marking as cable_marking,
                    o.name as owner_name,
                    os.name as status_name,
                    c.length_calculated
             FROM cable_route_channels crc
             JOIN cable_channels ch ON crc.cable_channel_id = ch.id
             JOIN cables c ON crc.cable_id = c.id
             LEFT JOIN cable_types ct ON c.cable_type_id = ct.id
             LEFT JOIN cable_catalog cc ON c.cable_catalog_id = cc.id
             LEFT JOIN owners o ON c.owner_id = o.id
             LEFT JOIN object_types ot ON c.object_type_id = ot.id
             LEFT JOIN object_status os ON c.status_id = os.id
             WHERE ch.direction_id = :id
             ORDER BY c.number",
            ['id' => $directionId]
        );
        Response::success($rows);
    }

    /**
     * GET /api/unified-cables/by-channel/{id}
     * Список кабелей, где в маршруте есть данный канал
     */
    public function byChannel(string $id): void
    {
        $channelId = (int) $id;
        $rows = $this->db->fetchAll(
            "SELECT DISTINCT c.id, c.number,
                    ct.name as cable_type_name,
                    ot.code as object_type_code, ot.name as object_type_name,
                    cc.marking as cable_marking,
                    o.name as owner_name,
                    os.name as status_name,
                    c.length_calculated
             FROM cable_route_channels crc
             JOIN cables c ON crc.cable_id = c.id
             LEFT JOIN cable_types ct ON c.cable_type_id = ct.id
             LEFT JOIN cable_catalog cc ON c.cable_catalog_id = cc.id
             LEFT JOIN owners o ON c.owner_id = o.id
             LEFT JOIN object_types ot ON c.object_type_id = ot.id
             LEFT JOIN object_status os ON c.status_id = os.id
             WHERE crc.cable_channel_id = :id
             ORDER BY c.number",
            ['id' => $channelId]
        );
        Response::success($rows);
    }

    /**
     * GET /api/unified-cables/{id}/route-directions-geojson
     * GeoJSON направлений, которые входят в маршрут кабеля (через route_channels)
     */
    public function routeDirectionsGeojson(string $id): void
    {
        $cableId = (int) $id;
        try {
            $rows = $this->db->fetchAll(
                "SELECT cd.id, cd.number,
                        ST_AsGeoJSON(cd.geom_wgs84) as geometry
                 FROM cable_route_channels crc
                 JOIN cable_channels ch ON crc.cable_channel_id = ch.id
                 JOIN channel_directions cd ON ch.direction_id = cd.id
                 WHERE crc.cable_id = :id AND cd.geom_wgs84 IS NOT NULL",
                ['id' => $cableId]
            );
        } catch (\PDOException $e) {
            // Безопасно возвращаем пустой слой вместо 500
            Response::geojson([], ['layer' => 'route_directions', 'count' => 0]);
            return;
        }

        $features = [];
        $seen = [];
        foreach ($rows as $row) {
            $dirId = (int) ($row['id'] ?? 0);
            if ($dirId && isset($seen[$dirId])) {
                continue;
            }
            if ($dirId) {
                $seen[$dirId] = true;
            }
            $geometry = is_string($row['geometry']) ? json_decode($row['geometry'], true) : $row['geometry'];
            unset($row['geometry']);
            if (empty($geometry) || !isset($geometry['type'])) continue;
            $features[] = ['type' => 'Feature', 'geometry' => $geometry, 'properties' => $row];
        }
        Response::geojson($features, ['layer' => 'route_directions', 'count' => count($features)]);
    }
}

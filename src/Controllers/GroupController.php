<?php
/**
 * Контроллер групп объектов
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class GroupController extends BaseController
{
    /**
     * GET /api/groups/by-object?type=well&object_id=123
     * Группы, в которые входит объект
     */
    public function byObject(): void
    {
        $type = (string) $this->request->query('type', '');
        $objectId = (int) $this->request->query('object_id', 0);

        if ($type === '' || $objectId <= 0) {
            Response::error('Некорректные параметры', 422);
        }

        $tables = [
            'well' => ['group_wells', 'well_id'],
            'channel_direction' => ['group_channel_directions', 'channel_direction_id'],
            'cable_channel' => ['group_cable_channels', 'cable_channel_id'],
            'ground_cable' => ['group_ground_cables', 'ground_cable_id'],
            'aerial_cable' => ['group_aerial_cables', 'aerial_cable_id'],
            'duct_cable' => ['group_duct_cables', 'duct_cable_id'],
            'unified_cable' => ['group_unified_cables', 'unified_cable_id'],
            'marker_post' => ['group_marker_posts', 'marker_post_id'],
        ];

        if (!isset($tables[$type])) {
            Response::success([]);
        }

        [$table, $column] = $tables[$type];

        try {
            $rows = $this->db->fetchAll(
                "SELECT g.id, g.number, g.name
                 FROM {$table} t
                 JOIN object_groups g ON t.group_id = g.id
                 WHERE t.{$column} = :id
                 ORDER BY g.name",
                ['id' => $objectId]
            );
            Response::success($rows);
        } catch (\Throwable $e) {
            // Таблица может отсутствовать (создаётся лениво)
            Response::success([]);
        }
    }
    /**
     * GET /api/groups
     * Список групп
     */
    public function index(): void
    {
        $pagination = $this->getPagination();
        
        $filters = $this->buildFilters([
            'group_type' => 'g.group_type',
            '_search' => ['g.number', 'g.name', 'g.description', 'g.request_basis'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        $total = $this->getTotal('object_groups', $where, $params, 'g');

        $sql = "SELECT g.id, g.number, g.name, g.description, g.group_type, g.tu_date, g.request_basis,
                       g.created_at, g.updated_at,
                       u.login as created_by_login,
                       (SELECT COUNT(*) FROM group_wells WHERE group_id = g.id) +
                       (SELECT COUNT(*) FROM group_channel_directions WHERE group_id = g.id) +
                       (SELECT COUNT(*) FROM group_ground_cables WHERE group_id = g.id) +
                       (SELECT COUNT(*) FROM group_aerial_cables WHERE group_id = g.id) +
                       (SELECT COUNT(*) FROM group_duct_cables WHERE group_id = g.id) +
                       (SELECT COUNT(*) FROM group_marker_posts WHERE group_id = g.id) as object_count
                FROM object_groups g
                LEFT JOIN users u ON g.created_by = u.id";
        
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY g.name LIMIT :limit OFFSET :offset";
        
        $params['limit'] = $pagination['limit'];
        $params['offset'] = $pagination['offset'];
        
        $data = $this->db->fetchAll($sql, $params);

        Response::paginated($data, $total, $pagination['page'], $pagination['limit']);
    }

    /**
     * GET /api/groups/export
     * Экспорт групп в CSV
     */
    public function export(): void
    {
        $filters = $this->buildFilters([
            'group_type' => 'g.group_type',
            '_search' => ['g.number', 'g.name', 'g.description', 'g.request_basis'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];
        $delimiter = $this->normalizeCsvDelimiter($this->request->query('delimiter'), ';');

        $sql = "SELECT g.number, g.name, g.tu_date, g.request_basis, g.description, g.group_type,
                       u.login as created_by_login,
                       g.created_at,
                       (SELECT COUNT(*) FROM group_wells WHERE group_id = g.id) +
                       (SELECT COUNT(*) FROM group_channel_directions WHERE group_id = g.id) +
                       (SELECT COUNT(*) FROM group_ground_cables WHERE group_id = g.id) +
                       (SELECT COUNT(*) FROM group_aerial_cables WHERE group_id = g.id) +
                       (SELECT COUNT(*) FROM group_duct_cables WHERE group_id = g.id) +
                       (SELECT COUNT(*) FROM group_marker_posts WHERE group_id = g.id) as object_count
                FROM object_groups g
                LEFT JOIN users u ON g.created_by = u.id";

        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY g.name";

        $data = $this->db->fetchAll($sql, $params);

        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename=\"groups_' . date('Y-m-d') . '.csv\"');

        $output = fopen('php://output', 'w');
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));

        fputcsv($output, ['Номер', 'Название', 'Дата', 'Основание (Запрос)', 'Описание', 'Тип ТУ', 'Создал', 'Создано', 'Объектов'], $delimiter);
        foreach ($data as $row) {
            fputcsv($output, array_values($row), $delimiter);
        }

        fclose($output);
        exit;
    }

    /**
     * GET /api/groups/{id}
     */
    public function show(string $id): void
    {
        $group = $this->db->fetch(
            "SELECT g.*, u.login as created_by_login
             FROM object_groups g
             LEFT JOIN users u ON g.created_by = u.id
             WHERE g.id = :id",
            ['id' => (int) $id]
        );

        if (!$group) {
            Response::error('Группа не найдена', 404);
        }

        $group['objects'] = $this->getGroupObjects((int) $id);

        Response::success($group);
    }

    /**
     * POST /api/groups
     */
    public function store(): void
    {
        $this->checkWriteAccess();

        $errors = $this->request->validate([
            'name' => 'required|string|max:100',
            'request_basis' => 'string|max:100',
        ]);

        if (!empty($errors)) {
            Response::error('Ошибка валидации', 422, $errors);
        }

        // number формируется автоматически (например, по ID)
        $data = $this->request->only(['name', 'description', 'group_type', 'tu_date', 'request_basis']);
        
        $user = Auth::user();
        $data['created_by'] = $user['id'];

        try {
            $this->db->beginTransaction();

            $id = $this->db->insert('object_groups', $data);

            // Автонумерация: если номер не задан, используем id
            $this->db->update('object_groups', ['number' => (string) $id], 'id = :id', ['id' => $id]);

            // Добавляем объекты
            $objects = $this->request->input('objects', []);
            $this->linkObjects($id, $objects);

            $this->db->commit();

            $group = $this->db->fetch("SELECT * FROM object_groups WHERE id = :id", ['id' => $id]);
            $group['objects'] = $this->getGroupObjects($id);

            $this->log('create', 'object_groups', $id, null, $group);

            Response::success($group, 'Группа создана', 201);
        } catch (\PDOException $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /**
     * PUT /api/groups/{id}
     */
    public function update(string $id): void
    {
        $this->checkWriteAccess();
        $groupId = (int) $id;

        $oldGroup = $this->db->fetch("SELECT * FROM object_groups WHERE id = :id", ['id' => $groupId]);
        if (!$oldGroup) {
            Response::error('Группа не найдена', 404);
        }

        // number не редактируется
        $data = $this->request->only(['name', 'description', 'group_type', 'tu_date', 'request_basis']);
        $data = array_filter($data, fn($v) => $v !== null);

        try {
            $this->db->beginTransaction();

            if (!empty($data)) {
                $this->db->update('object_groups', $data, 'id = :id', ['id' => $groupId]);
            }

            // Обновляем связи
            $objects = $this->request->input('objects');
            if ($objects !== null) {
                $this->unlinkAllObjects($groupId);
                $this->linkObjects($groupId, $objects);
            }

            $this->db->commit();

            $group = $this->db->fetch("SELECT * FROM object_groups WHERE id = :id", ['id' => $groupId]);
            $group['objects'] = $this->getGroupObjects($groupId);

            $this->log('update', 'object_groups', $groupId, $oldGroup, $group);

            Response::success($group, 'Группа обновлена');
        } catch (\PDOException $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /**
     * DELETE /api/groups/{id}
     */
    public function destroy(string $id): void
    {
        $this->checkDeleteAccess();
        $groupId = (int) $id;

        $group = $this->db->fetch("SELECT * FROM object_groups WHERE id = :id", ['id' => $groupId]);
        if (!$group) {
            Response::error('Группа не найдена', 404);
        }

        // Удаляем файлы вложений (если таблица есть)
        try {
            $atts = $this->db->fetchAll("SELECT * FROM group_attachments WHERE group_id = :id", ['id' => $groupId]);
            foreach ($atts as $a) {
                $path = $a['file_path'] ?? null;
                if ($path && file_exists($path)) {
                    @unlink($path);
                }
            }
        } catch (\Throwable $e) {
            // миграция могла быть не применена — игнорируем
        }

        $this->unlinkAllObjects($groupId);
        $this->db->delete('object_groups', 'id = :id', ['id' => $groupId]);

        $this->log('delete', 'object_groups', $groupId, $group, null);

        Response::success(null, 'Группа удалена');
    }

    /**
     * POST /api/groups/{id}/objects
     * Добавление объектов в группу
     */
    public function addObjects(string $id): void
    {
        $this->checkWriteAccess();
        $groupId = (int) $id;

        $group = $this->db->fetch("SELECT * FROM object_groups WHERE id = :id", ['id' => $groupId]);
        if (!$group) {
            Response::error('Группа не найдена', 404);
        }

        $objects = $this->request->input('objects', []);
        $this->linkObjects($groupId, $objects);

        $group['objects'] = $this->getGroupObjects($groupId);

        Response::success($group, 'Объекты добавлены');
    }

    /**
     * DELETE /api/groups/{id}/objects
     * Удаление объектов из группы
     */
    public function removeObjects(string $id): void
    {
        $this->checkWriteAccess();
        $groupId = (int) $id;

        $group = $this->db->fetch("SELECT * FROM object_groups WHERE id = :id", ['id' => $groupId]);
        if (!$group) {
            Response::error('Группа не найдена', 404);
        }

        $objects = $this->request->input('objects', []);
        $this->unlinkObjects($groupId, $objects);

        $group['objects'] = $this->getGroupObjects($groupId);

        Response::success($group, 'Объекты удалены');
    }

    /**
     * GET /api/groups/{id}/geojson
     * GeoJSON объектов группы
     */
    public function geojson(string $id): void
    {
        $groupId = (int) $id;

        $group = $this->db->fetch("SELECT * FROM object_groups WHERE id = :id", ['id' => $groupId]);
        if (!$group) {
            Response::error('Группа не найдена', 404);
        }

        $features = [];

        // Колодцы (с фильтрацией по геометрии)
        $wells = $this->db->fetchAll(
            "SELECT w.id, w.number, w.kind_id, ok.code as kind_code,
                    w.owner_id, o.short_name as owner_short_name, o.color as owner_color,
                    ST_AsGeoJSON(w.geom_wgs84)::json as geometry, 'well' as object_type,
                    ot.color as type_color,
                    os.code as status_code, os.name as status_name, os.color as status_color
             FROM group_wells gw
             JOIN wells w ON gw.well_id = w.id
             LEFT JOIN owners o ON w.owner_id = o.id
             LEFT JOIN object_types ot ON w.type_id = ot.id
             LEFT JOIN object_kinds ok ON w.kind_id = ok.id
             LEFT JOIN object_status os ON w.status_id = os.id
             WHERE gw.group_id = :id AND w.geom_wgs84 IS NOT NULL",
            ['id' => $groupId]
        );
        foreach ($wells as $row) {
            $geometry = is_string($row['geometry']) ? json_decode($row['geometry'], true) : $row['geometry'];
            unset($row['geometry']);
            if (!empty($geometry) && isset($geometry['type'])) {
                $features[] = ['type' => 'Feature', 'geometry' => $geometry, 'properties' => $row];
            }
        }

        // Направления (с фильтрацией по геометрии)
        $directions = $this->db->fetchAll(
            "SELECT cd.id, cd.number, ST_AsGeoJSON(cd.geom_wgs84)::json as geometry, 'channel_direction' as object_type,
                    cd.owner_id, o.short_name as owner_short_name, o.color as owner_color,
                    ot.color as type_color,
                    os.code as status_code, os.name as status_name, os.color as status_color
             FROM group_channel_directions gcd
             JOIN channel_directions cd ON gcd.channel_direction_id = cd.id
             LEFT JOIN owners o ON cd.owner_id = o.id
             LEFT JOIN object_types ot ON cd.type_id = ot.id
             LEFT JOIN object_status os ON cd.status_id = os.id
             WHERE gcd.group_id = :id AND cd.geom_wgs84 IS NOT NULL",
            ['id' => $groupId]
        );
        foreach ($directions as $row) {
            $geometry = is_string($row['geometry']) ? json_decode($row['geometry'], true) : $row['geometry'];
            unset($row['geometry']);
            if (!empty($geometry) && isset($geometry['type'])) {
                $features[] = ['type' => 'Feature', 'geometry' => $geometry, 'properties' => $row];
            }
        }

        // Кабели в грунте (с фильтрацией по геометрии)
        $groundCables = $this->db->fetchAll(
            "SELECT gc.id, gc.number, ST_AsGeoJSON(gc.geom_wgs84)::json as geometry, 'ground_cable' as object_type,
                    ot.color as type_color,
                    os.code as status_code, os.name as status_name, os.color as status_color
             FROM group_ground_cables ggc
             JOIN ground_cables gc ON ggc.ground_cable_id = gc.id
             LEFT JOIN object_types ot ON gc.type_id = ot.id
             LEFT JOIN object_status os ON gc.status_id = os.id
             WHERE ggc.group_id = :id AND gc.geom_wgs84 IS NOT NULL",
            ['id' => $groupId]
        );
        foreach ($groundCables as $row) {
            $geometry = is_string($row['geometry']) ? json_decode($row['geometry'], true) : $row['geometry'];
            unset($row['geometry']);
            if (!empty($geometry) && isset($geometry['type'])) {
                $features[] = ['type' => 'Feature', 'geometry' => $geometry, 'properties' => $row];
            }
        }

        // Воздушные кабели (с фильтрацией по геометрии)
        $aerialCables = $this->db->fetchAll(
            "SELECT ac.id, ac.number, ST_AsGeoJSON(ac.geom_wgs84)::json as geometry, 'aerial_cable' as object_type,
                    ot.color as type_color,
                    os.code as status_code, os.name as status_name, os.color as status_color
             FROM group_aerial_cables gac
             JOIN aerial_cables ac ON gac.aerial_cable_id = ac.id
             LEFT JOIN object_types ot ON ac.type_id = ot.id
             LEFT JOIN object_status os ON ac.status_id = os.id
             WHERE gac.group_id = :id AND ac.geom_wgs84 IS NOT NULL",
            ['id' => $groupId]
        );
        foreach ($aerialCables as $row) {
            $geometry = is_string($row['geometry']) ? json_decode($row['geometry'], true) : $row['geometry'];
            unset($row['geometry']);
            if (!empty($geometry) && isset($geometry['type'])) {
                $features[] = ['type' => 'Feature', 'geometry' => $geometry, 'properties' => $row];
            }
        }

        // Кабели в канализации (с фильтрацией по геометрии)
        $ductCables = $this->db->fetchAll(
            "SELECT dc.id, dc.number, ST_AsGeoJSON(dc.geom_wgs84)::json as geometry, 'duct_cable' as object_type,
                    ot.color as type_color,
                    os.code as status_code, os.name as status_name, os.color as status_color
             FROM group_duct_cables gdc
             JOIN duct_cables dc ON gdc.duct_cable_id = dc.id
             LEFT JOIN object_types ot ON dc.type_id = ot.id
             LEFT JOIN object_status os ON dc.status_id = os.id
             WHERE gdc.group_id = :id AND dc.geom_wgs84 IS NOT NULL",
            ['id' => $groupId]
        );
        foreach ($ductCables as $row) {
            $geometry = is_string($row['geometry']) ? json_decode($row['geometry'], true) : $row['geometry'];
            unset($row['geometry']);
            if (!empty($geometry) && isset($geometry['type'])) {
                $features[] = ['type' => 'Feature', 'geometry' => $geometry, 'properties' => $row];
            }
        }

        // Столбики (с фильтрацией по геометрии)
        $markerPosts = $this->db->fetchAll(
            "SELECT mp.id, mp.number, ST_AsGeoJSON(mp.geom_wgs84)::json as geometry, 'marker_post' as object_type,
                    ot.color as type_color,
                    os.code as status_code, os.name as status_name, os.color as status_color
             FROM group_marker_posts gmp
             JOIN marker_posts mp ON gmp.marker_post_id = mp.id
             LEFT JOIN object_types ot ON mp.type_id = ot.id
             LEFT JOIN object_status os ON mp.status_id = os.id
             WHERE gmp.group_id = :id AND mp.geom_wgs84 IS NOT NULL",
            ['id' => $groupId]
        );
        foreach ($markerPosts as $row) {
            $geometry = is_string($row['geometry']) ? json_decode($row['geometry'], true) : $row['geometry'];
            unset($row['geometry']);
            if (!empty($geometry) && isset($geometry['type'])) {
                $features[] = ['type' => 'Feature', 'geometry' => $geometry, 'properties' => $row];
            }
        }

        Response::geojson($features, ['group_id' => $groupId, 'group_name' => $group['name'], 'count' => count($features)]);
    }

    /**
     * Получить объекты группы
     */
    private function getGroupObjects(int $groupId): array
    {
        $result = [];

        $wells = $this->db->fetchAll(
            "SELECT w.id, w.number, 'well' as object_type FROM group_wells gw
             JOIN wells w ON gw.well_id = w.id WHERE gw.group_id = :id",
            ['id' => $groupId]
        );
        $result = array_merge($result, $wells);

        $directions = $this->db->fetchAll(
            "SELECT cd.id, cd.number, 'channel_direction' as object_type FROM group_channel_directions gcd
             JOIN channel_directions cd ON gcd.channel_direction_id = cd.id WHERE gcd.group_id = :id",
            ['id' => $groupId]
        );
        $result = array_merge($result, $directions);

        // Каналы кабельной канализации
        try {
            $channels = $this->db->fetchAll(
                "SELECT cc.id, CONCAT('Канал ', cc.channel_number) as number, 'cable_channel' as object_type 
                 FROM group_cable_channels gcc
                 JOIN cable_channels cc ON gcc.cable_channel_id = cc.id WHERE gcc.group_id = :id",
                ['id' => $groupId]
            );
            $result = array_merge($result, $channels);
        } catch (\PDOException $e) {
            // Таблица может не существовать
        }

        $groundCables = $this->db->fetchAll(
            "SELECT gc.id, gc.number, 'ground_cable' as object_type FROM group_ground_cables ggc
             JOIN ground_cables gc ON ggc.ground_cable_id = gc.id WHERE ggc.group_id = :id",
            ['id' => $groupId]
        );
        $result = array_merge($result, $groundCables);

        $aerialCables = $this->db->fetchAll(
            "SELECT ac.id, ac.number, 'aerial_cable' as object_type FROM group_aerial_cables gac
             JOIN aerial_cables ac ON gac.aerial_cable_id = ac.id WHERE gac.group_id = :id",
            ['id' => $groupId]
        );
        $result = array_merge($result, $aerialCables);

        $ductCables = $this->db->fetchAll(
            "SELECT dc.id, dc.number, 'duct_cable' as object_type FROM group_duct_cables gdc
             JOIN duct_cables dc ON gdc.duct_cable_id = dc.id WHERE gdc.group_id = :id",
            ['id' => $groupId]
        );
        $result = array_merge($result, $ductCables);

        // Унифицированные кабели
        try {
            $unifiedCables = $this->db->fetchAll(
                "SELECT uc.id, uc.number, 'unified_cable' as object_type FROM group_unified_cables guc
                 JOIN unified_cables uc ON guc.unified_cable_id = uc.id WHERE guc.group_id = :id",
                ['id' => $groupId]
            );
            $result = array_merge($result, $unifiedCables);
        } catch (\PDOException $e) {
            // Таблица может не существовать
        }

        $markerPosts = $this->db->fetchAll(
            "SELECT mp.id, mp.number, 'marker_post' as object_type FROM group_marker_posts gmp
             JOIN marker_posts mp ON gmp.marker_post_id = mp.id WHERE gmp.group_id = :id",
            ['id' => $groupId]
        );
        $result = array_merge($result, $markerPosts);

        return $result;
    }

    /**
     * Связать объекты с группой
     */
    private function linkObjects(int $groupId, array $objects): void
    {
        $tables = [
            'well' => ['group_wells', 'well_id'],
            'channel_direction' => ['group_channel_directions', 'channel_direction_id'],
            'cable_channel' => ['group_cable_channels', 'cable_channel_id'],
            'ground_cable' => ['group_ground_cables', 'ground_cable_id'],
            'aerial_cable' => ['group_aerial_cables', 'aerial_cable_id'],
            'duct_cable' => ['group_duct_cables', 'duct_cable_id'],
            'unified_cable' => ['group_unified_cables', 'unified_cable_id'],
            'marker_post' => ['group_marker_posts', 'marker_post_id'],
        ];

        foreach ($objects as $obj) {
            if (isset($tables[$obj['type']])) {
                [$table, $column] = $tables[$obj['type']];
                // Создаём таблицу если не существует
                $this->ensureGroupLinkTableExists($table, $column);
                $this->db->query(
                    "INSERT INTO {$table} (group_id, {$column}) VALUES (:group_id, :object_id) ON CONFLICT DO NOTHING",
                    ['group_id' => $groupId, 'object_id' => $obj['id']]
                );
            }
        }
    }

    /**
     * Убедиться, что таблица связи существует
     */
    private function ensureGroupLinkTableExists(string $table, string $column): void
    {
        static $checkedTables = [];
        
        if (isset($checkedTables[$table])) {
            return;
        }
        
        // Проверяем существование таблицы
        $exists = $this->db->fetch(
            "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = :table)",
            ['table' => $table]
        );
        
        if (!$exists['exists']) {
            // Определяем ссылочную таблицу по имени колонки
            $refTable = str_replace('_id', 's', $column);
            if ($column === 'cable_channel_id') $refTable = 'cable_channels';
            if ($column === 'unified_cable_id') $refTable = 'unified_cables';
            
            $this->db->query("
                CREATE TABLE IF NOT EXISTS {$table} (
                    group_id INTEGER NOT NULL REFERENCES object_groups(id) ON DELETE CASCADE,
                    {$column} INTEGER NOT NULL REFERENCES {$refTable}(id) ON DELETE CASCADE,
                    PRIMARY KEY (group_id, {$column})
                )
            ");
        }
        
        $checkedTables[$table] = true;
    }

    /**
     * Удалить связи объектов
     */
    private function unlinkObjects(int $groupId, array $objects): void
    {
        $tables = [
            'well' => ['group_wells', 'well_id'],
            'channel_direction' => ['group_channel_directions', 'channel_direction_id'],
            'cable_channel' => ['group_cable_channels', 'cable_channel_id'],
            'ground_cable' => ['group_ground_cables', 'ground_cable_id'],
            'aerial_cable' => ['group_aerial_cables', 'aerial_cable_id'],
            'duct_cable' => ['group_duct_cables', 'duct_cable_id'],
            'unified_cable' => ['group_unified_cables', 'unified_cable_id'],
            'marker_post' => ['group_marker_posts', 'marker_post_id'],
        ];

        foreach ($objects as $obj) {
            if (isset($tables[$obj['type']])) {
                [$table, $column] = $tables[$obj['type']];
                try {
                    $this->db->delete($table, "group_id = :group_id AND {$column} = :object_id", 
                        ['group_id' => $groupId, 'object_id' => $obj['id']]);
                } catch (\PDOException $e) {
                    // Игнорируем ошибки если таблица не существует
                }
            }
        }
    }

    /**
     * Удалить все связи
     */
    private function unlinkAllObjects(int $groupId): void
    {
        $tables = [
            'group_wells', 'group_channel_directions', 'group_cable_channels',
            'group_ground_cables', 'group_aerial_cables', 'group_duct_cables',
            'group_unified_cables', 'group_marker_posts'
        ];

        foreach ($tables as $table) {
            try {
                $this->db->delete($table, 'group_id = :id', ['id' => $groupId]);
            } catch (\PDOException $e) {
                // Игнорируем ошибки если таблица не существует
            }
        }
    }
}

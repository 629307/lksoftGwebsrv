<?php
/**
 * Контроллер указательных столбиков
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class MarkerPostController extends BaseController
{
    /**
     * GET /api/marker-posts
     * Список столбиков
     */
    public function index(): void
    {
        $pagination = $this->getPagination();
        
        $filters = $this->buildFilters([
            'owner_id' => 'mp.owner_id',
            'type_id' => 'mp.type_id',
            'kind_id' => 'mp.kind_id',
            'status_id' => 'mp.status_id',
            '_search' => ['mp.number', 'mp.notes'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        $total = $this->getTotal('marker_posts', $where, $params, 'mp');

        $sql = "SELECT mp.id, mp.number, 
                       ST_X(mp.geom_wgs84) as longitude, ST_Y(mp.geom_wgs84) as latitude,
                       ST_X(mp.geom_msk86) as x_msk86, ST_Y(mp.geom_msk86) as y_msk86,
                       mp.owner_id, mp.type_id, mp.kind_id, mp.status_id,
                       mp.height_m, mp.material, mp.installation_date, mp.notes,
                       (SELECT COUNT(*) FROM object_photos op WHERE op.object_table = 'marker_posts' AND op.object_id = mp.id) as photo_count,
                       o.name as owner_name,
                       ot.name as type_name, ot.color as type_color,
                       ok.name as kind_name,
                       os.name as status_name, os.color as status_color,
                       mp.created_at, mp.updated_at
                FROM marker_posts mp
                LEFT JOIN owners o ON mp.owner_id = o.id
                LEFT JOIN object_types ot ON mp.type_id = ot.id
                LEFT JOIN object_kinds ok ON mp.kind_id = ok.id
                LEFT JOIN object_status os ON mp.status_id = os.id";
        
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY mp.number LIMIT :limit OFFSET :offset";
        
        $params['limit'] = $pagination['limit'];
        $params['offset'] = $pagination['offset'];
        
        $data = $this->db->fetchAll($sql, $params);

        Response::paginated($data, $total, $pagination['page'], $pagination['limit']);
    }

    /**
     * GET /api/marker-posts/export
     * Экспорт столбиков в CSV
     */
    public function export(): void
    {
        $filters = $this->buildFilters([
            'owner_id' => 'mp.owner_id',
            'type_id' => 'mp.type_id',
            'kind_id' => 'mp.kind_id',
            'status_id' => 'mp.status_id',
            '_search' => ['mp.number', 'mp.notes'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];
        $delimiter = $this->normalizeCsvDelimiter($this->request->query('delimiter'), ';');

        $sql = "SELECT mp.number,
                       ST_X(mp.geom_wgs84) as longitude, ST_Y(mp.geom_wgs84) as latitude,
                       ST_X(mp.geom_msk86) as x_msk86, ST_Y(mp.geom_msk86) as y_msk86,
                       o.name as owner,
                       ot.name as type,
                       ok.name as kind,
                       os.name as status,
                       mp.height_m,
                       mp.material,
                       mp.installation_date,
                       mp.notes
                FROM marker_posts mp
                LEFT JOIN owners o ON mp.owner_id = o.id
                LEFT JOIN object_types ot ON mp.type_id = ot.id
                LEFT JOIN object_kinds ok ON mp.kind_id = ok.id
                LEFT JOIN object_status os ON mp.status_id = os.id";

        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY mp.number";

        $data = $this->db->fetchAll($sql, $params);

        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="marker_posts_' . date('Y-m-d') . '.csv"');

        $output = fopen('php://output', 'w');
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));

        fputcsv($output, [
            'Номер', 'Долгота', 'Широта', 'X (МСК86)', 'Y (МСК86)',
            'Собственник', 'Вид', 'Тип', 'Состояние', 'Высота (м)', 'Материал', 'Дата установки', 'Примечания'
        ], $delimiter);

        foreach ($data as $row) {
            fputcsv($output, array_values($row), $delimiter);
        }
        fclose($output);
        exit;
    }

    /**
     * GET /api/marker-posts/geojson
     * GeoJSON столбиков для карты
     */
    public function geojson(): void
    {
        $filters = $this->buildFilters([
            'owner_id' => 'mp.owner_id',
            'status_id' => 'mp.status_id',
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        // Обязательно фильтруем по наличию геометрии
        $geomCondition = 'mp.geom_wgs84 IS NOT NULL';
        if ($where) {
            $where = "{$geomCondition} AND ({$where})";
        } else {
            $where = $geomCondition;
        }

        $sql = "SELECT mp.id, mp.number, 
                       ST_AsGeoJSON(mp.geom_wgs84)::json as geometry,
                       mp.owner_id, mp.status_id,
                       o.name as owner_name,
                       ot.name as type_name, ot.color as type_color,
                       os.code as status_code, os.name as status_name, os.color as status_color
                FROM marker_posts mp
                LEFT JOIN owners o ON mp.owner_id = o.id
                LEFT JOIN object_types ot ON mp.type_id = ot.id
                LEFT JOIN object_status os ON mp.status_id = os.id
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

        Response::geojson($features, ['layer' => 'marker_posts', 'count' => count($features)]);
    }

    /**
     * GET /api/marker-posts/{id}
     */
    public function show(string $id): void
    {
        $post = $this->db->fetch(
            "SELECT mp.*, 
                    ST_X(mp.geom_wgs84) as longitude, ST_Y(mp.geom_wgs84) as latitude,
                    ST_X(mp.geom_msk86) as x_msk86, ST_Y(mp.geom_msk86) as y_msk86,
                    o.name as owner_name,
                    ot.name as type_name,
                    ok.name as kind_name,
                    os.name as status_name, os.color as status_color
             FROM marker_posts mp
             LEFT JOIN owners o ON mp.owner_id = o.id
             LEFT JOIN object_types ot ON mp.type_id = ot.id
             LEFT JOIN object_kinds ok ON mp.kind_id = ok.id
             LEFT JOIN object_status os ON mp.status_id = os.id
             WHERE mp.id = :id",
            ['id' => (int) $id]
        );

        if (!$post) {
            Response::error('Столбик не найден', 404);
        }

        $photos = $this->db->fetchAll(
            "SELECT id, filename, original_filename, description, created_at 
             FROM object_photos 
             WHERE object_table = 'marker_posts' AND object_id = :id 
             ORDER BY sort_order",
            ['id' => (int) $id]
        );
        $post['photos'] = $photos;

        Response::success($post);
    }

    /**
     * POST /api/marker-posts
     */
    public function store(): void
    {
        $this->checkWriteAccess();

        $data = $this->request->only([
            'number', 'owner_id', 'type_id', 'kind_id', 'status_id',
            'height_m', 'material', 'installation_date', 'notes'
        ]);

        // number генерируется автоматически после вставки, но параметр нужен для SQL с :number
        if (!array_key_exists('number', $data)) {
            $data['number'] = null;
        }

        // Убедиться, что все необязательные поля присутствуют (даже если null)
        $optionalFields = ['height_m', 'material', 'installation_date', 'notes'];
        foreach ($optionalFields as $field) {
            if (!array_key_exists($field, $data)) {
                $data[$field] = null;
            }
        }

        $longitude = $this->request->input('longitude');
        $latitude = $this->request->input('latitude');
        $xMsk86 = $this->request->input('x_msk86');
        $yMsk86 = $this->request->input('y_msk86');

        $user = Auth::user();
        $data['created_by'] = $user['id'];
        $data['updated_by'] = $user['id'];

        try {
            $this->db->beginTransaction();

            if ($longitude && $latitude) {
                // PostgreSQL PDO не поддерживает повторное использование именованных параметров,
                // поэтому используем подзапрос с CTE для создания геометрии один раз
                $sql = "WITH geom_point AS (
                            SELECT ST_SetSRID(ST_MakePoint(:lon, :lat), 4326) as wgs84_point
                        )
                        INSERT INTO marker_posts (number, geom_wgs84, geom_msk86, owner_id, type_id, kind_id, status_id,
                                                  height_m, material, installation_date, notes, created_by, updated_by)
                        SELECT :number, 
                               wgs84_point,
                               ST_Transform(wgs84_point, 200004),
                               :owner_id, :type_id, :kind_id, :status_id,
                               :height_m, :material, :installation_date, :notes, :created_by, :updated_by
                        FROM geom_point
                        RETURNING id";
                $data['lon'] = $longitude;
                $data['lat'] = $latitude;
            } else {
                // PostgreSQL PDO не поддерживает повторное использование именованных параметров,
                // поэтому используем подзапрос с CTE для создания геометрии один раз
                $sql = "WITH geom_point AS (
                            SELECT ST_SetSRID(ST_MakePoint(:x, :y), 200004) as msk86_point
                        )
                        INSERT INTO marker_posts (number, geom_wgs84, geom_msk86, owner_id, type_id, kind_id, status_id,
                                                  height_m, material, installation_date, notes, created_by, updated_by)
                        SELECT :number,
                               ST_Transform(msk86_point, 4326),
                               msk86_point,
                               :owner_id, :type_id, :kind_id, :status_id,
                               :height_m, :material, :installation_date, :notes, :created_by, :updated_by
                        FROM geom_point
                        RETURNING id";
                $data['x'] = $xMsk86;
                $data['y'] = $yMsk86;
            }

            $stmt = $this->db->query($sql, $data);
            $id = $stmt->fetchColumn();

            // Формируем номер: СТ-<код_собств>-<id>
            $ownerCode = '';
            if (!empty($data['owner_id'])) {
                $owner = $this->db->fetch("SELECT code FROM owners WHERE id = :id", ['id' => (int) $data['owner_id']]);
                $ownerCode = $owner['code'] ?? '';
            }
            if ($ownerCode) {
                $number = "СТ-{$ownerCode}-{$id}";
                $this->db->update('marker_posts', ['number' => $number], 'id = :id', ['id' => $id]);
            }

            $this->db->commit();

            $post = $this->db->fetch(
                "SELECT *, ST_X(geom_wgs84) as longitude, ST_Y(geom_wgs84) as latitude
                 FROM marker_posts WHERE id = :id",
                ['id' => $id]
            );

            $this->log('create', 'marker_posts', $id, null, $post);

            Response::success($post, 'Столбик создан', 201);
        } catch (\PDOException $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /**
     * PUT /api/marker-posts/{id}
     */
    public function update(string $id): void
    {
        $this->checkWriteAccess();
        $postId = (int) $id;

        $oldPost = $this->db->fetch("SELECT * FROM marker_posts WHERE id = :id", ['id' => $postId]);
        if (!$oldPost) {
            Response::error('Столбик не найден', 404);
        }

        // number не редактируется
        $data = $this->request->only([
            'owner_id', 'type_id', 'kind_id', 'status_id',
            'height_m', 'material', 'installation_date', 'notes'
        ]);
        $data = array_filter($data, fn($v) => $v !== null);

        $user = Auth::user();
        $data['updated_by'] = $user['id'];

        $longitude = $this->request->input('longitude');
        $latitude = $this->request->input('latitude');
        $xMsk86 = $this->request->input('x_msk86');
        $yMsk86 = $this->request->input('y_msk86');

        if ($longitude && $latitude) {
            // PostgreSQL PDO не поддерживает повторное использование именованных параметров
            $this->db->query(
                "UPDATE marker_posts SET 
                    geom_wgs84 = wgs_point.geom,
                    geom_msk86 = ST_Transform(wgs_point.geom, 200004)
                 FROM (SELECT ST_SetSRID(ST_MakePoint(:lon, :lat), 4326) as geom) as wgs_point
                 WHERE marker_posts.id = :id",
                ['lon' => $longitude, 'lat' => $latitude, 'id' => $postId]
            );
        } elseif ($xMsk86 && $yMsk86) {
            // PostgreSQL PDO не поддерживает повторное использование именованных параметров
            $this->db->query(
                "UPDATE marker_posts SET 
                    geom_msk86 = msk_point.geom,
                    geom_wgs84 = ST_Transform(msk_point.geom, 4326)
                 FROM (SELECT ST_SetSRID(ST_MakePoint(:x, :y), 200004) as geom) as msk_point
                 WHERE marker_posts.id = :id",
                ['x' => $xMsk86, 'y' => $yMsk86, 'id' => $postId]
            );
        }

        if (!empty($data)) {
            $this->db->update('marker_posts', $data, 'id = :id', ['id' => $postId]);
        }

        $post = $this->db->fetch(
            "SELECT *, ST_X(geom_wgs84) as longitude, ST_Y(geom_wgs84) as latitude
             FROM marker_posts WHERE id = :id",
            ['id' => $postId]
        );

        $this->log('update', 'marker_posts', $postId, $oldPost, $post);

        Response::success($post, 'Столбик обновлён');
    }

    /**
     * DELETE /api/marker-posts/{id}
     */
    public function destroy(string $id): void
    {
        $this->checkDeleteAccess();
        $postId = (int) $id;

        $post = $this->db->fetch("SELECT * FROM marker_posts WHERE id = :id", ['id' => $postId]);
        if (!$post) {
            Response::error('Столбик не найден', 404);
        }

        $this->db->delete('object_photos', "object_table = 'marker_posts' AND object_id = :id", ['id' => $postId]);
        $this->db->delete('marker_posts', 'id = :id', ['id' => $postId]);

        $this->log('delete', 'marker_posts', $postId, $post, null);

        Response::success(null, 'Столбик удалён');
    }
}

<?php
/**
 * Контроллер инцидентов
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class IncidentController extends BaseController
{
    /**
     * GET /api/incidents
     * Список инцидентов
     */
    public function index(): void
    {
        $pagination = $this->getPagination();
        
        $filters = $this->buildFilters([
            'status' => 'i.status',
            'priority' => 'i.priority',
            'created_by' => 'i.created_by',
            'assigned_to' => 'i.assigned_to',
            '_search' => ['i.number', 'i.title', 'i.description'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        // Фильтр по дате
        $dateFrom = $this->request->query('date_from');
        $dateTo = $this->request->query('date_to');
        
        if ($dateFrom) {
            $where .= ($where ? ' AND ' : '') . 'i.incident_date >= :date_from';
            $params['date_from'] = $dateFrom;
        }
        if ($dateTo) {
            $where .= ($where ? ' AND ' : '') . 'i.incident_date <= :date_to';
            $params['date_to'] = $dateTo;
        }

        $totalSql = "SELECT COUNT(*) as cnt FROM incidents i";
        if ($where) {
            $totalSql .= " WHERE {$where}";
        }
        $total = (int) $this->db->fetch($totalSql, $params)['cnt'];

        $sql = "SELECT i.id, i.number, i.title, i.description, i.incident_date,
                       i.status, i.priority, i.culprit, i.resolution, i.resolved_at,
                       i.notes, i.created_at, i.updated_at,
                       uc.login as created_by_login, uc.full_name as created_by_name,
                       ua.login as assigned_to_login, ua.full_name as assigned_to_name
                FROM incidents i
                LEFT JOIN users uc ON i.created_by = uc.id
                LEFT JOIN users ua ON i.assigned_to = ua.id";
        
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY i.incident_date DESC LIMIT :limit OFFSET :offset";
        
        $params['limit'] = $pagination['limit'];
        $params['offset'] = $pagination['offset'];
        
        $data = $this->db->fetchAll($sql, $params);

        Response::paginated($data, $total, $pagination['page'], $pagination['limit']);
    }

    /**
     * GET /api/incidents/{id}
     */
    public function show(string $id): void
    {
        $incident = $this->db->fetch(
            "SELECT i.*,
                    uc.login as created_by_login, uc.full_name as created_by_name,
                    ua.login as assigned_to_login, ua.full_name as assigned_to_name
             FROM incidents i
             LEFT JOIN users uc ON i.created_by = uc.id
             LEFT JOIN users ua ON i.assigned_to = ua.id
             WHERE i.id = :id",
            ['id' => (int) $id]
        );

        if (!$incident) {
            Response::error('Инцидент не найден', 404);
        }

        // Связанные объекты
        $incident['related_objects'] = $this->getRelatedObjects((int) $id);

        // История
        $history = $this->db->fetchAll(
            "SELECT ih.*, u.login as created_by_login
             FROM incident_history ih
             LEFT JOIN users u ON ih.created_by = u.id
             WHERE ih.incident_id = :id
             ORDER BY ih.action_date DESC",
            ['id' => (int) $id]
        );
        $incident['history'] = $history;

        // Фотографии
        $photos = $this->db->fetchAll(
            "SELECT id, filename, original_filename, description, created_at 
             FROM object_photos 
             WHERE object_table = 'incidents' AND object_id = :id 
             ORDER BY sort_order",
            ['id' => (int) $id]
        );
        $incident['photos'] = $photos;

        // Документы
        $docs = $this->db->fetchAll(
            "SELECT id, filename, original_filename, description, created_at
             FROM incident_documents
             WHERE incident_id = :id
             ORDER BY created_at DESC",
            ['id' => (int) $id]
        );
        foreach ($docs as &$d) {
            $d['url'] = '/uploads/incident_documents/' . $d['filename'];
        }
        $incident['documents'] = $docs;

        Response::success($incident);
    }

    /**
     * POST /api/incidents
     */
    public function store(): void
    {
        $this->checkWriteAccess();

        $errors = $this->request->validate([
            'number' => 'required|string|max:50',
            'title' => 'required|string|max:255',
            'incident_date' => 'required',
        ]);

        if (!empty($errors)) {
            Response::error('Ошибка валидации', 422, $errors);
        }

        $data = $this->request->only([
            'number', 'title', 'description', 'incident_date', 'status', 'priority',
            'culprit', 'resolution', 'assigned_to', 'notes'
        ]);

        // Убедиться, что все необязательные поля присутствуют (даже если null)
        $optionalFields = ['description', 'culprit', 'resolution', 'assigned_to', 'notes'];
        foreach ($optionalFields as $field) {
            if (!array_key_exists($field, $data)) {
                $data[$field] = null;
            }
        }

        $user = Auth::user();
        $data['created_by'] = $user['id'];

        if (empty($data['status'])) {
            $data['status'] = 'open';
        }
        if (empty($data['priority'])) {
            $data['priority'] = 'normal';
        }

        try {
            $this->db->beginTransaction();

            $id = $this->db->insert('incidents', $data);

            // Связываем с объектами
            $relatedObjects = $this->request->input('related_objects', []);
            $this->linkObjects($id, $relatedObjects);

            // Добавляем запись в историю
            $this->addHistory($id, 'created', 'Инцидент создан');

            $this->db->commit();

            $incident = $this->db->fetch("SELECT * FROM incidents WHERE id = :id", ['id' => $id]);
            $incident['related_objects'] = $this->getRelatedObjects($id);

            $this->log('create', 'incidents', $id, null, $incident);

            Response::success($incident, 'Инцидент создан', 201);
        } catch (\PDOException $e) {
            $this->db->rollback();
            if (strpos($e->getMessage(), 'unique') !== false) {
                Response::error('Инцидент с таким номером уже существует', 400);
            }
            throw $e;
        }
    }

    /**
     * PUT /api/incidents/{id}
     */
    public function update(string $id): void
    {
        $this->checkWriteAccess();
        $incidentId = (int) $id;

        $oldIncident = $this->db->fetch("SELECT * FROM incidents WHERE id = :id", ['id' => $incidentId]);
        if (!$oldIncident) {
            Response::error('Инцидент не найден', 404);
        }

        $data = $this->request->only([
            'number', 'title', 'description', 'incident_date', 'status', 'priority',
            'culprit', 'resolution', 'assigned_to', 'notes'
        ]);
        $data = array_filter($data, fn($v) => $v !== null);

        try {
            $this->db->beginTransaction();

            // Если статус меняется на resolved, устанавливаем resolved_at
            if (isset($data['status']) && $data['status'] === 'resolved' && $oldIncident['status'] !== 'resolved') {
                $data['resolved_at'] = date('Y-m-d H:i:s');
            }

            $this->db->update('incidents', $data, 'id = :id', ['id' => $incidentId]);

            // Обновляем связи с объектами
            $relatedObjects = $this->request->input('related_objects');
            if ($relatedObjects !== null) {
                $this->unlinkAllObjects($incidentId);
                $this->linkObjects($incidentId, $relatedObjects);
            }

            // Добавляем запись в историю
            $changes = array_diff_assoc($data, $oldIncident);
            if (!empty($changes)) {
                $this->addHistory($incidentId, 'updated', 'Инцидент обновлён: ' . implode(', ', array_keys($changes)));
            }

            $this->db->commit();

            $incident = $this->db->fetch("SELECT * FROM incidents WHERE id = :id", ['id' => $incidentId]);
            $incident['related_objects'] = $this->getRelatedObjects($incidentId);

            $this->log('update', 'incidents', $incidentId, $oldIncident, $incident);

            Response::success($incident, 'Инцидент обновлён');
        } catch (\PDOException $e) {
            $this->db->rollback();
            throw $e;
        }
    }

    /**
     * DELETE /api/incidents/{id}
     */
    public function destroy(string $id): void
    {
        $this->checkDeleteAccess();
        $incidentId = (int) $id;

        $incident = $this->db->fetch("SELECT * FROM incidents WHERE id = :id", ['id' => $incidentId]);
        if (!$incident) {
            Response::error('Инцидент не найден', 404);
        }

        // Документы (удаляем файлы)
        $docs = $this->db->fetchAll("SELECT * FROM incident_documents WHERE incident_id = :id", ['id' => $incidentId]);
        foreach ($docs as $d) {
            if (!empty($d['file_path']) && file_exists($d['file_path'])) {
                unlink($d['file_path']);
            }
        }
        $this->db->delete('incident_documents', 'incident_id = :id', ['id' => $incidentId]);

        $this->db->delete('object_photos', "object_table = 'incidents' AND object_id = :id", ['id' => $incidentId]);
        $this->unlinkAllObjects($incidentId);
        $this->db->delete('incident_history', 'incident_id = :id', ['id' => $incidentId]);
        $this->db->delete('incidents', 'id = :id', ['id' => $incidentId]);

        $this->log('delete', 'incidents', $incidentId, $incident, null);

        Response::success(null, 'Инцидент удалён');
    }

    /**
     * POST /api/incidents/{id}/history
     * Добавление записи в историю
     */
    public function addHistoryEntry(string $id): void
    {
        $this->checkWriteAccess();
        $incidentId = (int) $id;

        $incident = $this->db->fetch("SELECT * FROM incidents WHERE id = :id", ['id' => $incidentId]);
        if (!$incident) {
            Response::error('Инцидент не найден', 404);
        }

        $errors = $this->request->validate([
            'action_type' => 'required|string',
            'description' => 'required|string',
        ]);

        if (!empty($errors)) {
            Response::error('Ошибка валидации', 422, $errors);
        }

        $historyId = $this->addHistory(
            $incidentId,
            $this->request->input('action_type'),
            $this->request->input('description'),
            $this->request->input('number'),
            $this->request->input('notes')
        );

        $history = $this->db->fetch("SELECT * FROM incident_history WHERE id = :id", ['id' => $historyId]);

        Response::success($history, 'Запись добавлена в историю', 201);
    }

    /**
     * Получить связанные объекты
     */
    private function getRelatedObjects(int $incidentId): array
    {
        $result = [];

        // Колодцы
        $wells = $this->db->fetchAll(
            "SELECT w.id, w.number, 'well' as object_type FROM incident_wells iw
             JOIN wells w ON iw.well_id = w.id WHERE iw.incident_id = :id",
            ['id' => $incidentId]
        );
        $result = array_merge($result, $wells);

        // Направления
        $directions = $this->db->fetchAll(
            "SELECT cd.id, cd.number, 'channel_direction' as object_type FROM incident_channel_directions icd
             JOIN channel_directions cd ON icd.channel_direction_id = cd.id WHERE icd.incident_id = :id",
            ['id' => $incidentId]
        );
        $result = array_merge($result, $directions);

        // Каналы (cable_channels)
        $channels = $this->db->fetchAll(
            "SELECT cc.id,
                    CONCAT('Канал ', cc.channel_number, ' (', cd.number, ')') as number,
                    'cable_channel' as object_type
             FROM incident_cable_channels icc
             JOIN cable_channels cc ON icc.cable_channel_id = cc.id
             JOIN channel_directions cd ON cc.direction_id = cd.id
             WHERE icc.incident_id = :id",
            ['id' => $incidentId]
        );
        $result = array_merge($result, $channels);

        // Унифицированные кабели (таблица cables)
        $cables = $this->db->fetchAll(
            "SELECT c.id, c.number, 'unified_cable' as object_type
             FROM incident_cables ic
             JOIN cables c ON ic.cable_id = c.id
             WHERE ic.incident_id = :id",
            ['id' => $incidentId]
        );
        $result = array_merge($result, $cables);

        // Кабели в грунте
        $groundCables = $this->db->fetchAll(
            "SELECT gc.id, gc.number, 'ground_cable' as object_type FROM incident_ground_cables igc
             JOIN ground_cables gc ON igc.ground_cable_id = gc.id WHERE igc.incident_id = :id",
            ['id' => $incidentId]
        );
        $result = array_merge($result, $groundCables);

        // Воздушные кабели
        $aerialCables = $this->db->fetchAll(
            "SELECT ac.id, ac.number, 'aerial_cable' as object_type FROM incident_aerial_cables iac
             JOIN aerial_cables ac ON iac.aerial_cable_id = ac.id WHERE iac.incident_id = :id",
            ['id' => $incidentId]
        );
        $result = array_merge($result, $aerialCables);

        // Кабели в канализации
        $ductCables = $this->db->fetchAll(
            "SELECT dc.id, dc.number, 'duct_cable' as object_type FROM incident_duct_cables idc
             JOIN duct_cables dc ON idc.duct_cable_id = dc.id WHERE idc.incident_id = :id",
            ['id' => $incidentId]
        );
        $result = array_merge($result, $ductCables);

        // Столбики
        $markerPosts = $this->db->fetchAll(
            "SELECT mp.id, mp.number, 'marker_post' as object_type FROM incident_marker_posts imp
             JOIN marker_posts mp ON imp.marker_post_id = mp.id WHERE imp.incident_id = :id",
            ['id' => $incidentId]
        );
        $result = array_merge($result, $markerPosts);

        return $result;
    }

    /**
     * Связать объекты с инцидентом
     */
    private function linkObjects(int $incidentId, array $objects): void
    {
        $tables = [
            'well' => ['incident_wells', 'well_id'],
            'channel_direction' => ['incident_channel_directions', 'channel_direction_id'],
            'cable_channel' => ['incident_cable_channels', 'cable_channel_id'],
            'unified_cable' => ['incident_cables', 'cable_id'],
            'ground_cable' => ['incident_ground_cables', 'ground_cable_id'],
            'aerial_cable' => ['incident_aerial_cables', 'aerial_cable_id'],
            'duct_cable' => ['incident_duct_cables', 'duct_cable_id'],
            'marker_post' => ['incident_marker_posts', 'marker_post_id'],
        ];

        foreach ($objects as $obj) {
            if (isset($tables[$obj['type']])) {
                [$table, $column] = $tables[$obj['type']];
                $this->db->query(
                    "INSERT INTO {$table} (incident_id, {$column}) VALUES (:incident_id, :object_id) ON CONFLICT DO NOTHING",
                    ['incident_id' => $incidentId, 'object_id' => $obj['id']]
                );
            }
        }
    }

    /**
     * Удалить все связи объектов
     */
    private function unlinkAllObjects(int $incidentId): void
    {
        $tables = [
            'incident_wells', 'incident_channel_directions', 'incident_cable_channels', 'incident_cables', 'incident_ground_cables',
            'incident_aerial_cables', 'incident_duct_cables', 'incident_marker_posts'
        ];

        foreach ($tables as $table) {
            $this->db->delete($table, 'incident_id = :id', ['id' => $incidentId]);
        }
    }

    /**
     * Добавить запись в историю
     */
    private function addHistory(int $incidentId, string $actionType, string $description, string $number = null, string $notes = null): int
    {
        $user = Auth::user();
        
        return $this->db->insert('incident_history', [
            'incident_id' => $incidentId,
            'number' => $number,
            'action_type' => $actionType,
            'description' => $description,
            'created_by' => $user['id'],
            'notes' => $notes,
        ]);
    }
}

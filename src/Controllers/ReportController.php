<?php
/**
 * Контроллер отчётов
 */

namespace App\Controllers;

use App\Core\Response;

class ReportController extends BaseController
{
    /**
     * GET /api/reports/objects
     * Отчёт по объектам
     */
    public function objects(): void
    {
        $filters = $this->buildFilters([
            'owner_id' => 'owner_id',
            'type_id' => 'type_id',
            'status_id' => 'status_id',
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        // Статистика по колодцам
        $wellsSql = "SELECT 'wells' as object_type, 'Колодцы' as object_name, COUNT(*) as count FROM wells";
        if ($where) $wellsSql .= " WHERE {$where}";
        $wells = $this->db->fetch($wellsSql, $params);

        // Направления каналов
        $directionsSql = "SELECT 'channel_directions' as object_type, 'Направления каналов' as object_name, COUNT(*) as count FROM channel_directions";
        if ($where) $directionsSql .= " WHERE {$where}";
        $directions = $this->db->fetch($directionsSql, $params);

        // Столбики
        $postsSql = "SELECT 'marker_posts' as object_type, 'Столбики' as object_name, COUNT(*) as count FROM marker_posts";
        if ($where) $postsSql .= " WHERE {$where}";
        $posts = $this->db->fetch($postsSql, $params);

        // Кабели в грунте
        $groundSql = "SELECT 'ground_cables' as object_type, 'Кабели в грунте' as object_name, COUNT(*) as count, COALESCE(SUM(length_m), 0) as total_length FROM ground_cables";
        if ($where) $groundSql .= " WHERE {$where}";
        $ground = $this->db->fetch($groundSql, $params);

        // Воздушные кабели
        $aerialSql = "SELECT 'aerial_cables' as object_type, 'Воздушные кабели' as object_name, COUNT(*) as count, COALESCE(SUM(length_m), 0) as total_length FROM aerial_cables";
        if ($where) $aerialSql .= " WHERE {$where}";
        $aerial = $this->db->fetch($aerialSql, $params);

        // Кабели в канализации
        $ductSql = "SELECT 'duct_cables' as object_type, 'Кабели в канализации' as object_name, COUNT(*) as count, COALESCE(SUM(length_m), 0) as total_length FROM duct_cables";
        if ($where) $ductSql .= " WHERE {$where}";
        $duct = $this->db->fetch($ductSql, $params);

        // Статистика по состояниям
        $byStatus = $this->db->fetchAll(
            "SELECT os.name as status_name, os.color,
                    (SELECT COUNT(*) FROM wells WHERE status_id = os.id) as wells,
                    (SELECT COUNT(*) FROM marker_posts WHERE status_id = os.id) as marker_posts,
                    (SELECT COUNT(*) FROM ground_cables WHERE status_id = os.id) as ground_cables,
                    (SELECT COUNT(*) FROM aerial_cables WHERE status_id = os.id) as aerial_cables,
                    (SELECT COUNT(*) FROM duct_cables WHERE status_id = os.id) as duct_cables
             FROM object_status os
             ORDER BY os.sort_order"
        );

        // Статистика по собственникам
        $byOwner = $this->db->fetchAll(
            "SELECT o.name as owner_name,
                    (SELECT COUNT(*) FROM wells WHERE owner_id = o.id) as wells,
                    (SELECT COUNT(*) FROM marker_posts WHERE owner_id = o.id) as marker_posts,
                    (SELECT COUNT(*) FROM ground_cables WHERE owner_id = o.id) as ground_cables,
                    (SELECT COUNT(*) FROM aerial_cables WHERE owner_id = o.id) as aerial_cables,
                    (SELECT COUNT(*) FROM duct_cables WHERE owner_id = o.id) as duct_cables
             FROM owners o
             ORDER BY o.name"
        );

        Response::success([
            'summary' => [
                $wells,
                $directions,
                $posts,
                $ground,
                $aerial,
                $duct,
            ],
            'by_status' => $byStatus,
            'by_owner' => $byOwner,
            'owners' => $this->db->fetchAll("SELECT id, name FROM owners ORDER BY name"),
        ]);
    }

    /**
     * GET /api/reports/contracts
     * Отчёт по контрактам
     */
    public function contracts(): void
    {
        $contractId = (int) $this->request->query('contract_id', 0);

        // Список контрактов для селекта
        $contracts = $this->db->fetchAll(
            "SELECT c.id, c.number, c.name, c.amount, c.owner_id, o.name as owner_name
             FROM contracts c
             LEFT JOIN owners o ON c.owner_id = o.id
             ORDER BY c.start_date DESC NULLS LAST, c.id DESC"
        );

        // По умолчанию ничего не выводим, пока контракт не выбран
        if ($contractId <= 0) {
            Response::success([
                'contracts' => $contracts,
                'contract' => null,
                'contracted' => ['stats' => ['count' => 0, 'length_sum' => 0, 'cost_per_meter' => null], 'cables' => []],
                'uncontracted' => ['stats' => ['count' => 0, 'length_sum' => 0], 'cables' => []],
            ]);
        }

        $contract = $this->db->fetch(
            "SELECT c.*, o.name as owner_name
             FROM contracts c
             LEFT JOIN owners o ON c.owner_id = o.id
             WHERE c.id = :id",
            ['id' => $contractId]
        );
        if (!$contract) {
            Response::error('Контракт не найден', 404);
        }

        // Кабели контракта (унифицированные)
        $contractedCables = $this->db->fetchAll(
            "SELECT cb.id, cb.number,
                    ot.name as object_type_name,
                    ct.name as cable_type_name,
                    cc.marking,
                    o.name as owner_name,
                    cb.length_calculated
             FROM cables cb
             LEFT JOIN object_types ot ON cb.object_type_id = ot.id
             LEFT JOIN cable_types ct ON cb.cable_type_id = ct.id
             LEFT JOIN cable_catalog cc ON cb.cable_catalog_id = cc.id
             LEFT JOIN owners o ON cb.owner_id = o.id
             WHERE cb.contract_id = :cid
             ORDER BY cb.number",
            ['cid' => $contractId]
        );
        $contractedCount = count($contractedCables);
        $contractedLength = array_sum(array_map(fn($c) => (float) ($c['length_calculated'] ?? 0), $contractedCables));
        $amount = (float) ($contract['amount'] ?? 0);
        $costPerMeter = $contractedLength > 0 ? round($amount / $contractedLength, 4) : null;

        // Незаконтрактованные кабели собственника контракта (contract_id IS NULL)
        $ownerId = (int) ($contract['owner_id'] ?? 0);
        $uncontractedCables = [];
        if ($ownerId > 0) {
            $uncontractedCables = $this->db->fetchAll(
                "SELECT cb.id, cb.number,
                        ot.name as object_type_name,
                        ct.name as cable_type_name,
                        cc.marking,
                        o.name as owner_name,
                        cb.length_calculated
                 FROM cables cb
                 LEFT JOIN object_types ot ON cb.object_type_id = ot.id
                 LEFT JOIN cable_types ct ON cb.cable_type_id = ct.id
                 LEFT JOIN cable_catalog cc ON cb.cable_catalog_id = cc.id
                 LEFT JOIN owners o ON cb.owner_id = o.id
                 WHERE cb.owner_id = :oid AND cb.contract_id IS NULL
                 ORDER BY cb.number",
                ['oid' => $ownerId]
            );
        }
        $uncontractedCount = count($uncontractedCables);
        $uncontractedLength = array_sum(array_map(fn($c) => (float) ($c['length_calculated'] ?? 0), $uncontractedCables));

        Response::success([
            'contracts' => $contracts,
            'contract' => $contract,
            'contracted' => [
                'stats' => [
                    'count' => $contractedCount,
                    'length_sum' => round($contractedLength, 2),
                    'cost_per_meter' => $costPerMeter,
                ],
                'cables' => $contractedCables,
            ],
            'uncontracted' => [
                'stats' => [
                    'count' => $uncontractedCount,
                    'length_sum' => round($uncontractedLength, 2),
                ],
                'cables' => $uncontractedCables,
            ],
        ]);
    }

    /**
     * GET /api/reports/owners
     * Отчёт по собственникам
     */
    public function owners(): void
    {
        $owners = $this->db->fetchAll(
            "SELECT o.id, o.name, o.short_name, o.inn, o.contact_person, o.contact_phone,
                    (SELECT COUNT(*) FROM wells WHERE owner_id = o.id) as wells,
                    (SELECT COUNT(*) FROM channel_directions WHERE owner_id = o.id) as channel_directions,
                    (SELECT COALESCE(SUM(length_m), 0) FROM channel_directions WHERE owner_id = o.id) as channel_directions_length_m,
                    (SELECT COUNT(*) FROM marker_posts WHERE owner_id = o.id) as marker_posts,
                    (SELECT COUNT(*) FROM cables WHERE owner_id = o.id) as cables,
                    (SELECT COALESCE(SUM(length_calculated), 0) FROM cables WHERE owner_id = o.id) as cables_length_m,
                    (SELECT COUNT(*) FROM contracts WHERE owner_id = o.id) as contracts
             FROM owners o
             ORDER BY o.name"
        );

        Response::success($owners);
    }

    /**
     * GET /api/reports/incidents
     * Отчёт по инцидентам
     */
    public function incidents(): void
    {
        $dateFrom = $this->request->query('date_from', date('Y-01-01'));
        $dateTo = $this->request->query('date_to', date('Y-m-d'));

        // По статусам
        $byStatus = $this->db->fetchAll(
            "SELECT status, COUNT(*) as count
             FROM incidents
             WHERE incident_date BETWEEN :from AND :to
             GROUP BY status
             ORDER BY count DESC",
            ['from' => $dateFrom, 'to' => $dateTo]
        );

        // По приоритетам
        $byPriority = $this->db->fetchAll(
            "SELECT priority, COUNT(*) as count
             FROM incidents
             WHERE incident_date BETWEEN :from AND :to
             GROUP BY priority
             ORDER BY count DESC",
            ['from' => $dateFrom, 'to' => $dateTo]
        );

        // По месяцам
        $byMonth = $this->db->fetchAll(
            "SELECT TO_CHAR(incident_date, 'YYYY-MM') as month, COUNT(*) as count
             FROM incidents
             WHERE incident_date BETWEEN :from AND :to
             GROUP BY TO_CHAR(incident_date, 'YYYY-MM')
             ORDER BY month",
            ['from' => $dateFrom, 'to' => $dateTo]
        );

        // Последние инциденты
        $recent = $this->db->fetchAll(
            "SELECT i.id, i.number, i.title, i.incident_date, i.status, i.priority,
                    u.login as created_by
             FROM incidents i
             LEFT JOIN users u ON i.created_by = u.id
             WHERE i.incident_date BETWEEN :from AND :to
             ORDER BY i.incident_date DESC
             LIMIT 20",
            ['from' => $dateFrom, 'to' => $dateTo]
        );

        // Общая статистика
        $summary = $this->db->fetch(
            "SELECT COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'open') as open,
                    COUNT(*) FILTER (WHERE status = 'in_progress') as in_progress,
                    COUNT(*) FILTER (WHERE status = 'resolved') as resolved,
                    AVG(EXTRACT(EPOCH FROM (COALESCE(resolved_at, NOW()) - incident_date)) / 86400)::numeric(10,1) as avg_resolution_days
             FROM incidents
             WHERE incident_date BETWEEN :from AND :to",
            ['from' => $dateFrom, 'to' => $dateTo]
        );

        Response::success([
            'period' => ['from' => $dateFrom, 'to' => $dateTo],
            'summary' => $summary,
            'by_status' => $byStatus,
            'by_priority' => $byPriority,
            'by_month' => $byMonth,
            'recent' => $recent,
        ]);
    }

    /**
     * GET /api/reports/export/{type}
     * Экспорт отчёта в CSV
     */
    public function export(string $type): void
    {
        $data = [];
        $filename = '';
        $headers = [];
        $delimiter = $this->normalizeCsvDelimiter($this->request->query('delimiter'), ';');

        switch ($type) {
            case 'objects':
                $filename = 'report_objects_' . date('Y-m-d') . '.csv';
                $headers = ['Тип объекта', 'Количество', 'Общая длина (м)'];
                
                $data[] = ['Колодцы', $this->db->fetch("SELECT COUNT(*) as c FROM wells")['c'], '-'];
                $data[] = ['Направления каналов', $this->db->fetch("SELECT COUNT(*) as c FROM channel_directions")['c'], '-'];
                $data[] = ['Каналы', $this->db->fetch("SELECT COUNT(*) as c FROM cable_channels")['c'], '-'];
                $data[] = ['Столбики', $this->db->fetch("SELECT COUNT(*) as c FROM marker_posts")['c'], '-'];
                
                $gc = $this->db->fetch("SELECT COUNT(*) as c, COALESCE(SUM(length_m), 0) as l FROM ground_cables");
                $data[] = ['Кабели в грунте', $gc['c'], $gc['l']];
                
                $ac = $this->db->fetch("SELECT COUNT(*) as c, COALESCE(SUM(length_m), 0) as l FROM aerial_cables");
                $data[] = ['Воздушные кабели', $ac['c'], $ac['l']];
                
                $dc = $this->db->fetch("SELECT COUNT(*) as c, COALESCE(SUM(length_m), 0) as l FROM duct_cables");
                $data[] = ['Кабели в канализации', $dc['c'], $dc['l']];
                break;

            case 'contracts':
                $filename = 'report_contracts_' . date('Y-m-d') . '.csv';
                $headers = ['Номер', 'Наименование', 'Собственник', 'Начало', 'Окончание', 'Статус', 'Сумма'];
                
                $contracts = $this->db->fetchAll(
                    "SELECT c.number, c.name, o.name as owner, c.start_date, c.end_date, c.status, c.amount
                     FROM contracts c LEFT JOIN owners o ON c.owner_id = o.id ORDER BY c.start_date DESC"
                );
                foreach ($contracts as $c) {
                    $data[] = array_values($c);
                }
                break;

            case 'owners':
                $filename = 'report_owners_' . date('Y-m-d') . '.csv';
                $headers = ['Собственник', 'ИНН', 'Колодцы', 'Направления', 'Столбики', 'Кабели в грунте', 'Воздушные', 'В канализации'];
                
                $owners = $this->db->fetchAll(
                    "SELECT o.name, o.inn,
                            (SELECT COUNT(*) FROM wells WHERE owner_id = o.id),
                            (SELECT COUNT(*) FROM channel_directions WHERE owner_id = o.id),
                            (SELECT COUNT(*) FROM marker_posts WHERE owner_id = o.id),
                            (SELECT COUNT(*) FROM ground_cables WHERE owner_id = o.id),
                            (SELECT COUNT(*) FROM aerial_cables WHERE owner_id = o.id),
                            (SELECT COUNT(*) FROM duct_cables WHERE owner_id = o.id)
                     FROM owners o ORDER BY o.name"
                );
                foreach ($owners as $o) {
                    $data[] = array_values($o);
                }
                break;

            default:
                Response::error('Неизвестный тип отчёта', 400);
        }

        // Формируем CSV
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');

        $output = fopen('php://output', 'w');
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));
        
        fputcsv($output, $headers, $delimiter);
        foreach ($data as $row) {
            fputcsv($output, $row, $delimiter);
        }
        
        fclose($output);
        exit;
    }
}

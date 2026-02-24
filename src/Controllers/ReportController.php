<?php
/**
 * Контроллер отчётов
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class ReportController extends BaseController
{
    /**
     * GET /api/reports/objects
     * Отчёт по объектам
     */
    public function objects(): void
    {
        // аудит: запрос формирования отчёта
        try { $this->log('report', 'reports', null, null, ['type' => 'objects', 'owner_id' => (int) $this->request->query('owner_id', 0)]); } catch (\Throwable $e) {}
        // На экране отчёта используется фильтр по собственнику (owner_id)
        $ownerId = (int) $this->request->query('owner_id', 0);
        $params = $ownerId > 0 ? ['oid' => $ownerId] : [];
        $whereOwner = $ownerId > 0 ? " WHERE owner_id = :oid" : "";

        // Статистика по колодцам
        $wellsSql = "SELECT 'wells' as object_type, 'Колодцы' as object_name, COUNT(*) as count FROM wells";
        $wells = $this->db->fetch($wellsSql . $whereOwner, $params);

        // Направления каналов
        $directionsSql = "SELECT 'channel_directions' as object_type, 'Направления каналов' as object_name,
                                 COUNT(*) as count, COALESCE(SUM(length_m), 0) as total_length
                          FROM channel_directions";
        $directions = $this->db->fetch($directionsSql . $whereOwner, $params);

        // Столбики
        $postsSql = "SELECT 'marker_posts' as object_type, 'Столбики' as object_name, COUNT(*) as count FROM marker_posts";
        $posts = $this->db->fetch($postsSql . $whereOwner, $params);

        // Кабели в грунте
        $groundSql = "SELECT 'ground_cables' as object_type, 'Кабели в грунте' as object_name, COUNT(*) as count, COALESCE(SUM(length_m), 0) as total_length FROM ground_cables";
        $ground = $this->db->fetch($groundSql . $whereOwner, $params);

        // Воздушные кабели
        $aerialSql = "SELECT 'aerial_cables' as object_type, 'Воздушные кабели' as object_name, COUNT(*) as count, COALESCE(SUM(length_m), 0) as total_length FROM aerial_cables";
        $aerial = $this->db->fetch($aerialSql . $whereOwner, $params);

        // Кабели в канализации
        $ductSql = "SELECT 'duct_cables' as object_type, 'Кабели в канализации' as object_name, COUNT(*) as count, COALESCE(SUM(length_m), 0) as total_length FROM duct_cables";
        $duct = $this->db->fetch($ductSql . $whereOwner, $params);

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
        try { $this->log('report', 'reports', null, null, ['type' => 'contracts', 'contract_id' => (int) $this->request->query('contract_id', 0)]); } catch (\Throwable $e) {}
        $contractId = (int) $this->request->query('contract_id', 0);

        // Список контрактов для селекта
        $contracts = $this->db->fetchAll(
            "SELECT c.id, c.number, c.name, c.amount, c.owner_id, o.name as owner_name,
                    c.landlord_id, ol.name as landlord_name
             FROM contracts c
             LEFT JOIN owners o ON c.owner_id = o.id
             LEFT JOIN owners ol ON c.landlord_id = ol.id
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
            "SELECT c.*, o.name as owner_name, ol.name as landlord_name
             FROM contracts c
             LEFT JOIN owners o ON c.owner_id = o.id
             LEFT JOIN owners ol ON c.landlord_id = ol.id
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
        $contractedLengthTotal = array_sum(array_map(fn($c) => (float) ($c['length_calculated'] ?? 0), $contractedCables));

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
        $uncontractedLengthTotal = array_sum(array_map(fn($c) => (float) ($c['length_calculated'] ?? 0), $uncontractedCables));

        // "Длина расч. (м) в части контракта" = SUM(length_m направлений арендодателя) + K * COUNT(направлений арендодателя),
        // где K = настройка "cable_in_well_length_m" (учитываемая длина кабеля в колодце)
        $landlordId = (int) ($contract['landlord_id'] ?? 0);
        $cableInWellLen = (float) $this->getAppSetting('cable_in_well_length_m', 3);
        $amount = (float) ($contract['amount'] ?? 0);

        $decorateWithContractPart = function(array $rows) use ($landlordId, $cableInWellLen): array {
            if (empty($rows)) return [];
            $ids = array_map(fn($r) => (int) ($r['id'] ?? 0), $rows);
            $ids = array_values(array_filter($ids));
            $map = [];
            if ($landlordId > 0 && !empty($ids)) {
                // Уникальные направления в маршруте кабеля
                $in = implode(',', array_fill(0, count($ids), '?'));
                $sql = "
                    WITH dirs AS (
                        SELECT DISTINCT crc.cable_id, cd.id as dir_id, cd.length_m, cd.owner_id
                        FROM cable_route_channels crc
                        JOIN cable_channels ch ON crc.cable_channel_id = ch.id
                        JOIN channel_directions cd ON ch.direction_id = cd.id
                        WHERE crc.cable_id IN ({$in})
                    )
                    SELECT cable_id,
                           COALESCE(SUM(CASE WHEN owner_id = ? THEN COALESCE(length_m, 0) ELSE 0 END), 0) as sum_len,
                           COALESCE(SUM(CASE WHEN owner_id = ? THEN 1 ELSE 0 END), 0) as cnt_dirs
                    FROM dirs
                    GROUP BY cable_id
                ";
                $params = array_merge($ids, [$landlordId, $landlordId]);
                $calcRows = $this->db->fetchAll($sql, $params);
                foreach ($calcRows as $cr) {
                    $cid = (int) ($cr['cable_id'] ?? 0);
                    $sumLen = (float) ($cr['sum_len'] ?? 0);
                    $cnt = (int) ($cr['cnt_dirs'] ?? 0);
                    $map[$cid] = round($sumLen + $cableInWellLen * $cnt, 2);
                }
            }
            foreach ($rows as &$r) {
                $cid = (int) ($r['id'] ?? 0);
                $r['length_contract_part'] = $cid && isset($map[$cid]) ? $map[$cid] : 0.0;
            }
            unset($r);
            return $rows;
        };

        $contractedCables = $decorateWithContractPart($contractedCables);
        $uncontractedCables = $decorateWithContractPart($uncontractedCables);

        $contractedLengthPart = array_sum(array_map(fn($c) => (float) ($c['length_contract_part'] ?? 0), $contractedCables));
        $uncontractedLengthPart = array_sum(array_map(fn($c) => (float) ($c['length_contract_part'] ?? 0), $uncontractedCables));

        $contractedCostPerMeter = $contractedLengthPart > 0 ? round($amount / $contractedLengthPart, 4) : null;
        $uncontractedCostPerMeter = $uncontractedLengthPart > 0 ? round($amount / $uncontractedLengthPart, 4) : null;

        Response::success([
            'contracts' => $contracts,
            'contract' => $contract,
            'contracted' => [
                'stats' => [
                    'count' => $contractedCount,
                    'length_sum_total' => round($contractedLengthTotal, 2),
                    'length_sum_contract_part' => round($contractedLengthPart, 2),
                    'cost_per_meter' => $contractedCostPerMeter,
                ],
                'cables' => $contractedCables,
            ],
            'uncontracted' => [
                'stats' => [
                    'count' => $uncontractedCount,
                    'length_sum_total' => round($uncontractedLengthTotal, 2),
                    'length_sum_contract_part' => round($uncontractedLengthPart, 2),
                    'cost_per_meter' => $uncontractedCostPerMeter,
                ],
                'cables' => $uncontractedCables,
            ],
        ]);
    }

    /**
     * GET /api/reports/inventory
     * Отчёт по инвентаризации (по направлениям, где есть inventory_summary)
     */
    public function inventory(): void
    {
        // Разрешаем всем авторизованным (в т.ч. readonly)
        if (!Auth::user()) {
            Response::error('Требуется авторизация', 401);
        }
        try { $this->log('report', 'reports', null, null, ['type' => 'inventory']); } catch (\Throwable $e) {}

        $ownerId = (int) $this->request->query('owner_id', 0); // собственник направления
        $tagOwnerId = (int) $this->request->query('tag_owner_id', 0); // собственник бирки
        $whereParts = [];
        $params = [];
        if ($ownerId > 0) {
            $whereParts[] = "cd.owner_id = :oid";
            $params['oid'] = $ownerId;
        }
        if ($tagOwnerId > 0) {
            $whereParts[] = "(
                EXISTS (SELECT 1 FROM inventory_tags itx WHERE itx.card_id = sc.card_id AND itx.owner_id = :toid)
                OR
                EXISTS (SELECT 1 FROM inventory_tags itx WHERE itx.card_id = ec.card_id AND itx.owner_id = :toid)
            )";
            $params['toid'] = $tagOwnerId;
        }
        $whereSql = $whereParts ? ("WHERE " . implode(" AND ", $whereParts)) : "";

        // latest card per well
        $rows = $this->db->fetchAll(
            "WITH latest_cards AS (
                SELECT DISTINCT ON (well_id) id as card_id, well_id, filled_date
                FROM inventory_cards
                ORDER BY well_id, filled_date DESC, id DESC
            ),
            tags_by_card AS (
                SELECT it.card_id,
                       STRING_AGG(o.name, E'\n' ORDER BY it.id) as tag_owners,
                       STRING_AGG(it.owner_id::text, E'\n' ORDER BY it.id) as tag_owner_ids
                FROM inventory_tags it
                JOIN owners o ON it.owner_id = o.id
                GROUP BY it.card_id
            ),
            cables_distinct AS (
                SELECT DISTINCT
                    cd.id as direction_id,
                    c.id as cable_id,
                    c.number,
                    c.owner_id
                FROM channel_directions cd
                LEFT JOIN cable_channels ch ON ch.direction_id = cd.id
                LEFT JOIN cable_route_channels crc ON crc.cable_channel_id = ch.id
                LEFT JOIN cables c ON c.id = crc.cable_id
                WHERE c.id IS NOT NULL
            ),
            cables_by_direction AS (
                SELECT direction_id,
                       STRING_AGG(number, E'\n' ORDER BY number) as cable_numbers,
                       STRING_AGG(owner_id::text, E'\n' ORDER BY number) as cable_owner_ids
                FROM cables_distinct
                GROUP BY direction_id
            )
            SELECT
                cd.id as direction_id,
                cd.number as direction_number,
                COALESCE(cd.length_m, ROUND(ST_Length(cd.geom_wgs84::geography)::numeric, 2), 0) as direction_length_m,
                sw.number as start_well_number,
                ew.number as end_well_number,
                COALESCE(cbd.cable_numbers, '') as cable_numbers,
                COALESCE(cbd.cable_owner_ids, '') as cable_owner_ids,
                COALESCE(s.unaccounted_cables, 0) as unaccounted_cables,
                COALESCE(s.max_inventory_cables, 0) as max_inventory_cables,

                sc.card_id as start_card_id,
                COALESCE(sdc.cable_count, 0) as start_inventory_cables,
                COALESCE(st.tag_owners, '') as start_tag_owners,
                COALESCE(st.tag_owner_ids, '') as start_tag_owner_ids,

                ec.card_id as end_card_id,
                COALESCE(edc.cable_count, 0) as end_inventory_cables,
                COALESCE(et.tag_owners, '') as end_tag_owners,
                COALESCE(et.tag_owner_ids, '') as end_tag_owner_ids
            FROM inventory_summary s
            JOIN channel_directions cd ON cd.id = s.direction_id
            LEFT JOIN wells sw ON cd.start_well_id = sw.id
            LEFT JOIN wells ew ON cd.end_well_id = ew.id
            LEFT JOIN cables_by_direction cbd ON cbd.direction_id = cd.id
            LEFT JOIN latest_cards sc ON sc.well_id = cd.start_well_id
            LEFT JOIN latest_cards ec ON ec.well_id = cd.end_well_id
            LEFT JOIN inventory_direction_cables sdc ON sdc.card_id = sc.card_id AND sdc.direction_id = cd.id
            LEFT JOIN inventory_direction_cables edc ON edc.card_id = ec.card_id AND edc.direction_id = cd.id
            LEFT JOIN tags_by_card st ON st.card_id = sc.card_id
            LEFT JOIN tags_by_card et ON et.card_id = ec.card_id
            {$whereSql}
            ORDER BY cd.number"
            ,
            $params
        );

        Response::success([
            'rows' => $rows,
        ]);
    }

    /**
     * GET /api/reports/inventory-recommendations?owner_id=123
     * Рекомендации по инвентаризации для выбранного собственника (по колодцам).
     */
    public function inventoryRecommendations(): void
    {
        // Разрешаем всем авторизованным (в т.ч. readonly)
        if (!Auth::user()) {
            Response::error('Требуется авторизация', 401);
        }

        $ownerId = (int) $this->request->query('owner_id', 0);
        if ($ownerId <= 0) {
            Response::error('Не указан собственник (owner_id)', 422);
        }
        try { $this->log('report', 'reports', null, null, ['type' => 'inventory_recommendations', 'owner_id' => $ownerId]); } catch (\Throwable $e) {}

        $owner = $this->db->fetch("SELECT id, name FROM owners WHERE id = :id", ['id' => $ownerId]);
        if (!$owner) Response::error('Собственник не найден', 404);

        // Последняя карточка на колодец
        $latestCte = "WITH latest_cards AS (
            SELECT DISTINCT ON (well_id)
                   well_id,
                   id,
                   number AS card_number,
                   filled_date AS card_date
            FROM inventory_cards
            ORDER BY well_id, filled_date DESC, id DESC
        )";

        // 1) не инвентаризированные колодцы (нет карточек)
        $part1 = $this->db->fetchAll(
            "{$latestCte}
             SELECT w.id AS well_id,
                    w.number AS well_number,
                    NULL::text AS card_number,
                    NULL::date AS card_date
             FROM wells w
             LEFT JOIN latest_cards lc ON lc.well_id = w.id
             WHERE w.owner_id = :oid
               AND lc.id IS NULL
             ORDER BY w.number",
            ['oid' => $ownerId]
        );

        // 2) инвентаризация более 2 лет назад
        $part2 = $this->db->fetchAll(
            "{$latestCte}
             SELECT w.id AS well_id,
                    w.number AS well_number,
                    lc.card_number,
                    lc.card_date
             FROM wells w
             JOIN latest_cards lc ON lc.well_id = w.id
             WHERE w.owner_id = :oid
               AND lc.card_date < (CURRENT_DATE - INTERVAL '2 years')
             ORDER BY w.number",
            ['oid' => $ownerId]
        );

        // 3) количество неучтенных кабелей выше среднего и не менее 4
        $part3 = $this->db->fetchAll(
            "{$latestCte},
             avg_unacc AS (
                 SELECT COALESCE(AVG(unaccounted_cables)::numeric, 0) AS avg_val
                 FROM inventory_summary
                 WHERE unaccounted_cables > 0
             ),
             dir_wells AS (
                 SELECT start_well_id AS well_id, id AS direction_id FROM channel_directions
                 UNION ALL
                 SELECT end_well_id AS well_id, id AS direction_id FROM channel_directions
             )
             SELECT DISTINCT
                    w.id AS well_id,
                    w.number AS well_number,
                    lc.card_number,
                    lc.card_date
             FROM wells w
             JOIN dir_wells dw ON dw.well_id = w.id
             JOIN inventory_summary isum ON isum.direction_id = dw.direction_id
             CROSS JOIN avg_unacc a
             LEFT JOIN latest_cards lc ON lc.well_id = w.id
             WHERE w.owner_id = :oid
               AND isum.unaccounted_cables >= 4
               AND isum.unaccounted_cables > a.avg_val
             ORDER BY w.number",
            ['oid' => $ownerId]
        );

        $normalize = function(array $rows): array {
            $out = [];
            foreach ($rows as $r) {
                $out[] = [
                    'well_id' => (int) ($r['well_id'] ?? 0),
                    'well_number' => (string) ($r['well_number'] ?? ''),
                    'card_number' => (string) ($r['card_number'] ?? ''),
                    'card_date' => $r['card_date'] ? (string) $r['card_date'] : '',
                ];
            }
            return $out;
        };

        Response::success([
            'owner_id' => $ownerId,
            'owner_name' => (string) ($owner['name'] ?? ''),
            'summary' => [
                'part1_count' => count($part1),
                'part2_count' => count($part2),
                'part3_count' => count($part3),
            ],
            'parts' => [
                [
                    'code' => 'no_cards',
                    'title' => 'Не инвентаризированные колодцы',
                    'count' => count($part1),
                    'rows' => $normalize($part1),
                ],
                [
                    'code' => 'older_2y',
                    'title' => 'Инвентаризация более 2 лет назад',
                    'count' => count($part2),
                    'rows' => $normalize($part2),
                ],
                [
                    'code' => 'unacc_above_avg',
                    'title' => 'Количество неучтенных кабелей выше среднего',
                    'count' => count($part3),
                    'rows' => $normalize($part3),
                ],
            ],
        ]);
    }

    /**
     * GET /api/reports/owners
     * Отчёт по собственникам
     */
    public function owners(): void
    {
        try { $this->log('report', 'reports', null, null, ['type' => 'owners']); } catch (\Throwable $e) {}
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
        try { $this->log('report', 'reports', null, null, ['type' => 'incidents']); } catch (\Throwable $e) {}
        // В UI для фильтра чаще приходят даты без времени (YYYY-MM-DD).
        // Для TIMESTAMP важно включать весь день, иначе при date_to=сегодня будет отсечено всё после 00:00:00.
        $dateFrom = (string) $this->request->query('date_from', date('Y-01-01 00:00:00'));
        $dateTo = (string) $this->request->query('date_to', date('Y-m-d H:i:s'));

        $normalize = function(string $v, bool $isTo): string {
            $v = trim($v);
            if ($v === '') return $v;
            // Если пришла только дата без времени — добавляем границы дня
            if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $v)) {
                return $isTo ? ($v . ' 23:59:59') : ($v . ' 00:00:00');
            }
            // Если HTML datetime-local (YYYY-MM-DDTHH:MM) — приводим к пробелу и секундам
            if (preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/', $v)) {
                return str_replace('T', ' ', $v) . ':00';
            }
            return $v;
        };
        $dateFrom = $normalize($dateFrom, false);
        $dateTo = $normalize($dateTo, true);

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
        try { $this->log('report_export', 'reports', null, null, ['type' => $type]); } catch (\Throwable $e) {}
        $data = [];
        $filename = '';
        $headers = [];
        $delimiter = $this->normalizeCsvDelimiter($this->request->query('delimiter'), ';');

        switch ($type) {
            case 'objects':
                $filename = 'report_objects_' . date('Y-m-d') . '.csv';
                $headers = ['Тип объекта', 'Количество', 'Общая длина (м)'];

                // Учитываем фильтр по собственнику из UI (единственный фильтр на экране)
                $ownerId = (int) $this->request->query('owner_id', 0);
                $p = $ownerId > 0 ? ['oid' => $ownerId] : [];
                $w = $ownerId > 0 ? " WHERE owner_id = :oid" : "";

                $data[] = ['Колодцы', $this->db->fetch("SELECT COUNT(*) as c FROM wells{$w}", $p)['c'], '-'];
                $dir = $this->db->fetch("SELECT COUNT(*) as c, COALESCE(SUM(length_m), 0) as l FROM channel_directions{$w}", $p);
                $data[] = ['Направления каналов', $dir['c'], $dir['l']];
                $data[] = ['Каналы', $this->db->fetch(
                    $ownerId > 0
                        ? "SELECT COUNT(*) as c FROM cable_channels cc JOIN channel_directions cd ON cc.direction_id = cd.id WHERE cd.owner_id = :oid"
                        : "SELECT COUNT(*) as c FROM cable_channels",
                    $p
                )['c'], '-'];
                $data[] = ['Столбики', $this->db->fetch("SELECT COUNT(*) as c FROM marker_posts{$w}", $p)['c'], '-'];

                // По старым таблицам кабелей (как в отчёте на экране)
                $gc = $this->db->fetch(
                    "SELECT COUNT(*) as c, COALESCE(SUM(length_m), 0) as l FROM ground_cables" . ($ownerId > 0 ? " WHERE owner_id = :oid" : ""),
                    $p
                );
                $data[] = ['Кабели в грунте', $gc['c'], $gc['l']];

                $ac = $this->db->fetch(
                    "SELECT COUNT(*) as c, COALESCE(SUM(length_m), 0) as l FROM aerial_cables" . ($ownerId > 0 ? " WHERE owner_id = :oid" : ""),
                    $p
                );
                $data[] = ['Воздушные кабели', $ac['c'], $ac['l']];

                $dc = $this->db->fetch(
                    "SELECT COUNT(*) as c, COALESCE(SUM(length_m), 0) as l FROM duct_cables" . ($ownerId > 0 ? " WHERE owner_id = :oid" : ""),
                    $p
                );
                $data[] = ['Кабели в канализации', $dc['c'], $dc['l']];
                break;

            case 'contracts':
                $contractId = (int) $this->request->query('contract_id', 0);

                // Если контракт не выбран — выгружаем список контрактов
                if ($contractId <= 0) {
                    $filename = 'report_contracts_' . date('Y-m-d') . '.csv';
                    $headers = ['Номер', 'Наименование', 'Арендатор', 'Арендодатель', 'Начало', 'Окончание', 'Статус', 'Сумма'];
                    $contracts = $this->db->fetchAll(
                        "SELECT c.number, c.name, o.name as tenant, ol.name as landlord, c.start_date, c.end_date, c.status, c.amount
                         FROM contracts c
                         LEFT JOIN owners o ON c.owner_id = o.id
                         LEFT JOIN owners ol ON c.landlord_id = ol.id
                         ORDER BY c.start_date DESC"
                    );
                    foreach ($contracts as $c) {
                        $data[] = array_values($c);
                    }
                    break;
                }

                // Контракт выбран — выгружаем всё, что на экране (контракт + 2 таблицы кабелей + статистика)
                $filename = 'report_contract_' . $contractId . '_' . date('Y-m-d') . '.csv';

                $contract = $this->db->fetch(
                    "SELECT c.*, o.name as owner_name, ol.name as landlord_name
                     FROM contracts c
                     LEFT JOIN owners o ON c.owner_id = o.id
                     LEFT JOIN owners ol ON c.landlord_id = ol.id
                     WHERE c.id = :id",
                    ['id' => $contractId]
                );
                if (!$contract) {
                    Response::error('Контракт не найден', 404);
                }

                $contractedCables = $this->db->fetchAll(
                    "SELECT cb.number,
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
                $amount = (float) ($contract['amount'] ?? 0);
                $landlordId = (int) ($contract['landlord_id'] ?? 0);

                $ownerId = (int) ($contract['owner_id'] ?? 0);
                $uncontractedCables = [];
                if ($ownerId > 0) {
                    $uncontractedCables = $this->db->fetchAll(
                        "SELECT cb.number,
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

                $cableInWellLen = (float) $this->getAppSetting('cable_in_well_length_m', 3);
                $calcPart = function(array $rows) use ($landlordId, $cableInWellLen): array {
                    if (empty($rows)) return [$rows, 0.0];
                    $numbers = array_map(fn($r) => (string) ($r['number'] ?? ''), $rows);
                    $numbers = array_values(array_filter($numbers));
                    $map = [];
                    if ($landlordId > 0 && !empty($numbers)) {
                        $in = implode(',', array_fill(0, count($numbers), '?'));
                        $sql = "
                            WITH cable_ids AS (
                                SELECT id, number FROM cables WHERE number IN ({$in})
                            ),
                            dirs AS (
                                SELECT DISTINCT crc.cable_id, cd.id as dir_id, cd.length_m, cd.owner_id
                                FROM cable_route_channels crc
                                JOIN cable_channels ch ON crc.cable_channel_id = ch.id
                                JOIN channel_directions cd ON ch.direction_id = cd.id
                                WHERE crc.cable_id IN (SELECT id FROM cable_ids)
                            )
                            SELECT cable_id,
                                   COALESCE(SUM(CASE WHEN owner_id = ? THEN COALESCE(length_m, 0) ELSE 0 END), 0) as sum_len,
                                   COALESCE(SUM(CASE WHEN owner_id = ? THEN 1 ELSE 0 END), 0) as cnt_dirs
                            FROM dirs
                            GROUP BY cable_id
                        ";
                        $params = array_merge($numbers, [$landlordId, $landlordId]);
                        $calcRows = $this->db->fetchAll($sql, $params);
                        foreach ($calcRows as $cr) {
                            $cid = (int) ($cr['cable_id'] ?? 0);
                            $sumLen = (float) ($cr['sum_len'] ?? 0);
                            $cnt = (int) ($cr['cnt_dirs'] ?? 0);
                            $map[$cid] = round($sumLen + $cableInWellLen * $cnt, 2);
                        }
                    }
                    // Подтягиваем id по номеру и проставляем длину
                    $idByNumber = [];
                    if (!empty($numbers)) {
                        $in2 = implode(',', array_fill(0, count($numbers), '?'));
                        $idRows = $this->db->fetchAll("SELECT id, number FROM cables WHERE number IN ({$in2})", $numbers);
                        foreach ($idRows as $ir) $idByNumber[(string) $ir['number']] = (int) $ir['id'];
                    }
                    $sum = 0.0;
                    foreach ($rows as &$r) {
                        $cid = $idByNumber[(string) ($r['number'] ?? '')] ?? 0;
                        $val = $cid && isset($map[$cid]) ? (float) $map[$cid] : 0.0;
                        $r['length_contract_part'] = $val;
                        $sum += $val;
                    }
                    unset($r);
                    return [$rows, $sum];
                };

                [$contractedCables, $contractedPartSum] = $calcPart($contractedCables);
                [$uncontractedCables, $uncontractedPartSum] = $calcPart($uncontractedCables);

                $contractedCostPerMeter = $contractedPartSum > 0 ? round($amount / $contractedPartSum, 4) : null;
                $uncontractedCostPerMeter = $uncontractedPartSum > 0 ? round($amount / $uncontractedPartSum, 4) : null;

                // Для "мультисекционного" CSV используем пустой $headers и сами пишем строки ниже
                $headers = [];
                $data = [
                    ['__SECTION__', 'Контракт'],
                    ['Номер', $contract['number'] ?? ''],
                    ['Наименование', $contract['name'] ?? ''],
                    ['Арендатор', $contract['owner_name'] ?? ''],
                    ['Арендодатель', $contract['landlord_name'] ?? ''],
                    ['Начало', $contract['start_date'] ?? ''],
                    ['Окончание', $contract['end_date'] ?? ''],
                    ['Статус', $contract['status'] ?? ''],
                    ['Сумма', $contract['amount'] ?? ''],
                    ['__SECTION__', 'Кабеля контракта (статистика)'],
                    ['Количество', $contractedCount],
                    ['Общая протяженность кабелей (м) в части контракта', round($contractedPartSum, 2)],
                    ['Стоимость за 1 метр', $contractedCostPerMeter === null ? '' : $contractedCostPerMeter],
                    ['__SECTION__', 'Кабеля контракта'],
                    ['Номер', 'Вид объекта', 'Тип кабеля', 'Кабель (из каталога)', 'Собственник', 'Длина расч. (м), всего кабеля', 'Длина расч. (м) в части контракта'],
                    ...array_map(fn($c) => [$c['number'], $c['object_type_name'], $c['cable_type_name'], $c['marking'], $c['owner_name'], $c['length_calculated'], $c['length_contract_part'] ?? 0], $contractedCables),
                    ['__SECTION__', 'Не законтрактованные кабеля собственника (статистика)'],
                    ['Количество', $uncontractedCount],
                    ['Общая протяженность кабелей (м) в части контракта', round($uncontractedPartSum, 2)],
                    ['Стоимость за 1 метр', $uncontractedCostPerMeter === null ? '' : $uncontractedCostPerMeter],
                    ['__SECTION__', 'Не законтрактованные кабеля собственника'],
                    ['Номер', 'Вид объекта', 'Тип кабеля', 'Кабель (из каталога)', 'Собственник', 'Длина расч. (м), всего кабеля', 'Длина расч. (м) в части контракта'],
                    ...array_map(fn($c) => [$c['number'], $c['object_type_name'], $c['cable_type_name'], $c['marking'], $c['owner_name'], $c['length_calculated'], $c['length_contract_part'] ?? 0], $uncontractedCables),
                ];
                break;

            case 'owners':
                $filename = 'report_owners_' . date('Y-m-d') . '.csv';
                // Выгружаем по тем же данным, что возвращает /api/reports/owners
                $headers = ['Собственник', 'ИНН', 'Колодцы', 'Направления', 'Направления (м)', 'Столбики', 'Кабели', 'Кабели (м)', 'Контракты'];

                $owners = $this->db->fetchAll(
                    "SELECT o.name, o.inn,
                            (SELECT COUNT(*) FROM wells WHERE owner_id = o.id) as wells,
                            (SELECT COUNT(*) FROM channel_directions WHERE owner_id = o.id) as channel_directions,
                            (SELECT COALESCE(SUM(length_m), 0) FROM channel_directions WHERE owner_id = o.id) as channel_directions_length_m,
                            (SELECT COUNT(*) FROM marker_posts WHERE owner_id = o.id) as marker_posts,
                            (SELECT COUNT(*) FROM cables WHERE owner_id = o.id) as cables,
                            (SELECT COALESCE(SUM(length_calculated), 0) FROM cables WHERE owner_id = o.id) as cables_length_m,
                            (SELECT COUNT(*) FROM contracts WHERE owner_id = o.id) as contracts
                     FROM owners o ORDER BY o.name"
                );
                foreach ($owners as $o) {
                    $data[] = array_values($o);
                }
                break;

            case 'inventory':
                $filename = 'report_inventory_' . date('Y-m-d') . '.csv';
                $headers = [
                    '№',
                    'Номер направления',
                    'Длина направления (м)',
                    'Кабели в направлении',
                    'Начальный колодец',
                    'Обнаружено (старт)',
                    'Бирки (старт)',
                    'Конечный колодец',
                    'Обнаружено (конец)',
                    'Бирки (конец)',
                    'Неучтённые',
                ];

                $ownerId = (int) $this->request->query('owner_id', 0); // собственник направления
                $tagOwnerId = (int) $this->request->query('tag_owner_id', 0); // собственник бирки
                $whereParts = [];
                $params = [];
                if ($ownerId > 0) {
                    $whereParts[] = "cd.owner_id = :oid";
                    $params['oid'] = $ownerId;
                }
                if ($tagOwnerId > 0) {
                    $whereParts[] = "(
                        EXISTS (SELECT 1 FROM inventory_tags itx WHERE itx.card_id = sc.card_id AND itx.owner_id = :toid)
                        OR
                        EXISTS (SELECT 1 FROM inventory_tags itx WHERE itx.card_id = ec.card_id AND itx.owner_id = :toid)
                    )";
                    $params['toid'] = $tagOwnerId;
                }
                $whereSql = $whereParts ? ("WHERE " . implode(" AND ", $whereParts)) : "";

                $rows = $this->db->fetchAll(
                    "WITH latest_cards AS (
                        SELECT DISTINCT ON (well_id) id as card_id, well_id, filled_date
                        FROM inventory_cards
                        ORDER BY well_id, filled_date DESC, id DESC
                    ),
                    tags_by_card AS (
                        SELECT it.card_id,
                               STRING_AGG(o.name, E'\n' ORDER BY it.id) as tag_owners,
                               STRING_AGG(it.owner_id::text, E'\n' ORDER BY it.id) as tag_owner_ids
                        FROM inventory_tags it
                        JOIN owners o ON it.owner_id = o.id
                        GROUP BY it.card_id
                    ),
                    cables_distinct AS (
                        SELECT DISTINCT
                            cd.id as direction_id,
                            c.id as cable_id,
                            c.number,
                            c.owner_id
                        FROM channel_directions cd
                        LEFT JOIN cable_channels ch ON ch.direction_id = cd.id
                        LEFT JOIN cable_route_channels crc ON crc.cable_channel_id = ch.id
                        LEFT JOIN cables c ON c.id = crc.cable_id
                        WHERE c.id IS NOT NULL
                    ),
                    cables_by_direction AS (
                        SELECT direction_id,
                               STRING_AGG(number, E'\n' ORDER BY number) as cable_numbers,
                               STRING_AGG(owner_id::text, E'\n' ORDER BY number) as cable_owner_ids
                        FROM cables_distinct
                        GROUP BY direction_id
                    )
                    SELECT
                        cd.id as direction_id,
                        cd.number as direction_number,
                        COALESCE(cd.length_m, ROUND(ST_Length(cd.geom_wgs84::geography)::numeric, 2), 0) as direction_length_m,
                        sw.number as start_well_number,
                        ew.number as end_well_number,
                        COALESCE(cbd.cable_numbers, '') as cable_numbers,
                        COALESCE(cbd.cable_owner_ids, '') as cable_owner_ids,
                        COALESCE(s.unaccounted_cables, 0) as unaccounted_cables,
                        sc.card_id as start_card_id,
                        COALESCE(sdc.cable_count, 0) as start_inventory_cables,
                        COALESCE(st.tag_owners, '') as start_tag_owners,
                        COALESCE(st.tag_owner_ids, '') as start_tag_owner_ids,
                        ec.card_id as end_card_id,
                        COALESCE(edc.cable_count, 0) as end_inventory_cables,
                        COALESCE(et.tag_owners, '') as end_tag_owners,
                        COALESCE(et.tag_owner_ids, '') as end_tag_owner_ids
                    FROM inventory_summary s
                    JOIN channel_directions cd ON cd.id = s.direction_id
                    LEFT JOIN wells sw ON cd.start_well_id = sw.id
                    LEFT JOIN wells ew ON cd.end_well_id = ew.id
                    LEFT JOIN cables_by_direction cbd ON cbd.direction_id = cd.id
                    LEFT JOIN latest_cards sc ON sc.well_id = cd.start_well_id
                    LEFT JOIN latest_cards ec ON ec.well_id = cd.end_well_id
                    LEFT JOIN inventory_direction_cables sdc ON sdc.card_id = sc.card_id AND sdc.direction_id = cd.id
                    LEFT JOIN inventory_direction_cables edc ON edc.card_id = ec.card_id AND edc.direction_id = cd.id
                    LEFT JOIN tags_by_card st ON st.card_id = sc.card_id
                    LEFT JOIN tags_by_card et ON et.card_id = ec.card_id
                    {$whereSql}
                    ORDER BY cd.number"
                    ,
                    $params
                );

                $i = 1;
                foreach ($rows as $r) {
                    $data[] = [
                        $i++,
                        (string) ($r['direction_number'] ?? ''),
                        (string) ($r['direction_length_m'] ?? ''),
                        (string) ($r['cable_numbers'] ?? ''),
                        (string) ($r['start_well_number'] ?? ''),
                        (string) ($r['start_inventory_cables'] ?? 0),
                        (string) ($r['start_tag_owners'] ?? ''),
                        (string) ($r['end_well_number'] ?? ''),
                        (string) ($r['end_inventory_cables'] ?? 0),
                        (string) ($r['end_tag_owners'] ?? ''),
                        (string) ($r['unaccounted_cables'] ?? 0),
                    ];
                }
                break;

            case 'inventory_recommendations':
                $ownerId = (int) $this->request->query('owner_id', 0);
                if ($ownerId <= 0) Response::error('Не указан собственник (owner_id)', 422);
                $owner = $this->db->fetch("SELECT name FROM owners WHERE id = :id", ['id' => $ownerId]);
                $ownerName = (string) ($owner['name'] ?? '');
                $filename = 'inventory_recommendations_' . $ownerId . '_' . date('Y-m-d') . '.csv';
                $headers = ['Раздел', '№', '№ колодца', '№ последней карточки', 'Дата последней карточки'];

                $latestCte = "WITH latest_cards AS (
                    SELECT DISTINCT ON (well_id)
                           well_id,
                           id,
                           number AS card_number,
                           filled_date AS card_date
                    FROM inventory_cards
                    ORDER BY well_id, filled_date DESC, id DESC
                )";
                $q1 = $this->db->fetchAll(
                    "{$latestCte}
                     SELECT w.number AS well_number, NULL::text AS card_number, NULL::date AS card_date
                     FROM wells w
                     LEFT JOIN latest_cards lc ON lc.well_id = w.id
                     WHERE w.owner_id = :oid AND lc.id IS NULL
                     ORDER BY w.number",
                    ['oid' => $ownerId]
                );
                $q2 = $this->db->fetchAll(
                    "{$latestCte}
                     SELECT w.number AS well_number, lc.card_number, lc.card_date
                     FROM wells w
                     JOIN latest_cards lc ON lc.well_id = w.id
                     WHERE w.owner_id = :oid AND lc.card_date < (CURRENT_DATE - INTERVAL '2 years')
                     ORDER BY w.number",
                    ['oid' => $ownerId]
                );
                $q3 = $this->db->fetchAll(
                    "{$latestCte},
                     avg_unacc AS (
                         SELECT COALESCE(AVG(unaccounted_cables)::numeric, 0) AS avg_val
                         FROM inventory_summary
                         WHERE unaccounted_cables > 0
                     ),
                     dir_wells AS (
                         SELECT start_well_id AS well_id, id AS direction_id FROM channel_directions
                         UNION ALL
                         SELECT end_well_id AS well_id, id AS direction_id FROM channel_directions
                     )
                     SELECT DISTINCT w.number AS well_number, lc.card_number, lc.card_date
                     FROM wells w
                     JOIN dir_wells dw ON dw.well_id = w.id
                     JOIN inventory_summary isum ON isum.direction_id = dw.direction_id
                     CROSS JOIN avg_unacc a
                     LEFT JOIN latest_cards lc ON lc.well_id = w.id
                     WHERE w.owner_id = :oid
                       AND isum.unaccounted_cables >= 4
                       AND isum.unaccounted_cables > a.avg_val
                     ORDER BY w.number",
                    ['oid' => $ownerId]
                );

                $pushSection = function(string $section, array $rows) use (&$data) {
                    $i = 0;
                    foreach ($rows as $r) {
                        $i++;
                        $data[] = [
                            $section,
                            $i,
                            (string) ($r['well_number'] ?? ''),
                            (string) ($r['card_number'] ?? ''),
                            $r['card_date'] ? (string) $r['card_date'] : '',
                        ];
                    }
                };
                $data[] = ['__SECTION__', 'Рекомендации по инвентаризации' . ($ownerName ? " ({$ownerName})" : '')];
                $pushSection('Не инвентаризированные колодцы', $q1);
                $pushSection('Инвентаризация более 2 лет назад', $q2);
                $pushSection('Количество неучтенных кабелей выше среднего', $q3);
                break;

            default:
                Response::error('Неизвестный тип отчёта', 400);
        }

        // Формируем CSV
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');

        $output = fopen('php://output', 'w');
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));
        
        if (!empty($headers)) {
            fputcsv($output, $headers, $delimiter);
        }
        foreach ($data as $row) {
            // Для мультисекционного экспорта контрактов: пропускаем технические маркеры и вставляем пустую строку
            if (is_array($row) && isset($row[0]) && $row[0] === '__SECTION__') {
                fputcsv($output, [], $delimiter);
                fputcsv($output, [(string) ($row[1] ?? '')], $delimiter);
                continue;
            }
            fputcsv($output, $row, $delimiter);
        }
        
        fclose($output);
        exit;
    }
}

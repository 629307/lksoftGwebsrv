<?php
/**
 * Предполагаемые кабели (3 варианта) по данным инвентаризации/бирок/существующих кабелей.
 */

namespace App\Controllers;

use App\Core\Auth;
use App\Core\Response;

class AssumedCableController extends BaseController
{
    /**
     * POST /api/assumed-cables/rebuild
     * Пересчитать и сохранить 3 сценария (variant_no=1..3).
     */
    public function rebuild(): void
    {
        $this->checkWriteAccess();

        // Если таблиц нет (миграция не применена) — не падать 500.
        try {
            $this->db->fetch("SELECT 1 FROM assumed_cable_scenarios LIMIT 1");
            $this->db->fetch("SELECT 1 FROM assumed_cables LIMIT 1");
        } catch (\Throwable $e) {
            Response::success(null, 'Таблицы предполагаемых кабелей отсутствуют (примените миграции)', 200);
        }

        $user = Auth::user();
        $userId = (int) ($user['id'] ?? 0);

        // 1) Направления с неучтёнными кабелями
        $edges = $this->db->fetchAll(
            "SELECT s.direction_id,
                    s.max_inventory_cables,
                    s.unaccounted_cables,
                    cd.number AS direction_number,
                    cd.start_well_id,
                    cd.end_well_id
             FROM inventory_summary s
             JOIN channel_directions cd ON cd.id = s.direction_id
             WHERE s.unaccounted_cables > 0
               AND cd.start_well_id IS NOT NULL
               AND cd.end_well_id IS NOT NULL
             ORDER BY cd.number"
        );

        // Нечего строить — очистим существующее и вернём OK
        if (!$edges) {
            $this->db->beginTransaction();
            try {
                $this->db->query("DELETE FROM assumed_cables");
                $this->db->query("DELETE FROM assumed_cable_scenarios");
                $this->db->commit();
            } catch (\Throwable $e) {
                $this->db->rollback();
            }
            Response::success([
                'variants' => [
                    ['variant_no' => 1, 'direction_rows' => 0],
                    ['variant_no' => 2, 'direction_rows' => 0],
                    ['variant_no' => 3, 'direction_rows' => 0],
                ],
            ], 'Нет направлений с неучтёнными кабелями');
        }

        $edgeByDir = [];
        $wellIds = [];
        $totalUnaccounted = 0;
        foreach ($edges as $r) {
            $dirId = (int) $r['direction_id'];
            $a = (int) $r['start_well_id'];
            $b = (int) $r['end_well_id'];
            $u = (int) $r['unaccounted_cables'];
            if ($dirId <= 0 || $a <= 0 || $b <= 0 || $u <= 0) continue;
            $edgeByDir[$dirId] = [
                'dir_id' => $dirId,
                'a' => $a,
                'b' => $b,
                'u' => $u,
                'max_inv' => (int) ($r['max_inventory_cables'] ?? 0),
                'direction_number' => (string) ($r['direction_number'] ?? ''),
            ];
            $wellIds[$a] = true;
            $wellIds[$b] = true;
            $totalUnaccounted += $u;
        }

        if (!$edgeByDir) {
            Response::success(null, 'Нет корректных данных для построения', 200);
        }

        // 2) Справочник собственников (для имён/цветов)
        $ownersRows = $this->db->fetchAll("SELECT id, code, name, color FROM owners ORDER BY id");
        $ownersById = [];
        foreach ($ownersRows as $o) {
            $oid = (int) ($o['id'] ?? 0);
            if ($oid <= 0) continue;
            $ownersById[$oid] = [
                'id' => $oid,
                'code' => (string) ($o['code'] ?? ''),
                'name' => (string) ($o['name'] ?? ''),
                'color' => (string) ($o['color'] ?? ''),
            ];
        }

        // 3) Тип "кабель в канализации" (для учёта существующих)
        $ductType = $this->db->fetch("SELECT id FROM object_types WHERE code = 'cable_duct' LIMIT 1");
        $ductTypeId = (int) ($ductType['id'] ?? 0);

        // 4) Бирки по последней инвентарной карточке каждого колодца
        $tagCounts = []; // [wellId][ownerId] => int
        try {
            $tagRows = $this->db->fetchAll(
                "WITH latest_cards AS (
                     SELECT DISTINCT ON (well_id) id, well_id
                     FROM inventory_cards
                     ORDER BY well_id, filled_date DESC, id DESC
                 )
                 SELECT lc.well_id, it.owner_id, COUNT(*)::int AS cnt
                 FROM latest_cards lc
                 JOIN inventory_tags it ON it.card_id = lc.id
                 GROUP BY lc.well_id, it.owner_id"
            );
            foreach ($tagRows as $tr) {
                $w = (int) ($tr['well_id'] ?? 0);
                $o = (int) ($tr['owner_id'] ?? 0);
                $c = (int) ($tr['cnt'] ?? 0);
                if ($w <= 0 || $o <= 0 || $c <= 0) continue;
                if (!isset($tagCounts[$w])) $tagCounts[$w] = [];
                $tagCounts[$w][$o] = $c;
            }
        } catch (\Throwable $e) {
            $tagCounts = [];
        }

        // 5) Существующие кабели по колодцу и собственнику (объясняют часть бирок)
        $existingWellOwner = []; // [wellId][ownerId] => int
        if ($ductTypeId > 0) {
            try {
                $existingRows = $this->db->fetchAll(
                    "SELECT crw.well_id, c.owner_id, COUNT(DISTINCT c.id)::int AS cnt
                     FROM cable_route_wells crw
                     JOIN cables c ON c.id = crw.cable_id
                     WHERE c.object_type_id = :tid
                       AND c.owner_id IS NOT NULL
                     GROUP BY crw.well_id, c.owner_id",
                    ['tid' => $ductTypeId]
                );
                foreach ($existingRows as $er) {
                    $w = (int) ($er['well_id'] ?? 0);
                    $o = (int) ($er['owner_id'] ?? 0);
                    $c = (int) ($er['cnt'] ?? 0);
                    if ($w <= 0 || $o <= 0 || $c <= 0) continue;
                    if (!isset($existingWellOwner[$w])) $existingWellOwner[$w] = [];
                    $existingWellOwner[$w][$o] = $c;
                }
            } catch (\Throwable $e) {
                $existingWellOwner = [];
            }
        }

        // 6) Собственники существующих кабелей на направлении (для варианта 3)
        $realDirOwners = []; // [directionId][ownerId] => int
        if ($ductTypeId > 0) {
            try {
                $realRows = $this->db->fetchAll(
                    "SELECT ch.direction_id, c.owner_id, COUNT(DISTINCT c.id)::int AS cnt
                     FROM cable_route_channels crc
                     JOIN cable_channels ch ON ch.id = crc.cable_channel_id
                     JOIN cables c ON c.id = crc.cable_id
                     WHERE c.object_type_id = :tid
                       AND c.owner_id IS NOT NULL
                     GROUP BY ch.direction_id, c.owner_id",
                    ['tid' => $ductTypeId]
                );
                foreach ($realRows as $rr) {
                    $d = (int) ($rr['direction_id'] ?? 0);
                    $o = (int) ($rr['owner_id'] ?? 0);
                    $c = (int) ($rr['cnt'] ?? 0);
                    if ($d <= 0 || $o <= 0 || $c <= 0) continue;
                    if (!isset($realDirOwners[$d])) $realDirOwners[$d] = [];
                    $realDirOwners[$d][$o] = $c;
                }
            } catch (\Throwable $e) {
                $realDirOwners = [];
            }
        }

        // 7) Supply по биркам: supply = max(0, tags - existingWellOwner)
        $supply0 = []; // [wellId][ownerId] => int
        foreach ($tagCounts as $w => $byOwner) {
            $w = (int) $w;
            foreach ($byOwner as $o => $cntTags) {
                $o = (int) $o;
                $t = (int) $cntTags;
                if ($w <= 0 || $o <= 0 || $t <= 0) continue;
                $e = (int) ($existingWellOwner[$w][$o] ?? 0);
                $s = $t - $e;
                if ($s <= 0) continue;
                if (!isset($supply0[$w])) $supply0[$w] = [];
                $supply0[$w][$o] = $s;
            }
        }

        // 8) Построение 3 вариантов
        $variants = [];

        $buildVariant = function(int $variantNo) use ($edgeByDir, $supply0, $tagCounts, $existingWellOwner, $ownersById): array {
            $rem = [];
            foreach ($edgeByDir as $dirId => $e) {
                $rem[$dirId] = (int) $e['u'];
            }

            // глубокая копия supply
            $supply = [];
            foreach ($supply0 as $w => $byOwner) {
                $supply[$w] = $byOwner ? array_map(fn($v) => (int) $v, $byOwner) : [];
            }

            $alloc = []; // [dirId][ownerId|null] => int (null key handled separately)

            $candidatesForEdge = function(array $edge) use (&$supply, $variantNo): array {
                $a = (int) $edge['a'];
                $b = (int) $edge['b'];
                $ca = $supply[$a] ?? [];
                $cb = $supply[$b] ?? [];

                $owners = [];
                if ($variantNo === 1) {
                    foreach ($ca as $oid => $sa) {
                        $oid = (int) $oid;
                        if ($sa <= 0) continue;
                        $sb = (int) ($cb[$oid] ?? 0);
                        if ($sb <= 0) continue;
                        $owners[$oid] = ['mode' => 'both'];
                    }
                    return $owners;
                }

                // variant 2/3 base: allow tags on one end (consumes only that end)
                foreach ($ca as $oid => $sa) {
                    $oid = (int) $oid;
                    if ($sa <= 0) continue;
                    $sb = (int) ($cb[$oid] ?? 0);
                    if ($sb > 0) $owners[$oid] = ['mode' => 'both'];
                    else $owners[$oid] = ['mode' => 'one_a'];
                }
                foreach ($cb as $oid => $sb) {
                    $oid = (int) $oid;
                    if ($sb <= 0) continue;
                    if (isset($owners[$oid])) continue;
                    $owners[$oid] = ['mode' => 'one_b'];
                }
                return $owners;
            };

            $availFor = function(array $edge, int $ownerId, string $mode) use (&$supply, $variantNo): int {
                $a = (int) $edge['a'];
                $b = (int) $edge['b'];
                $sa = (int) ($supply[$a][$ownerId] ?? 0);
                $sb = (int) ($supply[$b][$ownerId] ?? 0);
                if ($mode === 'both') return min($sa, $sb);
                if ($variantNo === 1) return 0;
                if ($mode === 'one_a') return $sa;
                if ($mode === 'one_b') return $sb;
                return 0;
            };

            $consume = function(array $edge, int $ownerId, string $mode, int $k) use (&$supply, $variantNo): void {
                if ($k <= 0) return;
                $a = (int) $edge['a'];
                $b = (int) $edge['b'];
                if ($mode === 'both') {
                    $supply[$a][$ownerId] = max(0, (int) ($supply[$a][$ownerId] ?? 0) - $k);
                    $supply[$b][$ownerId] = max(0, (int) ($supply[$b][$ownerId] ?? 0) - $k);
                    return;
                }
                if ($variantNo === 1) return;
                if ($mode === 'one_a') {
                    $supply[$a][$ownerId] = max(0, (int) ($supply[$a][$ownerId] ?? 0) - $k);
                    return;
                }
                if ($mode === 'one_b') {
                    $supply[$b][$ownerId] = max(0, (int) ($supply[$b][$ownerId] ?? 0) - $k);
                    return;
                }
            };

            // Forced allocations: edges with only 1 possible owner at the moment
            while (true) {
                $changed = false;
                foreach ($edgeByDir as $dirId => $edge) {
                    $dirId = (int) $dirId;
                    if (($rem[$dirId] ?? 0) <= 0) continue;
                    $cands = $candidatesForEdge($edge);
                    if (!$cands) continue;
                    // compute owners with avail>0
                    $availOwners = [];
                    foreach ($cands as $oid => $info) {
                        $oid = (int) $oid;
                        $a = $availFor($edge, $oid, (string) $info['mode']);
                        if ($a <= 0) continue;
                        $availOwners[$oid] = ['mode' => (string) $info['mode'], 'avail' => $a];
                    }
                    if (count($availOwners) !== 1) continue;
                    $oid = (int) array_key_first($availOwners);
                    $mode = (string) $availOwners[$oid]['mode'];
                    $k = min((int) $rem[$dirId], (int) $availOwners[$oid]['avail']);
                    if ($k <= 0) continue;
                    if (!isset($alloc[$dirId])) $alloc[$dirId] = [];
                    $alloc[$dirId][$oid] = (int) ($alloc[$dirId][$oid] ?? 0) + $k;
                    $rem[$dirId] -= $k;
                    $consume($edge, $oid, $mode, $k);
                    $changed = true;
                }
                if (!$changed) break;
            }

            // Greedy: pick best (edge, owner) and allocate batch
            $guard = 0;
            while (true) {
                $guard++;
                if ($guard > 200000) break;

                $best = null;
                foreach ($edgeByDir as $dirId => $edge) {
                    $dirId = (int) $dirId;
                    $r = (int) ($rem[$dirId] ?? 0);
                    if ($r <= 0) continue;
                    $cands = $candidatesForEdge($edge);
                    if (!$cands) continue;

                    $candAvail = [];
                    foreach ($cands as $oid => $info) {
                        $oid = (int) $oid;
                        $mode = (string) $info['mode'];
                        $a = $availFor($edge, $oid, $mode);
                        if ($a <= 0) continue;
                        $candAvail[$oid] = ['mode' => $mode, 'avail' => $a];
                    }
                    if (!$candAvail) continue;

                    $amb = count($candAvail);
                    foreach ($candAvail as $oid => $info) {
                        $oid = (int) $oid;
                        $mode = (string) $info['mode'];
                        $avail = (int) $info['avail'];
                        $a = (int) $edge['a'];
                        $b = (int) $edge['b'];
                        $tagsA = (int) ($tagCounts[$a][$oid] ?? 0);
                        $tagsB = (int) ($tagCounts[$b][$oid] ?? 0);
                        $exA = (int) ($existingWellOwner[$a][$oid] ?? 0);
                        $exB = (int) ($existingWellOwner[$b][$oid] ?? 0);
                        $minSupply = ($mode === 'both') ? min((int) ($supply[$a][$oid] ?? 0), (int) ($supply[$b][$oid] ?? 0))
                            : (($mode === 'one_a') ? (int) ($supply[$a][$oid] ?? 0) : (int) ($supply[$b][$oid] ?? 0));

                        $modeBonus = ($mode === 'both') ? 3000 : 0;
                        $uniqBonus = ($amb === 1) ? 5000 : 0;
                        $support = ($tagsA + $tagsB) - ($exA + $exB);
                        $support = max(0, $support);
                        $score = $uniqBonus + $modeBonus + ($support * 10) + ($minSupply * 3) - ($amb * 5);
                        if ($best === null || $score > $best['score']) {
                            $best = [
                                'dir_id' => $dirId,
                                'edge' => $edge,
                                'owner_id' => $oid,
                                'mode' => $mode,
                                'avail' => $avail,
                                'score' => $score,
                            ];
                        }
                    }
                }

                if ($best === null) break;

                $dirId = (int) $best['dir_id'];
                $oid = (int) $best['owner_id'];
                $mode = (string) $best['mode'];
                $edge = (array) $best['edge'];
                $k = min((int) ($rem[$dirId] ?? 0), (int) $best['avail']);
                if ($k <= 0) continue;

                if (!isset($alloc[$dirId])) $alloc[$dirId] = [];
                $alloc[$dirId][$oid] = (int) ($alloc[$dirId][$oid] ?? 0) + $k;
                $rem[$dirId] -= $k;
                $consume($edge, $oid, $mode, $k);
            }

            // Unknown остаток (owner_id NULL)
            foreach ($edgeByDir as $dirId => $_edge) {
                $dirId = (int) $dirId;
                $r = (int) ($rem[$dirId] ?? 0);
                if ($r <= 0) continue;
                if (!isset($alloc[$dirId])) $alloc[$dirId] = [];
                $alloc[$dirId]['__unknown__'] = (int) ($alloc[$dirId]['__unknown__'] ?? 0) + $r;
                $rem[$dirId] = 0;
            }

            return [
                'alloc' => $alloc,
            ];
        };

        // Variant 1
        $v1 = $buildVariant(1);
        // Variant 2
        $v2 = $buildVariant(2);
        // Variant 3 starts with variant 2 and fills remainder by real cable owners (direction-local)
        $v3Alloc = $v2['alloc'];
        foreach ($edgeByDir as $dirId => $edge) {
            $dirId = (int) $dirId;
            $u = (int) $edge['u'];
            $byOwner = $v3Alloc[$dirId] ?? [];
            $sum = 0;
            foreach ($byOwner as $k => $cnt) {
                $sum += (int) $cnt;
            }
            $rem = $u - $sum;
            if ($rem <= 0) continue;

            // сначала попробуем заполнить реальными собственниками существующих кабелей на направлении
            $real = $realDirOwners[$dirId] ?? [];
            if ($real) {
                arsort($real);
                $totalReal = 0;
                foreach ($real as $oid => $c) $totalReal += (int) $c;
                if ($totalReal > 0) {
                    $allocTmp = [];
                    $left = $rem;
                    foreach ($real as $oid => $c) {
                        $oid = (int) $oid;
                        $c = (int) $c;
                        if ($oid <= 0 || $c <= 0) continue;
                        $k = (int) floor($rem * ($c / $totalReal));
                        if ($k <= 0) continue;
                        $allocTmp[$oid] = $k;
                        $left -= $k;
                    }
                    // раздать остаток самым вероятным
                    if ($left > 0) {
                        foreach ($real as $oid => $c) {
                            $oid = (int) $oid;
                            if ($oid <= 0) continue;
                            if ($left <= 0) break;
                            $allocTmp[$oid] = (int) ($allocTmp[$oid] ?? 0) + 1;
                            $left--;
                        }
                    }
                    if ($left > 0) {
                        // если что-то осталось (редкий случай) — в unknown
                        $allocTmp['__unknown__'] = (int) ($allocTmp['__unknown__'] ?? 0) + $left;
                    }

                    foreach ($allocTmp as $oid => $k) {
                        if ($k <= 0) continue;
                        if (!isset($v3Alloc[$dirId])) $v3Alloc[$dirId] = [];
                        $v3Alloc[$dirId][$oid] = (int) ($v3Alloc[$dirId][$oid] ?? 0) + (int) $k;
                    }
                    continue;
                }
            }

            // иначе всё в unknown
            if (!isset($v3Alloc[$dirId])) $v3Alloc[$dirId] = [];
            $v3Alloc[$dirId]['__unknown__'] = (int) ($v3Alloc[$dirId]['__unknown__'] ?? 0) + $rem;
        }

        $variants = [
            1 => $v1['alloc'],
            2 => $v2['alloc'],
            3 => $v3Alloc,
        ];

        // 9) Сохранение (перезаписываем текущие сценарии каждого варианта)
        $this->db->beginTransaction();
        try {
            for ($variantNo = 1; $variantNo <= 3; $variantNo++) {
                $this->db->query(
                    "DELETE FROM assumed_cables
                     WHERE scenario_id IN (SELECT id FROM assumed_cable_scenarios WHERE variant_no = :v)",
                    ['v' => $variantNo]
                );
                $this->db->query("DELETE FROM assumed_cable_scenarios WHERE variant_no = :v", ['v' => $variantNo]);

                $scenarioId = (int) $this->db->insert('assumed_cable_scenarios', [
                    'variant_no' => $variantNo,
                    'built_by' => $userId > 0 ? $userId : null,
                    'params_json' => json_encode([
                        'build' => 'assumed_cables_v1',
                        'note' => 'inventory/tags/existing duct cables',
                    ], JSON_UNESCAPED_UNICODE),
                    'stats_json' => json_encode([
                        'directions' => count($edgeByDir),
                        'total_unaccounted' => $totalUnaccounted,
                    ], JSON_UNESCAPED_UNICODE),
                ]);

                $dirAlloc = $variants[$variantNo] ?? [];
                $rowsInserted = 0;
                foreach ($dirAlloc as $dirId => $byOwner) {
                    $dirId = (int) $dirId;
                    $edge = $edgeByDir[$dirId] ?? null;
                    if (!$edge) continue;
                    $a = (int) $edge['a'];
                    $b = (int) $edge['b'];

                    foreach ($byOwner as $ownerKey => $cnt) {
                        $cnt = (int) $cnt;
                        if ($cnt <= 0) continue;
                        $ownerId = null;
                        $mode = 'unknown';
                        $confidence = 0.15;

                        if ($ownerKey !== '__unknown__') {
                            $ownerId = (int) $ownerKey;
                            if ($variantNo === 1) {
                                $mode = 'tags_both_ends';
                                $confidence = 0.90;
                            } elseif ($variantNo === 2) {
                                // approx: both if supply existed on both ends at some point — estimate by raw tags
                                $hasA = ((int) ($tagCounts[$a][$ownerId] ?? 0)) > 0;
                                $hasB = ((int) ($tagCounts[$b][$ownerId] ?? 0)) > 0;
                                $mode = ($hasA && $hasB) ? 'tags_both_ends' : 'tags_one_end';
                                $confidence = ($mode === 'tags_both_ends') ? 0.70 : 0.50;
                            } else {
                                $mode = 'mixed';
                                $confidence = 0.35;
                            }
                        } else {
                            $mode = 'unknown';
                            $confidence = ($variantNo === 1) ? 0.20 : (($variantNo === 2) ? 0.18 : 0.10);
                        }

                        $evidence = [
                            'mode' => $mode,
                            'start_well_id' => $a,
                            'end_well_id' => $b,
                            'tags_start' => $ownerId ? (int) ($tagCounts[$a][$ownerId] ?? 0) : null,
                            'tags_end' => $ownerId ? (int) ($tagCounts[$b][$ownerId] ?? 0) : null,
                            'existing_start' => $ownerId ? (int) ($existingWellOwner[$a][$ownerId] ?? 0) : null,
                            'existing_end' => $ownerId ? (int) ($existingWellOwner[$b][$ownerId] ?? 0) : null,
                        ];

                        $this->db->insert('assumed_cables', [
                            'scenario_id' => $scenarioId,
                            'direction_id' => $dirId,
                            'owner_id' => $ownerId,
                            'assumed_count' => $cnt,
                            'confidence' => $confidence,
                            'evidence_json' => json_encode($evidence, JSON_UNESCAPED_UNICODE),
                        ]);
                        $rowsInserted++;
                    }
                }

                $variants[$variantNo] = [
                    'scenario_id' => $scenarioId,
                    'variant_no' => $variantNo,
                    'rows' => $rowsInserted,
                ];
            }

            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollback();
            Response::error('Ошибка пересчёта предполагаемых кабелей', 500);
        }

        try { $this->log('rebuild_assumed_cables', 'assumed_cable_scenarios', null, null, ['variants' => [1,2,3]]); } catch (\Throwable $e) {}

        Response::success([
            'variants' => [
                $variants[1],
                $variants[2],
                $variants[3],
            ],
        ], 'Сценарии предполагаемых кабелей пересчитаны');
    }

    /**
     * GET /api/assumed-cables/geojson?variant=1
     */
    public function geojson(): void
    {
        $variantNo = (int) $this->request->query('variant', 1);
        if (!in_array($variantNo, [1, 2, 3], true)) $variantNo = 1;

        // если таблиц нет — вернуть пустую коллекцию
        try {
            $this->db->fetch("SELECT 1 FROM assumed_cable_scenarios LIMIT 1");
        } catch (\Throwable $e) {
            Response::geojson([]);
        }

        $sc = $this->db->fetch(
            "SELECT id, variant_no, built_at
             FROM assumed_cable_scenarios
             WHERE variant_no = :v
             ORDER BY id DESC
             LIMIT 1",
            ['v' => $variantNo]
        );

        if (!$sc) {
            Response::geojson([], ['variant' => $variantNo]);
        }

        $scenarioId = (int) ($sc['id'] ?? 0);
        if ($scenarioId <= 0) Response::geojson([], ['variant' => $variantNo]);

        $rows = $this->db->fetchAll(
            "WITH agg AS (
                 SELECT ac.direction_id,
                        SUM(ac.assumed_count)::int AS assumed_total,
                        json_agg(
                            json_build_object(
                                'owner_id', ac.owner_id,
                                'owner_name', COALESCE(o.name, 'Не определён'),
                                'owner_color', COALESCE(o.color, ''),
                                'count', ac.assumed_count,
                                'confidence', ac.confidence
                            )
                            ORDER BY ac.assumed_count DESC, COALESCE(o.name, 'Не определён')
                        ) AS owners
                 FROM assumed_cables ac
                 LEFT JOIN owners o ON ac.owner_id = o.id
                 WHERE ac.scenario_id = :sid
                 GROUP BY ac.direction_id
             )
             SELECT cd.id AS direction_id,
                    cd.number AS direction_number,
                    ST_AsGeoJSON(cd.geom_wgs84)::text AS geom,
                    COALESCE(s.unaccounted_cables, 0)::int AS inv_unaccounted,
                    COALESCE(s.max_inventory_cables, 0)::int AS inv_max,
                    a.assumed_total,
                    a.owners
             FROM agg a
             JOIN channel_directions cd ON cd.id = a.direction_id
             LEFT JOIN inventory_summary s ON s.direction_id = cd.id
             WHERE cd.geom_wgs84 IS NOT NULL
             ORDER BY cd.number",
            ['sid' => $scenarioId]
        );

        $features = [];
        foreach ($rows as $r) {
            $geomJson = $r['geom'] ?? null;
            if (!$geomJson) continue;
            $geom = json_decode($geomJson, true);
            if (!$geom) continue;

            $owners = $r['owners'] ?? [];
            if (is_string($owners)) {
                $owners = json_decode($owners, true);
                if (!$owners) $owners = [];
            }

            $features[] = [
                'type' => 'Feature',
                'geometry' => $geom,
                'properties' => [
                    'direction_id' => (int) ($r['direction_id'] ?? 0),
                    'direction_number' => (string) ($r['direction_number'] ?? ''),
                    'variant_no' => $variantNo,
                    'scenario_id' => $scenarioId,
                    'inv_unaccounted' => (int) ($r['inv_unaccounted'] ?? 0),
                    'inv_max' => (int) ($r['inv_max'] ?? 0),
                    'assumed_total' => (int) ($r['assumed_total'] ?? 0),
                    'owners' => $owners,
                ],
            ];
        }

        Response::geojson($features, [
            'variant' => $variantNo,
            'scenario_id' => $scenarioId,
            'built_at' => (string) ($sc['built_at'] ?? ''),
        ]);
    }
}


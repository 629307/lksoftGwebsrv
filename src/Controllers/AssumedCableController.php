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
            $this->db->fetch("SELECT 1 FROM assumed_cable_routes LIMIT 1");
        } catch (\Throwable $e) {
            Response::success(null, 'Таблицы предполагаемых кабелей отсутствуют (примените миграции)', 200);
        }

        $user = Auth::user();
        $userId = (int) ($user['id'] ?? 0);

        // 1) Граф направлений (вся сеть) + ёмкости (неучтенные)
        $dirRows = $this->db->fetchAll(
            "SELECT cd.id,
                    cd.number,
                    cd.start_well_id,
                    cd.end_well_id,
                    COALESCE(
                        cd.length_m,
                        ROUND(ST_Length(COALESCE(cd.geom_wgs84, ST_Transform(cd.geom_msk86, 4326))::geography)::numeric, 2),
                        0
                    )::numeric AS length_m,
                    ST_AsGeoJSON(COALESCE(cd.geom_wgs84, ST_Transform(cd.geom_msk86, 4326)))::text AS geom
             FROM channel_directions cd
             WHERE cd.start_well_id IS NOT NULL
               AND cd.end_well_id IS NOT NULL
               AND (cd.geom_wgs84 IS NOT NULL OR cd.geom_msk86 IS NOT NULL)"
        );

        $dirs = []; // dirId => {a,b,length_m,geom_coords,number}
        foreach ($dirRows as $r) {
            $id = (int) ($r['id'] ?? 0);
            $a = (int) ($r['start_well_id'] ?? 0);
            $b = (int) ($r['end_well_id'] ?? 0);
            if ($id <= 0 || $a <= 0 || $b <= 0) continue;
            $geom = $r['geom'] ?? null;
            $g = $geom ? json_decode((string) $geom, true) : null;
            $coords = (is_array($g) && ($g['type'] ?? '') === 'LineString' && is_array($g['coordinates'] ?? null)) ? $g['coordinates'] : null;
            if (!$coords || count($coords) < 2) continue;
            $dirs[$id] = [
                'id' => $id,
                'number' => (string) ($r['number'] ?? ''),
                'a' => $a,
                'b' => $b,
                'length_m' => (float) ($r['length_m'] ?? 0),
                'coords' => $coords, // [[lng,lat],...]
            ];
        }

        $capRows = $this->db->fetchAll("SELECT direction_id, unaccounted_cables FROM inventory_summary WHERE unaccounted_cables > 0");
        $baseRem = []; // dirId => remaining capacity
        $totalUnaccounted = 0;
        foreach ($capRows as $r) {
            $dirId = (int) ($r['direction_id'] ?? 0);
            $u = (int) ($r['unaccounted_cables'] ?? 0);
            if ($dirId <= 0 || $u <= 0) continue;
            if (!isset($dirs[$dirId])) continue; // нет геометрии/направления
            $baseRem[$dirId] = $u;
            $totalUnaccounted += $u;
        }

        if ($totalUnaccounted <= 0 || !$baseRem) {
            $this->db->beginTransaction();
            try {
                $this->db->query("DELETE FROM assumed_cable_routes");
                $this->db->query("DELETE FROM assumed_cable_route_directions");
                $this->db->query("DELETE FROM assumed_cables");
                $this->db->query("DELETE FROM assumed_cable_scenarios");
                $this->db->commit();
            } catch (\Throwable $e) {
                $this->db->rollback();
            }
            Response::success(['variants' => []], 'Нет направлений с неучтёнными кабелями');
        }

        // 2) Тип "кабель в канализации" (для учёта существующих)
        $ductType = $this->db->fetch("SELECT id FROM object_types WHERE code = 'cable_duct' LIMIT 1");
        $ductTypeId = (int) ($ductType['id'] ?? 0);

        // 3) Бирки по последней карточке колодца + существующие кабели в колодце (вычитаем)
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
        } catch (\Throwable $e) {}

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
            } catch (\Throwable $e) {}
        }

        $supply0 = []; // [wellId][ownerId] => int
        foreach ($tagCounts as $w => $byOwner) {
            $w = (int) $w;
            foreach ($byOwner as $o => $t) {
                $o = (int) $o;
                $t = (int) $t;
                $e = (int) ($existingWellOwner[$w][$o] ?? 0);
                $s = $t - $e;
                if ($s <= 0) continue;
                if (!isset($supply0[$w])) $supply0[$w] = [];
                $supply0[$w][$o] = $s;
            }
        }

        // 4) Реальные собственники по направлениям (фоллбек для варианта 3)
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
            } catch (\Throwable $e) {}
        }

        // helpers
        $weightFor = function(int $variantNo, float $lengthM): float {
            // ВАЖНО:
            // Ранее v2/v3 добавляли большой "бонус за ребро", из-за чего алгоритм
            // начинал предпочитать маршруты по множеству коротких направлений (ответвления->ответвления),
            // что визуально выглядело как "малый граф -> малый граф".
            // Для "магистраль сначала" вес ребра должен определяться в первую очередь длиной.
            return $lengthM;
        };

        $deepCopySupply = function(array $s) {
            $out = [];
            foreach ($s as $w => $byOwner) {
                $out[(int) $w] = [];
                foreach ($byOwner as $o => $v) $out[(int) $w][(int) $o] = (int) $v;
            }
            return $out;
        };

        $buildRouteGeometry = function(array $route) use ($dirs): array {
            $dirIds = $route['direction_ids'] ?? [];
            $cur = (int) ($route['start_well_id'] ?? 0);
            $line = [];
            $length = 0.0;
            foreach ($dirIds as $dirId) {
                $dirId = (int) $dirId;
                $d = $dirs[$dirId] ?? null;
                if (!$d) continue;
                $length += (float) ($d['length_m'] ?? 0);
                $coords = $d['coords'] ?? [];
                $a = (int) ($d['a'] ?? 0);
                $b = (int) ($d['b'] ?? 0);
                $needReverse = ($cur && $cur === $b);
                if ($needReverse) $coords = array_reverse($coords);
                // concat
                if (!$line) {
                    $line = $coords;
                } else {
                    // skip duplicate join point
                    $first = $coords[0] ?? null;
                    $last = $line[count($line) - 1] ?? null;
                    if ($first && $last && is_array($first) && is_array($last) && count($first) >= 2 && count($last) >= 2) {
                        if ($first[0] === $last[0] && $first[1] === $last[1]) {
                            array_shift($coords);
                        }
                    }
                    $line = array_merge($line, $coords);
                }
                // advance current
                if ($cur === $a) $cur = $b;
                else if ($cur === $b) $cur = $a;
                else $cur = $b;
            }
            $geom = null;
            if ($line && count($line) >= 2) {
                $geom = json_encode(['type' => 'LineString', 'coordinates' => $line], JSON_UNESCAPED_UNICODE);
            }
            return ['geom' => $geom, 'length_m' => round($length, 2)];
        };

        $inferOwnerForRoute = function(int $variantNo, array $route, array &$supply) use ($realDirOwners, $dirs): array {
            $a = (int) ($route['start_well_id'] ?? 0);
            $b = (int) ($route['end_well_id'] ?? 0);
            $dirIds = array_map('intval', (array) ($route['direction_ids'] ?? []));

            // Для owner inference используем теги на ВСЕХ колодцах, через которые проходит маршрут.
            // Теги уже вычтены от существующих известных кабелей (supply0), поэтому здесь можно их "тратить".
            $routeWellIds = function() use ($a, $dirIds, $dirs) {
                $wells = [];
                $cur = (int) $a;
                if ($cur > 0) $wells[] = $cur;
                foreach ($dirIds as $dirId) {
                    $dirId = (int) $dirId;
                    $d = $dirs[$dirId] ?? null;
                    if (!$d) continue;
                    $wa = (int) ($d['a'] ?? 0);
                    $wb = (int) ($d['b'] ?? 0);
                    $next = 0;
                    if ($cur === $wa) $next = $wb;
                    else if ($cur === $wb) $next = $wa;
                    else $next = $wb;
                    if ($next > 0) {
                        $wells[] = $next;
                        $cur = $next;
                    }
                }
                // unique keep order
                $seen = [];
                $out = [];
                foreach ($wells as $w) {
                    $w = (int) $w;
                    if ($w <= 0 || isset($seen[$w])) continue;
                    $seen[$w] = true;
                    $out[] = $w;
                }
                return $out;
            };

            $wellsOnRoute = $routeWellIds();

            // aggregate scores by owner across all wells on route
            $scores = []; // ownerId => ['score'=>sum, 'hits'=>wellsWithTag]
            foreach ($wellsOnRoute as $w) {
                foreach (($supply[$w] ?? []) as $oid => $cnt) {
                    $oid = (int) $oid;
                    $cnt = (int) $cnt;
                    if ($oid <= 0 || $cnt <= 0) continue;
                    if (!isset($scores[$oid])) $scores[$oid] = ['score' => 0, 'hits' => 0];
                    $scores[$oid]['score'] += $cnt;
                    $scores[$oid]['hits'] += 1;
                }
            }
            $candidates = [];
            if ($scores) {
                foreach ($scores as $oid => $s) {
                    $oid = (int) $oid;
                    $score = (int) ($s['score'] ?? 0);
                    $hits = (int) ($s['hits'] ?? 0);
                    if ($oid <= 0 || $score <= 0) continue;
                    $candidates[] = ['owner_id' => $oid, 'score' => $score, 'hits' => $hits];
                }
                usort($candidates, fn($a, $b) => (($b['score'] ?? 0) <=> ($a['score'] ?? 0)) ?: (($b['hits'] ?? 0) <=> ($a['hits'] ?? 0)));
                $candidates = array_slice($candidates, 0, 10);
            }
            if ($scores) {
                // pick by max score, then max hits
                $bestOwner = null;
                foreach ($scores as $oid => $s) {
                    $oid = (int) $oid;
                    $score = (int) ($s['score'] ?? 0);
                    $hits = (int) ($s['hits'] ?? 0);
                    if ($oid <= 0 || $score <= 0) continue;
                    if ($bestOwner === null) {
                        $bestOwner = ['owner_id' => $oid, 'score' => $score, 'hits' => $hits];
                        continue;
                    }
                    if ($score > $bestOwner['score'] || ($score === $bestOwner['score'] && $hits > $bestOwner['hits'])) {
                        $bestOwner = ['owner_id' => $oid, 'score' => $score, 'hits' => $hits];
                    }
                }
                if ($bestOwner) {
                    $oid = (int) $bestOwner['owner_id'];
                    // ТЗ: если кабель проходит через колодец с owner tag, он может быть назначен этому owner.
                    // Поэтому назначаем при наличии хотя бы одного тега на маршруте, а уверенность повышаем,
                    // если теги встречаются в нескольких колодцах по маршруту.
                    $need = 1; // тратим один tag на один маршрут
                    foreach ($wellsOnRoute as $w) {
                        if ($need <= 0) break;
                        $curCnt = (int) ($supply[$w][$oid] ?? 0);
                        if ($curCnt <= 0) continue;
                        $supply[$w][$oid] = max(0, $curCnt - 1);
                        $need--;
                    }
                    $hits = (int) ($bestOwner['hits'] ?? 0);
                    $conf = ($hits >= 2) ? 0.85 : 0.60;
                    if ($variantNo === 2) $conf = ($hits >= 2) ? 0.80 : 0.65;
                    if ($variantNo >= 3) $conf = ($hits >= 2) ? 0.75 : 0.55;
                    return [
                        'owner_id' => $oid,
                        'confidence' => $conf,
                        'mode' => ($hits >= 2 ? 'tags_multi_wells' : 'tags_any_well'),
                        'well_ids' => $wellsOnRoute,
                        'owner_candidates' => $candidates,
                    ];
                }
            }

            if ($variantNo >= 3) {
                // fallback: existing real cables owners on directions of route
                $votes = [];
                foreach ($dirIds as $dirId) {
                    foreach (($realDirOwners[$dirId] ?? []) as $oid => $cnt) {
                        $oid = (int) $oid; $cnt = (int) $cnt;
                        if ($oid <= 0 || $cnt <= 0) continue;
                        $votes[$oid] = (int) ($votes[$oid] ?? 0) + $cnt;
                    }
                }
                if ($votes) {
                    arsort($votes);
                    $oid = (int) array_key_first($votes);
                    if ($oid > 0) return ['owner_id' => $oid, 'confidence' => 0.35, 'mode' => 'real_cables_fallback', 'well_ids' => $wellsOnRoute, 'owner_candidates' => $candidates];
                }
            }

            return ['owner_id' => null, 'confidence' => 0.15, 'mode' => 'unknown', 'well_ids' => $wellsOnRoute, 'owner_candidates' => $candidates];
        };

        // --- 3 независимых алгоритма (METHOD 1/2/3) ---
        // Общие утилиты: подграф capacity>0, компоненты, "longest path" (эвристика: диаметр по длине).

        $dijkstra = function(int $start, array $adj): array {
            $dist = [$start => 0.0];
            $parentNode = [$start => 0];
            $parentEdge = [];
            $pq = new \SplPriorityQueue();
            $pq->setExtractFlags(\SplPriorityQueue::EXTR_BOTH);
            $pq->insert($start, 0.0); // priority = -dist (we store negative dist)
            while (!$pq->isEmpty()) {
                $cur = $pq->extract();
                $u = (int) ($cur['data'] ?? 0);
                $d = -1.0 * (float) ($cur['priority'] ?? 0);
                if ($u <= 0) continue;
                if ($d > (float) ($dist[$u] ?? 1e100) + 1e-9) continue;
                foreach (($adj[$u] ?? []) as $e) {
                    $v = (int) ($e['to'] ?? 0);
                    $w = (float) ($e['w'] ?? 0);
                    $eid = (int) ($e['dir'] ?? 0);
                    if ($v <= 0 || $w <= 0 || $eid <= 0) continue;
                    $nd = $d + $w;
                    if (!isset($dist[$v]) || $nd < (float) $dist[$v] - 1e-9) {
                        $dist[$v] = $nd;
                        $parentNode[$v] = $u;
                        $parentEdge[$v] = $eid;
                        $pq->insert($v, -1.0 * $nd);
                    }
                }
            }
            $far = $start;
            $best = -1.0;
            foreach ($dist as $n => $d) {
                $n = (int) $n;
                $d = (float) $d;
                if ($d > $best) { $best = $d; $far = $n; }
            }
            return [$far, $best, $dist, $parentNode, $parentEdge];
        };

        $diameterPath = function(array $dirIds, array $rem) use ($dirs, $dijkstra): ?array {
            // build adj limited to dirIds and rem>0
            $adj = [];
            foreach ($dirIds as $dirId) {
                $dirId = (int) $dirId;
                if ($dirId <= 0) continue;
                if ((int) ($rem[$dirId] ?? 0) <= 0) continue;
                $d = $dirs[$dirId] ?? null;
                if (!$d) continue;
                $a = (int) ($d['a'] ?? 0);
                $b = (int) ($d['b'] ?? 0);
                if ($a <= 0 || $b <= 0) continue;
                $w = (float) ($d['length_m'] ?? 0);
                if (!isset($adj[$a])) $adj[$a] = [];
                if (!isset($adj[$b])) $adj[$b] = [];
                $adj[$a][] = ['to' => $b, 'dir' => $dirId, 'w' => $w];
                $adj[$b][] = ['to' => $a, 'dir' => $dirId, 'w' => $w];
            }
            if (!$adj) return null;
            $start = (int) array_key_first($adj);
            if ($start <= 0) return null;
            [$aNode] = $dijkstra($start, $adj);
            [$bNode, $diam, $_dist2, $pn2, $pe2] = $dijkstra($aNode, $adj);
            if ($diam <= 0) return null;
            // reconstruct dir path from bNode to aNode
            $pathDirs = [];
            $cur = (int) $bNode;
            while ($cur !== (int) $aNode && isset($pn2[$cur])) {
                $eid = (int) ($pe2[$cur] ?? 0);
                if ($eid > 0) $pathDirs[] = $eid;
                $cur = (int) ($pn2[$cur] ?? 0);
                if ($cur <= 0) break;
            }
            $pathDirs = array_reverse($pathDirs);
            if (!$pathDirs) return null;
            return [
                'start_well_id' => (int) $aNode,
                'end_well_id' => (int) $bNode,
                'direction_ids' => $pathDirs,
                'weight' => (float) $diam,
            ];
        };

        $buildCapacityComponents = function(array $rem, array $supply0) use ($dirs): array {
            // components on subgraph where rem>0
            $adj = [];
            foreach ($rem as $dirId => $cap) {
                $cap = (int) $cap;
                if ($cap <= 0) continue;
                $dirId = (int) $dirId;
                $d = $dirs[$dirId] ?? null;
                if (!$d) continue;
                $a = (int) ($d['a'] ?? 0);
                $b = (int) ($d['b'] ?? 0);
                if ($a <= 0 || $b <= 0) continue;
                if (!isset($adj[$a])) $adj[$a] = [];
                if (!isset($adj[$b])) $adj[$b] = [];
                $adj[$a][] = [$b, $dirId];
                $adj[$b][] = [$a, $dirId];
            }
            if (!$adj) return [];
            $visited = [];
            $out = [];
            foreach (array_keys($adj) as $start) {
                $start = (int) $start;
                if ($start <= 0 || isset($visited[$start])) continue;
                $stack = [$start];
                $visited[$start] = true;
                $wellSet = [];
                $dirSet = [];
                while ($stack) {
                    $u = (int) array_pop($stack);
                    $wellSet[$u] = true;
                    foreach (($adj[$u] ?? []) as $e) {
                        $v = (int) ($e[0] ?? 0);
                        $dirId = (int) ($e[1] ?? 0);
                        if ($dirId > 0) $dirSet[$dirId] = true;
                        if ($v > 0 && !isset($visited[$v])) {
                            $visited[$v] = true;
                            $stack[] = $v;
                        }
                    }
                }
                $wellIds = array_keys($wellSet);
                $dirIds = array_keys($dirSet);
                if (!$dirIds) continue;
                $sumCap = 0;
                foreach ($dirIds as $dirId) $sumCap += (int) ($rem[(int) $dirId] ?? 0);
                $tags = 0;
                foreach ($wellIds as $w) {
                    foreach (($supply0[(int) $w] ?? []) as $oid => $cnt) $tags += (int) $cnt;
                }
                $out[] = [
                    'well_ids' => $wellIds,
                    'dir_ids' => $dirIds,
                    'edges_count' => count($dirIds),
                    'sum_capacity' => $sumCap,
                    'owner_tags_count' => $tags,
                ];
            }
            return $out;
        };

        // METHOD 1: Weighted Components
        $buildRoutesMethod1 = function(array $baseRem, array $supply0) use ($buildCapacityComponents, $diameterPath, $dirs): array {
            $rem = $baseRem;
            $routes = [];
            $comps = $buildCapacityComponents($rem, $supply0);
            foreach ($comps as &$c) {
                $w = (int) ($c['edges_count'] ?? 0)
                    + 2 * (int) ($c['sum_capacity'] ?? 0)
                    + 3 * (int) ($c['owner_tags_count'] ?? 0);
                $c['weight'] = $w;
            }
            unset($c);
            usort($comps, fn($a, $b) => ((int) ($b['weight'] ?? 0) <=> (int) ($a['weight'] ?? 0)));
            foreach ($comps as $c) {
                $dirIds = $c['dir_ids'] ?? [];
                if (!$dirIds) continue;
                while (true) {
                    // stop if no remaining in this component
                    $has = false;
                    foreach ($dirIds as $dirId) { if ((int) ($rem[(int) $dirId] ?? 0) > 0) { $has = true; break; } }
                    if (!$has) break;
                    $best = $diameterPath($dirIds, $rem);
                    if (!$best) {
                        // fallback: choose longest remaining edge in component
                        $pickId = 0;
                        $pickLen = -1.0;
                        foreach ($dirIds as $dirId) {
                            $dirId = (int) $dirId;
                            if ((int) ($rem[$dirId] ?? 0) <= 0) continue;
                            $d = $dirs[$dirId] ?? null;
                            if (!$d) continue;
                            $len = (float) ($d['length_m'] ?? 0);
                            if ($len > $pickLen) { $pickLen = $len; $pickId = $dirId; }
                        }
                        if ($pickId <= 0) break;
                        $d = $dirs[$pickId] ?? null;
                        if (!$d) break;
                        $best = [
                            'start_well_id' => (int) ($d['a'] ?? 0),
                            'end_well_id' => (int) ($d['b'] ?? 0),
                            'direction_ids' => [$pickId],
                            'weight' => $pickLen > 0 ? $pickLen : 0.0,
                        ];
                    }
                    $okConsume = true;
                    foreach (($best['direction_ids'] ?? []) as $dirId) {
                        $dirId = (int) $dirId;
                        if ((int) ($rem[$dirId] ?? 0) <= 0) { $okConsume = false; break; }
                        $rem[$dirId] = (int) $rem[$dirId] - 1;
                    }
                    if (!$okConsume) break;
                    $routes[] = $best;
                }
            }
            return $routes;
        };

        // METHOD 2: K Longest Paths with Capacity (эвристика)
        $buildRoutesMethod2 = function(array $baseRem, int $k = 250) use ($buildCapacityComponents, $dijkstra, $dirs): array {
            $rem = $baseRem;
            $comps = $buildCapacityComponents($baseRem, []);
            $cands = [];
            $candSeen = [];
            foreach ($comps as $c) {
                $dirIds = $c['dir_ids'] ?? [];
                $wellIds = $c['well_ids'] ?? [];
                if (!$dirIds || !$wellIds) continue;
                // build adj once for this component
                $adj = [];
                foreach ($dirIds as $dirId) {
                    $dirId = (int) $dirId;
                    if ($dirId <= 0) continue;
                    if ((int) ($baseRem[$dirId] ?? 0) <= 0) continue;
                    $d = $dirs[$dirId] ?? null;
                    if (!$d) continue;
                    $a = (int) ($d['a'] ?? 0);
                    $b = (int) ($d['b'] ?? 0);
                    if ($a <= 0 || $b <= 0) continue;
                    $w = (float) ($d['length_m'] ?? 0);
                    if (!isset($adj[$a])) $adj[$a] = [];
                    if (!isset($adj[$b])) $adj[$b] = [];
                    $adj[$a][] = ['to' => $b, 'dir' => $dirId, 'w' => $w];
                    $adj[$b][] = ['to' => $a, 'dir' => $dirId, 'w' => $w];
                }
                if (!$adj) continue;
                // seeds: endpoints first
                $seeds = [];
                foreach ($adj as $w => $edges) {
                    if (count($edges) === 1) $seeds[] = (int) $w;
                }
                if (!$seeds) $seeds[] = (int) array_key_first($adj);
                $seeds = array_slice($seeds, 0, 8);

                foreach ($seeds as $seed) {
                    $seed = (int) $seed;
                    if ($seed <= 0) continue;
                    [$aNode] = $dijkstra($seed, $adj);
                    [$bNode, $diam, $_dist2, $pn2, $pe2] = $dijkstra($aNode, $adj);
                    if ($diam <= 0) continue;
                    $pathDirs = [];
                    $cur = (int) $bNode;
                    while ($cur !== (int) $aNode && isset($pn2[$cur])) {
                        $eid = (int) ($pe2[$cur] ?? 0);
                        if ($eid > 0) $pathDirs[] = $eid;
                        $cur = (int) ($pn2[$cur] ?? 0);
                        if ($cur <= 0) break;
                    }
                    $pathDirs = array_reverse($pathDirs);
                    if (!$pathDirs) continue;
                    $key1 = implode(',', $pathDirs);
                    $key2 = implode(',', array_reverse($pathDirs));
                    $key = strcmp($key1, $key2) <= 0 ? $key1 : $key2;
                    if (isset($candSeen[$key])) continue;
                    $candSeen[$key] = true;
                    $cands[] = [
                        'start_well_id' => (int) $aNode,
                        'end_well_id' => (int) $bNode,
                        'direction_ids' => $pathDirs,
                        'weight' => (float) $diam,
                    ];
                }
            }
            usort($cands, fn($a, $b) => ((float) ($b['weight'] ?? 0) <=> (float) ($a['weight'] ?? 0)));
            $cands = array_slice($cands, 0, max(1, $k));

            $routes = [];
            $maxRoutes = 20000;
            $progress = true;
            while ($progress && count($routes) < $maxRoutes) {
                $progress = false;
                foreach ($cands as $cand) {
                    $dirIds = (array) ($cand['direction_ids'] ?? []);
                    if (!$dirIds) continue;
                    $ok = true;
                    foreach ($dirIds as $dirId) {
                        $dirId = (int) $dirId;
                        if ((int) ($rem[$dirId] ?? 0) <= 0) { $ok = false; break; }
                    }
                    if (!$ok) continue;
                    foreach ($dirIds as $dirId) {
                        $dirId = (int) $dirId;
                        $rem[$dirId] = (int) ($rem[$dirId] ?? 0) - 1;
                    }
                    $routes[] = $cand;
                    $progress = true;
                    if (count($routes) >= $maxRoutes) break;
                }
            }

            // добиваем остатки одиночными рёбрами (чтобы не оставлять rem)
            foreach ($rem as $dirId => $cap) {
                $dirId = (int) $dirId;
                $cap = (int) $cap;
                if ($dirId <= 0 || $cap <= 0) continue;
                $d = $dirs[$dirId] ?? null;
                if (!$d) continue;
                for ($i = 0; $i < $cap && count($routes) < $maxRoutes; $i++) {
                    $routes[] = [
                        'start_well_id' => (int) ($d['a'] ?? 0),
                        'end_well_id' => (int) ($d['b'] ?? 0),
                        'direction_ids' => [$dirId],
                        'weight' => (float) ($d['length_m'] ?? 0),
                    ];
                }
            }
            return $routes;
        };

        // METHOD 3: Min Cost Max Flow (DAG-ориентация + последовательные кратчайшие пути по cost=-length)
        // Для устойчивости избегаем отрицательных циклов: ориентируем направления по (lng,lat,id).
        $wellRank = [];
        try {
            $wells = $this->db->fetchAll(
                "SELECT id,
                        ST_X(COALESCE(geom_wgs84, ST_Transform(geom_msk86, 4326))) AS lng,
                        ST_Y(COALESCE(geom_wgs84, ST_Transform(geom_msk86, 4326))) AS lat
                 FROM wells
                 WHERE geom_wgs84 IS NOT NULL OR geom_msk86 IS NOT NULL"
            );
            usort($wells, function($a, $b) {
                $ax = (float) ($a['lng'] ?? 0); $bx = (float) ($b['lng'] ?? 0);
                if ($ax !== $bx) return ($ax <=> $bx);
                $ay = (float) ($a['lat'] ?? 0); $by = (float) ($b['lat'] ?? 0);
                if ($ay !== $by) return ($ay <=> $by);
                return ((int) ($a['id'] ?? 0) <=> (int) ($b['id'] ?? 0));
            });
            $r = 1;
            foreach ($wells as $w) {
                $id = (int) ($w['id'] ?? 0);
                if ($id > 0) $wellRank[$id] = $r++;
            }
        } catch (\Throwable $e) {}

        $buildRoutesMethod3 = function(array $baseRem) use ($dirs, $wellRank): array {
            $rem = $baseRem;
            $routes = [];
            $S = 0;
            $T = -1;

            // topo order: S, wells sorted by rank/id, T
            $wellIds = [];
            foreach ($rem as $dirId => $cap) {
                if ((int) $cap <= 0) continue;
                $d = $dirs[(int) $dirId] ?? null;
                if (!$d) continue;
                $wellIds[(int) ($d['a'] ?? 0)] = true;
                $wellIds[(int) ($d['b'] ?? 0)] = true;
            }
            $wellIds = array_keys(array_filter($wellIds, fn($x) => (int)$x > 0));
            usort($wellIds, function($a, $b) use ($wellRank) {
                $ra = (int) ($wellRank[(int)$a] ?? 0);
                $rb = (int) ($wellRank[(int)$b] ?? 0);
                if ($ra && $rb && $ra !== $rb) return $ra <=> $rb;
                if ($ra && !$rb) return -1;
                if (!$ra && $rb) return 1;
                return ((int)$a <=> (int)$b);
            });
            $topo = array_merge([$S], $wellIds, [$T]);

            $INF = 1000000000;

            // build outEdges each iteration uses rem, but topology constant
            $baseOut = [];
            foreach ($wellIds as $w) {
                $baseOut[$w] = [];
            }
            $baseOut[$S] = [];
            $baseOut[$T] = [];

            // S -> wells, wells -> T
            foreach ($wellIds as $w) {
                $baseOut[$S][] = ['to' => $w, 'type' => 'aux', 'cost' => 0.0, 'cap' => $INF];
                $baseOut[$w][] = ['to' => $T, 'type' => 'aux', 'cost' => 0.0, 'cap' => $INF];
            }

            // direction edges, oriented by rank/id
            foreach ($rem as $dirId => $cap) {
                $dirId = (int) $dirId;
                $cap = (int) $cap;
                if ($dirId <= 0 || $cap <= 0) continue;
                $d = $dirs[$dirId] ?? null;
                if (!$d) continue;
                $a = (int) ($d['a'] ?? 0);
                $b = (int) ($d['b'] ?? 0);
                if ($a <= 0 || $b <= 0) continue;
                $ra = (int) ($wellRank[$a] ?? 0);
                $rb = (int) ($wellRank[$b] ?? 0);
                $u = $a; $v = $b;
                if (($ra && $rb && $ra > $rb) || (!$ra && !$rb && $a > $b) || ($ra && !$rb)) {
                    $u = $b; $v = $a;
                }
                if (!isset($baseOut[$u])) $baseOut[$u] = [];
                $cost = -1.0 * (float) ($d['length_m'] ?? 0);
                $baseOut[$u][] = ['to' => $v, 'type' => 'dir', 'dir' => $dirId, 'cost' => $cost];
            }

            $maxRoutes = 20000;
            while (count($routes) < $maxRoutes) {
                // shortest path in DAG (topo DP)
                $dist = [];
                $parN = [];
                $parE = [];
                foreach ($topo as $n) $dist[$n] = 1e100;
                $dist[$S] = 0.0;

                foreach ($topo as $u) {
                    $du = (float) ($dist[$u] ?? 1e100);
                    if ($du >= 1e90) continue;
                    foreach (($baseOut[$u] ?? []) as $e) {
                        $to = $e['to'];
                        $type = $e['type'] ?? 'aux';
                        if ($type === 'dir') {
                            $dirId = (int) ($e['dir'] ?? 0);
                            if ($dirId <= 0) continue;
                            if ((int) ($rem[$dirId] ?? 0) <= 0) continue;
                        }
                        $nd = $du + (float) ($e['cost'] ?? 0);
                        if ($nd < (float) ($dist[$to] ?? 1e100) - 1e-9) {
                            $dist[$to] = $nd;
                            $parN[$to] = $u;
                            $parE[$to] = $e;
                        }
                    }
                }

                $bestCost = (float) ($dist[$T] ?? 1e100);
                if ($bestCost >= -1e-9 || $bestCost >= 1e90) break; // no negative-cost route left

                // reconstruct path
                $nodes = [];
                $dirIds = [];
                $cur = $T;
                while ($cur !== $S && isset($parN[$cur])) {
                    $e = $parE[$cur] ?? null;
                    $p = $parN[$cur];
                    $nodes[] = $cur;
                    if (($e['type'] ?? '') === 'dir') {
                        $dirIds[] = (int) ($e['dir'] ?? 0);
                    }
                    $cur = $p;
                }
                $nodes[] = $S;
                $nodes = array_reverse($nodes);
                $dirIds = array_reverse($dirIds);
                if (!$dirIds) break;

                // start/end wells
                $startWell = 0;
                $endWell = 0;
                foreach ($nodes as $n) {
                    $n = (int) $n;
                    if ($n > 0) { $startWell = $n; break; }
                }
                for ($i = count($nodes) - 1; $i >= 0; $i--) {
                    $n = (int) $nodes[$i];
                    if ($n > 0) { $endWell = $n; break; }
                }

                // consume 1 on each edge
                foreach ($dirIds as $dirId) {
                    $dirId = (int) $dirId;
                    if ((int) ($rem[$dirId] ?? 0) <= 0) { $dirIds = []; break; }
                    $rem[$dirId] = (int) $rem[$dirId] - 1;
                }
                if (!$dirIds) break;

                $routes[] = [
                    'start_well_id' => $startWell,
                    'end_well_id' => $endWell,
                    'direction_ids' => $dirIds,
                    'weight' => -1.0 * $bestCost,
                ];
            }

            // остатки одиночными рёбрами
            foreach ($rem as $dirId => $cap) {
                $dirId = (int) $dirId;
                $cap = (int) $cap;
                if ($dirId <= 0 || $cap <= 0) continue;
                $d = $dirs[$dirId] ?? null;
                if (!$d) continue;
                for ($i = 0; $i < $cap && count($routes) < $maxRoutes; $i++) {
                    $routes[] = [
                        'start_well_id' => (int) ($d['a'] ?? 0),
                        'end_well_id' => (int) ($d['b'] ?? 0),
                        'direction_ids' => [$dirId],
                        'weight' => (float) ($d['length_m'] ?? 0),
                    ];
                }
            }

            return $routes;
        };

        $buildRoutesForVariant = function(int $variantNo, array $baseRem) use ($buildRoutesMethod1, $buildRoutesMethod2, $buildRoutesMethod3, $supply0): array {
            if ($variantNo === 1) return $buildRoutesMethod1($baseRem, $supply0);
            if ($variantNo === 2) return $buildRoutesMethod2($baseRem, 250);
            return $buildRoutesMethod3($baseRem);
        };

        // 5) Сохранение: 3 варианта (маршруты + собственник)
        $resultVariants = [];
        $this->db->beginTransaction();
        try {
            for ($variantNo = 1; $variantNo <= 3; $variantNo++) {
                // очистим старые сценарии (cascade)
                $this->db->query("DELETE FROM assumed_cable_scenarios WHERE variant_no = :v", ['v' => $variantNo]);

                $scenarioId = (int) $this->db->insert('assumed_cable_scenarios', [
                    'variant_no' => $variantNo,
                    'built_by' => $userId > 0 ? $userId : null,
                    'params_json' => json_encode([
                        'build' => 'assumed_routes_v1',
                        'graph' => 'all_wells_and_directions',
                        'capacity' => 'inventory_summary.unaccounted_cables',
                        'weight' => 'length_m',
                    ], JSON_UNESCAPED_UNICODE),
                    'stats_json' => json_encode([
                        'total_unaccounted' => $totalUnaccounted,
                    ], JSON_UNESCAPED_UNICODE),
                ]);

                $routes = $buildRoutesForVariant($variantNo, $baseRem);
                $supply = $deepCopySupply($supply0);

                $routesTotal = 0;
                $ownersAssigned = 0;
                $totalLengthM = 0.0;
                $totalEdgeUnits = 0;
                foreach ($routes as $rt) {
                    $rt['variant_no'] = $variantNo;
                    $geo = $buildRouteGeometry($rt);
                    $geomJson = $geo['geom'];
                    $lenM = (float) ($geo['length_m'] ?? 0);
                    $rt['length_m'] = $lenM;
                    $totalLengthM += $lenM;
                    $totalEdgeUnits += count((array) ($rt['direction_ids'] ?? []));
                    $owner = $inferOwnerForRoute($variantNo, $rt, $supply);
                    $ownerId = $owner['owner_id'] ?? null;
                    $confidence = (float) ($owner['confidence'] ?? 0);
                    $mode = (string) ($owner['mode'] ?? 'unknown');
                    $wellIds = (array) ($owner['well_ids'] ?? []);
                    $ownerCandidates = (array) ($owner['owner_candidates'] ?? []);
                    if ($ownerId) $ownersAssigned++;

                    $evidence = [
                        'mode' => $mode,
                        'direction_ids' => array_values(array_map('intval', (array) ($rt['direction_ids'] ?? []))),
                        'start_well_id' => (int) ($rt['start_well_id'] ?? 0),
                        'end_well_id' => (int) ($rt['end_well_id'] ?? 0),
                        'well_ids' => array_values(array_map('intval', $wellIds)),
                        'owner_candidates' => $ownerCandidates,
                    ];

                    $sql = "INSERT INTO assumed_cable_routes
                            (scenario_id, owner_id, confidence, start_well_id, end_well_id, length_m, geom_wgs84, evidence_json)
                            VALUES
                            (:sid, :oid, :conf, :sw, :ew, :len,
                             ST_SetSRID(ST_GeomFromGeoJSON(NULLIF(:geom, '')), 4326),
                             :ev::jsonb)
                            RETURNING id";
                    $stmt = $this->db->query($sql, [
                        'sid' => $scenarioId,
                        'oid' => $ownerId ? (int) $ownerId : null,
                        'conf' => $confidence,
                        'sw' => (int) ($rt['start_well_id'] ?? 0) ?: null,
                        'ew' => (int) ($rt['end_well_id'] ?? 0) ?: null,
                        'len' => $lenM,
                        'geom' => $geomJson,
                        'ev' => json_encode($evidence, JSON_UNESCAPED_UNICODE),
                    ]);
                    $routeId = (int) $stmt->fetchColumn();

                    $seq = 1;
                    foreach (($rt['direction_ids'] ?? []) as $dirId) {
                        $dirId = (int) $dirId;
                        $d = $dirs[$dirId] ?? null;
                        if (!$d) continue;
                        $this->db->insert('assumed_cable_route_directions', [
                            'route_id' => $routeId,
                            'seq' => $seq++,
                            'direction_id' => $dirId,
                            'length_m' => round((float) ($d['length_m'] ?? 0), 2),
                        ]);
                    }
                    $routesTotal++;
                }

                // обновим stats_json сценария
                $stats = [
                    'total_unaccounted' => $totalUnaccounted,
                    'routes_total' => $routesTotal,
                    'owners_assigned' => $ownersAssigned,
                    'owners_unknown' => max(0, $routesTotal - $ownersAssigned),
                    'total_length_m' => round($totalLengthM, 2),
                    'total_edge_units' => (int) $totalEdgeUnits,
                ];
                $this->db->query("UPDATE assumed_cable_scenarios SET stats_json = :s::jsonb WHERE id = :id", [
                    's' => json_encode($stats, JSON_UNESCAPED_UNICODE),
                    'id' => $scenarioId,
                ]);

                $resultVariants[] = [
                    'scenario_id' => $scenarioId,
                    'variant_no' => $variantNo,
                    'routes' => $routesTotal,
                ];
            }
            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollback();
            try {
                $this->logError('Assumed cables rebuild failed', [
                    'error' => $e->getMessage(),
                    'file' => $e->getFile(),
                    'line' => $e->getLine(),
                ]);
            } catch (\Throwable $ee) {}
            Response::error('Ошибка пересчёта предполагаемых кабелей', 500);
        }

        try { $this->log('rebuild_assumed_cables', 'assumed_cable_scenarios', null, null, ['variants' => [1,2,3]]); } catch (\Throwable $e) {}

        Response::success(['variants' => $resultVariants], 'Сценарии предполагаемых кабелей пересчитаны');
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
            "SELECT r.id AS route_id,
                    ST_AsGeoJSON(r.geom_wgs84)::text AS geom,
                    r.owner_id,
                    COALESCE(o.name, 'Не определён') AS owner_name,
                    COALESCE(o.color, '') AS owner_color,
                    r.confidence,
                    r.length_m,
                    sw.number AS start_well_number,
                    ew.number AS end_well_number
             FROM assumed_cable_routes r
             LEFT JOIN owners o ON r.owner_id = o.id
             LEFT JOIN wells sw ON r.start_well_id = sw.id
             LEFT JOIN wells ew ON r.end_well_id = ew.id
             WHERE r.scenario_id = :sid
               AND r.geom_wgs84 IS NOT NULL
             ORDER BY r.id",
            ['sid' => $scenarioId]
        );

        $features = [];
        foreach ($rows as $r) {
            $geomJson = $r['geom'] ?? null;
            if (!$geomJson) continue;
            $geom = json_decode($geomJson, true);
            if (!$geom) continue;

            $features[] = [
                'type' => 'Feature',
                'geometry' => $geom,
                'properties' => [
                    'route_id' => (int) ($r['route_id'] ?? 0),
                    'variant_no' => $variantNo,
                    'scenario_id' => $scenarioId,
                    'owner_id' => (int) ($r['owner_id'] ?? 0) ?: null,
                    'owner_name' => (string) ($r['owner_name'] ?? ''),
                    'owner_color' => (string) ($r['owner_color'] ?? ''),
                    'confidence' => (float) ($r['confidence'] ?? 0),
                    'length_m' => (float) ($r['length_m'] ?? 0),
                    'start_well_number' => (string) ($r['start_well_number'] ?? ''),
                    'end_well_number' => (string) ($r['end_well_number'] ?? ''),
                ],
            ];
        }

        Response::geojson($features, [
            'variant' => $variantNo,
            'scenario_id' => $scenarioId,
            'built_at' => (string) ($sc['built_at'] ?? ''),
        ]);
    }

    /**
     * GET /api/assumed-cables/list?variant=1
     * Данные для правой панели: список маршрутов (предполагаемые кабели) + сводные счётчики.
     */
    public function list(): void
    {
        $variantNo = (int) $this->request->query('variant', 1);
        if (!in_array($variantNo, [1, 2, 3], true)) $variantNo = 1;

        // если таблиц нет — вернуть пустой результат
        try {
            $this->db->fetch("SELECT 1 FROM assumed_cable_scenarios LIMIT 1");
        } catch (\Throwable $e) {
            Response::success([
                'variant_no' => $variantNo,
                'scenario_id' => null,
                'built_at' => null,
                'summary' => [
                    'used_unaccounted' => 0,
                    'total_unaccounted' => 0,
                    'assumed_total' => 0,
                    'rows' => 0,
                ],
                'rows' => [],
            ]);
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
            Response::success([
                'variant_no' => $variantNo,
                'scenario_id' => null,
                'built_at' => null,
                'summary' => [
                    'used_unaccounted' => 0,
                    'total_unaccounted' => 0,
                    'assumed_total' => 0,
                    'rows' => 0,
                ],
                'rows' => [],
            ]);
        }

        $scenarioId = (int) ($sc['id'] ?? 0);
        if ($scenarioId <= 0) {
            Response::success([
                'variant_no' => $variantNo,
                'scenario_id' => null,
                'built_at' => (string) ($sc['built_at'] ?? ''),
                'summary' => [
                    'used_unaccounted' => 0,
                    'total_unaccounted' => 0,
                    'assumed_total' => 0,
                    'rows' => 0,
                ],
                'rows' => [],
            ]);
        }

        $rows = $this->db->fetchAll(
            "SELECT
                r.id AS route_id,
                r.owner_id,
                COALESCE(o.name, '') AS owner_name,
                r.confidence,
                r.length_m,
                COALESCE(r.evidence_json->'direction_ids', '[]'::jsonb) AS direction_ids,
                sw.number AS start_well_number,
                ew.number AS end_well_number
             FROM assumed_cable_routes r
             LEFT JOIN owners o ON r.owner_id = o.id
             LEFT JOIN wells sw ON r.start_well_id = sw.id
             LEFT JOIN wells ew ON r.end_well_id = ew.id
             WHERE r.scenario_id = :sid
             ORDER BY r.id",
            ['sid' => $scenarioId]
        );

        $summary = $this->db->fetch(
            "WITH r AS (
                SELECT owner_id
                FROM assumed_cable_routes
                WHERE scenario_id = :sid
            )
            SELECT
                COALESCE(SUM(CASE WHEN r.owner_id IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS used_unaccounted,
                COUNT(*)::int AS assumed_total,
                (SELECT COALESCE(SUM(unaccounted_cables), 0)::int FROM inventory_summary WHERE unaccounted_cables > 0) AS total_unaccounted,
                COUNT(*)::int AS rows
            FROM r",
            ['sid' => $scenarioId]
        ) ?? [];

        Response::success([
            'variant_no' => $variantNo,
            'scenario_id' => $scenarioId,
            'built_at' => (string) ($sc['built_at'] ?? ''),
            'summary' => [
                'used_unaccounted' => (int) ($summary['used_unaccounted'] ?? 0),
                'total_unaccounted' => (int) ($summary['total_unaccounted'] ?? 0),
                'assumed_total' => (int) ($summary['assumed_total'] ?? 0),
                'rows' => (int) ($summary['rows'] ?? 0),
            ],
            'rows' => $rows,
        ]);
    }

    /**
     * GET /api/assumed-cables/export?variant=1&delimiter=;
     */
    public function export(): void
    {
        $variantNo = (int) $this->request->query('variant', 1);
        if (!in_array($variantNo, [1, 2, 3], true)) $variantNo = 1;
        $delimiter = (string) $this->request->query('delimiter', ';');
        if ($delimiter === '') $delimiter = ';';
        // mbstring может быть не установлен на сервере -> не используем mb_substr()
        $delimiter = substr($delimiter, 0, 1);
        if ($delimiter === '' || $delimiter === false) $delimiter = ';';

        // reuse list logic (без дублирования ошибок в 500)
        // если таблиц нет — пустой файл
        $sc = null;
        try {
            $sc = $this->db->fetch(
                "SELECT id, built_at FROM assumed_cable_scenarios WHERE variant_no = :v ORDER BY id DESC LIMIT 1",
                ['v' => $variantNo]
            );
        } catch (\Throwable $e) {
            $sc = null;
        }

        $rows = [];
        if ($sc && (int) ($sc['id'] ?? 0) > 0) {
            $scenarioId = (int) $sc['id'];
            $rows = $this->db->fetchAll(
                "SELECT
                    r.id AS route_id,
                    COALESCE(o.name, 'Не определён') AS owner_name,
                    r.owner_id,
                    r.confidence,
                    r.length_m,
                    sw.number AS start_well_number,
                    ew.number AS end_well_number,
                    COALESCE((
                        SELECT STRING_AGG(cd.number, ' -> ' ORDER BY rd.seq)
                        FROM assumed_cable_route_directions rd
                        JOIN channel_directions cd ON cd.id = rd.direction_id
                        WHERE rd.route_id = r.id
                    ), '') AS route_directions
                 FROM assumed_cable_routes r
                 LEFT JOIN owners o ON r.owner_id = o.id
                 LEFT JOIN wells sw ON r.start_well_id = sw.id
                 LEFT JOIN wells ew ON r.end_well_id = ew.id
                 WHERE r.scenario_id = :sid
                 ORDER BY r.id",
                ['sid' => $scenarioId]
            );
        }

        $filename = 'assumed_cables_routes_v' . $variantNo . '_' . date('Y-m-d') . '.csv';
        header('Content-Type: text/csv; charset=utf-8');
        header('Content-Disposition: attachment; filename="' . $filename . '"');

        $output = fopen('php://output', 'w');
        fprintf($output, chr(0xEF).chr(0xBB).chr(0xBF));

        $headers = ['№', 'Вариант', 'ID', 'Собственник', 'Уверенность', 'Длина (м)', 'Начальный колодец', 'Конечный колодец', 'Маршрут (направления)'];
        fputcsv($output, $headers, $delimiter);
        $i = 1;
        foreach ($rows as $r) {
            fputcsv($output, [
                $i++,
                $variantNo,
                (string) ($r['route_id'] ?? ''),
                (string) ($r['owner_name'] ?? ''),
                (string) ($r['confidence'] ?? ''),
                (string) ($r['length_m'] ?? 0),
                (string) ($r['start_well_number'] ?? ''),
                (string) ($r['end_well_number'] ?? ''),
                (string) ($r['route_directions'] ?? ''),
            ], $delimiter);
        }

        fclose($output);
        exit;
    }
}


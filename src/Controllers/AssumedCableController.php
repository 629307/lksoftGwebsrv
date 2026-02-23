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
        // Важно: топология графа берётся по ВСЕМ направлениям (в т.ч. с capacity=0),
        // но расходный ресурс — только inventory_summary.unaccounted_cables (capacity>0).
        //
        // Условные коэффициенты для score(path):
        $LAMBDA_TAG = 25.0; // вклад одной "бирочной" вершины (в метрах)
        $MU_BOTTLENECK = 50.0; // вклад bottleneck capacity (в метрах)

        $tagPresence = []; // wellId => int (сколько "свободных" бирок суммарно)
        foreach ($supply0 as $w => $byOwner) {
            $sum = 0;
            foreach ($byOwner as $oid => $cnt) $sum += (int) $cnt;
            if ($sum > 0) $tagPresence[(int) $w] = $sum;
        }

        // Полная топология: adjacency по ВСЕМ directions (capacity может быть 0)
        $fullAdj = []; // wellId => [ ['to'=>wellId,'dir'=>dirId,'len'=>m], ...]
        foreach ($dirs as $dirId => $d) {
            $dirId = (int) $dirId;
            $a = (int) ($d['a'] ?? 0);
            $b = (int) ($d['b'] ?? 0);
            if ($dirId <= 0 || $a <= 0 || $b <= 0) continue;
            $len = (float) ($d['length_m'] ?? 0);
            if ($len <= 0) continue;
            if (!isset($fullAdj[$a])) $fullAdj[$a] = [];
            if (!isset($fullAdj[$b])) $fullAdj[$b] = [];
            $fullAdj[$a][] = ['to' => $b, 'dir' => $dirId, 'len' => $len];
            $fullAdj[$b][] = ['to' => $a, 'dir' => $dirId, 'len' => $len];
        }

        $routeWellIdsFromRoute = function(array $route) use ($dirs): array {
            $a = (int) ($route['start_well_id'] ?? 0);
            $dirIds = array_values(array_map('intval', (array) ($route['direction_ids'] ?? [])));
            $wells = [];
            $cur = $a;
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

        $scoreRoute = function(array $route, array $rem) use ($dirs, $tagPresence, $routeWellIdsFromRoute, $LAMBDA_TAG, $MU_BOTTLENECK): array {
            $dirIds = array_values(array_map('intval', (array) ($route['direction_ids'] ?? [])));
            if (!$dirIds) return ['ok' => false, 'score' => -INF, 'len' => 0.0, 'tagHits' => 0, 'minCap' => 0];

            $len = 0.0;
            $minCap = null;
            $hasCap = false;
            foreach ($dirIds as $dirId) {
                $d = $dirs[(int) $dirId] ?? null;
                if ($d) $len += (float) ($d['length_m'] ?? 0);
                $cap = (int) ($rem[(int) $dirId] ?? 0);
                if ($cap > 0) {
                    $hasCap = true;
                    if ($minCap === null || $cap < $minCap) $minCap = $cap;
                }
            }
            if (!$hasCap || $minCap === null || $minCap <= 0) {
                return ['ok' => false, 'score' => -INF, 'len' => $len, 'tagHits' => 0, 'minCap' => 0];
            }

            $wells = $routeWellIdsFromRoute($route);
            $tagHits = 0;
            foreach ($wells as $w) {
                if ((int) ($tagPresence[(int) $w] ?? 0) > 0) $tagHits++;
            }

            $score = $len + ($LAMBDA_TAG * $tagHits) + ($MU_BOTTLENECK * (int) $minCap);
            return ['ok' => true, 'score' => $score, 'len' => $len, 'tagHits' => $tagHits, 'minCap' => (int) $minCap];
        };

        $mstDiameterPath = function(array $dirIdsAll, array $rem, bool $onlyCapEdges, bool $tagBonusEdges) use ($dirs, $tagPresence, $routeWellIdsFromRoute): ?array {
            // Build edge list (full topology within component, optionally only cap edges)
            $edges = [];
            $nodes = [];
            foreach ($dirIdsAll as $dirId) {
                $dirId = (int) $dirId;
                $d = $dirs[$dirId] ?? null;
                if (!$d) continue;
                $a = (int) ($d['a'] ?? 0);
                $b = (int) ($d['b'] ?? 0);
                if ($a <= 0 || $b <= 0) continue;
                $len = (float) ($d['length_m'] ?? 0);
                if ($len <= 0) continue;
                $cap = (int) ($rem[$dirId] ?? 0);
                if ($onlyCapEdges && $cap <= 0) continue;
                $bonus = 0.0;
                if ($tagBonusEdges) {
                    $bonus += ((int) ($tagPresence[$a] ?? 0) > 0) ? 10.0 : 0.0;
                    $bonus += ((int) ($tagPresence[$b] ?? 0) > 0) ? 10.0 : 0.0;
                }
                // prefer edges with remaining capacity a bit (but not required)
                $bonus += ($cap > 0) ? 5.0 : 0.0;
                $w = $len + $bonus;
                $edges[] = ['dir' => $dirId, 'a' => $a, 'b' => $b, 'w' => $w, 'len' => $len];
                $nodes[$a] = true;
                $nodes[$b] = true;
            }
            if (!$edges || !$nodes) return null;

            usort($edges, fn($x, $y) => ((float) ($y['w'] ?? 0) <=> (float) ($x['w'] ?? 0)));

            // Union-Find to build maximum spanning tree
            $parent = [];
            $rank = [];
            foreach (array_keys($nodes) as $n) { $parent[$n] = $n; $rank[$n] = 0; }
            $find = function($x) use (&$parent, &$find) {
                if (!isset($parent[$x])) $parent[$x] = $x;
                if ($parent[$x] !== $x) $parent[$x] = $find($parent[$x]);
                return $parent[$x];
            };
            $union = function($a, $b) use (&$parent, &$rank, $find) {
                $ra = $find($a); $rb = $find($b);
                if ($ra === $rb) return false;
                $rka = (int) ($rank[$ra] ?? 0);
                $rkb = (int) ($rank[$rb] ?? 0);
                if ($rka < $rkb) $parent[$ra] = $rb;
                else if ($rka > $rkb) $parent[$rb] = $ra;
                else { $parent[$rb] = $ra; $rank[$ra] = $rka + 1; }
                return true;
            };

            $adj = [];
            foreach (array_keys($nodes) as $n) $adj[(int) $n] = [];
            foreach ($edges as $e) {
                $a = (int) $e['a']; $b = (int) $e['b'];
                if ($union($a, $b)) {
                    $adj[$a][] = ['to' => $b, 'dir' => (int) $e['dir'], 'w' => (float) ($e['len'] ?? 0)];
                    $adj[$b][] = ['to' => $a, 'dir' => (int) $e['dir'], 'w' => (float) ($e['len'] ?? 0)];
                }
            }

            // Find diameter in the tree (DFS twice)
            $farthest = function(int $start) use ($adj): array {
                $stack = [[$start, 0]];
                $dist = [$start => 0.0];
                $pn = [$start => 0];
                $pe = [];
                while ($stack) {
                    [$u, $p] = array_pop($stack);
                    foreach (($adj[$u] ?? []) as $e) {
                        $v = (int) ($e['to'] ?? 0);
                        if ($v <= 0) continue;
                        if ($v === (int) $p) continue;
                        if (isset($dist[$v])) continue;
                        $pn[$v] = $u;
                        $pe[$v] = (int) ($e['dir'] ?? 0);
                        $dist[$v] = (float) ($dist[$u] ?? 0) + (float) ($e['w'] ?? 0);
                        $stack[] = [$v, $u];
                    }
                }
                $far = $start; $best = -1.0;
                foreach ($dist as $n => $d) {
                    if ($d > $best) { $best = (float) $d; $far = (int) $n; }
                }
                return [$far, $best, $pn, $pe];
            };

            $start = (int) array_key_first($adj);
            if ($start <= 0) return null;
            [$aNode] = $farthest($start);
            [$bNode, $diam, $pn2, $pe2] = $farthest($aNode);
            if ($diam <= 0) return null;
            $pathDirs = [];
            $cur = $bNode;
            while ($cur !== $aNode && isset($pn2[$cur])) {
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

        $buildFullComponents = function(array $fullAdj, array $rem, array $supply0) use ($dirs): array {
            // компоненты по полной топологии (включая edges cap=0), но оставляем только те,
            // где есть хотя бы одно ребро с rem>0.
            $visited = [];
            $components = [];
            foreach (array_keys($fullAdj) as $start) {
                $start = (int) $start;
                if ($start <= 0 || isset($visited[$start])) continue;
                $stack = [$start];
                $visited[$start] = true;
                $wellSet = [];
                $dirAll = [];
                while ($stack) {
                    $u = (int) array_pop($stack);
                    $wellSet[$u] = true;
                    foreach (($fullAdj[$u] ?? []) as $e) {
                        $v = (int) ($e['to'] ?? 0);
                        $dirId = (int) ($e['dir'] ?? 0);
                        if ($dirId > 0) $dirAll[$dirId] = true;
                        if ($v > 0 && !isset($visited[$v])) {
                            $visited[$v] = true;
                            $stack[] = $v;
                        }
                    }
                }
                $wellIds = array_keys($wellSet);
                $dirIdsAll = array_keys($dirAll);
                if (!$dirIdsAll) continue;

                $dirIdsCap = [];
                $sumCap = 0;
                foreach ($dirIdsAll as $dirId) {
                    $dirId = (int) $dirId;
                    $cap = (int) ($rem[$dirId] ?? 0);
                    if ($cap > 0) {
                        $dirIdsCap[] = $dirId;
                        $sumCap += $cap;
                    }
                }
                if (!$dirIdsCap) continue;

                $tags = 0;
                foreach ($wellIds as $w) {
                    foreach (($supply0[(int) $w] ?? []) as $oid => $cnt) $tags += (int) $cnt;
                }

                $components[] = [
                    'well_ids' => $wellIds,
                    'dir_ids_all' => $dirIdsAll,
                    'dir_ids_cap' => $dirIdsCap,
                    'edges_count' => count($dirIdsCap),
                    'sum_capacity' => $sumCap,
                    'owner_tags_count' => $tags,
                ];
            }
            return $components;
        };

        $anyCapacityLeft = function(array $rem): bool {
            foreach ($rem as $cap) if ((int) $cap > 0) return true;
            return false;
        };
        $routeConsumesAny = function(array $route, array $rem): bool {
            foreach ((array) ($route['direction_ids'] ?? []) as $dirId) {
                $dirId = (int) $dirId;
                if ((int) ($rem[$dirId] ?? 0) > 0) return true;
            }
            return false;
        };
        $consumeRoute = function(array &$rem, array $route): bool {
            $did = false;
            foreach ((array) ($route['direction_ids'] ?? []) as $dirId) {
                $dirId = (int) $dirId;
                $cap = (int) ($rem[$dirId] ?? 0);
                if ($cap > 0) {
                    $rem[$dirId] = $cap - 1;
                    $did = true;
                }
            }
            return $did;
        };

        // METHOD 1: Global Longest Paths with Capacity Consumption (Greedy)
        $buildRoutesMethod1 = function(array $baseRem, array $supply0) use ($dirs, $fullAdj, $buildFullComponents, $mstDiameterPath, $scoreRoute, $anyCapacityLeft, $routeConsumesAny, $consumeRoute): array {
            $rem = $baseRem;
            $routes = [];
            $maxRoutes = 20000;

            // 1) сгенерируем набор длинных путей по полной сети (без фильтрации по capacity)
            $comps0 = $buildFullComponents($fullAdj, $rem, $supply0);
            $cands = [];
            foreach ($comps0 as $c) {
                $dirAll = $c['dir_ids_all'] ?? [];
                if (!$dirAll) continue;
                foreach ([ [false,false], [false,true] ] as $opt) {
                    $p = $mstDiameterPath($dirAll, $rem, (bool) $opt[0], (bool) $opt[1]);
                    if ($p) $cands[] = $p;
                }
            }
            // уникализация + длина
            $uniq = [];
            foreach ($cands as $cand) {
                $dirIds = array_values(array_map('intval', (array) ($cand['direction_ids'] ?? [])));
                if (!$dirIds) continue;
                $k1 = implode(',', $dirIds);
                $k2 = implode(',', array_reverse($dirIds));
                $key = strcmp($k1, $k2) <= 0 ? $k1 : $k2;
                $s = $scoreRoute($cand, $rem);
                $cand['_len'] = (float) ($s['len'] ?? 0);
                $uniq[$key] = $cand;
            }
            $cands = array_values($uniq);
            usort($cands, fn($a, $b) => ((float) ($b['_len'] ?? 0) <=> (float) ($a['_len'] ?? 0)));

            // 2) жадно потребляем capacity по пути, пока есть ресурс
            while ($anyCapacityLeft($rem) && count($routes) < $maxRoutes) {
                $progress = false;
                foreach ($cands as $cand) {
                    if (count($routes) >= $maxRoutes) break;
                    if (!$routeConsumesAny($cand, $rem)) continue;
                    if ($consumeRoute($rem, $cand)) {
                        $progress = true;
                        $r = $cand;
                        unset($r['_len']);
                        $routes[] = $r;
                    }
                }
                if (!$progress) break;
            }

            // fallback: оставшиеся единицы capacity -> одиночные кабели по направлению
            foreach ($rem as $dirId => $cap) {
                $dirId = (int) $dirId;
                $cap = (int) $cap;
                if ($dirId <= 0 || $cap <= 0) continue;
                for ($i = 0; $i < $cap && count($routes) < $maxRoutes; $i++) {
                    $d = $dirs[$dirId] ?? null;
                    $a = (int) ($d['a'] ?? 0);
                    $b = (int) ($d['b'] ?? 0);
                    $routes[] = [
                        'start_well_id' => $a > 0 ? $a : null,
                        'end_well_id' => $b > 0 ? $b : null,
                        'direction_ids' => [$dirId],
                        'weight' => 0.0,
                    ];
                }
            }

            return $routes;
        };

        // METHOD 2: Capacity-Aware Iterative Longest Path Extraction
        $buildRoutesMethod2 = function(array $baseRem, array $supply0) use ($fullAdj, $buildFullComponents, $mstDiameterPath, $scoreRoute, $anyCapacityLeft, $consumeRoute): array {
            $rem = $baseRem;
            $routes = [];
            $maxRoutes = 20000;

            while ($anyCapacityLeft($rem) && count($routes) < $maxRoutes) {
                $comps = $buildFullComponents($fullAdj, $rem, $supply0);
                if (!$comps) break;

                $best = null;
                $bestScore = -1e100;
                foreach ($comps as $c) {
                    $dirAll = $c['dir_ids_all'] ?? [];
                    if (!$dirAll) continue;
                    foreach ([ [false,false], [false,true], [true,false] ] as $opt) {
                        $p = $mstDiameterPath($dirAll, $rem, (bool) $opt[0], (bool) $opt[1]);
                        if (!$p) continue;
                        $s = $scoreRoute($p, $rem);
                        if (!($s['ok'] ?? false)) continue;
                        if ((float) ($s['score'] ?? -1e100) > $bestScore) {
                            $bestScore = (float) $s['score'];
                            $best = $p;
                        }
                    }
                }
                if (!$best) break;

                if (!$consumeRoute($rem, $best)) break;
                $routes[] = $best;
            }

            return $routes;
        };

        // METHOD 3: "Min Cost Max Flow" (декомпозиция потока capacity в пути)
        // Реализация без DAG: берём мультирёбра по capacity>0 и раскладываем на максимальные trails.
        $buildRoutesMethod3 = function(array $baseRem) use ($dirs): array {
            $rem = $baseRem; // dirId => capacity
            $routes = [];
            $maxRoutes = 20000;

            // adjacency for remaining (only edges with cap>0)
            $adj = []; // wellId => [dirId...]
            $edgeEnds = []; // dirId => [a,b]
            foreach ($rem as $dirId => $cap) {
                $dirId = (int) $dirId;
                $cap = (int) $cap;
                if ($dirId <= 0 || $cap <= 0) continue;
                $d = $dirs[$dirId] ?? null;
                if (!$d) continue;
                $a = (int) ($d['a'] ?? 0);
                $b = (int) ($d['b'] ?? 0);
                if ($a <= 0 || $b <= 0) continue;
                $edgeEnds[$dirId] = [$a, $b];
                if (!isset($adj[$a])) $adj[$a] = [];
                if (!isset($adj[$b])) $adj[$b] = [];
                $adj[$a][] = $dirId;
                $adj[$b][] = $dirId;
            }

            $degree = function(int $w) use (&$adj, &$rem): int {
                $deg = 0;
                foreach (($adj[$w] ?? []) as $dirId) $deg += max(0, (int) ($rem[(int)$dirId] ?? 0));
                return $deg;
            };

            while (count($routes) < $maxRoutes) {
                // pick start: prefer odd degree (in multigraph sense), else any with degree>0
                $start = 0;
                foreach (array_keys($adj) as $w) {
                    $w = (int) $w;
                    $deg = $degree($w);
                    if ($deg <= 0) continue;
                    if (($deg % 2) === 1) { $start = $w; break; }
                    if ($start <= 0) $start = $w;
                }
                if ($start <= 0) break;

                $cur = $start;
                $pathDirs = [];
                // greedy walk: always take the longest available incident edge
                while (true) {
                    $bestDir = 0;
                    $bestLen = -1.0;
                    foreach (($adj[$cur] ?? []) as $dirId) {
                        $dirId = (int) $dirId;
                        if ((int) ($rem[$dirId] ?? 0) <= 0) continue;
                        $len = (float) ($dirs[$dirId]['length_m'] ?? 0);
                        if ($len > $bestLen) { $bestLen = $len; $bestDir = $dirId; }
                    }
                    if ($bestDir <= 0) break;
                    // consume 1
                    $rem[$bestDir] = (int) ($rem[$bestDir] ?? 0) - 1;
                    $pathDirs[] = $bestDir;
                    // move to other end
                    $ends = $edgeEnds[$bestDir] ?? null;
                    if (!$ends) break;
                    $a = (int) ($ends[0] ?? 0);
                    $b = (int) ($ends[1] ?? 0);
                    $cur = ($cur === $a) ? $b : $a;
                }

                if (!$pathDirs) break;
                // end well: current
                $routes[] = [
                    'start_well_id' => $start,
                    'end_well_id' => $cur,
                    'direction_ids' => $pathDirs,
                    'weight' => 0.0,
                ];
            }

            return $routes;
        };

        $buildRoutesForVariant = function(int $variantNo, array $baseRem) use ($buildRoutesMethod1, $buildRoutesMethod2, $buildRoutesMethod3, $supply0): array {
            if ($variantNo === 1) return $buildRoutesMethod1($baseRem, $supply0);
            if ($variantNo === 2) return $buildRoutesMethod2($baseRem, $supply0);
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


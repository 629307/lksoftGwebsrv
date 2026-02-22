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
                    COALESCE(cd.length_m, ROUND(ST_Length(cd.geom_wgs84::geography)::numeric, 2), 0)::numeric AS length_m,
                    ST_AsGeoJSON(cd.geom_wgs84)::text AS geom
             FROM channel_directions cd
             WHERE cd.start_well_id IS NOT NULL
               AND cd.end_well_id IS NOT NULL
               AND cd.geom_wgs84 IS NOT NULL"
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

        $inferOwnerForRoute = function(int $variantNo, array $route, array &$supply) use ($realDirOwners): array {
            $a = (int) ($route['start_well_id'] ?? 0);
            $b = (int) ($route['end_well_id'] ?? 0);
            $dirIds = array_map('intval', (array) ($route['direction_ids'] ?? []));

            $bestBoth = null;
            if ($a > 0 && $b > 0) {
                $sa = $supply[$a] ?? [];
                $sb = $supply[$b] ?? [];
                foreach ($sa as $oid => $va) {
                    $oid = (int) $oid;
                    $va = (int) $va;
                    if ($oid <= 0 || $va <= 0) continue;
                    $vb = (int) ($sb[$oid] ?? 0);
                    if ($vb <= 0) continue;
                    $score = min($va, $vb);
                    if ($bestBoth === null || $score > $bestBoth['score']) {
                        $bestBoth = ['owner_id' => $oid, 'score' => $score];
                    }
                }
            }
            if ($bestBoth) {
                $oid = (int) $bestBoth['owner_id'];
                $supply[$a][$oid] = max(0, (int) ($supply[$a][$oid] ?? 0) - 1);
                $supply[$b][$oid] = max(0, (int) ($supply[$b][$oid] ?? 0) - 1);
                return ['owner_id' => $oid, 'confidence' => 0.90, 'mode' => 'tags_both_ends'];
            }

            if ($variantNo >= 2) {
                // one-end tags
                $bestOne = null;
                foreach ([$a, $b] as $w) {
                    if ($w <= 0) continue;
                    foreach (($supply[$w] ?? []) as $oid => $v) {
                        $oid = (int) $oid; $v = (int) $v;
                        if ($oid <= 0 || $v <= 0) continue;
                        if ($bestOne === null || $v > $bestOne['score']) {
                            $bestOne = ['well' => $w, 'owner_id' => $oid, 'score' => $v];
                        }
                    }
                }
                if ($bestOne) {
                    $w = (int) $bestOne['well'];
                    $oid = (int) $bestOne['owner_id'];
                    $supply[$w][$oid] = max(0, (int) ($supply[$w][$oid] ?? 0) - 1);
                    return ['owner_id' => $oid, 'confidence' => 0.60, 'mode' => 'tags_one_end'];
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
                    if ($oid > 0) return ['owner_id' => $oid, 'confidence' => 0.35, 'mode' => 'real_cables_fallback'];
                }
            }

            return ['owner_id' => null, 'confidence' => 0.15, 'mode' => 'unknown'];
        };

        $buildRoutesForVariant = function(int $variantNo, array $baseRem) use ($dirs, $weightFor): array {
            $rem = $baseRem;
            $routes = [];

            // union-find helpers
            $ufInit = function(array $nodes) {
                $p = [];
                $r = [];
                foreach ($nodes as $n) {
                    $p[$n] = $n;
                    $r[$n] = 0;
                }
                return [$p, $r];
            };

            $find = null;
            $find = function($x, &$p) use (&$find) {
                if (!isset($p[$x])) $p[$x] = $x;
                if ($p[$x] !== $x) $p[$x] = $find($p[$x], $p);
                return $p[$x];
            };
            $union = function($a, $b, &$p, &$r) use ($find) {
                $ra = $find($a, $p);
                $rb = $find($b, $p);
                if ($ra === $rb) return false;
                $rka = $r[$ra] ?? 0;
                $rkb = $r[$rb] ?? 0;
                if ($rka < $rkb) { $p[$ra] = $rb; }
                elseif ($rka > $rkb) { $p[$rb] = $ra; }
                else { $p[$rb] = $ra; $r[$ra] = $rka + 1; }
                return true;
            };

            $farthestFrom = function(int $start, array $adj): array {
                $stack = [[$start, 0]];
                $dist = [$start => 0.0];
                $parentNode = [$start => 0];
                $parentEdge = [];
                $nodes = [];
                while ($stack) {
                    [$u, $p] = array_pop($stack);
                    $nodes[] = $u;
                    foreach (($adj[$u] ?? []) as $e) {
                        $v = (int) ($e['to'] ?? 0);
                        if ($v <= 0) continue;
                        if ($v === (int) $p) continue;
                        if (isset($dist[$v])) continue;
                        $parentNode[$v] = $u;
                        $parentEdge[$v] = (int) ($e['dir'] ?? 0);
                        $dist[$v] = (float) ($dist[$u] ?? 0) + (float) ($e['w'] ?? 0);
                        $stack[] = [$v, $u];
                    }
                }
                $far = $start;
                $best = -1.0;
                foreach ($dist as $n => $d) {
                    if ($d > $best) { $best = $d; $far = (int) $n; }
                }
                return [$far, $best, $dist, $parentNode, $parentEdge, $nodes];
            };

            $buildEdges = function(array $rem, ?array $restrictDirIds = null) use ($dirs, $weightFor, $variantNo): array {
                $edges = [];
                if ($restrictDirIds !== null) {
                    foreach ($restrictDirIds as $dirId) {
                        $dirId = (int) $dirId;
                        if ($dirId <= 0) continue;
                        if (!isset($rem[$dirId]) || (int) $rem[$dirId] <= 0) continue;
                        $d = $dirs[$dirId] ?? null;
                        if (!$d) continue;
                        $a = (int) $d['a']; $b = (int) $d['b'];
                        $w = $weightFor($variantNo, (float) ($d['length_m'] ?? 0));
                        $edges[] = ['dir' => $dirId, 'a' => $a, 'b' => $b, 'w' => (float) $w];
                    }
                } else {
                    foreach ($rem as $dirId => $cap) {
                        $cap = (int) $cap;
                        if ($cap <= 0) continue;
                        $d = $dirs[(int) $dirId] ?? null;
                        if (!$d) continue;
                        $a = (int) $d['a']; $b = (int) $d['b'];
                        $w = $weightFor($variantNo, (float) ($d['length_m'] ?? 0));
                        $edges[] = ['dir' => (int) $dirId, 'a' => $a, 'b' => $b, 'w' => (float) $w];
                    }
                }
                if ($edges) usort($edges, fn($x, $y) => ($y['w'] <=> $x['w']));
                return $edges;
            };

            $bestPathForEdges = function(array $edges) use ($ufInit, $union, $farthestFrom): ?array {
                if (!$edges) return null;
                $nodesSet = [];
                foreach ($edges as $e) {
                    $nodesSet[(int) $e['a']] = true;
                    $nodesSet[(int) $e['b']] = true;
                }
                $nodes = array_keys($nodesSet);
                if (!$nodes) return null;
                [$p, $rk] = $ufInit($nodes);
                $adj = [];
                foreach ($nodes as $n) $adj[(int) $n] = [];
                foreach ($edges as $e) {
                    $a = (int) $e['a']; $b = (int) $e['b'];
                    if ($union($a, $b, $p, $rk)) {
                        $adj[$a][] = ['to' => $b, 'dir' => (int) $e['dir'], 'w' => (float) $e['w']];
                        $adj[$b][] = ['to' => $a, 'dir' => (int) $e['dir'], 'w' => (float) $e['w']];
                    }
                }

                // find best diameter among tree-components
                $visited = [];
                $bestPath = null;
                foreach ($nodes as $n0) {
                    $n0 = (int) $n0;
                    if (isset($visited[$n0])) continue;
                    if (empty($adj[$n0])) { $visited[$n0] = true; continue; }
                    [$aNode, $_d1, $_dist1, $_pn1, $_pe1, $compNodes] = $farthestFrom($n0, $adj);
                    foreach ($compNodes as $cn) $visited[(int) $cn] = true;
                    [$bNode, $diam, $_dist2, $pn2, $pe2] = $farthestFrom($aNode, $adj);
                    if ($diam < 0) continue;
                    // reconstruct path dir ids from bNode to aNode
                    $dirsPath = [];
                    $cur = $bNode;
                    while ($cur !== $aNode && isset($pn2[$cur])) {
                        $eid = (int) ($pe2[$cur] ?? 0);
                        if ($eid > 0) $dirsPath[] = $eid;
                        $cur = (int) $pn2[$cur];
                        if ($cur <= 0) break;
                    }
                    $dirsPath = array_reverse($dirsPath);
                    if (!$dirsPath) continue;
                    if ($bestPath === null || $diam > (float) ($bestPath['weight'] ?? 0)) {
                        $bestPath = [
                            'start_well_id' => $aNode,
                            'end_well_id' => $bNode,
                            'direction_ids' => $dirsPath,
                            'weight' => (float) $diam,
                        ];
                    }
                }
                return $bestPath;
            };

            $buildComponents = function(array $rem) use ($dirs): array {
                // компоненты считаем по рёбрам с остатком > 0 (неучтённые)
                $adj = []; // wellId => [ [toWellId, dirId], ...]
                foreach ($rem as $dirId => $cap) {
                    $cap = (int) $cap;
                    if ($cap <= 0) continue;
                    $d = $dirs[(int) $dirId] ?? null;
                    if (!$d) continue;
                    $a = (int) ($d['a'] ?? 0);
                    $b = (int) ($d['b'] ?? 0);
                    if ($a <= 0 || $b <= 0) continue;
                    if (!isset($adj[$a])) $adj[$a] = [];
                    if (!isset($adj[$b])) $adj[$b] = [];
                    $adj[$a][] = [$b, (int) $dirId];
                    $adj[$b][] = [$a, (int) $dirId];
                }
                if (!$adj) return [];
                $visited = [];
                $components = [];
                foreach (array_keys($adj) as $start) {
                    $start = (int) $start;
                    if (isset($visited[$start])) continue;
                    $stack = [$start];
                    $visited[$start] = true;
                    $dirSet = [];
                    while ($stack) {
                        $u = (int) array_pop($stack);
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
                    if ($dirSet) {
                        $components[] = ['dir_ids' => array_keys($dirSet)];
                    }
                }
                return $components;
            };

            // ВАЖНО: сначала обрабатываем компоненты сети по убыванию "веса" (длины),
            // и вырабатываем ресурс (неучтённые отрезки) внутри компоненты до конца, только потом переходим к следующей.
            $components = $buildComponents($rem);
            foreach ($components as &$c) {
                $edges0 = $buildEdges($rem, $c['dir_ids'] ?? []);
                $bp0 = $bestPathForEdges($edges0);
                $c['weight'] = (float) ($bp0['weight'] ?? 0);
            }
            unset($c);
            usort($components, fn($x, $y) => ((float) ($y['weight'] ?? 0) <=> (float) ($x['weight'] ?? 0)));

            foreach ($components as $c) {
                $dirIds = $c['dir_ids'] ?? [];
                if (!$dirIds) continue;
                while (true) {
                    $edges = $buildEdges($rem, $dirIds);
                    if (!$edges) break;
                    $bestPath = $bestPathForEdges($edges);
                    if ($bestPath === null) {
                        // fallback: single best remaining edge in this component
                        $e = $edges[0] ?? null;
                        if (!$e) break;
                        $bestPath = [
                            'start_well_id' => (int) ($e['a'] ?? 0),
                            'end_well_id' => (int) ($e['b'] ?? 0),
                            'direction_ids' => [(int) ($e['dir'] ?? 0)],
                            'weight' => (float) ($e['w'] ?? 0),
                        ];
                    }
                    if (!$bestPath || empty($bestPath['direction_ids'])) break;

                    // consume 1 along path
                    foreach ($bestPath['direction_ids'] as $dirId) {
                        $dirId = (int) $dirId;
                        if (!isset($rem[$dirId]) || (int) $rem[$dirId] <= 0) continue;
                        $rem[$dirId] = (int) $rem[$dirId] - 1;
                    }
                    $routes[] = $bestPath;
                }
            }

            return $routes;
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
                foreach ($routes as $rt) {
                    $rt['variant_no'] = $variantNo;
                    $geo = $buildRouteGeometry($rt);
                    $geomJson = $geo['geom'];
                    $lenM = (float) ($geo['length_m'] ?? 0);
                    $rt['length_m'] = $lenM;
                    $owner = $inferOwnerForRoute($variantNo, $rt, $supply);
                    $ownerId = $owner['owner_id'] ?? null;
                    $confidence = (float) ($owner['confidence'] ?? 0);
                    $mode = (string) ($owner['mode'] ?? 'unknown');
                    if ($ownerId) $ownersAssigned++;

                    $evidence = [
                        'mode' => $mode,
                        'direction_ids' => array_values(array_map('intval', (array) ($rt['direction_ids'] ?? []))),
                        'start_well_id' => (int) ($rt['start_well_id'] ?? 0),
                        'end_well_id' => (int) ($rt['end_well_id'] ?? 0),
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
        $delimiter = mb_substr($delimiter, 0, 1);

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


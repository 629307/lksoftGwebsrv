<?php
/**
 * Импортированные слои (MapInfo -> PostGIS) + GeoJSON
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class ImportedLayerController extends BaseController
{
    private function requireAdminLike(): void
    {
        if (!Auth::isAdmin() && !Auth::isRoot()) {
            Response::error('Доступ запрещён', 403);
        }
    }

    private function safeLower(string $s): string
    {
        try {
            if (function_exists('mb_strtolower')) {
                return (string) @mb_strtolower($s, 'UTF-8');
            }
        } catch (\Throwable $e) {}
        return strtolower($s);
    }

    private function slugifyCode(string $name): string
    {
        $s0 = trim($name);
        $s = $this->safeLower($s0);
        // пробуем транслитерацию (для кириллицы и др.)
        try {
            if (function_exists('iconv')) {
                $tr = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s0);
                if (is_string($tr) && trim($tr) !== '') {
                    $s = $this->safeLower($tr);
                }
            }
        } catch (\Throwable $e) {}
        // заменяем всё, кроме латиницы/цифр на "_"
        $s = preg_replace('/[^a-z0-9]+/u', '_', $s);
        $s = trim((string) $s, '_');
        if ($s === '') {
            $s = 'layer_' . date('Ymd_His');
        }
        // ограничим длину
        if (strlen($s) > 40) {
            $s = substr($s, 0, 40);
            $s = rtrim($s, '_');
        }
        return $s;
    }

    private function ensureSafeIdent(string $ident): string
    {
        $id = (string) $ident;
        if (!preg_match('/^[a-z0-9_]{1,63}$/', $id)) {
            Response::error('Некорректный идентификатор', 400);
        }
        return $id;
    }

    private function normalizeSrsString(string $raw): string
    {
        $s = trim((string) $raw);
        if ($s === '') return '';
        // EPSG:xxxx
        if (preg_match('/^epsg\\s*:\\s*(\\d{3,6})$/i', $s, $m)) {
            return 'EPSG:' . $m[1];
        }

        // PROJ строка в двойных кавычках (обязательно, по ТЗ)
        // Пример: "+proj=tmerc +lat_0=0 +lon_0=78 ..."
        // Кавычки нужны для ввода/копипаста; для ogr2ogr передадим строку без внешних кавычек.
        if (preg_match('/^"([^"\\r\\n]{3,480})"$/', $s, $m)) {
            $inner = (string) $m[1];
            // базовая защита от управляющих символов
            if (preg_match('/[\\x00-\\x1F\\x7F]/', $inner)) {
                Response::error('Некорректная система координат', 422);
            }
            return $inner;
        }

        Response::error('Некорректная система координат. Используйте EPSG:XXXX или PROJ-строку в двойных кавычках.', 422);
        return '';
    }

    private function rrmdir(string $dir): void
    {
        if (!is_dir($dir)) return;
        $items = @scandir($dir);
        if (!is_array($items)) return;
        foreach ($items as $it) {
            if ($it === '.' || $it === '..') continue;
            $p = $dir . DIRECTORY_SEPARATOR . $it;
            if (is_dir($p)) $this->rrmdir($p);
            else @unlink($p);
        }
        @rmdir($dir);
    }

    private function tableHasColumn(string $table, string $column): bool
    {
        try {
            $row = $this->db->fetch(
                "SELECT 1
                 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = :t AND column_name = :c
                 LIMIT 1",
                ['t' => $table, 'c' => $column]
            );
            return !!$row;
        } catch (\Throwable $e) {
            return false;
        }
    }

    private function readStyleFromRequest(array $data): array
    {
        $p = $data['point'] ?? [];
        $l = $data['line'] ?? [];

        $pointSymbol = (string) ($p['symbol'] ?? ($data['point_symbol'] ?? 'circle'));
        $pointSymbol = trim($pointSymbol) !== '' ? trim($pointSymbol) : 'circle';
        $pointSize = (float) ($p['size'] ?? ($data['point_size'] ?? 10));
        if (!is_finite($pointSize) || $pointSize <= 0) $pointSize = 10;
        if ($pointSize > 200) $pointSize = 200;
        $pointColor = (string) ($p['color'] ?? ($data['point_color'] ?? '#ff0000'));
        $pointColor = trim($pointColor);
        if (!preg_match('/^#[0-9a-f]{6}$/i', $pointColor)) $pointColor = '#ff0000';

        $lineStyle = (string) ($l['style'] ?? ($data['line_style'] ?? 'solid'));
        $lineStyle = trim($lineStyle) !== '' ? trim($lineStyle) : 'solid';
        $lineWeight = (float) ($l['weight'] ?? ($data['line_weight'] ?? 2));
        if (!is_finite($lineWeight) || $lineWeight <= 0) $lineWeight = 2;
        if ($lineWeight > 50) $lineWeight = 50;
        $lineColor = (string) ($l['color'] ?? ($data['line_color'] ?? '#0066ff'));
        $lineColor = trim($lineColor);
        if (!preg_match('/^#[0-9a-f]{6}$/i', $lineColor)) $lineColor = '#0066ff';

        return [
            'point' => [
                'symbol' => $pointSymbol,
                'size' => $pointSize,
                'color' => strtolower($pointColor),
            ],
            'line' => [
                'style' => $lineStyle,
                'weight' => $lineWeight,
                'color' => strtolower($lineColor),
            ],
        ];
    }

    /**
     * GET /api/imported-layers
     * Доступно всем авторизованным
     */
    public function index(): void
    {
        $isAdminLike = Auth::isAdmin() || Auth::isRoot();
        try {
            $rows = $this->db->fetchAll(
                "SELECT id, code, name, table_name, geometry_column, srid, version, uploaded_at, updated_at,
                        style_json, is_public, min_zoom, show_points, show_lines, show_polygons
                 FROM imported_layers
                 " . ($isAdminLike ? "" : "WHERE is_public = true") . "
                 ORDER BY name ASC, id ASC"
            );
        } catch (\PDOException $e) {
            // если не применена миграция v24 (нет колонок) — подскажем явно
            Response::error('Настройки импортированных слоёв не готовы. Примените миграции database/migration_v23.sql и database/migration_v24.sql', 500);
        }

        foreach ($rows as &$r) {
            try {
                $r['style'] = json_decode((string) ($r['style_json'] ?? '{}'), true) ?: [];
            } catch (\Throwable $e) {
                $r['style'] = [];
            }
            unset($r['style_json']);
        }
        Response::success($rows);
    }

    /**
     * GET /api/imported-layers/{code}/geojson
     * Query:
     * - bbox=minLng,minLat,maxLng,maxLat (WGS84)
     * - limit=...
     */
    public function geojson(string $code): void
    {
        $code = $this->ensureSafeIdent(strtolower(trim($code)));
        $isAdminLike = Auth::isAdmin() || Auth::isRoot();
        try {
            $layer = $this->db->fetch("SELECT * FROM imported_layers WHERE code = :c", ['c' => $code]);
        } catch (\PDOException $e) {
            Response::error('Настройки импортированных слоёв не готовы. Примените миграции database/migration_v23.sql и database/migration_v24.sql', 500);
        }
        if (!$layer) Response::error('Слой не найден', 404);
        if (!$isAdminLike && !((bool) ($layer['is_public'] ?? false))) {
            Response::error('Доступ запрещён', 403);
        }

        $table = $this->ensureSafeIdent((string) ($layer['table_name'] ?? ''));
        $geomCol = $this->ensureSafeIdent((string) ($layer['geometry_column'] ?? 'geom'));
        $srid = (int) ($layer['srid'] ?? 4326);
        if ($srid <= 0) $srid = 4326;

        $params = [];
        $where = "{$geomCol} IS NOT NULL";

        // фильтр по типам геометрии (настройки слоя)
        $sp = (bool) ($layer['show_points'] ?? true);
        $sl = (bool) ($layer['show_lines'] ?? true);
        $sg = (bool) ($layer['show_polygons'] ?? true);
        $typeConds = [];
        if ($sp) $typeConds[] = "ST_GeometryType({$geomCol}) IN ('ST_Point','ST_MultiPoint')";
        if ($sl) $typeConds[] = "ST_GeometryType({$geomCol}) IN ('ST_LineString','ST_MultiLineString')";
        if ($sg) $typeConds[] = "ST_GeometryType({$geomCol}) IN ('ST_Polygon','ST_MultiPolygon')";
        if ($typeConds) {
            $where .= " AND (" . implode(" OR ", $typeConds) . ")";
        }

        $bbox = (string) ($this->request->query('bbox', '') ?? '');
        $bbox = trim($bbox);
        if ($bbox !== '') {
            $parts = array_map('trim', explode(',', $bbox));
            if (count($parts) === 4) {
                $minx = (float) $parts[0];
                $miny = (float) $parts[1];
                $maxx = (float) $parts[2];
                $maxy = (float) $parts[3];
                if (is_finite($minx) && is_finite($miny) && is_finite($maxx) && is_finite($maxy)) {
                    // envelope в srid слоя (по умолчанию 4326)
                    $where .= " AND ST_Intersects({$geomCol}, ST_MakeEnvelope(:minx, :miny, :maxx, :maxy, :srid))";
                    $params['minx'] = $minx;
                    $params['miny'] = $miny;
                    $params['maxx'] = $maxx;
                    $params['maxy'] = $maxy;
                    $params['srid'] = $srid;
                }
            }
        }

        $limit = (int) ($this->request->query('limit', 0) ?? 0);
        if ($limit < 0) $limit = 0;
        if ($limit > 200000) $limit = 200000;

        // Важно: table/geomCol подставляем как идентификаторы (проверили regex)
        $sql = "SELECT *, ST_AsGeoJSON({$geomCol}) AS __geometry FROM {$table} WHERE {$where}";
        if ($limit > 0) $sql .= " LIMIT " . (int) $limit;

        try {
            $rows = $this->db->fetchAll($sql, $params);
        } catch (\PDOException $e) {
            Response::error('Ошибка чтения слоя из БД', 500);
        }

        $features = [];
        foreach ($rows as $r) {
            $geomRaw = $r['__geometry'] ?? null;
            $geom = is_string($geomRaw) ? json_decode($geomRaw, true) : null;
            if (!$geom || !isset($geom['type'])) continue;
            unset($r['__geometry']);
            // удаляем сырую геометрию из properties (может быть wkb)
            unset($r[$geomCol]);
            $features[] = [
                'type' => 'Feature',
                'geometry' => $geom,
                'properties' => $r,
            ];
        }

        $style = [];
        try { $style = json_decode((string) ($layer['style_json'] ?? '{}'), true) ?: []; } catch (\Throwable $e) {}
        Response::geojson($features, [
            'layer_code' => $layer['code'],
            'layer_name' => $layer['name'],
            'version' => $layer['version'],
            'style' => $style,
        ]);
    }

    /**
     * GET /api/imported-layers/{code}/features
     * Возвращает объекты слоя (постранично) в порядке:
     * point -> line -> other (polygon etc).
     *
     * Query:
     * - limit (default 500, max 5000)
     * - offset (default 0)
     */
    public function features(string $code): void
    {
        $code = $this->ensureSafeIdent(strtolower(trim($code)));
        $isAdminLike = Auth::isAdmin() || Auth::isRoot();
        try {
            $layer = $this->db->fetch("SELECT * FROM imported_layers WHERE code = :c", ['c' => $code]);
        } catch (\PDOException $e) {
            Response::error('Настройки импортированных слоёв не готовы. Примените миграции database/migration_v23.sql и database/migration_v24.sql', 500);
        }
        if (!$layer) Response::error('Слой не найден', 404);
        if (!$isAdminLike && !((bool) ($layer['is_public'] ?? false))) {
            Response::error('Доступ запрещён', 403);
        }

        $table = $this->ensureSafeIdent((string) ($layer['table_name'] ?? ''));
        $geomCol = $this->ensureSafeIdent((string) ($layer['geometry_column'] ?? 'geom'));

        $limit = (int) ($this->request->query('limit', 500) ?? 500);
        if ($limit <= 0) $limit = 500;
        if ($limit > 5000) $limit = 5000;
        $offset = (int) ($this->request->query('offset', 0) ?? 0);
        if ($offset < 0) $offset = 0;

        // filter by geometry type settings
        $sp = (bool) ($layer['show_points'] ?? true);
        $sl = (bool) ($layer['show_lines'] ?? true);
        $sg = (bool) ($layer['show_polygons'] ?? true);
        $typeConds = [];
        if ($sp) $typeConds[] = "ST_GeometryType({$geomCol}) IN ('ST_Point','ST_MultiPoint')";
        if ($sl) $typeConds[] = "ST_GeometryType({$geomCol}) IN ('ST_LineString','ST_MultiLineString')";
        if ($sg) $typeConds[] = "ST_GeometryType({$geomCol}) IN ('ST_Polygon','ST_MultiPolygon')";
        $typeWhere = $typeConds ? (" AND (" . implode(" OR ", $typeConds) . ")") : "";

        try {
            $totalRow = $this->db->fetch("SELECT COUNT(*)::int AS cnt FROM {$table} WHERE {$geomCol} IS NOT NULL{$typeWhere}");
            $total = (int) ($totalRow['cnt'] ?? 0);
        } catch (\PDOException $e) {
            Response::error('Ошибка чтения слоя из БД', 500);
        }

        // ordering by geometry type (point -> line -> other)
        $orderCase = "CASE
            WHEN ST_GeometryType({$geomCol}) IN ('ST_Point','ST_MultiPoint') THEN 1
            WHEN ST_GeometryType({$geomCol}) IN ('ST_LineString','ST_MultiLineString') THEN 2
            ELSE 3
        END";
        $orderId = $this->tableHasColumn($table, 'gid') ? 'gid' : ($this->tableHasColumn($table, 'id') ? 'id' : null);

        $sql = "SELECT *, ST_AsGeoJSON({$geomCol}) AS __geometry, ST_GeometryType({$geomCol}) AS __gtype
                FROM {$table}
                WHERE {$geomCol} IS NOT NULL{$typeWhere}
                ORDER BY {$orderCase} ASC" . ($orderId ? (", {$orderId} ASC") : "") . "
                LIMIT :lim OFFSET :off";
        try {
            $rows = $this->db->fetchAll($sql, ['lim' => $limit, 'off' => $offset]);
        } catch (\PDOException $e) {
            Response::error('Ошибка чтения слоя из БД', 500);
        }

        $features = [];
        foreach ($rows as $r) {
            $geomRaw = $r['__geometry'] ?? null;
            $geom = is_string($geomRaw) ? json_decode($geomRaw, true) : null;
            if (!$geom || !isset($geom['type'])) continue;
            $gtype = (string) ($r['__gtype'] ?? '');
            unset($r['__geometry'], $r['__gtype']);
            unset($r[$geomCol]);
            // добавим тип геометрии в properties (удобно для UI)
            $r['_geometry_type'] = $gtype;
            $features[] = ['type' => 'Feature', 'geometry' => $geom, 'properties' => $r];
        }

        Response::geojson($features, [
            'layer_code' => $layer['code'],
            'layer_name' => $layer['name'],
            'version' => $layer['version'],
            'total' => $total,
            'limit' => $limit,
            'offset' => $offset,
        ]);
    }

    /**
     * POST /api/imported-layers/import
     * multipart/form-data:
     * - name
     * - tab_file, dat_file, map_file, id_file
     * - point_symbol, point_size, point_color
     * - line_style, line_weight, line_color
     */
    public function import(): void
    {
        $this->requireAdminLike();

        // Имя слоя может прийти пустым (например, при больших файлах и нестабильном UI).
        // В этом случае подставим базовое имя файла.
        $name = trim((string) $this->request->input('name', ''));

        $tab = $this->request->file('tab_file');
        $dat = $this->request->file('dat_file');
        $map = $this->request->file('map_file');
        $idf = $this->request->file('id_file');

        $need = ['tab_file' => $tab, 'dat_file' => $dat, 'map_file' => $map, 'id_file' => $idf];
        foreach ($need as $k => $f) {
            if (!$f || !is_array($f) || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
                Response::error('Необходимо загрузить файлы .TAB, .DAT, .MAP, .ID', 400);
            }
        }

        $baseTab = pathinfo((string) ($tab['name'] ?? ''), PATHINFO_FILENAME);
        $baseDat = pathinfo((string) ($dat['name'] ?? ''), PATHINFO_FILENAME);
        $baseMap = pathinfo((string) ($map['name'] ?? ''), PATHINFO_FILENAME);
        $baseId = pathinfo((string) ($idf['name'] ?? ''), PATHINFO_FILENAME);
        $base = (string) $baseTab;
        if ($base === '' || strcasecmp($base, (string) $baseDat) !== 0 || strcasecmp($base, (string) $baseMap) !== 0 || strcasecmp($base, (string) $baseId) !== 0) {
            Response::error('Файлы слоя должны иметь одинаковое базовое имя (например: layer.tab/layer.dat/layer.map/layer.id)', 422);
        }
        if ($name === '') $name = $base;
        if ($name === '') Response::error('Необходимо указать "Имя слоя"', 422);

        $codeRaw = trim((string) $this->request->input('code', ''));
        $code = $codeRaw !== '' ? $this->slugifyCode($codeRaw) : $this->slugifyCode($name);
        $code = $this->ensureSafeIdent($code);
        $tableName = $this->ensureSafeIdent('mi_' . $code);

        // Сохраняем в temp, чтобы .TAB видел остальные файлы по имени
        $tmpDir = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'igs_mapinfo_' . bin2hex(random_bytes(8));
        if (!@mkdir($tmpDir, 0755, true) && !is_dir($tmpDir)) {
            Response::error('Ошибка создания временной директории', 500);
        }

        $tabPath = $tmpDir . DIRECTORY_SEPARATOR . $base . '.tab';
        $datPath = $tmpDir . DIRECTORY_SEPARATOR . $base . '.dat';
        $mapPath = $tmpDir . DIRECTORY_SEPARATOR . $base . '.map';
        $idPath = $tmpDir . DIRECTORY_SEPARATOR . $base . '.id';

        if (!move_uploaded_file($tab['tmp_name'], $tabPath)) { $this->rrmdir($tmpDir); Response::error('Ошибка сохранения .TAB', 500); }
        if (!move_uploaded_file($dat['tmp_name'], $datPath)) { $this->rrmdir($tmpDir); Response::error('Ошибка сохранения .DAT', 500); }
        if (!move_uploaded_file($map['tmp_name'], $mapPath)) { $this->rrmdir($tmpDir); Response::error('Ошибка сохранения .MAP', 500); }
        if (!move_uploaded_file($idf['tmp_name'], $idPath)) { $this->rrmdir($tmpDir); Response::error('Ошибка сохранения .ID', 500); }

        $filesJson = [];
        $hashes = [];
        foreach (['tab' => $tabPath, 'dat' => $datPath, 'map' => $mapPath, 'id' => $idPath] as $ext => $p) {
            $h = @hash_file('sha256', $p) ?: '';
            $hashes[] = $h;
            $filesJson[$ext] = [
                'name' => basename($p),
                'size' => @filesize($p) ?: 0,
                'sha256' => $h,
            ];
        }
        $version = @hash('sha256', implode('|', $hashes)) ?: '';

        $style = $this->readStyleFromRequest($this->request->input(null, []));
        $styleJson = json_encode($style, JSON_UNESCAPED_UNICODE);
        if (!is_string($styleJson)) $styleJson = '{}';

        // Исходная СК: авто / s_srs / a_srs
        $sourceMode = strtolower(trim((string) $this->request->input('source_srs_mode', 'auto')));
        if (!in_array($sourceMode, ['auto', 's_srs', 'a_srs'], true)) $sourceMode = 'auto';
        $sourceSrs = $this->normalizeSrsString((string) $this->request->input('source_srs', ''));
        if ($sourceMode !== 'auto' && $sourceSrs === '') {
            Response::error('Укажите исходную систему координат (например EPSG:3857)', 422);
        }

        // Проверим наличие ogr2ogr
        $ogrPath = @shell_exec('command -v ogr2ogr 2>/dev/null');
        $ogrPath = is_string($ogrPath) ? trim($ogrPath) : '';
        if ($ogrPath === '') {
            $this->rrmdir($tmpDir);
            Response::error('ogr2ogr не найден на сервере. Установите GDAL (gdal-bin).', 500);
        }

        // Подключение к Postgres
        $dbCfg = require __DIR__ . '/../../config/database.php';
        $pg = 'PG:';
        $pg .= 'host=' . (string) ($dbCfg['host'] ?? 'localhost') . ' ';
        $pg .= 'port=' . (string) ($dbCfg['port'] ?? '5432') . ' ';
        $pg .= 'dbname=' . (string) ($dbCfg['dbname'] ?? '') . ' ';
        $pg .= 'user=' . (string) ($dbCfg['user'] ?? '') . ' ';
        if ((string) ($dbCfg['password'] ?? '') !== '') {
            $pg .= 'password=' . (string) ($dbCfg['password'] ?? '') . ' ';
        }
        $pg = trim($pg);

        // Импорт: перезаписываем таблицу при повторной загрузке
        $srsOpt = '';
        if ($sourceMode === 's_srs') {
            $srsOpt = ' -s_srs ' . escapeshellarg($sourceSrs);
        } elseif ($sourceMode === 'a_srs') {
            $srsOpt = ' -a_srs ' . escapeshellarg($sourceSrs);
        }
        $cmd =
            'ogr2ogr -f PostgreSQL ' . escapeshellarg($pg) . ' ' . escapeshellarg($tabPath) .
            ' -nln ' . escapeshellarg($tableName) .
            ' -lco GEOMETRY_NAME=geom' .
            ' -lco FID=gid' .
            ' -lco SPATIAL_INDEX=GIST' .
            ' -nlt PROMOTE_TO_MULTI' .
            $srsOpt .
            ' -t_srs EPSG:4326' .
            ' -overwrite' .
            ' -skipfailures';

        $out = [];
        $ret = 0;
        @exec($cmd . ' 2>&1', $out, $ret);

        // подчистим temp сразу после импорта
        $this->rrmdir($tmpDir);

        if ($ret !== 0) {
            $tail = implode("\n", array_slice($out, -25));
            Response::error('Ошибка импорта MapInfo слоя: ' . ($tail ?: 'ogr2ogr завершился с ошибкой'), 500);
        }

        // Счётчик импортированных объектов + bbox (WGS84) для удобства проверки
        $importedCount = null;
        $extent = null;
        try {
            $cntRow = $this->db->fetch("SELECT COUNT(*)::int AS cnt FROM {$tableName} WHERE geom IS NOT NULL");
            $importedCount = (int) ($cntRow['cnt'] ?? 0);
        } catch (\Throwable $e) {
            $importedCount = null;
        }
        try {
            $extRow = $this->db->fetch(
                "SELECT
                    ST_XMin(e) AS minx, ST_YMin(e) AS miny, ST_XMax(e) AS maxx, ST_YMax(e) AS maxy
                 FROM (SELECT ST_Extent(geom) AS e FROM {$tableName} WHERE geom IS NOT NULL) t"
            );
            if ($extRow && is_numeric($extRow['minx'] ?? null) && is_numeric($extRow['miny'] ?? null) && is_numeric($extRow['maxx'] ?? null) && is_numeric($extRow['maxy'] ?? null)) {
                $extent = [
                    'minx' => (float) $extRow['minx'],
                    'miny' => (float) $extRow['miny'],
                    'maxx' => (float) $extRow['maxx'],
                    'maxy' => (float) $extRow['maxy'],
                ];
            }
        } catch (\Throwable $e) {
            $extent = null;
        }

        $user = Auth::user();
        $uid = (int) ($user['id'] ?? 0);

        try {
            $existing = $this->db->fetch("SELECT * FROM imported_layers WHERE code = :c", ['c' => $code]);
        } catch (\PDOException $e) {
            Response::error('Настройки импортированных слоёв не готовы. Примените миграции database/migration_v23.sql и database/migration_v24.sql', 500);
        }

        $parseBool = function($v, bool $default = false): bool {
            if ($v === null) return $default;
            if (is_bool($v)) return $v;
            $s = strtolower(trim((string) $v));
            if ($s === '') return $default;
            return in_array($s, ['1','true','yes','on'], true);
        };
        $parseMinZoom = function($v, $default = null) {
            if ($v === null) return $default;
            $s = trim((string) $v);
            if ($s === '') return $default;
            if (!is_numeric($s)) Response::error('Некорректный min_zoom', 422);
            $n = (int) $s;
            if ($n < 0) $n = 0;
            if ($n > 30) $n = 30;
            return $n;
        };

        // Новые свойства слоя (migration_v24)
        $isPublic = $parseBool($this->request->input('is_public', null), (bool) ($existing['is_public'] ?? false));
        $minZoom = $parseMinZoom($this->request->input('min_zoom', null), $existing['min_zoom'] ?? null);
        $showPoints = $parseBool($this->request->input('show_points', null), (bool) ($existing['show_points'] ?? true));
        $showLines = $parseBool($this->request->input('show_lines', null), (bool) ($existing['show_lines'] ?? true));
        $showPolygons = $parseBool($this->request->input('show_polygons', null), (bool) ($existing['show_polygons'] ?? true));

        $now = date('Y-m-d H:i:s');
        $data = [
            'code' => $code,
            'name' => $name,
            'table_name' => $tableName,
            'geometry_column' => 'geom',
            'srid' => 4326,
            'files_json' => json_encode($filesJson, JSON_UNESCAPED_UNICODE),
            'version' => $version,
            'uploaded_at' => $now,
            'updated_at' => $now,
            'created_by' => $uid > 0 ? $uid : null,
            'updated_by' => $uid > 0 ? $uid : null,
            'style_json' => $styleJson,
            'is_public' => $isPublic,
            'min_zoom' => $minZoom,
            'show_points' => $showPoints,
            'show_lines' => $showLines,
            'show_polygons' => $showPolygons,
        ];

        try {
            if ($existing) {
                $id = (int) ($existing['id'] ?? 0);
                unset($data['code']);
                $this->db->update('imported_layers', $data, 'id = :id', ['id' => $id]);
                $layerId = $id;
            } else {
                $layerId = (int) $this->db->insert('imported_layers', $data);
            }
        } catch (\PDOException $e) {
            Response::error('Ошибка сохранения метаданных слоя', 500);
        }

        try { $this->log('import_mapinfo_layer', 'imported_layers', $layerId, null, ['code' => $code, 'name' => $name, 'table' => $tableName]); } catch (\Throwable $e) {}

        $saved = $this->db->fetch(
            "SELECT id, code, name, table_name, geometry_column, srid, version, uploaded_at, updated_at,
                    style_json, is_public, min_zoom, show_points, show_lines, show_polygons
             FROM imported_layers WHERE id = :id",
            ['id' => $layerId]
        );
        if (!$saved) {
            Response::success(null, 'Слой импортирован');
        }
        $saved['style'] = json_decode((string) ($saved['style_json'] ?? '{}'), true) ?: [];
        unset($saved['style_json']);
        $saved['imported_count'] = $importedCount;
        if ($extent) $saved['extent_wgs84'] = $extent;

        Response::success($saved, 'Слой импортирован');
    }

    /**
     * PUT /api/imported-layers/{code}/style
     * JSON body: { point:{symbol,size,color}, line:{style,weight,color} }
     */
    public function updateStyle(string $code): void
    {
        $this->requireAdminLike();
        $code = $this->ensureSafeIdent(strtolower(trim($code)));
        $data = $this->request->input(null, []);
        if (!is_array($data)) Response::error('Некорректные данные', 422);

        $style = $this->readStyleFromRequest($data);
        $styleJson = json_encode($style, JSON_UNESCAPED_UNICODE);
        if (!is_string($styleJson)) $styleJson = '{}';

        $user = Auth::user();
        $uid = (int) ($user['id'] ?? 0);

        try {
            $layer = $this->db->fetch("SELECT * FROM imported_layers WHERE code = :c", ['c' => $code]);
            if (!$layer) Response::error('Слой не найден', 404);

            $parseBool = function($v, bool $default = false): bool {
                if ($v === null) return $default;
                if (is_bool($v)) return $v;
                $s = strtolower(trim((string) $v));
                if ($s === '') return $default;
                return in_array($s, ['1','true','yes','on'], true);
            };
            $parseMinZoom = function($v, $default = null) {
                if ($v === null) return $default;
                $s = trim((string) $v);
                if ($s === '') return $default;
                if (!is_numeric($s)) Response::error('Некорректный min_zoom', 422);
                $n = (int) $s;
                if ($n < 0) $n = 0;
                if ($n > 30) $n = 30;
                return $n;
            };

            $isPublic = $parseBool($data['is_public'] ?? null, (bool) ($layer['is_public'] ?? false));
            $minZoom = $parseMinZoom($data['min_zoom'] ?? null, $layer['min_zoom'] ?? null);
            $showPoints = $parseBool($data['show_points'] ?? null, (bool) ($layer['show_points'] ?? true));
            $showLines = $parseBool($data['show_lines'] ?? null, (bool) ($layer['show_lines'] ?? true));
            $showPolygons = $parseBool($data['show_polygons'] ?? null, (bool) ($layer['show_polygons'] ?? true));
            $this->db->update(
                'imported_layers',
                [
                    'style_json' => $styleJson,
                    'is_public' => $isPublic,
                    'min_zoom' => $minZoom,
                    'show_points' => $showPoints,
                    'show_lines' => $showLines,
                    'show_polygons' => $showPolygons,
                    'updated_at' => date('Y-m-d H:i:s'),
                    'updated_by' => $uid > 0 ? $uid : null,
                ],
                'id = :id',
                ['id' => (int) $layer['id']]
            );
        } catch (\PDOException $e) {
            Response::error('Ошибка сохранения стиля слоя', 500);
        }

        try { $this->log('update_imported_layer_style', 'imported_layers', (int) ($layer['id'] ?? 0), ['style_json' => $layer['style_json'] ?? null], ['style_json' => $styleJson]); } catch (\Throwable $e) {}
        Response::success([
            'code' => $code,
            'style' => $style,
            'is_public' => $isPublic ?? null,
            'min_zoom' => $minZoom ?? null,
            'show_points' => $showPoints ?? null,
            'show_lines' => $showLines ?? null,
            'show_polygons' => $showPolygons ?? null,
        ], 'Настройки слоя сохранены');
    }

    /**
     * DELETE /api/imported-layers/{code}
     * Удаление слоя: метаданные + таблица PostGIS
     */
    public function destroy(string $code): void
    {
        $this->requireAdminLike();
        $code = $this->ensureSafeIdent(strtolower(trim($code)));

        try {
            $layer = $this->db->fetch("SELECT * FROM imported_layers WHERE code = :c", ['c' => $code]);
        } catch (\PDOException $e) {
            Response::error('Таблица импортированных слоёв не создана. Примените миграцию database/migration_v23.sql', 500);
        }
        if (!$layer) Response::error('Слой не найден', 404);

        $table = $this->ensureSafeIdent((string) ($layer['table_name'] ?? ''));
        $layerId = (int) ($layer['id'] ?? 0);

        $this->db->beginTransaction();
        try {
            // 1) удаляем запись
            $this->db->delete('imported_layers', 'id = :id', ['id' => $layerId]);
            // 2) удаляем таблицу (CASCADE на случай зависимостей индексов/вьюх)
            $this->db->query("DROP TABLE IF EXISTS {$table} CASCADE");

            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollback();
            Response::error('Ошибка удаления импортированного слоя', 500);
        }

        try { $this->log('delete_imported_layer', 'imported_layers', $layerId, $layer, null); } catch (\Throwable $e) {}
        Response::success(['code' => $code], 'Слой удалён');
    }
}


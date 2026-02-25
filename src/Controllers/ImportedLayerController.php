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
        try {
            $rows = $this->db->fetchAll(
                "SELECT id, code, name, table_name, geometry_column, srid, version, uploaded_at, updated_at, style_json
                 FROM imported_layers
                 ORDER BY name ASC, id ASC"
            );
        } catch (\PDOException $e) {
            Response::error('Таблица импортированных слоёв не создана. Примените миграцию database/migration_v23.sql', 500);
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
        try {
            $layer = $this->db->fetch("SELECT * FROM imported_layers WHERE code = :c", ['c' => $code]);
        } catch (\PDOException $e) {
            Response::error('Таблица импортированных слоёв не создана. Примените миграцию database/migration_v23.sql', 500);
        }
        if (!$layer) Response::error('Слой не найден', 404);

        $table = $this->ensureSafeIdent((string) ($layer['table_name'] ?? ''));
        $geomCol = $this->ensureSafeIdent((string) ($layer['geometry_column'] ?? 'geom'));
        $srid = (int) ($layer['srid'] ?? 4326);
        if ($srid <= 0) $srid = 4326;

        $params = [];
        $where = "{$geomCol} IS NOT NULL";

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

        $name = trim((string) $this->request->input('name', ''));
        if ($name === '') Response::error('Необходимо указать "Имя слоя"', 422);

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
        $cmd =
            'ogr2ogr -f PostgreSQL ' . escapeshellarg($pg) . ' ' . escapeshellarg($tabPath) .
            ' -nln ' . escapeshellarg($tableName) .
            ' -lco GEOMETRY_NAME=geom' .
            ' -lco FID=gid' .
            ' -lco SPATIAL_INDEX=GIST' .
            ' -nlt PROMOTE_TO_MULTI' .
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

        $user = Auth::user();
        $uid = (int) ($user['id'] ?? 0);

        try {
            $existing = $this->db->fetch("SELECT id FROM imported_layers WHERE code = :c", ['c' => $code]);
        } catch (\PDOException $e) {
            Response::error('Таблица импортированных слоёв не создана. Примените миграцию database/migration_v23.sql', 500);
        }

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
            "SELECT id, code, name, table_name, geometry_column, srid, version, uploaded_at, updated_at, style_json
             FROM imported_layers WHERE id = :id",
            ['id' => $layerId]
        );
        if (!$saved) {
            Response::success(null, 'Слой импортирован');
        }
        $saved['style'] = json_decode((string) ($saved['style_json'] ?? '{}'), true) ?: [];
        unset($saved['style_json']);

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
            $layer = $this->db->fetch("SELECT id, style_json FROM imported_layers WHERE code = :c", ['c' => $code]);
            if (!$layer) Response::error('Слой не найден', 404);
            $this->db->update(
                'imported_layers',
                [
                    'style_json' => $styleJson,
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
        Response::success(['code' => $code, 'style' => $style], 'Настройки слоя сохранены');
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


<?php
/**
 * Базовый контроллер с общими методами
 */

namespace App\Controllers;

use App\Core\Database;
use App\Core\Request;
use App\Core\Response;
use App\Core\Auth;
use App\Core\Logger;

abstract class BaseController
{
    protected Database $db;
    protected Request $request;
    protected Auth $auth;
    protected Logger $logger;
    protected array $config;

    public function __construct()
    {
        $this->db = Database::getInstance();
        $this->request = new Request();
        $this->auth = new Auth();
        $this->logger = Logger::getInstance();
        $this->config = require __DIR__ . '/../../config/app.php';
    }

    /**
     * Логирование ошибки
     */
    protected function logError(string $message, array $context = []): void
    {
        $callerClass = get_class($this);
        $module = str_replace(['App\\Controllers\\', 'Controller'], '', $callerClass);
        
        $trace = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 2);
        $file = $trace[1]['file'] ?? 'unknown';
        $line = $trace[1]['line'] ?? 0;
        
        $this->logger->error($message, $module, basename($file), $line, $context);
    }

    /**
     * Логирование предупреждения
     */
    protected function logWarning(string $message, array $context = []): void
    {
        $callerClass = get_class($this);
        $module = str_replace(['App\\Controllers\\', 'Controller'], '', $callerClass);
        
        $trace = debug_backtrace(DEBUG_BACKTRACE_IGNORE_ARGS, 2);
        $file = $trace[1]['file'] ?? 'unknown';
        $line = $trace[1]['line'] ?? 0;
        
        $this->logger->warning($message, $module, basename($file), $line, $context);
    }

    /**
     * Получить параметры пагинации
     */
    protected function getPagination(): array
    {
        $page = max(1, (int) $this->request->query('page', 1));
        $limit = min(
            $this->config['pagination']['max_limit'],
            max(1, (int) $this->request->query('limit', $this->config['pagination']['default_limit']))
        );
        $offset = ($page - 1) * $limit;

        return compact('page', 'limit', 'offset');
    }

    /**
     * Получить общее количество записей
     * @param string $table Имя таблицы
     * @param string $where WHERE условие
     * @param array $params Параметры запроса
     * @param string $alias Алиас таблицы (если в where используются алиасы)
     */
    protected function getTotal(string $table, string $where = '', array $params = [], string $alias = ''): int
    {
        $fromClause = $alias ? "{$table} {$alias}" : $table;
        $sql = "SELECT COUNT(*) as cnt FROM {$fromClause}";
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $result = $this->db->fetch($sql, $params);
        return (int) ($result['cnt'] ?? 0);
    }

    /**
     * Построить WHERE условие из фильтров
     */
    protected function buildFilters(array $allowedFilters): array
    {
        $conditions = [];
        $params = [];

        foreach ($allowedFilters as $filter => $column) {
            $value = $this->request->query($filter);
            if ($value !== null && $value !== '') {
                $conditions[] = "{$column} = :{$filter}";
                $params[$filter] = $value;
            }
        }

        // Поиск по тексту
        $search = $this->request->query('search');
        if ($search && isset($allowedFilters['_search'])) {
            $searchFields = $allowedFilters['_search'];
            $searchConditions = array_map(fn($f) => "{$f} ILIKE :search", $searchFields);
            $conditions[] = '(' . implode(' OR ', $searchConditions) . ')';
            $params['search'] = "%{$search}%";
        }

        return [
            'where' => $conditions ? implode(' AND ', $conditions) : '',
            'params' => $params,
        ];
    }

    /**
     * Проверка права на запись
     */
    protected function checkWriteAccess(): void
    {
        if (!Auth::canWrite()) {
            Response::error('Недостаточно прав для выполнения операции', 403);
        }
    }

    /**
     * Проверка права на удаление
     */
    protected function checkDeleteAccess(): void
    {
        if (!Auth::canDelete()) {
            Response::error('Недостаточно прав для удаления', 403);
        }
    }

    /**
     * Логирование действия
     */
    protected function log(string $action, string $table, int $recordId = null, array $oldValues = null, array $newValues = null): void
    {
        $this->auth->log($action, $table, $recordId, $oldValues, $newValues);
    }

    /**
     * Обработка загрузки файла
     */
    protected function handleFileUpload(string $fieldName, string $subDir = ''): ?array
    {
        $file = $this->request->file($fieldName);
        
        if (!$file || $file['error'] !== UPLOAD_ERR_OK) {
            return null;
        }

        // Проверка размера
        if ($file['size'] > $this->config['max_upload_size']) {
            Response::error('Файл слишком большой', 400);
        }

        // Проверка расширения
        $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if (!in_array($ext, $this->config['allowed_extensions'])) {
            Response::error('Недопустимый тип файла', 400);
        }

        // Генерируем уникальное имя
        $filename = uniqid() . '_' . time() . '.' . $ext;
        $uploadPath = $this->config['upload_path'];
        
        if ($subDir) {
            $uploadPath .= '/' . $subDir;
        }

        if (!is_dir($uploadPath)) {
            // mkdir может кинуть warning (который у нас превращается в Exception) — подавляем и проверяем явно
            if (!@mkdir($uploadPath, 0755, true) && !is_dir($uploadPath)) {
                Response::error('Нет прав на создание директории загрузки. Проверьте права на папку uploads.', 500);
            }
        }
        if (!is_writable($uploadPath)) {
            Response::error('Нет прав на запись в директорию загрузки. Проверьте владельца/права на папку uploads.', 500);
        }

        $filePath = $uploadPath . '/' . $filename;

        if (!move_uploaded_file($file['tmp_name'], $filePath)) {
            Response::error('Ошибка сохранения файла. Проверьте права на папку uploads и свободное место.', 500);
        }

        return [
            'filename' => $filename,
            'original_filename' => $file['name'],
            'file_path' => $filePath,
            'file_size' => $file['size'],
            'mime_type' => $file['type'],
        ];
    }

    /**
     * Трансформация координат WGS84 <-> МСК86
     */
    protected function transformCoordinates(string $fromSrid, string $toSrid, float $x, float $y): array
    {
        $sql = "SELECT ST_X(ST_Transform(ST_SetSRID(ST_MakePoint(:x, :y), :from_srid), :to_srid)) as x,
                       ST_Y(ST_Transform(ST_SetSRID(ST_MakePoint(:x, :y), :from_srid), :to_srid)) as y";
        
        return $this->db->fetch($sql, [
            'x' => $x,
            'y' => $y,
            'from_srid' => $fromSrid,
            'to_srid' => $toSrid,
        ]);
    }

    /**
     * Создание геометрии точки
     */
    protected function makePoint(float $x, float $y, int $srid = 4326): string
    {
        return "ST_SetSRID(ST_MakePoint({$x}, {$y}), {$srid})";
    }

    /**
     * Создание геометрии линии из массива точек
     */
    protected function makeLineString(array $points, int $srid = 4326): string
    {
        $coords = array_map(fn($p) => "{$p[0]} {$p[1]}", $points);
        return "ST_SetSRID(ST_GeomFromText('LINESTRING(" . implode(', ', $coords) . ")'), {$srid})";
    }

    /**
     * Нормализация разделителя CSV из query-параметра.
     * Поддержка: ; , tab \t |
     */
    protected function normalizeCsvDelimiter(?string $value, string $default = ';'): string
    {
        $v = trim((string) ($value ?? ''));
        if ($v === '') {
            return $default;
        }

        $lower = function_exists('mb_strtolower') ? mb_strtolower($v) : strtolower($v);
        return match ($lower) {
            ';', 'semicolon', 'точка-с-запятой', 'точка с запятой' => ';',
            ',', 'comma', 'запятая' => ',',
            '|', 'pipe', 'вертикальная черта' => '|',
            '\t', 'tab', 'таб', 'табуляция' => "\t",
            default => ((function_exists('mb_strlen') ? mb_strlen($v) : strlen($v)) === 1 ? $v : $default),
        };
    }
}

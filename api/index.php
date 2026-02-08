<?php
/**
 * Точка входа API
 * ИГС lksoftGwebsrv
 */

// Автозагрузка
require_once __DIR__ . '/../vendor/autoload.php';

// Конфигурация
$config = require __DIR__ . '/../config/app.php';

// Установка временной зоны
date_default_timezone_set($config['timezone']);

// Инициализация логгера
use App\Core\Logger;
$logger = Logger::getInstance();

// Заголовки CORS
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');

// Обработка preflight запросов
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

// Обработка ошибок PHP
set_error_handler(function($severity, $message, $file, $line) use ($logger) {
    // Определяем модуль по пути файла
    $module = 'PHP';
    if (strpos($file, 'Controllers') !== false) {
        preg_match('/Controllers\/(\w+)Controller/', $file, $matches);
        $module = $matches[1] ?? 'Controller';
    } elseif (strpos($file, 'Core') !== false) {
        preg_match('/Core\/(\w+)/', $file, $matches);
        $module = $matches[1] ?? 'Core';
    }
    
    // Логируем ошибку
    $logger->error($message, $module, basename($file), $line, [
        'severity' => $severity,
        'full_path' => $file
    ]);
    
    throw new ErrorException($message, 0, $severity, $file, $line);
});

// Обработка исключений
set_exception_handler(function($e) use ($config, $logger) {
    // Определяем модуль по пути файла
    $file = $e->getFile();
    $module = 'Exception';
    if (strpos($file, 'Controllers') !== false) {
        preg_match('/Controllers\/(\w+)Controller/', $file, $matches);
        $module = $matches[1] ?? 'Controller';
    } elseif (strpos($file, 'Core') !== false) {
        preg_match('/Core\/(\w+)/', $file, $matches);
        $module = $matches[1] ?? 'Core';
    }
    
    // Логируем исключение
    $logger->critical($e->getMessage(), $module, basename($file), $e->getLine(), [
        'exception_class' => get_class($e),
        'trace' => $e->getTraceAsString()
    ]);
    
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    
    $response = [
        'success' => false,
        'message' => 'Внутренняя ошибка сервера',
    ];
    
    if ($config['debug']) {
        $response['error'] = $e->getMessage();
        $response['file'] = $e->getFile() . ':' . $e->getLine();
        $response['trace'] = $e->getTraceAsString();
    }
    
    echo json_encode($response, JSON_UNESCAPED_UNICODE);
    exit;
});

// Логируем начало запроса (только для отладки)
if ($config['debug']) {
    $logger->debug(
        'API Request: ' . $_SERVER['REQUEST_METHOD'] . ' ' . $_SERVER['REQUEST_URI'],
        'Router',
        'index.php',
        0,
        ['ip' => $_SERVER['REMOTE_ADDR'] ?? 'unknown']
    );
}

use App\Core\Router;
use App\Core\Request;
use App\Core\Response;
use App\Core\Auth;
use App\Controllers\AuthController;
use App\Controllers\ReferenceController;
use App\Controllers\WellController;
use App\Controllers\ChannelController;
use App\Controllers\CableController;
use App\Controllers\UnifiedCableController;
use App\Controllers\MarkerPostController;
use App\Controllers\IncidentController;
use App\Controllers\IncidentDocumentController;
use App\Controllers\GroupController;
use App\Controllers\GroupAttachmentController;
use App\Controllers\OwnerColorController;
use App\Controllers\ImportController;
use App\Controllers\PhotoController;
use App\Controllers\ReportController;
use App\Controllers\SettingsController;

$router = new Router();
$request = new Request();

// Middleware для проверки авторизации
$router->addMiddleware('auth', function() use ($request) {
    $token = $request->bearerToken();
    
    if (!$token) {
        Response::error('Требуется авторизация', 401);
        return false;
    }
    
    $auth = new Auth();
    $user = $auth->validateToken($token);
    
    if (!$user) {
        Response::error('Недействительный токен', 401);
        return false;
    }
    
    return true;
});

// ========================
// ПУБЛИЧНЫЕ МАРШРУТЫ
// ========================

// Авторизация
$router->post('/api/auth/login', [AuthController::class, 'login']);

// ========================
// ЗАЩИЩЁННЫЕ МАРШРУТЫ
// ========================

// Авторизация
$router->post('/api/auth/logout', [AuthController::class, 'logout'], ['auth']);
$router->get('/api/auth/me', [AuthController::class, 'me'], ['auth']);
$router->put('/api/auth/password', [AuthController::class, 'changePassword'], ['auth']);

// Пользователи (только админ)
$router->post('/api/auth/register', [AuthController::class, 'register'], ['auth']);
$router->get('/api/users', [AuthController::class, 'listUsers'], ['auth']);
$router->put('/api/users/{id}', [AuthController::class, 'updateUser'], ['auth']);
$router->delete('/api/users/{id}', [AuthController::class, 'deleteUser'], ['auth']);
$router->get('/api/roles', [AuthController::class, 'listRoles'], ['auth']);

// Справочники
$router->get('/api/references', [ReferenceController::class, 'types'], ['auth']);
$router->get('/api/references/{type}', [ReferenceController::class, 'index'], ['auth']);
$router->get('/api/references/{type}/all', [ReferenceController::class, 'all'], ['auth']);
$router->get('/api/references/{type}/{id}', [ReferenceController::class, 'show'], ['auth']);
$router->post('/api/references/{type}', [ReferenceController::class, 'store'], ['auth']);
$router->put('/api/references/{type}/{id}', [ReferenceController::class, 'update'], ['auth']);
$router->delete('/api/references/{type}/{id}', [ReferenceController::class, 'destroy'], ['auth']);

// Персональные цвета собственников (для легенды)
$router->get('/api/owners/colors', [OwnerColorController::class, 'index'], ['auth']);
$router->put('/api/owners/colors/{id}', [OwnerColorController::class, 'update'], ['auth']);
$router->delete('/api/owners/colors/{id}', [OwnerColorController::class, 'destroy'], ['auth']);

// Колодцы
$router->get('/api/wells', [WellController::class, 'index'], ['auth']);
$router->get('/api/wells/geojson', [WellController::class, 'geojson'], ['auth']);
$router->get('/api/wells/exists', [WellController::class, 'existsNumber'], ['auth']);
$router->get('/api/wells/export', [WellController::class, 'export'], ['auth']);
$router->post('/api/wells/import-text/preview', [WellController::class, 'importTextPreview'], ['auth']);
$router->post('/api/wells/import-text', [WellController::class, 'importText'], ['auth']);
$router->get('/api/wells/{id}', [WellController::class, 'show'], ['auth']);
$router->post('/api/wells', [WellController::class, 'store'], ['auth']);
$router->post('/api/wells/{id}/dismantle', [WellController::class, 'dismantle'], ['auth']);
$router->put('/api/wells/{id}', [WellController::class, 'update'], ['auth']);
$router->delete('/api/wells/{id}', [WellController::class, 'destroy'], ['auth']);

// Направления каналов
$router->get('/api/channel-directions', [ChannelController::class, 'index'], ['auth']);
$router->get('/api/channel-directions/geojson', [ChannelController::class, 'geojson'], ['auth']);
$router->get('/api/channel-directions/shortest-path', [ChannelController::class, 'shortestPath'], ['auth']);
$router->get('/api/channel-directions/geojson-by-ids', [ChannelController::class, 'geojsonByIds'], ['auth']);
$router->get('/api/channel-directions/stats', [ChannelController::class, 'stats'], ['auth']);
$router->get('/api/channel-directions/export', [ChannelController::class, 'exportDirections'], ['auth']);
$router->get('/api/channel-directions/{id}', [ChannelController::class, 'show'], ['auth']);
$router->post('/api/channel-directions', [ChannelController::class, 'store'], ['auth']);
$router->put('/api/channel-directions/{id}', [ChannelController::class, 'update'], ['auth']);
$router->delete('/api/channel-directions/{id}', [ChannelController::class, 'destroy'], ['auth']);
$router->post('/api/channel-directions/{id}/channels', [ChannelController::class, 'addChannel'], ['auth']);
$router->post('/api/channel-directions/{id}/channels/ensure', [ChannelController::class, 'ensureChannelCount'], ['auth']);
$router->post('/api/channel-directions/{id}/stuff-well', [ChannelController::class, 'stuffWell'], ['auth']);

// Каналы (дочерние объекты направлений)
$router->get('/api/cable-channels', [ChannelController::class, 'listChannels'], ['auth']);
$router->get('/api/cable-channels/export', [ChannelController::class, 'exportChannels'], ['auth']);
$router->get('/api/cable-channels/{id}', [ChannelController::class, 'showChannel'], ['auth']);
$router->put('/api/cable-channels/{id}', [ChannelController::class, 'updateChannel'], ['auth']);
$router->delete('/api/cable-channels/{id}', [ChannelController::class, 'deleteChannel'], ['auth']);

// Кабели (старые таблицы - для совместимости)
$router->get('/api/cables/all/geojson', [CableController::class, 'allGeojson'], ['auth']);
$router->get('/api/cables/{type}', [CableController::class, 'index'], ['auth']);
$router->get('/api/cables/{type}/geojson', [CableController::class, 'geojson'], ['auth']);
$router->get('/api/cables/{type}/export', [CableController::class, 'export'], ['auth']);
$router->get('/api/cables/{type}/{id}', [CableController::class, 'show'], ['auth']);
$router->post('/api/cables/{type}', [CableController::class, 'store'], ['auth']);
$router->put('/api/cables/{type}/{id}', [CableController::class, 'update'], ['auth']);
$router->delete('/api/cables/{type}/{id}', [CableController::class, 'destroy'], ['auth']);

// Унифицированные кабели (новая таблица)
$router->get('/api/unified-cables/object-types', [UnifiedCableController::class, 'objectTypes'], ['auth']);
$router->get('/api/unified-cables/exists', [UnifiedCableController::class, 'existsNumber'], ['auth']);
$router->get('/api/unified-cables/geojson', [UnifiedCableController::class, 'geojson'], ['auth']);
$router->get('/api/unified-cables/stats', [UnifiedCableController::class, 'stats'], ['auth']);
$router->get('/api/unified-cables/export', [UnifiedCableController::class, 'export'], ['auth']);
$router->get('/api/unified-cables', [UnifiedCableController::class, 'index'], ['auth']);
$router->get('/api/unified-cables/by-well/{id}', [UnifiedCableController::class, 'byWell'], ['auth']);
$router->get('/api/unified-cables/by-direction/{id}', [UnifiedCableController::class, 'byDirection'], ['auth']);
$router->get('/api/unified-cables/by-channel/{id}', [UnifiedCableController::class, 'byChannel'], ['auth']);
$router->get('/api/unified-cables/{id}/route-directions-geojson', [UnifiedCableController::class, 'routeDirectionsGeojson'], ['auth']);
$router->get('/api/unified-cables/{id}', [UnifiedCableController::class, 'show'], ['auth']);
$router->get('/api/unified-cables/{id}/recalculate-length', [UnifiedCableController::class, 'recalculateLength'], ['auth']);
$router->post('/api/unified-cables', [UnifiedCableController::class, 'store'], ['auth']);
$router->put('/api/unified-cables/{id}', [UnifiedCableController::class, 'update'], ['auth']);
$router->delete('/api/unified-cables/{id}', [UnifiedCableController::class, 'destroy'], ['auth']);

// Столбики
$router->get('/api/marker-posts', [MarkerPostController::class, 'index'], ['auth']);
$router->get('/api/marker-posts/geojson', [MarkerPostController::class, 'geojson'], ['auth']);
$router->get('/api/marker-posts/exists', [MarkerPostController::class, 'existsNumber'], ['auth']);
$router->get('/api/marker-posts/export', [MarkerPostController::class, 'export'], ['auth']);
$router->get('/api/marker-posts/{id}', [MarkerPostController::class, 'show'], ['auth']);
$router->post('/api/marker-posts', [MarkerPostController::class, 'store'], ['auth']);
$router->put('/api/marker-posts/{id}', [MarkerPostController::class, 'update'], ['auth']);
$router->delete('/api/marker-posts/{id}', [MarkerPostController::class, 'destroy'], ['auth']);

// Инциденты
$router->get('/api/incidents', [IncidentController::class, 'index'], ['auth']);
$router->delete('/api/incidents/documents/{id}', [IncidentDocumentController::class, 'destroy'], ['auth']);
$router->get('/api/incidents/{id}', [IncidentController::class, 'show'], ['auth']);
$router->post('/api/incidents', [IncidentController::class, 'store'], ['auth']);
$router->put('/api/incidents/{id}', [IncidentController::class, 'update'], ['auth']);
$router->delete('/api/incidents/{id}', [IncidentController::class, 'destroy'], ['auth']);
$router->post('/api/incidents/{id}/history', [IncidentController::class, 'addHistoryEntry'], ['auth']);
$router->get('/api/incidents/{id}/documents', [IncidentDocumentController::class, 'byIncident'], ['auth']);
$router->post('/api/incidents/{id}/documents', [IncidentDocumentController::class, 'upload'], ['auth']);

// Группы
$router->get('/api/groups', [GroupController::class, 'index'], ['auth']);
$router->get('/api/groups/export', [GroupController::class, 'export'], ['auth']);
$router->get('/api/groups/by-object', [GroupController::class, 'byObject'], ['auth']);
$router->get('/api/groups/{id}', [GroupController::class, 'show'], ['auth']);
$router->get('/api/groups/{id}/geojson', [GroupController::class, 'geojson'], ['auth']);
$router->post('/api/groups', [GroupController::class, 'store'], ['auth']);
$router->put('/api/groups/{id}', [GroupController::class, 'update'], ['auth']);
$router->delete('/api/groups/{id}', [GroupController::class, 'destroy'], ['auth']);
$router->post('/api/groups/{id}/objects', [GroupController::class, 'addObjects'], ['auth']);
$router->delete('/api/groups/{id}/objects', [GroupController::class, 'removeObjects'], ['auth']);
$router->get('/api/groups/{id}/attachments', [GroupAttachmentController::class, 'byGroup'], ['auth']);
$router->post('/api/groups/{id}/attachments', [GroupAttachmentController::class, 'upload'], ['auth']);
$router->delete('/api/groups/attachments/{id}', [GroupAttachmentController::class, 'destroy'], ['auth']);

// Импорт
$router->post('/api/import/csv', [ImportController::class, 'importCsv'], ['auth']);
$router->post('/api/import/preview', [ImportController::class, 'previewCsv'], ['auth']);
$router->post('/api/import/mapinfo', [ImportController::class, 'importMapInfo'], ['auth']);
$router->post('/api/import/mapinfo/confirm', [ImportController::class, 'confirmMapInfoImport'], ['auth']);

// Фотографии
$router->post('/api/photos', [PhotoController::class, 'upload'], ['auth']);
$router->get('/api/photos/{id}', [PhotoController::class, 'show'], ['auth']);
$router->put('/api/photos/{id}', [PhotoController::class, 'update'], ['auth']);
$router->delete('/api/photos/{id}', [PhotoController::class, 'destroy'], ['auth']);
$router->get('/api/photos/object/{table}/{id}', [PhotoController::class, 'byObject'], ['auth']);
$router->post('/api/photos/reorder', [PhotoController::class, 'reorder'], ['auth']);

// Отчёты
$router->get('/api/reports/objects', [ReportController::class, 'objects'], ['auth']);
$router->get('/api/reports/contracts', [ReportController::class, 'contracts'], ['auth']);
$router->get('/api/reports/owners', [ReportController::class, 'owners'], ['auth']);
$router->get('/api/reports/incidents', [ReportController::class, 'incidents'], ['auth']);
$router->get('/api/reports/export/{type}', [ReportController::class, 'export'], ['auth']);

// Настройки (системные)
$router->get('/api/settings', [SettingsController::class, 'index'], ['auth']);
$router->put('/api/settings', [SettingsController::class, 'update'], ['auth']);

// Запуск маршрутизации
$uri = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$router->dispatch($_SERVER['REQUEST_METHOD'], $uri);

<?php
/**
 * Основная конфигурация приложения
 * ИГС lksoftGwebsrv
 */

$env = function (string $key, $default = null) {
    $v = getenv($key);
    if ($v === false || $v === null) {
        $v = $_ENV[$key] ?? null;
    }
    if ($v === null) return $default;
    if (is_string($v) && trim($v) === '') return $default;
    return $v;
};

$envBool = function (string $key, bool $default = false) use ($env): bool {
    $v = $env($key, null);
    if ($v === null) return $default;
    if (is_bool($v)) return $v;
    $s = strtolower(trim((string) $v));
    if (in_array($s, ['1', 'true', 'yes', 'on'], true)) return true;
    if (in_array($s, ['0', 'false', 'no', 'off'], true)) return false;
    return $default;
};

return [
    'name' => 'ИГС lksoftGwebsrv',
    'version' => '1.0.0',
    // В production debug должен быть выключен (не возвращаем stack trace/внутренности клиенту).
    'debug' => $envBool('IGS_APP_DEBUG', false),
    'timezone' => (string) $env('IGS_APP_TIMEZONE', 'Asia/Yekaterinburg'),
    'locale' => 'ru_RU',
    
    // Пути
    'base_url' => (string) $env('IGS_BASE_URL', ''),
    'upload_path' => (string) $env('IGS_UPLOAD_PATH', __DIR__ . '/../uploads'),
    'max_upload_size' => (int) $env('IGS_UPLOAD_MAX_BYTES', 50 * 1024 * 1024), // 50MB
    'allowed_extensions' => ['jpg', 'jpeg', 'png', 'gif', 'webp'],

    // CORS: для production ограничьте список origin'ов (через ENV).
    // Формат: "*", либо список через запятую: "https://a.example,https://b.example"
    'cors' => [
        'allow_origins' => (string) $env('IGS_CORS_ALLOW_ORIGINS', '*'),
        'allow_methods' => 'GET, POST, PUT, DELETE, OPTIONS',
        'allow_headers' => 'Content-Type, Authorization, X-Requested-With',
        'max_age' => (int) $env('IGS_CORS_MAX_AGE', 86400),
    ],
    
    // Сессии
    'session' => [
        'name' => 'IGS_SESSION',
        'lifetime' => (int) $env('IGS_SESSION_LIFETIME', 86400), // 24 часа
        // cookie-параметры на будущее (если будет cookie-based auth)
        'secure' => $envBool('IGS_SESSION_SECURE', true),
        'httponly' => true,
    ],
    
    // JWT токены
    'jwt' => [
        // В текущей версии приложения используется token-based session (user_sessions).
        // Оставлено на будущее: храните секреты только во внешнем окружении.
        'secret' => (string) $env('IGS_JWT_SECRET', ''),
        'algorithm' => (string) $env('IGS_JWT_ALG', 'HS256'),
        'expiration' => (int) $env('IGS_JWT_EXP', 86400), // 24 часа
    ],
    
    // SRID для систем координат
    'srid' => [
        'wgs84' => 4326,
        'msk86_zone4' => 200004,
    ],
    
    // Лимиты
    'pagination' => [
        'default_limit' => 50,
        'max_limit' => 1000,
    ],
    'photos' => [
        'max_per_object' => 10,
    ],
];

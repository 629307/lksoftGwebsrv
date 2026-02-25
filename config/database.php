<?php
/**
 * Конфигурация подключения к базе данных PostgreSQL
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

return [
    // В production храните учётные данные БД во внешнем окружении, а не в репозитории.
    'host' => (string) $env('IGS_DB_HOST', 'localhost'),
    'port' => (string) $env('IGS_DB_PORT', '5432'),
    'dbname' => (string) $env('IGS_DB_NAME', 'lksoftgwebsrv'),
    'user' => (string) $env('IGS_DB_USER', 'lksoftgwebsrv'),
    'password' => (string) $env('IGS_DB_PASSWORD', ''),
    'charset' => (string) $env('IGS_DB_CHARSET', 'UTF8'),
    'options' => [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]
];

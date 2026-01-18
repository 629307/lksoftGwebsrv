<?php
/**
 * Основная конфигурация приложения
 * ИГС lksoftGwebsrv
 */

return [
    'name' => 'ИГС lksoftGwebsrv',
    'version' => '1.0.0',
    'debug' => true,
    'timezone' => 'Asia/Yekaterinburg',
    'locale' => 'ru_RU',
    
    // Пути
    'base_url' => '',
    'upload_path' => __DIR__ . '/../uploads',
    'max_upload_size' => 50 * 1024 * 1024, // 50MB
    'allowed_extensions' => ['jpg', 'jpeg', 'png', 'gif', 'webp'],
    
    // Сессии
    'session' => [
        'name' => 'IGS_SESSION',
        'lifetime' => 86400, // 24 часа
        'secure' => false,
        'httponly' => true,
    ],
    
    // JWT токены
    'jwt' => [
        'secret' => 'lksoftGwebsrv_jwt_secret_key_2024',
        'algorithm' => 'HS256',
        'expiration' => 86400, // 24 часа
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

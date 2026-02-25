<?php
/**
 * Класс для формирования HTTP ответов
 */

namespace App\Core;

class Response
{
    public static function json($data, int $status = 200, array $headers = []): void
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        
        foreach ($headers as $key => $value) {
            header("$key: $value");
        }

        echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
        exit;
    }

    public static function success($data = null, string $message = 'OK', int $status = 200): void
    {
        self::json([
            'success' => true,
            'message' => $message,
            'data' => $data,
        ], $status);
    }

    public static function error(string $message, int $status = 400, $errors = null): void
    {
        $response = [
            'success' => false,
            'message' => $message,
        ];

        if ($errors !== null) {
            $response['errors'] = $errors;
        }

        self::json($response, $status);
    }

    public static function paginated(array $data, int $total, int $page, int $limit): void
    {
        self::json([
            'success' => true,
            'data' => $data,
            'pagination' => [
                'total' => $total,
                'page' => $page,
                'limit' => $limit,
                'pages' => ceil($total / $limit),
            ],
        ]);
    }

    public static function geojson(array $features, array $properties = []): void
    {
        $geojson = [
            'type' => 'FeatureCollection',
            'features' => $features,
        ];

        if (!empty($properties)) {
            $geojson['properties'] = $properties;
        }

        self::json($geojson);
    }

    public static function file(string $path, string $filename = null, string $contentType = null): void
    {
        if (!file_exists($path)) {
            self::error('Файл не найден', 404);
        }

        $filename = $filename ?? basename($path);
        // Защита от header injection через имя файла
        $filename = preg_replace('/[\r\n"]+/', '', (string) $filename);
        if ($filename === '') {
            $filename = 'download';
        }
        $contentType = $contentType ?? mime_content_type($path);

        header('Content-Type: ' . $contentType);
        header('Content-Disposition: attachment; filename="' . $filename . '"');
        header('Content-Length: ' . filesize($path));

        readfile($path);
        exit;
    }
}

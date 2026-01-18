<?php
/**
 * Контроллер фотографий объектов
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class PhotoController extends BaseController
{
    private array $allowedTables = [
        'wells', 'channel_directions', 'cable_channels', 'marker_posts',
        'ground_cables', 'aerial_cables', 'duct_cables', 'cables', 'incidents', 'incident_history'
    ];

    /**
     * POST /api/photos
     * Загрузка фотографии
     */
    public function upload(): void
    {
        $this->checkWriteAccess();

        $objectTable = $this->request->input('object_table');
        $objectId = $this->request->input('object_id');

        if (!$objectTable || !$objectId) {
            Response::error('Необходимо указать object_table и object_id', 422);
        }

        if (!in_array($objectTable, $this->allowedTables)) {
            Response::error('Недопустимый тип объекта', 400);
        }

        // Проверяем существование объекта
        $exists = $this->db->fetch("SELECT id FROM {$objectTable} WHERE id = :id", ['id' => (int) $objectId]);
        if (!$exists) {
            Response::error('Объект не найден', 404);
        }

        // Проверяем лимит фотографий
        $count = $this->db->fetch(
            "SELECT COUNT(*) as cnt FROM object_photos WHERE object_table = :table AND object_id = :id",
            ['table' => $objectTable, 'id' => (int) $objectId]
        );
        if ($count['cnt'] >= 10) {
            Response::error('Достигнут лимит фотографий (максимум 10)', 400);
        }

        $fileInfo = $this->handleFileUpload('file', $objectTable);
        if (!$fileInfo) {
            Response::error('Ошибка загрузки файла', 400);
        }

        // Создаём миниатюру
        $thumbnailPath = null;
        try {
            $thumbnailPath = $this->createThumbnail($fileInfo['file_path']);
        } catch (\Throwable $e) {
            // GD может быть не установлен на сервере — миниатюра необязательна
            $thumbnailPath = null;
        }

        // Получаем размеры изображения
        $imageInfo = @getimagesize($fileInfo['file_path']);
        $width = $imageInfo[0] ?? null;
        $height = $imageInfo[1] ?? null;

        $user = Auth::user();

        $photoId = $this->db->insert('object_photos', [
            'object_table' => $objectTable,
            'object_id' => (int) $objectId,
            'filename' => $fileInfo['filename'],
            'original_filename' => $fileInfo['original_filename'],
            'file_path' => $fileInfo['file_path'],
            'file_size' => $fileInfo['file_size'],
            'mime_type' => $fileInfo['mime_type'],
            'width' => $width,
            'height' => $height,
            'thumbnail_path' => $thumbnailPath,
            'description' => $this->request->input('description'),
            'sort_order' => $count['cnt'],
            'uploaded_by' => $user['id'],
        ]);

        $photo = $this->db->fetch("SELECT * FROM object_photos WHERE id = :id", ['id' => $photoId]);

        $this->log('upload_photo', $objectTable, (int) $objectId, null, $photo);

        Response::success($photo, 'Фотография загружена', 201);
    }

    /**
     * GET /api/photos/{id}
     * Получение информации о фотографии
     */
    public function show(string $id): void
    {
        $photo = $this->db->fetch(
            "SELECT p.*, u.login as uploaded_by_login
             FROM object_photos p
             LEFT JOIN users u ON p.uploaded_by = u.id
             WHERE p.id = :id",
            ['id' => (int) $id]
        );

        if (!$photo) {
            Response::error('Фотография не найдена', 404);
        }

        // Формируем URL
        $photo['url'] = '/uploads/' . basename(dirname($photo['file_path'])) . '/' . $photo['filename'];
        if ($photo['thumbnail_path']) {
            $photo['thumbnail_url'] = '/uploads/' . basename(dirname($photo['thumbnail_path'])) . '/' . basename($photo['thumbnail_path']);
        }

        Response::success($photo);
    }

    /**
     * PUT /api/photos/{id}
     * Обновление описания фотографии
     */
    public function update(string $id): void
    {
        $this->checkWriteAccess();
        $photoId = (int) $id;

        $photo = $this->db->fetch("SELECT * FROM object_photos WHERE id = :id", ['id' => $photoId]);
        if (!$photo) {
            Response::error('Фотография не найдена', 404);
        }

        $data = $this->request->only(['description', 'sort_order']);
        $data = array_filter($data, fn($v) => $v !== null);

        if (!empty($data)) {
            $this->db->update('object_photos', $data, 'id = :id', ['id' => $photoId]);
        }

        $photo = $this->db->fetch("SELECT * FROM object_photos WHERE id = :id", ['id' => $photoId]);

        Response::success($photo, 'Фотография обновлена');
    }

    /**
     * DELETE /api/photos/{id}
     * Удаление фотографии
     */
    public function destroy(string $id): void
    {
        $this->checkWriteAccess();
        $photoId = (int) $id;

        $photo = $this->db->fetch("SELECT * FROM object_photos WHERE id = :id", ['id' => $photoId]);
        if (!$photo) {
            Response::error('Фотография не найдена', 404);
        }

        // Удаляем файлы
        if (file_exists($photo['file_path'])) {
            unlink($photo['file_path']);
        }
        if ($photo['thumbnail_path'] && file_exists($photo['thumbnail_path'])) {
            unlink($photo['thumbnail_path']);
        }

        $this->db->delete('object_photos', 'id = :id', ['id' => $photoId]);

        $this->log('delete_photo', $photo['object_table'], $photo['object_id'], $photo, null);

        Response::success(null, 'Фотография удалена');
    }

    /**
     * GET /api/photos/object/{table}/{id}
     * Получение всех фотографий объекта
     */
    public function byObject(string $table, string $id): void
    {
        if (!in_array($table, $this->allowedTables)) {
            Response::error('Недопустимый тип объекта', 400);
        }

        $photos = $this->db->fetchAll(
            "SELECT p.*, u.login as uploaded_by_login
             FROM object_photos p
             LEFT JOIN users u ON p.uploaded_by = u.id
             WHERE p.object_table = :table AND p.object_id = :id
             ORDER BY p.sort_order, p.created_at",
            ['table' => $table, 'id' => (int) $id]
        );

        foreach ($photos as &$photo) {
            $photo['url'] = '/uploads/' . $table . '/' . $photo['filename'];
            if ($photo['thumbnail_path']) {
                $photo['thumbnail_url'] = '/uploads/' . $table . '/' . basename($photo['thumbnail_path']);
            }
        }

        Response::success($photos);
    }

    /**
     * POST /api/photos/reorder
     * Изменение порядка фотографий
     */
    public function reorder(): void
    {
        $this->checkWriteAccess();

        $order = $this->request->input('order');
        if (!is_array($order)) {
            Response::error('Необходимо передать массив order', 422);
        }

        foreach ($order as $index => $photoId) {
            $this->db->update('object_photos', ['sort_order' => $index], 'id = :id', ['id' => (int) $photoId]);
        }

        Response::success(null, 'Порядок обновлён');
    }

    /**
     * Создание миниатюры
     */
    private function createThumbnail(string $sourcePath, int $maxWidth = 200, int $maxHeight = 200): ?string
    {
        if (!file_exists($sourcePath)) {
            return null;
        }

        // GD extension может быть отсутствовать
        if (!function_exists('imagecreatetruecolor') || !function_exists('imagecopyresampled')) {
            return null;
        }

        $imageInfo = @getimagesize($sourcePath);
        if (!$imageInfo) {
            return null;
        }

        $mime = $imageInfo['mime'];
        $width = $imageInfo[0];
        $height = $imageInfo[1];

        // Вычисляем размеры
        $ratio = min($maxWidth / $width, $maxHeight / $height);
        $newWidth = (int) ($width * $ratio);
        $newHeight = (int) ($height * $ratio);

        // Создаём изображение
        switch ($mime) {
            case 'image/jpeg':
                if (!function_exists('imagecreatefromjpeg')) return null;
                $source = imagecreatefromjpeg($sourcePath);
                break;
            case 'image/png':
                if (!function_exists('imagecreatefrompng')) return null;
                $source = imagecreatefrompng($sourcePath);
                break;
            case 'image/gif':
                if (!function_exists('imagecreatefromgif')) return null;
                $source = imagecreatefromgif($sourcePath);
                break;
            case 'image/webp':
                if (!function_exists('imagecreatefromwebp')) return null;
                $source = imagecreatefromwebp($sourcePath);
                break;
            default:
                return null;
        }

        if (!$source) {
            return null;
        }

        $thumb = imagecreatetruecolor($newWidth, $newHeight);
        
        // Сохраняем прозрачность для PNG
        if ($mime === 'image/png') {
            imagealphablending($thumb, false);
            imagesavealpha($thumb, true);
        }

        imagecopyresampled($thumb, $source, 0, 0, 0, 0, $newWidth, $newHeight, $width, $height);

        // Путь к миниатюре
        $pathInfo = pathinfo($sourcePath);
        $thumbPath = $pathInfo['dirname'] . '/thumb_' . $pathInfo['basename'];

        // Сохраняем
        switch ($mime) {
            case 'image/jpeg':
                imagejpeg($thumb, $thumbPath, 85);
                break;
            case 'image/png':
                imagepng($thumb, $thumbPath, 8);
                break;
            case 'image/gif':
                imagegif($thumb, $thumbPath);
                break;
            case 'image/webp':
                imagewebp($thumb, $thumbPath, 85);
                break;
        }

        imagedestroy($source);
        imagedestroy($thumb);

        return $thumbPath;
    }
}

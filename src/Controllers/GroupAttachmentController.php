<?php
/**
 * Контроллер вложений ТУ (object_groups)
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class GroupAttachmentController extends BaseController
{
    private array $allowedExtensions = [
        'jpg', 'jpeg', 'png', 'gif', 'webp',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv',
    ];

    /**
     * GET /api/groups/{id}/attachments
     */
    public function byGroup(string $id): void
    {
        $groupId = (int) $id;
        $group = $this->db->fetch("SELECT id FROM object_groups WHERE id = :id", ['id' => $groupId]);
        if (!$group) {
            Response::error('ТУ не найдено', 404);
        }

        $items = $this->db->fetchAll(
            "SELECT a.*, u.login as uploaded_by_login
             FROM group_attachments a
             LEFT JOIN users u ON a.uploaded_by = u.id
             WHERE a.group_id = :id
             ORDER BY a.created_at DESC",
            ['id' => $groupId]
        );

        foreach ($items as &$a) {
            $a['url'] = '/uploads/' . basename(dirname($a['file_path'])) . '/' . $a['filename'];
        }

        Response::success($items);
    }

    /**
     * POST /api/groups/{id}/attachments
     */
    public function upload(string $id): void
    {
        $this->checkWriteAccess();
        $groupId = (int) $id;

        $group = $this->db->fetch("SELECT id FROM object_groups WHERE id = :id", ['id' => $groupId]);
        if (!$group) {
            Response::error('ТУ не найдено', 404);
        }

        $file = $this->request->file('file');
        if (!$file || $file['error'] !== UPLOAD_ERR_OK) {
            Response::error('Ошибка загрузки файла', 400);
        }

        $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if (!in_array($ext, $this->allowedExtensions, true)) {
            Response::error('Недопустимый тип файла', 400);
        }

        if ($file['size'] > ($this->config['max_upload_size'] ?? 10 * 1024 * 1024)) {
            Response::error('Файл слишком большой', 400);
        }

        $subDir = 'group_attachments';
        $uploadPath = ($this->config['upload_path'] ?? (__DIR__ . '/../../uploads')) . '/' . $subDir;
        if (!is_dir($uploadPath)) {
            if (!mkdir($uploadPath, 0755, true) && !is_dir($uploadPath)) {
                Response::error('Ошибка создания директории для загрузки', 500);
            }
        }
        if (!is_writable($uploadPath)) {
            Response::error('Директория загрузки недоступна для записи', 500);
        }

        try {
            $filename = bin2hex(random_bytes(16)) . '.' . $ext;
        } catch (\Throwable $e) {
            $filename = uniqid('', true) . '.' . $ext;
        }
        $filePath = $uploadPath . '/' . $filename;

        if (!move_uploaded_file($file['tmp_name'], $filePath)) {
            Response::error('Ошибка сохранения файла', 500);
        }

        $mime = 'application/octet-stream';
        try {
            if (function_exists('finfo_open')) {
                $fi = @finfo_open(FILEINFO_MIME_TYPE);
                if ($fi) {
                    $m = @finfo_file($fi, $filePath);
                    @finfo_close($fi);
                    if (is_string($m) && $m !== '') $mime = $m;
                }
            } elseif (function_exists('mime_content_type')) {
                $m = @mime_content_type($filePath);
                if (is_string($m) && $m !== '') $mime = $m;
            }
        } catch (\Throwable $e) {}

        $user = Auth::user();
        $attId = $this->db->insert('group_attachments', [
            'group_id' => $groupId,
            'filename' => $filename,
            'original_filename' => $file['name'],
            'file_path' => $filePath,
            'file_size' => $file['size'],
            'mime_type' => $mime,
            'description' => $this->request->input('description'),
            'uploaded_by' => $user['id'],
        ]);

        $att = $this->db->fetch("SELECT * FROM group_attachments WHERE id = :id", ['id' => $attId]);
        $att['url'] = '/uploads/' . $subDir . '/' . $att['filename'];

        $this->log('upload_attachment', 'object_groups', $groupId, null, $att);
        Response::success($att, 'Файл загружен', 201);
    }

    /**
     * DELETE /api/groups/attachments/{id}
     */
    public function destroy(string $id): void
    {
        $this->checkDeleteAccess();
        $attId = (int) $id;

        $att = $this->db->fetch("SELECT * FROM group_attachments WHERE id = :id", ['id' => $attId]);
        if (!$att) {
            Response::error('Файл не найден', 404);
        }

        if (!empty($att['file_path']) && file_exists($att['file_path'])) {
            unlink($att['file_path']);
        }

        $this->db->delete('group_attachments', 'id = :id', ['id' => $attId]);
        $this->log('delete_attachment', 'object_groups', (int) $att['group_id'], $att, null);

        Response::success(null, 'Файл удалён');
    }
}


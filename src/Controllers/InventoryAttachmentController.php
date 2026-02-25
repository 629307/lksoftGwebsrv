<?php
/**
 * Контроллер вложений инвентарных карточек
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class InventoryAttachmentController extends BaseController
{
    private function allowedExtensions(): array
    {
        $raw = (string) $this->getAppSetting(
            'inventory_attachments_allowed_extensions',
            'jpg,jpeg,png,gif,webp,pdf,doc,docx,xls,xlsx,txt,csv,zip,rar'
        );
        $parts = preg_split('/[,\s]+/', strtolower($raw)) ?: [];
        $out = [];
        foreach ($parts as $p) {
            $e = trim((string) $p);
            if ($e === '') continue;
            if (!preg_match('/^[a-z0-9]{1,10}$/', $e)) continue;
            $out[] = $e;
        }
        return array_values(array_unique($out));
    }

    private function maxUploadBytes(): int
    {
        $raw = (string) $this->getAppSetting('inventory_attachments_max_upload_bytes', (string) (50 * 1024 * 1024));
        $n = (int) $raw;
        if ($n < 0) $n = 0;
        if ($n > (1024 * 1024 * 1024)) $n = 1024 * 1024 * 1024;
        return $n;
    }

    /**
     * GET /api/inventory-cards/{id}/attachments
     */
    public function byCard(string $id): void
    {
        if (Auth::hasRole('readonly')) {
            Response::error('Инвентаризация недоступна для роли "Только чтение"', 403);
        }
        $cardId = (int) $id;
        $card = $this->db->fetch("SELECT id FROM inventory_cards WHERE id = :id", ['id' => $cardId]);
        if (!$card) Response::error('Инвентарная карточка не найдена', 404);

        $items = $this->db->fetchAll(
            "SELECT a.*, u.login as uploaded_by_login
             FROM inventory_card_attachments a
             LEFT JOIN users u ON a.uploaded_by = u.id
             WHERE a.card_id = :id
             ORDER BY a.created_at DESC",
            ['id' => $cardId]
        );
        foreach ($items as &$a) {
            $a['url'] = '/uploads/' . basename(dirname($a['file_path'])) . '/' . $a['filename'];
        }
        Response::success($items);
    }

    /**
     * POST /api/inventory-cards/{id}/attachments
     */
    public function upload(string $id): void
    {
        $this->checkWriteAccess();
        $cardId = (int) $id;
        $card = $this->db->fetch("SELECT id, well_id FROM inventory_cards WHERE id = :id", ['id' => $cardId]);
        if (!$card) Response::error('Инвентарная карточка не найдена', 404);

        $file = $this->request->file('file');
        if (!$file || $file['error'] !== UPLOAD_ERR_OK) {
            Response::error('Ошибка загрузки файла', 400);
        }

        $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if (!in_array($ext, $this->allowedExtensions(), true)) {
            Response::error('Недопустимый тип файла', 400);
        }
        if ($file['size'] > $this->maxUploadBytes()) {
            Response::error('Файл слишком большой', 400);
        }

        $subDir = 'inventory_cards';
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
        $attId = $this->db->insert('inventory_card_attachments', [
            'card_id' => $cardId,
            'filename' => $filename,
            'original_filename' => $file['name'],
            'file_path' => $filePath,
            'file_size' => $file['size'],
            'mime_type' => $mime,
            'description' => $this->request->input('description'),
            'uploaded_by' => $user['id'] ?? null,
        ]);

        $att = $this->db->fetch("SELECT * FROM inventory_card_attachments WHERE id = :id", ['id' => $attId]);
        $att['url'] = '/uploads/' . $subDir . '/' . $att['filename'];

        try { $this->log('upload_inventory_attachment', 'inventory_cards', $cardId, null, $att); } catch (\Throwable $e) {}
        Response::success($att, 'Файл загружен', 201);
    }

    /**
     * DELETE /api/inventory-cards/attachments/{id}
     */
    public function destroy(string $id): void
    {
        $this->checkDeleteAccess();
        $attId = (int) $id;

        $att = $this->db->fetch("SELECT * FROM inventory_card_attachments WHERE id = :id", ['id' => $attId]);
        if (!$att) Response::error('Файл не найден', 404);

        $path = (string) ($att['file_path'] ?? '');
        if ($path !== '' && file_exists($path)) {
            @unlink($path);
        }

        $this->db->delete('inventory_card_attachments', 'id = :id', ['id' => $attId]);
        try { $this->log('delete_inventory_attachment', 'inventory_cards', (int) ($att['card_id'] ?? 0), $att, null); } catch (\Throwable $e) {}
        Response::success(null, 'Файл удалён');
    }
}


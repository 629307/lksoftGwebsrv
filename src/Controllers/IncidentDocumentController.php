<?php
/**
 * Контроллер документов инцидентов
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class IncidentDocumentController extends BaseController
{
    private array $allowedExtensions = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'csv', 'zip', 'rar'];

    /**
     * GET /api/incidents/{id}/documents
     */
    public function byIncident(string $id): void
    {
        $incidentId = (int) $id;
        $incident = $this->db->fetch("SELECT id FROM incidents WHERE id = :id", ['id' => $incidentId]);
        if (!$incident) {
            Response::error('Инцидент не найден', 404);
        }

        $docs = $this->db->fetchAll(
            "SELECT d.*, u.login as uploaded_by_login
             FROM incident_documents d
             LEFT JOIN users u ON d.uploaded_by = u.id
             WHERE d.incident_id = :id
             ORDER BY d.created_at DESC",
            ['id' => $incidentId]
        );

        foreach ($docs as &$d) {
            $d['url'] = '/uploads/' . basename(dirname($d['file_path'])) . '/' . $d['filename'];
        }

        Response::success($docs);
    }

    /**
     * POST /api/incidents/{id}/documents
     */
    public function upload(string $id): void
    {
        $this->checkWriteAccess();
        $incidentId = (int) $id;

        $incident = $this->db->fetch("SELECT id FROM incidents WHERE id = :id", ['id' => $incidentId]);
        if (!$incident) {
            Response::error('Инцидент не найден', 404);
        }

        $file = $this->request->file('file');
        if (!$file || $file['error'] !== UPLOAD_ERR_OK) {
            Response::error('Ошибка загрузки файла', 400);
        }

        $ext = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
        if (!in_array($ext, $this->allowedExtensions, true)) {
            Response::error('Недопустимый тип файла', 400);
        }

        // Лимит размера берём из конфигурации приложения
        if ($file['size'] > ($this->config['max_upload_size'] ?? 10 * 1024 * 1024)) {
            Response::error('Файл слишком большой', 400);
        }

        $subDir = 'incident_documents';
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
        $docId = $this->db->insert('incident_documents', [
            'incident_id' => $incidentId,
            'filename' => $filename,
            'original_filename' => $file['name'],
            'file_path' => $filePath,
            'file_size' => $file['size'],
            'mime_type' => $mime,
            'description' => $this->request->input('description'),
            'uploaded_by' => $user['id'],
        ]);

        $doc = $this->db->fetch("SELECT * FROM incident_documents WHERE id = :id", ['id' => $docId]);
        $doc['url'] = '/uploads/' . $subDir . '/' . $doc['filename'];

        $this->log('upload_document', 'incidents', $incidentId, null, $doc);
        Response::success($doc, 'Документ загружен', 201);
    }

    /**
     * DELETE /api/incidents/documents/{id}
     */
    public function destroy(string $id): void
    {
        $this->checkDeleteAccess();
        $docId = (int) $id;

        $doc = $this->db->fetch("SELECT * FROM incident_documents WHERE id = :id", ['id' => $docId]);
        if (!$doc) {
            Response::error('Документ не найден', 404);
        }

        if (!empty($doc['file_path']) && file_exists($doc['file_path'])) {
            unlink($doc['file_path']);
        }

        $this->db->delete('incident_documents', 'id = :id', ['id' => $docId]);
        $this->log('delete_document', 'incidents', (int) $doc['incident_id'], $doc, null);

        Response::success(null, 'Документ удалён');
    }
}


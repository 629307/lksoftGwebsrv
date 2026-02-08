<?php
/**
 * Контроллер журнала аудита (только администратор)
 */

namespace App\Controllers;

use App\Core\Auth;
use App\Core\Response;

class AuditLogController extends BaseController
{
    /**
     * GET /api/admin/audit-log?user_id=..&limit=..
     * Возвращает последние действия (по умолчанию 1000).
     */
    public function index(): void
    {
        if (!Auth::isAdmin()) {
            Response::error('Доступ запрещён', 403);
        }

        $userId = (int) $this->request->query('user_id', 0);
        $limit = (int) $this->request->query('limit', 1000);
        if ($limit < 1) $limit = 1000;
        if ($limit > 1000) $limit = 1000;

        $where = '';
        $params = ['limit' => $limit];
        if ($userId > 0) {
            $where = 'WHERE al.user_id = :uid';
            $params['uid'] = $userId;
        }

        $sql = "SELECT al.id,
                       al.user_id,
                       u.login as user_login,
                       u.full_name as user_full_name,
                       al.action,
                       al.table_name,
                       al.record_id,
                       al.ip_address,
                       al.created_at
                FROM audit_log al
                LEFT JOIN users u ON al.user_id = u.id
                {$where}
                ORDER BY al.created_at DESC, al.id DESC
                LIMIT :limit";

        $rows = $this->db->fetchAll($sql, $params);
        Response::success($rows);
    }
}


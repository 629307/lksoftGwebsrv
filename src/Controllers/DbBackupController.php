<?php
/**
 * Администрирование: резервное копирование/восстановление БД PostgreSQL.
 * Доступно только роли "admin".
 */

namespace App\Controllers;

use App\Core\Auth;
use App\Core\Response;

class DbBackupController extends BaseController
{
    private function requireAdmin(): void
    {
        if (!Auth::isAdmin()) {
            Response::error('Доступ запрещён', 403);
        }
    }

    private function backupDir(): string
    {
        // Храним вне публичных директорий (закрыто через .htaccess для /storage)
        return realpath(__DIR__ . '/../../') . '/storage/db_backups';
    }

    private function ensureBackupDir(): string
    {
        $dir = $this->backupDir();
        if (!is_dir($dir)) {
            if (!@mkdir($dir, 0755, true) && !is_dir($dir)) {
                Response::error('Не удалось создать директорию для бэкапов. Проверьте права на папку storage/db_backups.', 500);
            }
        }
        if (!is_writable($dir)) {
            Response::error('Нет прав на запись в директорию бэкапов. Проверьте права на папку storage/db_backups.', 500);
        }
        return $dir;
    }

    private function dbCfg(): array
    {
        return require __DIR__ . '/../../config/database.php';
    }

    private function runCommand(array $cmd, array $env = [], int $timeoutSec = 600): array
    {
        if (!function_exists('proc_open')) {
            Response::error('Функция proc_open отключена на сервере. Невозможно выполнить pg_dump/pg_restore.', 500);
        }

        $descriptor = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];

        $command = implode(' ', array_map('escapeshellarg', $cmd));
        $procEnv = array_merge($_ENV, $env);

        $process = @proc_open($command, $descriptor, $pipes, null, $procEnv);
        if (!is_resource($process)) {
            Response::error('Не удалось запустить системную команду для работы с БД', 500);
        }

        // Не пишем в stdin
        @fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $stdout = '';
        $stderr = '';
        $start = time();

        while (true) {
            $status = proc_get_status($process);
            $stdout .= stream_get_contents($pipes[1]);
            $stderr .= stream_get_contents($pipes[2]);
            if (!$status['running']) break;
            if ((time() - $start) > $timeoutSec) {
                @proc_terminate($process);
                Response::error('Превышено время выполнения операции резервного копирования/восстановления', 504);
            }
            usleep(100000); // 100ms
        }

        $stdout .= stream_get_contents($pipes[1]);
        $stderr .= stream_get_contents($pipes[2]);
        @fclose($pipes[1]);
        @fclose($pipes[2]);

        $exit = proc_close($process);

        return ['exit_code' => $exit, 'stdout' => $stdout, 'stderr' => $stderr, 'cmd' => $cmd];
    }

    private function withLock(string $lockName, callable $fn)
    {
        $dir = $this->ensureBackupDir();
        $lockPath = $dir . '/.' . preg_replace('/[^A-Za-z0-9_.-]+/', '_', $lockName) . '.lock';
        $fh = @fopen($lockPath, 'c');
        if (!$fh) {
            Response::error('Не удалось создать lock-файл для операции', 500);
        }
        $locked = @flock($fh, LOCK_EX | LOCK_NB);
        if (!$locked) {
            @fclose($fh);
            Response::error('Операция уже выполняется. Повторите позже.', 409);
        }
        try {
            return $fn();
        } finally {
            try { @flock($fh, LOCK_UN); } catch (\Throwable $e) {}
            try { @fclose($fh); } catch (\Throwable $e) {}
        }
    }

    private function getSetting(string $code, $default = null)
    {
        return $this->getAppSetting($code, $default);
    }

    private function setSetting(string $code, string $value): void
    {
        $this->db->query(
            "INSERT INTO app_settings(code, value, updated_at)
             VALUES (:code, :value, NOW())
             ON CONFLICT (code) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
            ['code' => $code, 'value' => $value]
        );
    }

    private function sanitizeBackupId(string $id): string
    {
        $x = trim($id);
        // ожидаем имя файла без путей
        if ($x === '' || strpos($x, '/') !== false || strpos($x, '\\') !== false) {
            Response::error('Некорректный идентификатор бэкапа', 422);
        }
        if (!preg_match('/^[A-Za-z0-9_.-]+$/', $x)) {
            Response::error('Некорректный идентификатор бэкапа', 422);
        }
        return $x;
    }

    /**
     * GET /api/admin/db-backups/config
     */
    public function config(): void
    {
        $this->requireAdmin();
        $enabled = (string) ($this->getSetting('db_backup_schedule_enabled', '0') ?? '0');
        $intervalH = (string) ($this->getSetting('db_backup_interval_hours', '24') ?? '24');
        $keep = (string) ($this->getSetting('db_backup_keep_count', '') ?? '');
        $lastRun = (string) ($this->getSetting('db_backup_last_run_at', '') ?? '');

        Response::success([
            'schedule_enabled' => ($enabled === '1'),
            'interval_hours' => (int) $intervalH,
            'keep_count' => ($keep === '' ? null : (int) $keep),
            'last_run_at' => ($lastRun !== '' ? $lastRun : null),
        ]);
    }

    /**
     * PUT /api/admin/db-backups/config
     */
    public function updateConfig(): void
    {
        $this->requireAdmin();
        $data = $this->request->input(null, []);
        if (!is_array($data)) Response::error('Некорректные данные', 422);

        $enabled = !empty($data['schedule_enabled']) ? '1' : '0';
        $interval = (int) ($data['interval_hours'] ?? 24);
        if ($interval < 1 || $interval > 720) Response::error('Некорректная периодичность', 422);
        $keepRaw = $data['keep_count'] ?? null;
        $keep = null;
        if ($keepRaw !== null && $keepRaw !== '') {
            $keep = (int) $keepRaw;
            if ($keep < 1 || $keep > 365) Response::error('Некорректное значение "хранить последних бэкапов"', 422);
        }

        try {
            $this->db->beginTransaction();
            $this->setSetting('db_backup_schedule_enabled', $enabled);
            $this->setSetting('db_backup_interval_hours', (string) $interval);
            $this->setSetting('db_backup_keep_count', ($keep === null ? '' : (string) $keep));
            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollback();
            throw $e;
        }

        Response::success([
            'schedule_enabled' => ($enabled === '1'),
            'interval_hours' => $interval,
            'keep_count' => $keep,
        ], 'Настройки бэкапа сохранены');
    }

    /**
     * GET /api/admin/db-backups
     */
    public function index(): void
    {
        $this->requireAdmin();
        $dir = $this->ensureBackupDir();
        $files = @scandir($dir) ?: [];
        $out = [];
        foreach ($files as $f) {
            if ($f === '.' || $f === '..') continue;
            if (!preg_match('/\.dump$/', $f)) continue;
            $path = $dir . '/' . $f;
            if (!is_file($path)) continue;
            $out[] = [
                'id' => $f,
                'size_bytes' => (int) (@filesize($path) ?: 0),
                'created_at' => date('c', (int) (@filemtime($path) ?: time())),
            ];
        }
        usort($out, fn($a, $b) => strcmp($b['created_at'], $a['created_at']));
        Response::success($out);
    }

    /**
     * POST /api/admin/db-backups
     * Создать бэкап прямо сейчас
     */
    public function create(): void
    {
        $this->requireAdmin();
        @set_time_limit(0);

        $this->withLock('db_backup', function () {
            $dir = $this->ensureBackupDir();
            $db = $this->dbCfg();
            $ts = date('Ymd_His');
            $name = 'db_' . preg_replace('/[^A-Za-z0-9_]+/', '_', (string) ($db['dbname'] ?? 'db')) . '_' . $ts . '.dump';
            $path = $dir . '/' . $name;

            $env = [
                'PGPASSWORD' => (string) ($db['password'] ?? ''),
            ];
            $cmd = [
                'pg_dump',
                '-h', (string) ($db['host'] ?? 'localhost'),
                '-p', (string) ($db['port'] ?? '5432'),
                '-U', (string) ($db['user'] ?? ''),
                '-F', 'c',
                '--no-owner',
                '--no-acl',
                '-f', $path,
                (string) ($db['dbname'] ?? ''),
            ];

            $res = $this->runCommand($cmd, $env, 1200);
            if ((int) ($res['exit_code'] ?? 1) !== 0) {
                // cleanup
                try { if (is_file($path)) @unlink($path); } catch (\Throwable $e) {}
                Response::error('Ошибка создания бэкапа: ' . trim((string) ($res['stderr'] ?? '')), 500);
            }

            $this->setSetting('db_backup_last_run_at', date('c'));

            // ретеншн по количеству (если настроено)
            $keepRaw = (string) ($this->getSetting('db_backup_keep_count', '') ?? '');
            $keep = ($keepRaw === '') ? null : (int) $keepRaw;
            if ($keep !== null && $keep > 0) {
                $this->applyRetentionByCount($keep);
            }

            Response::success([
                'id' => $name,
                'size_bytes' => (int) (@filesize($path) ?: 0),
                'created_at' => date('c', (int) (@filemtime($path) ?: time())),
            ], 'Бэкап создан');
        });
    }

    private function applyRetentionByCount(int $keep): void
    {
        $dir = $this->ensureBackupDir();
        $files = @scandir($dir) ?: [];
        $list = [];
        foreach ($files as $f) {
            if ($f === '.' || $f === '..') continue;
            if (!preg_match('/\.dump$/', $f)) continue;
            $p = $dir . '/' . $f;
            if (!is_file($p)) continue;
            $list[] = ['f' => $f, 't' => (int) (@filemtime($p) ?: 0)];
        }
        usort($list, fn($a, $b) => $b['t'] <=> $a['t']);
        $toDelete = array_slice($list, $keep);
        foreach ($toDelete as $x) {
            try { @unlink($dir . '/' . $x['f']); } catch (\Throwable $e) {}
        }
    }

    /**
     * POST /api/admin/db-backups/tick
     * Проверка расписания и создание бэкапа, если пора.
     */
    public function tick(): void
    {
        $this->requireAdmin();
        $enabled = (string) ($this->getSetting('db_backup_schedule_enabled', '0') ?? '0');
        if ($enabled !== '1') {
            Response::success(['ran' => false, 'reason' => 'disabled']);
        }
        $interval = (int) ((string) ($this->getSetting('db_backup_interval_hours', '24') ?? '24'));
        if ($interval < 1) $interval = 24;

        $last = (string) ($this->getSetting('db_backup_last_run_at', '') ?? '');
        $lastTs = $last ? strtotime($last) : 0;
        $due = (!$lastTs) || ((time() - $lastTs) >= ($interval * 3600));
        if (!$due) {
            Response::success(['ran' => false, 'reason' => 'not_due', 'last_run_at' => $last ?: null]);
        }

        // Создаём бэкап как manual create()
        $this->create();
    }

    /**
     * POST /api/admin/db-backups/{id}/restore
     */
    public function restore(string $id): void
    {
        $this->requireAdmin();
        @set_time_limit(0);

        $this->withLock('db_restore', function () use ($id) {
            $dir = $this->ensureBackupDir();
            $bid = $this->sanitizeBackupId($id);
            if (!preg_match('/\.dump$/', $bid)) {
                Response::error('Некорректный файл бэкапа', 422);
            }
            $path = $dir . '/' . $bid;
            if (!is_file($path)) {
                Response::error('Бэкап не найден', 404);
            }

            $db = $this->dbCfg();
            $env = [
                'PGPASSWORD' => (string) ($db['password'] ?? ''),
            ];
            $cmd = [
                'pg_restore',
                '-h', (string) ($db['host'] ?? 'localhost'),
                '-p', (string) ($db['port'] ?? '5432'),
                '-U', (string) ($db['user'] ?? ''),
                '-d', (string) ($db['dbname'] ?? ''),
                '--clean',
                '--if-exists',
                '--no-owner',
                '--no-acl',
                '--exit-on-error',
                '--single-transaction',
                $path,
            ];

            $res = $this->runCommand($cmd, $env, 3600);
            if ((int) ($res['exit_code'] ?? 1) !== 0) {
                Response::error('Ошибка восстановления: ' . trim((string) ($res['stderr'] ?? '')), 500);
            }

            Response::success(['restored' => true, 'id' => $bid], 'База данных восстановлена');
        });
    }
}


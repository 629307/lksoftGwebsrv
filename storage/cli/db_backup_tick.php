<?php
/**
 * CLI: проверка расписания и создание бэкапа БД (pg_dump) при необходимости.
 * Запускать из cron: */10 * * * * php /path/to/storage/cli/db_backup_tick.php
 *
 * Важно: этот скрипт НЕ требует авторизации, поэтому должен быть доступен только локально (не через web).
 * Папка storage закрыта в .htaccess.
 */

require_once __DIR__ . '/../../vendor/autoload.php';

$app = require __DIR__ . '/../../config/app.php';
date_default_timezone_set($app['timezone'] ?? 'UTC');

$dbCfg = require __DIR__ . '/../../config/database.php';

function pdoConnect(array $cfg): PDO {
    $dsn = sprintf('pgsql:host=%s;port=%s;dbname=%s', $cfg['host'], $cfg['port'], $cfg['dbname']);
    $pdo = new PDO($dsn, $cfg['user'], $cfg['password'], $cfg['options'] ?? []);
    $pdo->exec("SET NAMES '" . ($cfg['charset'] ?? 'UTF8') . "'");
    return $pdo;
}

function getSetting(PDO $pdo, string $code, $default = null) {
    try {
        $st = $pdo->prepare("SELECT value FROM app_settings WHERE code = :c");
        $st->execute(['c' => $code]);
        $row = $st->fetch(PDO::FETCH_ASSOC);
        if (!$row) return $default;
        return $row['value'];
    } catch (Throwable $e) {
        return $default;
    }
}

function setSetting(PDO $pdo, string $code, string $value): void {
    $sql = "INSERT INTO app_settings(code, value, updated_at)
            VALUES (:code, :value, NOW())
            ON CONFLICT (code) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()";
    $st = $pdo->prepare($sql);
    $st->execute(['code' => $code, 'value' => $value]);
}

function ensureDir(string $dir): void {
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
}

function runCmd(array $cmd, array $env = [], int $timeoutSec = 1800): array {
    $command = implode(' ', array_map('escapeshellarg', $cmd));
    $des = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
    $proc = @proc_open($command, $des, $pipes, null, array_merge($_ENV, $env));
    if (!is_resource($proc)) return ['exit_code' => 1, 'stderr' => 'proc_open failed'];
    @fclose($pipes[0]);
    stream_set_blocking($pipes[1], false);
    stream_set_blocking($pipes[2], false);
    $out = ''; $err = '';
    $start = time();
    while (true) {
        $st = proc_get_status($proc);
        $out .= stream_get_contents($pipes[1]);
        $err .= stream_get_contents($pipes[2]);
        if (!$st['running']) break;
        if ((time() - $start) > $timeoutSec) {
            @proc_terminate($proc);
            return ['exit_code' => 124, 'stderr' => 'timeout'];
        }
        usleep(100000);
    }
    $out .= stream_get_contents($pipes[1]);
    $err .= stream_get_contents($pipes[2]);
    @fclose($pipes[1]); @fclose($pipes[2]);
    $exit = proc_close($proc);
    return ['exit_code' => $exit, 'stdout' => $out, 'stderr' => $err];
}

function retention(string $dir, int $keep): void {
    if ($keep <= 0) return;
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
    $del = array_slice($list, $keep);
    foreach ($del as $x) {
        @unlink($dir . '/' . $x['f']);
    }
}

try {
    $pdo = pdoConnect($dbCfg);
} catch (Throwable $e) {
    fwrite(STDERR, "DB connect error: " . $e->getMessage() . "\n");
    exit(2);
}

$enabled = (string) (getSetting($pdo, 'db_backup_schedule_enabled', '0') ?? '0');
if ($enabled !== '1') {
    exit(0);
}

$interval = (int) ((string) (getSetting($pdo, 'db_backup_interval_hours', '24') ?? '24'));
if ($interval < 1) $interval = 24;

$last = (string) (getSetting($pdo, 'db_backup_last_run_at', '') ?? '');
$lastTs = $last ? strtotime($last) : 0;
$due = (!$lastTs) || ((time() - $lastTs) >= ($interval * 3600));
if (!$due) {
    exit(0);
}

$root = realpath(__DIR__ . '/../../') ?: (__DIR__ . '/../../');
$dir = $root . '/storage/db_backups';
ensureDir($dir);

$ts = date('Ymd_His');
$safeDb = preg_replace('/[^A-Za-z0-9_]+/', '_', (string) ($dbCfg['dbname'] ?? 'db'));
$name = "db_{$safeDb}_{$ts}.dump";
$path = $dir . '/' . $name;

$env = ['PGPASSWORD' => (string) ($dbCfg['password'] ?? '')];
$cmd = [
    'pg_dump',
    '-h', (string) ($dbCfg['host'] ?? 'localhost'),
    '-p', (string) ($dbCfg['port'] ?? '5432'),
    '-U', (string) ($dbCfg['user'] ?? ''),
    '-F', 'c',
    '--no-owner',
    '--no-acl',
    '-f', $path,
    (string) ($dbCfg['dbname'] ?? ''),
];

$res = runCmd($cmd, $env, 1200);
if ((int) ($res['exit_code'] ?? 1) !== 0) {
    @unlink($path);
    fwrite(STDERR, "pg_dump error: " . trim((string) ($res['stderr'] ?? '')) . "\n");
    exit(1);
}

setSetting($pdo, 'db_backup_last_run_at', date('c'));

$keepRaw = (string) (getSetting($pdo, 'db_backup_keep_count', '') ?? '');
$keep = ($keepRaw === '') ? 0 : (int) $keepRaw;
if ($keep > 0) retention($dir, $keep);

echo "OK: created {$name}\n";
exit(0);


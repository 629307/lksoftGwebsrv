<?php
/**
 * Bootstrap окружения (dotenv).
 *
 * Задача:
 * - безопасно загрузить переменные окружения из .env (если файл существует),
 * - НЕ переопределять уже заданные переменные окружения (ENV важнее .env),
 * - не требовать внешних зависимостей.
 *
 * .env файл не должен коммититься в git (см. .gitignore).
 */

if (!function_exists('igs_bootstrap_env')) {
    function igs_bootstrap_env(): void
    {
        static $loaded = false;
        if ($loaded) return;
        $loaded = true;

        $root = realpath(__DIR__ . '/..') ?: (__DIR__ . '/..');
        $envPath = $root . '/.env';
        if (!is_file($envPath) || !is_readable($envPath)) return;

        $lines = @file($envPath, FILE_IGNORE_NEW_LINES);
        if (!is_array($lines)) return;

        foreach ($lines as $line) {
            $line = trim((string) $line);
            if ($line === '' || str_starts_with($line, '#')) continue;

            if (str_starts_with($line, 'export ')) {
                $line = trim(substr($line, 7));
            }

            $pos = strpos($line, '=');
            if ($pos === false) continue;

            $key = trim(substr($line, 0, $pos));
            $val = trim(substr($line, $pos + 1));

            if ($key === '' || !preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $key)) {
                continue;
            }

            // не переопределяем уже заданные env vars
            $existing = getenv($key);
            if ($existing !== false) continue;
            if (array_key_exists($key, $_ENV)) continue;

            // remove inline comments only for unquoted values
            $isQuoted = (str_starts_with($val, '"') && str_ends_with($val, '"')) || (str_starts_with($val, "'") && str_ends_with($val, "'"));
            if (!$isQuoted) {
                $hashPos = strpos($val, ' #');
                if ($hashPos !== false) $val = trim(substr($val, 0, $hashPos));
                if (str_starts_with($val, '#')) $val = '';
            }

            // unquote
            if (str_starts_with($val, '"') && str_ends_with($val, '"') && strlen($val) >= 2) {
                $val = substr($val, 1, -1);
                // basic escapes for double-quoted
                $val = str_replace(['\\n', '\\r', '\\t', '\\"', '\\\\'], ["\n", "\r", "\t", '"', '\\'], $val);
            } elseif (str_starts_with($val, "'") && str_ends_with($val, "'") && strlen($val) >= 2) {
                $val = substr($val, 1, -1);
            }

            // export to environment
            try {
                @putenv($key . '=' . $val);
            } catch (\Throwable $e) {}
            $_ENV[$key] = $val;
            // PHP sometimes relies on $_SERVER for env
            if (!array_key_exists($key, $_SERVER)) {
                $_SERVER[$key] = $val;
            }
        }
    }
}

igs_bootstrap_env();


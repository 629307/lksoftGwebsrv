<?php
/**
 * Класс для логирования ошибок и событий
 * ИГС lksoftGwebsrv
 */

namespace App\Core;

class Logger
{
    private static ?Logger $instance = null;
    private array $logLevels = ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'];

    private function __construct()
    {
        // Логирование через стандартный механизм PHP (error_log).
        // Ведение отдельного файла dmessite.log отключено.
    }

    public static function getInstance(): Logger
    {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function write(string $logEntry): void
    {
        // error_log пишет в стандартный error_log PHP/веб-сервера (настройка окружения).
        // Не создаёт/не использует dmessite.log в корне проекта.
        error_log($logEntry);
    }

    /**
     * Записать сообщение в лог
     * 
     * @param string $level Уровень логирования (DEBUG, INFO, WARNING, ERROR, CRITICAL)
     * @param string $message Сообщение
     * @param string $module Имя модуля
     * @param string $file Имя файла
     * @param int $line Номер строки
     * @param array $context Дополнительный контекст
     */
    public function log(string $level, string $message, string $module = '', string $file = '', int $line = 0, array $context = []): void
    {
        $level = strtoupper($level);
        if (!in_array($level, $this->logLevels)) {
            $level = 'INFO';
        }

        $timestamp = date('Y-m-d H:i:s');
        $contextStr = !empty($context) ? ' | Context: ' . json_encode($context, JSON_UNESCAPED_UNICODE) : '';
        
        $logEntry = sprintf(
            "[%s] [%s] [Module: %s] [File: %s] [Line: %d] %s%s\n",
            $timestamp,
            $level,
            $module ?: 'unknown',
            $file ?: 'unknown',
            $line,
            $message,
            $contextStr
        );

        $this->write($logEntry);
    }

    /**
     * Логирование ошибки
     */
    public function error(string $message, string $module = '', string $file = '', int $line = 0, array $context = []): void
    {
        $this->log('ERROR', $message, $module, $file, $line, $context);
    }

    /**
     * Логирование критической ошибки
     */
    public function critical(string $message, string $module = '', string $file = '', int $line = 0, array $context = []): void
    {
        $this->log('CRITICAL', $message, $module, $file, $line, $context);
    }

    /**
     * Логирование предупреждения
     */
    public function warning(string $message, string $module = '', string $file = '', int $line = 0, array $context = []): void
    {
        $this->log('WARNING', $message, $module, $file, $line, $context);
    }

    /**
     * Логирование информации
     */
    public function info(string $message, string $module = '', string $file = '', int $line = 0, array $context = []): void
    {
        $this->log('INFO', $message, $module, $file, $line, $context);
    }

    /**
     * Логирование отладочной информации
     */
    public function debug(string $message, string $module = '', string $file = '', int $line = 0, array $context = []): void
    {
        $this->log('DEBUG', $message, $module, $file, $line, $context);
    }

    /**
     * Логирование исключения
     */
    public function exception(\Throwable $e, string $module = ''): void
    {
        $this->log(
            'ERROR',
            $e->getMessage(),
            $module,
            $e->getFile(),
            $e->getLine(),
            ['trace' => $e->getTraceAsString()]
        );
    }

    /**
     * Получить путь к файлу лога
     */
    public function getLogFile(): string
    {
        // Файл dmessite.log больше не используется.
        return '';
    }

    /**
     * Получить последние записи из лога
     */
    public function getLastEntries(int $count = 100): array
    {
        // Хвост лога из файла недоступен (ведётся в error_log окружения).
        return [];
    }

    /**
     * Очистить файл лога
     */
    public function clear(): void
    {
        // Нечего очищать: dmessite.log отключён.
    }

    // Предотвращаем клонирование
    private function __clone() {}

    public function __wakeup()
    {
        throw new \Exception("Cannot unserialize singleton");
    }
}

/**
 * Глобальные функции для удобства использования
 */
function logError(string $message, string $module = '', string $file = '', int $line = 0, array $context = []): void
{
    Logger::getInstance()->error($message, $module, $file, $line, $context);
}

function logWarning(string $message, string $module = '', string $file = '', int $line = 0, array $context = []): void
{
    Logger::getInstance()->warning($message, $module, $file, $line, $context);
}

function logInfo(string $message, string $module = '', string $file = '', int $line = 0, array $context = []): void
{
    Logger::getInstance()->info($message, $module, $file, $line, $context);
}

function logException(\Throwable $e, string $module = ''): void
{
    Logger::getInstance()->exception($e, $module);
}

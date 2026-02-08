<?php
/**
 * Сервис авторизации и управления сессиями
 */

namespace App\Core;

class Auth
{
    private static ?array $user = null;
    private Database $db;
    private array $config;

    public function __construct()
    {
        $this->db = Database::getInstance();
        $this->config = require __DIR__ . '/../../config/app.php';
    }

    /**
     * Авторизация пользователя
     */
    public function login(string $login, string $password): ?array
    {
        $user = $this->db->fetch(
            "SELECT u.*, r.code as role_code, r.name as role_name, r.permissions 
             FROM users u 
             JOIN roles r ON u.role_id = r.id 
             WHERE u.login = :login AND u.is_active = true",
            ['login' => $login]
        );

        if (!$user || !password_verify($password, $user['password_hash'])) {
            return null;
        }

        // Обновляем last_login
        $this->db->update('users', ['last_login' => date('Y-m-d H:i:s')], 'id = :id', ['id' => $user['id']]);

        // Создаём токен сессии
        $token = $this->createSession($user['id']);

        // Убираем пароль из ответа
        unset($user['password_hash']);
        $user['token'] = $token;
        $user['permissions'] = json_decode($user['permissions'], true);

        self::$user = $user;

        return $user;
    }

    /**
     * Создание сессии
     */
    private function createSession(int $userId): string
    {
        $token = bin2hex(random_bytes(32));
        $expiresAt = date('Y-m-d H:i:s', time() + $this->config['session']['lifetime']);

        // Удаляем старые сессии пользователя
        $this->db->delete('user_sessions', 'user_id = :user_id', ['user_id' => $userId]);

        // Создаём новую сессию
        $this->db->query(
            "INSERT INTO user_sessions (user_id, session_token, ip_address, user_agent, expires_at) 
             VALUES (:user_id, :token, :ip, :ua, :expires)",
            [
                'user_id' => $userId,
                'token' => $token,
                'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
                'ua' => $_SERVER['HTTP_USER_AGENT'] ?? '',
                'expires' => $expiresAt,
            ]
        );

        return $token;
    }

    /**
     * Проверка токена и получение пользователя
     */
    public function validateToken(string $token): ?array
    {
        $session = $this->db->fetch(
            "SELECT s.*, u.login, u.email, u.full_name, u.is_active, u.role_id,
                    r.code as role_code, r.name as role_name, r.permissions
             FROM user_sessions s
             JOIN users u ON s.user_id = u.id
             JOIN roles r ON u.role_id = r.id
             WHERE s.session_token = :token AND s.expires_at > NOW() AND u.is_active = true",
            ['token' => $token]
        );

        if (!$session) {
            return null;
        }

        self::$user = [
            'id' => $session['user_id'],
            'login' => $session['login'],
            'email' => $session['email'],
            'full_name' => $session['full_name'],
            'role_id' => $session['role_id'],
            'role_code' => $session['role_code'],
            'role_name' => $session['role_name'],
            'permissions' => json_decode($session['permissions'], true),
        ];

        return self::$user;
    }

    /**
     * Выход из системы
     */
    public function logout(string $token): bool
    {
        $result = $this->db->delete('user_sessions', 'session_token = :token', ['token' => $token]);
        self::$user = null;
        return $result > 0;
    }

    /**
     * Получение текущего пользователя
     */
    public static function user(): ?array
    {
        return self::$user;
    }

    /**
     * Проверка роли
     */
    public static function hasRole(string $role): bool
    {
        return self::$user && self::$user['role_code'] === $role;
    }

    /**
     * Проверка прав
     */
    public static function can(string $permission): bool
    {
        if (!self::$user) {
            return false;
        }

        $permissions = self::$user['permissions'] ?? [];

        // Администратор имеет все права
        if (isset($permissions['all']) && $permissions['all'] === true) {
            return true;
        }

        return isset($permissions[$permission]) && $permissions[$permission] === true;
    }

    /**
     * Проверка доступа только для администратора
     */
    public static function isAdmin(): bool
    {
        return self::hasRole('admin');
    }

    /**
     * Root пользователь (технический аккаунт)
     */
    public static function isRoot(): bool
    {
        return (self::$user && (self::$user['login'] ?? '') === 'root');
    }

    /**
     * Проверка права на запись
     */
    public static function canWrite(): bool
    {
        return self::can('write') || self::isAdmin();
    }

    /**
     * Проверка права на удаление
     */
    public static function canDelete(): bool
    {
        // По ТЗ роль "user" может удалять объекты (ограничения только на справочники/пользователей/системные настройки)
        if (self::hasRole('user')) return true;
        return self::can('delete') || self::isAdmin();
    }

    /**
     * Хеширование пароля
     */
    public static function hashPassword(string $password): string
    {
        return password_hash($password, PASSWORD_BCRYPT, ['cost' => 10]);
    }

    /**
     * Регистрация нового пользователя (только для админа)
     */
    public function register(array $data): ?array
    {
        // Проверяем уникальность логина
        $exists = $this->db->fetch("SELECT id FROM users WHERE login = :login", ['login' => $data['login']]);
        if ($exists) {
            return null;
        }

        $userId = $this->db->insert('users', [
            'login' => $data['login'],
            'password_hash' => self::hashPassword($data['password']),
            'email' => $data['email'] ?? null,
            'full_name' => $data['full_name'] ?? null,
            'role_id' => $data['role_id'],
        ]);

        return $this->db->fetch(
            "SELECT id, login, email, full_name, role_id, created_at FROM users WHERE id = :id",
            ['id' => $userId]
        );
    }

    /**
     * Смена пароля
     */
    public function changePassword(int $userId, string $currentPassword, string $newPassword): bool
    {
        $user = $this->db->fetch("SELECT password_hash FROM users WHERE id = :id", ['id' => $userId]);
        
        if (!$user || !password_verify($currentPassword, $user['password_hash'])) {
            return false;
        }

        $this->db->update(
            'users',
            ['password_hash' => self::hashPassword($newPassword)],
            'id = :id',
            ['id' => $userId]
        );

        return true;
    }

    /**
     * Логирование действий
     */
    public function log(string $action, string $tableName = null, int $recordId = null, array $oldValues = null, array $newValues = null): void
    {
        $this->db->query(
            "INSERT INTO audit_log (user_id, action, table_name, record_id, old_values, new_values, ip_address) 
             VALUES (:user_id, :action, :table, :record_id, :old_values, :new_values, :ip)",
            [
                'user_id' => self::$user['id'] ?? null,
                'action' => $action,
                'table' => $tableName,
                'record_id' => $recordId,
                'old_values' => $oldValues ? json_encode($oldValues) : null,
                'new_values' => $newValues ? json_encode($newValues) : null,
                'ip' => $_SERVER['REMOTE_ADDR'] ?? '',
            ]
        );
    }
}

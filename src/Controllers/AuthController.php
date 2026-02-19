<?php
/**
 * Контроллер авторизации
 */

namespace App\Controllers;

use App\Core\Auth;
use App\Core\Request;
use App\Core\Response;
use App\Core\Database;

class AuthController
{
    private Auth $auth;
    private Request $request;
    private Database $db;

    public function __construct()
    {
        $this->auth = new Auth();
        $this->request = new Request();
        $this->db = Database::getInstance();
    }

    /**
     * POST /api/auth/login
     * Авторизация пользователя
     */
    public function login(): void
    {
        $errors = $this->request->validate([
            'login' => 'required|string',
            'password' => 'required|string|min:6',
        ]);

        if (!empty($errors)) {
            Response::error('Ошибка валидации', 422, $errors);
        }

        $login = $this->request->input('login');
        $password = $this->request->input('password');

        $user = $this->auth->login($login, $password);

        if (!$user) {
            Response::error('Неверный логин или пароль', 401);
        }

        $this->auth->log('login', 'users', $user['id']);

        Response::success([
            'user' => [
                'id' => $user['id'],
                'login' => $user['login'],
                'email' => $user['email'],
                'full_name' => $user['full_name'],
                'owner_id' => $user['owner_id'] ?? null,
                'owner_name' => $user['owner_name'] ?? null,
                'role' => [
                    'code' => $user['role_code'],
                    'name' => $user['role_name'],
                ],
                'permissions' => $user['permissions'],
            ],
            'token' => $user['token'],
        ], 'Авторизация успешна');
    }

    /**
     * POST /api/auth/logout
     * Выход из системы
     */
    public function logout(): void
    {
        $token = $this->request->bearerToken();
        
        if ($token) {
            $this->auth->logout($token);
        }

        Response::success(null, 'Выход выполнен');
    }

    /**
     * GET /api/auth/me
     * Получение текущего пользователя
     */
    public function me(): void
    {
        $user = Auth::user();
        
        if (!$user) {
            Response::error('Не авторизован', 401);
        }

        Response::success([
            'id' => $user['id'],
            'login' => $user['login'],
            'email' => $user['email'],
            'full_name' => $user['full_name'],
            'owner_id' => $user['owner_id'] ?? null,
            'owner_name' => $user['owner_name'] ?? null,
            'role' => [
                'code' => $user['role_code'],
                'name' => $user['role_name'],
            ],
            'permissions' => $user['permissions'],
        ]);
    }

    /**
     * PUT /api/auth/password
     * Смена пароля
     */
    public function changePassword(): void
    {
        $user = Auth::user();
        
        if (!$user) {
            Response::error('Не авторизован', 401);
        }

        $errors = $this->request->validate([
            'current_password' => 'required|string',
            'new_password' => 'required|string|min:6',
        ]);

        if (!empty($errors)) {
            Response::error('Ошибка валидации', 422, $errors);
        }

        $result = $this->auth->changePassword(
            $user['id'],
            $this->request->input('current_password'),
            $this->request->input('new_password')
        );

        if (!$result) {
            Response::error('Неверный текущий пароль', 400);
        }

        $this->auth->log('change_password', 'users', $user['id']);

        Response::success(null, 'Пароль успешно изменён');
    }

    /**
     * POST /api/auth/register (только для админа)
     * Регистрация нового пользователя
     */
    public function register(): void
    {
        if (!Auth::isAdmin()) {
            Response::error('Доступ запрещён', 403);
        }

        $errors = $this->request->validate([
            'login' => 'required|string|min:3|max:100',
            'password' => 'required|string|min:6',
            'role_id' => 'required|integer',
        ]);

        if (!empty($errors)) {
            Response::error('Ошибка валидации', 422, $errors);
        }

        $data = $this->request->only(['login', 'password', 'email', 'full_name', 'role_id', 'owner_id']);
        // owner_id имеет смысл только для роли "readonly" (ограничение видимости кабелей по собственнику)
        try {
            $roleRow = $this->db->fetch("SELECT code FROM roles WHERE id = :id", ['id' => (int) ($data['role_id'] ?? 0)]);
            $roleCode = (string) ($roleRow['code'] ?? '');
            if ($roleCode !== 'readonly') {
                $data['owner_id'] = null;
            }
        } catch (\Throwable $e) {
            // если роль не найдена — валидация/создание дальше вернёт ошибку
        }

        $user = $this->auth->register($data);

        if (!$user) {
            Response::error('Пользователь с таким логином уже существует', 400);
        }

        $this->auth->log('register', 'users', $user['id'], null, $user);

        Response::success($user, 'Пользователь создан', 201);
    }

    /**
     * GET /api/users
     * Список пользователей (только для админа)
     */
    public function listUsers(): void
    {
        if (!Auth::isAdmin()) {
            Response::error('Доступ запрещён', 403);
        }

        $users = $this->db->fetchAll(
            "SELECT u.id, u.login, u.email, u.full_name, u.is_active, u.last_login, u.created_at,
                    r.code as role_code, r.name as role_name,
                    u.owner_id, o.name as owner_name
             FROM users u
             JOIN roles r ON u.role_id = r.id
             LEFT JOIN owners o ON u.owner_id = o.id
             ORDER BY u.id"
        );

        Response::success($users);
    }

    /**
     * PUT /api/users/{id}
     * Обновление пользователя (только для админа)
     */
    public function updateUser(string $id): void
    {
        if (!Auth::isAdmin()) {
            Response::error('Доступ запрещён', 403);
        }

        $userId = (int) $id;
        $data = $this->request->only(['email', 'full_name', 'role_id', 'is_active', 'owner_id']);

        // Если передан пароль, хешируем его
        if ($this->request->input('password')) {
            $data['password_hash'] = Auth::hashPassword($this->request->input('password'));
        }

        $oldData = $this->db->fetch("SELECT * FROM users WHERE id = :id", ['id' => $userId]);
        
        if (!$oldData) {
            Response::error('Пользователь не найден', 404);
        }

        // Нормализуем owner_id и очищаем его для не-readonly ролей
        $roleId = array_key_exists('role_id', $data) ? (int) $data['role_id'] : (int) ($oldData['role_id'] ?? 0);
        $roleRow = $this->db->fetch("SELECT code FROM roles WHERE id = :id", ['id' => $roleId]);
        $roleCode = (string) ($roleRow['code'] ?? '');

        if ($roleCode !== 'readonly') {
            $data['owner_id'] = null;
        } else {
            if (array_key_exists('owner_id', $data)) {
                $v = $data['owner_id'];
                if ($v === '' || $v === null || $v === '0' || $v === 0) {
                    $data['owner_id'] = null;
                } else {
                    $data['owner_id'] = (int) $v;
                }
            }
        }

        $this->db->update('users', $data, 'id = :id', ['id' => $userId]);
        
        $this->auth->log('update', 'users', $userId, $oldData, $data);

        $user = $this->db->fetch(
            "SELECT id, login, email, full_name, role_id, owner_id, is_active FROM users WHERE id = :id",
            ['id' => $userId]
        );

        Response::success($user, 'Пользователь обновлён');
    }

    /**
     * DELETE /api/users/{id}
     * Удаление пользователя (только для админа)
     */
    public function deleteUser(string $id): void
    {
        if (!Auth::isAdmin()) {
            Response::error('Доступ запрещён', 403);
        }

        $userId = (int) $id;
        $currentUser = Auth::user();

        // Нельзя удалить себя
        if ($userId === $currentUser['id']) {
            Response::error('Нельзя удалить свой аккаунт', 400);
        }

        $user = $this->db->fetch("SELECT * FROM users WHERE id = :id", ['id' => $userId]);
        
        if (!$user) {
            Response::error('Пользователь не найден', 404);
        }
        // root — системный пользователь, удаление запрещено
        if (($user['login'] ?? '') === 'root') {
            Response::error('Нельзя удалить системного пользователя root', 400);
        }

        try {
            $this->db->beginTransaction();

            // Удаляем сессии пользователя
            $this->db->delete('user_sessions', 'user_id = :id', ['id' => $userId]);

            // Удаляем пользователя (FK в объектах настроены как ON DELETE SET NULL / CASCADE)
            $this->db->delete('users', 'id = :id', ['id' => $userId]);

            $this->db->commit();
        } catch (\Throwable $e) {
            $this->db->rollback();
            throw $e;
        }

        $this->auth->log('delete', 'users', $userId, $user, null);

        Response::success(null, 'Пользователь удалён');
    }

    /**
     * GET /api/roles
     * Список ролей
     */
    public function listRoles(): void
    {
        $roles = $this->db->fetchAll("SELECT id, code, name, description, permissions FROM roles ORDER BY id");
        
        foreach ($roles as &$role) {
            $role['permissions'] = json_decode($role['permissions'], true);
        }

        Response::success($roles);
    }
}

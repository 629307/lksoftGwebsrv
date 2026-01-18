<?php
/**
 * Контроллер для справочников
 */

namespace App\Controllers;

use App\Core\Response;
use App\Core\Auth;

class ReferenceController extends BaseController
{
    private function systemObjectTypeCodes(): array
    {
        return ['well', 'channel', 'marker', 'cable_ground', 'cable_aerial', 'cable_duct'];
    }

    // Конфигурация справочников
    private array $references = [
        'object_types' => [
            'table' => 'object_types',
            'fields' => ['code', 'name', 'description', 'icon', 'color'],
            'search' => ['code', 'name'],
        ],
        'object_kinds' => [
            'table' => 'object_kinds',
            'fields' => ['code', 'name', 'object_type_id', 'description'],
            'search' => ['code', 'name'],
        ],
        'object_status' => [
            'table' => 'object_status',
            'fields' => ['code', 'name', 'color', 'description', 'sort_order'],
            'search' => ['code', 'name'],
        ],
        'owners' => [
            'table' => 'owners',
            'fields' => ['code', 'name', 'short_name', 'inn', 'address', 'contact_person', 'contact_phone', 'contact_email', 'notes'],
            'search' => ['code', 'name', 'short_name', 'inn'],
        ],
        'contracts' => [
            'table' => 'contracts',
            'fields' => ['number', 'name', 'owner_id', 'start_date', 'end_date', 'status', 'amount', 'notes'],
            'search' => ['number', 'name'],
        ],
        'cable_types' => [
            'table' => 'cable_types',
            'fields' => ['code', 'name', 'description'],
            'search' => ['code', 'name'],
        ],
        'cable_catalog' => [
            'table' => 'cable_catalog',
            'fields' => ['cable_type_id', 'fiber_count', 'marking', 'description'],
            'search' => ['marking'],
        ],
    ];

    /**
     * GET /api/references/{type}
     * Список записей справочника
     */
    public function index(string $type): void
    {
        $config = $this->getConfig($type);
        
        $pagination = $this->getPagination();
        $filters = $this->buildFilters([
            '_search' => $config['search'],
        ]);

        $where = $filters['where'];
        $params = $filters['params'];

        // Общее количество
        $total = $this->getTotal($config['table'], $where, $params);

        // Данные
        $sql = "SELECT * FROM {$config['table']}";
        if ($where) {
            $sql .= " WHERE {$where}";
        }
        $sql .= " ORDER BY id LIMIT :limit OFFSET :offset";
        
        $params['limit'] = $pagination['limit'];
        $params['offset'] = $pagination['offset'];
        
        $data = $this->db->fetchAll($sql, $params);

        Response::paginated($data, $total, $pagination['page'], $pagination['limit']);
    }

    /**
     * GET /api/references/{type}/all
     * Все записи справочника (без пагинации, для выпадающих списков)
     */
    public function all(string $type): void
    {
        $config = $this->getConfig($type);
        
        $sql = "SELECT * FROM {$config['table']} ORDER BY ";
        
        // Сортировка по sort_order если есть, иначе по наиболее подходящему полю.
        // В некоторых справочниках (например, cable_catalog) поля 'name' нет.
        if (in_array('sort_order', $config['fields'])) {
            $sql .= "sort_order";
            if (in_array('name', $config['fields'])) {
                $sql .= ", name";
            } else {
                $sql .= ", id";
            }
        } elseif (in_array('name', $config['fields'])) {
            $sql .= "name";
        } elseif (in_array('number', $config['fields'])) {
            $sql .= "number";
        } elseif (in_array('marking', $config['fields'])) {
            $sql .= "marking";
        } else {
            $sql .= "id";
        }
        
        $data = $this->db->fetchAll($sql);
        
        Response::success($data);
    }

    /**
     * GET /api/references/{type}/{id}
     * Получение записи справочника
     */
    public function show(string $type, string $id): void
    {
        $config = $this->getConfig($type);
        
        $item = $this->db->fetch(
            "SELECT * FROM {$config['table']} WHERE id = :id",
            ['id' => (int) $id]
        );

        if (!$item) {
            Response::error('Запись не найдена', 404);
        }

        Response::success($item);
    }

    /**
     * POST /api/references/{type}
     * Создание записи справочника
     */
    public function store(string $type): void
    {
        $this->checkWriteAccess();
        $config = $this->getConfig($type);

        $data = $this->request->only($config['fields']);
        
        // Валидация обязательных полей в зависимости от типа справочника
        $required = $this->getRequiredFields($type);
        foreach ($required as $field) {
            if (empty($data[$field])) {
                Response::error("Поле {$field} обязательно", 422);
            }
        }
        
        // Преобразование булевых значений
        if (isset($data['is_default'])) {
            $data['is_default'] = filter_var($data['is_default'], FILTER_VALIDATE_BOOLEAN);
        }

        try {
            // Фильтруем пустые значения, но сохраняем 0 и false
            $filteredData = array_filter($data, fn($v) => $v !== null && $v !== '');
            
            $id = $this->db->insert($config['table'], $filteredData);
            
            $item = $this->db->fetch(
                "SELECT * FROM {$config['table']} WHERE id = :id",
                ['id' => $id]
            );

            $this->log('create', $config['table'], $id, null, $item);

            Response::success($item, 'Запись создана', 201);
        } catch (\PDOException $e) {
            if (strpos($e->getMessage(), 'unique') !== false || strpos($e->getMessage(), 'duplicate') !== false) {
                Response::error('Запись с таким кодом/номером уже существует', 400);
            }
            throw $e;
        }
    }

    /**
     * Получить обязательные поля для типа справочника
     */
    private function getRequiredFields(string $type): array
    {
        $required = [
            'object_types' => ['code', 'name'],
            'object_kinds' => ['code', 'name'],
            'object_status' => ['code', 'name'],
            'owners' => ['code', 'name'],
            'contracts' => ['number', 'name'],
            'cable_types' => ['code', 'name'],
            'cable_catalog' => ['cable_type_id', 'marking'],
        ];
        
        return $required[$type] ?? ['name'];
    }

    /**
     * PUT /api/references/{type}/{id}
     * Обновление записи справочника
     */
    public function update(string $type, string $id): void
    {
        $this->checkWriteAccess();
        $config = $this->getConfig($type);
        $recordId = (int) $id;

        $oldItem = $this->db->fetch(
            "SELECT * FROM {$config['table']} WHERE id = :id",
            ['id' => $recordId]
        );

        if (!$oldItem) {
            Response::error('Запись не найдена', 404);
        }

        $data = $this->request->only($config['fields']);

        // Для видов объектов запрещаем изменение code (чтобы не ломать логику слоёв/карты)
        if ($type === 'object_types' && array_key_exists('code', $data)) {
            unset($data['code']);
        }
        
        // Преобразование булевых значений
        if (array_key_exists('is_default', $data)) {
            $data['is_default'] = filter_var($data['is_default'], FILTER_VALIDATE_BOOLEAN);
        }
        
        // Фильтруем только null значения, сохраняем пустые строки и 0
        $data = array_filter($data, fn($v) => $v !== null);

        if (empty($data)) {
            Response::error('Нет данных для обновления', 400);
        }

        try {
            $this->db->update($config['table'], $data, 'id = :id', ['id' => $recordId]);
            
            $item = $this->db->fetch(
                "SELECT * FROM {$config['table']} WHERE id = :id",
                ['id' => $recordId]
            );

            $this->log('update', $config['table'], $recordId, $oldItem, $item);

            Response::success($item, 'Запись обновлена');
        } catch (\PDOException $e) {
            if (strpos($e->getMessage(), 'unique') !== false || strpos($e->getMessage(), 'duplicate') !== false) {
                Response::error('Запись с таким кодом/номером уже существует', 400);
            }
            throw $e;
        }
    }

    /**
     * DELETE /api/references/{type}/{id}
     * Удаление записи справочника
     */
    public function destroy(string $type, string $id): void
    {
        $this->checkDeleteAccess();
        $config = $this->getConfig($type);
        $recordId = (int) $id;

        $item = $this->db->fetch(
            "SELECT * FROM {$config['table']} WHERE id = :id",
            ['id' => $recordId]
        );

        if (!$item) {
            Response::error('Запись не найдена', 404);
        }

        // Проверка на системные записи
        if (isset($item['is_system']) && $item['is_system']) {
            Response::error('Нельзя удалить системную запись', 400);
        }
        // Системные виды объектов (well/channel/marker/cable_*) не удаляем, но редактирование разрешено
        if ($type === 'object_types' && isset($item['code']) && in_array($item['code'], $this->systemObjectTypeCodes(), true)) {
            Response::error('Нельзя удалить системный вид объекта', 400);
        }

        try {
            $this->db->delete($config['table'], 'id = :id', ['id' => $recordId]);
            
            $this->log('delete', $config['table'], $recordId, $item, null);

            Response::success(null, 'Запись удалена');
        } catch (\PDOException $e) {
            if (strpos($e->getMessage(), 'violates foreign key') !== false) {
                Response::error('Нельзя удалить запись, так как она используется в других объектах', 400);
            }
            throw $e;
        }
    }

    /**
     * Получить конфигурацию справочника
     */
    private function getConfig(string $type): array
    {
        if (!isset($this->references[$type])) {
            Response::error('Неизвестный тип справочника', 404);
        }
        return $this->references[$type];
    }

    /**
     * GET /api/references
     * Список доступных справочников
     */
    public function types(): void
    {
        $types = array_keys($this->references);
        
        $result = array_map(fn($type) => [
            'code' => $type,
            'name' => $this->getTypeName($type),
        ], $types);

        Response::success($result);
    }

    private function getTypeName(string $type): string
    {
        $names = [
            'object_types' => 'Виды объектов',
            'object_kinds' => 'Типы объектов',
            'object_status' => 'Состояния объектов',
            'owners' => 'Собственники',
            'contracts' => 'Контракты',
            'cable_types' => 'Типы кабелей',
            'cable_catalog' => 'Каталог кабелей',
        ];
        return $names[$type] ?? $type;
    }
}

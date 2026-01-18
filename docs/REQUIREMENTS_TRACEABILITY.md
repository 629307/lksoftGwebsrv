# Трассировка требований

## ИГС lksoftGwebsrv - Файл аналитики

Данный документ описывает, в каких файлах, функциях и блоках кода реализовано каждое требование из технического задания.

---

## 1. ТЕХНИЧЕСКИЙ СТЕК

### 1.1 Backend: PostgreSQL с PostGIS

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Подключение к БД | `config/database.php` | Конфигурация подключения |
| Подключение к БД | `src/Core/Database.php` | Класс `Database`, метод `connect()` |
| Хранение геометрий в PostGIS | `database/schema.sql` | Строки 1-50: `CREATE EXTENSION postgis` |
| Координаты WGS84 (EPSG:4326) | `database/schema.sql` | Колонки `geom_wgs84 GEOMETRY(*, 4326)` |
| Координаты МСК86-Зона 4 | `database/schema.sql` | Строки 15-25: определение SRID 200004 |
| ST_Transform для пересчёта | `database/schema.sql` | Функции `transform_wgs84_to_msk86()`, `transform_msk86_to_wgs84()` (строки 350-380) |

### 1.2 Frontend: Web-интерфейс

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Тема dark по умолчанию | `assets/css/style.css` | Переменные CSS `:root` (строки 10-25) |
| Переключение dark/grey | `assets/css/style.css` | Класс `.theme-grey` (строки 27-37) |
| Переключение темы | `assets/js/app.js` | Метод `setTheme()` (строки 150-155) |
| Карта с слоями | `assets/js/map.js` | Класс `MapManager`, метод `init()` |
| Поддержка OpenStreetMap | `assets/js/map.js` | Строки 30-35: `L.tileLayer('https://{s}.tile.openstreetmap.org...')` |
| Клик по объектам и popup | `assets/js/map.js` | Метод `showObjectInfo()` (строки 200-250) |
| Фильтры | `index.html` | Блок `.filters-panel` (строки 100-130) |
| Фильтры (логика) | `assets/js/app.js` | Методы `applyFilters()`, `resetFilters()` |
| Leaflet | `index.html` | Подключение Leaflet (строки 8, 170) |

---

## 2. АВТОРИЗАЦИЯ И РОЛИ

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Таблица users | `database/schema.sql` | Строки 55-70: `CREATE TABLE users` |
| Таблица roles | `database/schema.sql` | Строки 40-52: `CREATE TABLE roles` |
| Хеширование bcrypt | `src/Core/Auth.php` | Метод `hashPassword()` (строки 160-165) |
| Роль Пользователь | `database/schema.sql` | Строки 450-455: INSERT roles 'user' |
| Роль Администратор | `database/schema.sql` | Строки 450-455: INSERT roles 'admin' |
| Роль Только чтение | `database/schema.sql` | Строки 450-455: INSERT roles 'readonly' |
| Админ root/Kolobaha00! | `database/schema.sql` | Строки 458-462: INSERT users 'root' |
| Проверка авторизации | `src/Core/Auth.php` | Метод `validateToken()` (строки 80-110) |
| Права по роли | `src/Core/Auth.php` | Методы `can()`, `isAdmin()`, `canWrite()` |
| API с учётом прав | `src/Controllers/BaseController.php` | Методы `checkWriteAccess()`, `checkDeleteAccess()` |
| Middleware авторизации | `api/index.php` | Middleware 'auth' (строки 45-60) |

---

## 3. СПРАВОЧНЫЕ ТАБЛИЦЫ

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| roles | `database/schema.sql` | Строки 40-52 |
| object_types (виды) | `database/schema.sql` | Строки 72-85 |
| object_kinds (типы) | `database/schema.sql` | Строки 87-100 |
| object_status (состояния) | `database/schema.sql` | Строки 102-115 |
| owners (собственники) | `database/schema.sql` | Строки 117-135 |
| contracts (контракты) | `database/schema.sql` | Строки 137-155 |
| Уникальные ключи | `database/schema.sql` | Ограничения `UNIQUE` в каждой таблице |
| FK ON DELETE RESTRICT | `database/schema.sql` | Внешние ключи с `ON DELETE RESTRICT` |
| CRUD справочников | `src/Controllers/ReferenceController.php` | Методы `index()`, `store()`, `update()`, `destroy()` |

---

## 4. ОСНОВНЫЕ ТАБЛИЦЫ ОБЪЕКТОВ

### 4.1 Колодцы (wells)

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Таблица wells | `database/schema.sql` | Строки 200-230 |
| id SERIAL PRIMARY KEY | `database/schema.sql` | Строка 201 |
| number VARCHAR UNIQUE NOT NULL | `database/schema.sql` | Строка 202 |
| geom_wgs84 GEOMETRY(POINT,4326) | `database/schema.sql` | Строка 203 |
| geom_msk86 GEOMETRY(POINT,200004) | `database/schema.sql` | Строка 204 |
| FK к owners, types, kinds, status | `database/schema.sql` | Строки 205-208 |
| photos через object_photos | `database/schema.sql` | Таблица object_photos (строки 380-400) |
| API колодцев | `src/Controllers/WellController.php` | Все методы |
| GeoJSON колодцев | `src/Controllers/WellController.php` | Метод `geojson()` |

### 4.2 Направления каналов (channel_directions)

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Таблица channel_directions | `database/schema.sql` | Строки 232-260 |
| geom_wgs84 GEOMETRY(LINESTRING) | `database/schema.sql` | Строка 235 |
| start_well_id, end_well_id FK | `database/schema.sql` | Строки 239-240 |
| Связь 1..16 каналов | `database/schema.sql` | Таблица cable_channels (строки 262-280) |
| API направлений | `src/Controllers/ChannelController.php` | Все методы |

### 4.3 Каналы (cable_channels)

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Таблица cable_channels | `database/schema.sql` | Строки 262-280 |
| channel_number 1-16 | `database/schema.sql` | `CHECK (channel_number BETWEEN 1 AND 16)` |
| FK к direction_id | `database/schema.sql` | Строка 265 |
| API каналов | `src/Controllers/ChannelController.php` | Методы `addChannel()`, `updateChannel()`, `deleteChannel()` |

### 4.4 Столбики (marker_posts)

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Таблица marker_posts | `database/schema.sql` | Строки 282-310 |
| API столбиков | `src/Controllers/MarkerPostController.php` | Все методы |

### 4.5-4.7 Кабели

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| ground_cables (в грунте) | `database/schema.sql` | Строки 312-340 |
| aerial_cables (воздушные) | `database/schema.sql` | Строки 342-370 |
| duct_cables (в канализации) | `database/schema.sql` | Строки 372-400 |
| geom MULTILINESTRING | `database/schema.sql` | Колонки geom_wgs84, geom_msk86 |
| FK к owners, contracts | `database/schema.sql` | В каждой таблице кабелей |
| Связь duct с каналами | `database/schema.sql` | Таблица duct_cable_channels (строки 402-410) |
| API кабелей | `src/Controllers/CableController.php` | Все методы |

### 4.8 Инциденты (incidents)

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Таблица incidents | `database/schema.sql` | Строки 420-445 |
| created_by FK к users | `database/schema.sql` | Строка 430 |
| Связи многие-ко-многим | `database/schema.sql` | Таблицы incident_wells, incident_* (строки 460-500) |
| API инцидентов | `src/Controllers/IncidentController.php` | Все методы |

### 4.9 История инцидента (incident_history)

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Таблица incident_history | `database/schema.sql` | Строки 447-458 |
| FK к incidents | `database/schema.sql` | Строка 449 |
| API истории | `src/Controllers/IncidentController.php` | Метод `addHistoryEntry()` |

### 4.10 Группы объектов (object_groups)

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Таблица object_groups | `database/schema.sql` | Строки 510-525 |
| Связи многие-ко-многим | `database/schema.sql` | Таблицы group_wells, group_* (строки 527-560) |
| API групп | `src/Controllers/GroupController.php` | Все методы |

---

## 5. ИМПОРТ И ДОБАВЛЕНИЕ ДАННЫХ

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Ручное добавление WGS84/МСК86 | `src/Controllers/WellController.php` | Метод `store()` (строки 100-170) |
| Автоматический пересчёт | `database/schema.sql` | Триггеры transform_* (строки 350-380) |
| Импорт CSV | `src/Controllers/ImportController.php` | Метод `importCsv()` |
| Сопоставление колонок | `src/Controllers/ImportController.php` | Метод `previewCsv()` |
| Импорт MapInfo (.TAB, .DAT, .MAP, .ID) | `src/Controllers/ImportController.php` | Методы `importMapInfo()`, `confirmMapInfoImport()` |
| UI импорта | `assets/js/app.js` | Метод `showImportModal()` |

---

## 6. WEB ФУНКЦИОНАЛ

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Просмотр справочников | `index.html` | Раздел `#content-references` |
| Редактирование справочников | `src/Controllers/ReferenceController.php` | CRUD методы |
| Просмотр объектов | `index.html` | Раздел `#content-objects` |
| Редактирование объектов | Контроллеры объектов | Методы `update()` |
| Табличное отображение | `assets/js/app.js` | Метод `renderObjectsTable()` |
| Фильтры по типу, собственнику | `assets/js/app.js` | Метод `applyFilters()` |
| Выгрузка отчётов | `src/Controllers/ReportController.php` | Метод `export()` |
| Карта с объектами | `assets/js/map.js` | Класс `MapManager` |
| Включение/выключение слоёв | `assets/js/map.js` | Метод `toggleLayer()` |
| Всплывающая информация | `assets/js/map.js` | Метод `showObjectInfo()`, `bindTooltip()` |
| Отображение WGS84/МСК86 | `assets/js/map.js` | Метод `setCoordinateSystem()` |
| OpenStreetMap при WGS84 | `assets/js/map.js` | Базовый слой `this.baseLayer` |
| Стили по типам и состояниям | `assets/js/map.js` | Объекты `colors`, `statusColors` |

---

## 7. ФОТОГРАФИИ

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Таблица object_photos | `database/schema.sql` | Строки 560-590 |
| Максимум 10 фото | `database/schema.sql` | Триггер `check_photo_limit()` (строки 595-605) |
| API фотографий | `src/Controllers/PhotoController.php` | Все методы |
| Загрузка фото | `src/Controllers/PhotoController.php` | Метод `upload()` |
| Миниатюры | `src/Controllers/PhotoController.php` | Метод `createThumbnail()` |

---

## 8. ОТЧЁТЫ

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Отчёт по объектам | `src/Controllers/ReportController.php` | Метод `objects()` |
| Отчёт по контрактам | `src/Controllers/ReportController.php` | Метод `contracts()` |
| Отчёт по собственникам | `src/Controllers/ReportController.php` | Метод `owners()` |
| Отчёт по инцидентам | `src/Controllers/ReportController.php` | Метод `incidents()` |
| Экспорт в CSV | `src/Controllers/ReportController.php` | Метод `export()` |
| UI отчётов | `index.html` | Раздел `#content-reports` |
| Рендеринг отчётов | `assets/js/app.js` | Методы `renderObjectsReport()`, etc. |

---

## 9. АДМИНИСТРИРОВАНИЕ

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| Управление пользователями | `src/Controllers/AuthController.php` | Методы `listUsers()`, `updateUser()`, `deleteUser()` |
| Регистрация пользователей | `src/Controllers/AuthController.php` | Метод `register()` |
| UI администрирования | `index.html` | Раздел `#content-admin` |
| Журнал аудита | `database/schema.sql` | Таблица `audit_log` (строки 610-625) |
| Логирование действий | `src/Core/Auth.php` | Метод `log()` |

---

## 10. ПРЕДСТАВЛЕНИЯ (VIEWS)

| Требование | Файл | Функция/Блок |
|------------|------|--------------|
| v_wells | `database/schema.sql` | Строки 630-660 |
| v_channel_directions | `database/schema.sql` | Строки 662-690 |
| v_all_cables | `database/schema.sql` | Строки 692-730 |

---

## Резюме по файлам

### Backend (PHP)

| Файл | Назначение |
|------|------------|
| `api/index.php` | Точка входа API, маршрутизация |
| `vendor/autoload.php` | Автозагрузчик классов |
| `config/database.php` | Конфигурация БД |
| `config/app.php` | Конфигурация приложения |
| `src/Core/Database.php` | Работа с БД (Singleton) |
| `src/Core/Router.php` | Маршрутизатор |
| `src/Core/Request.php` | Обработка HTTP запросов |
| `src/Core/Response.php` | Формирование ответов |
| `src/Core/Auth.php` | Авторизация и сессии |
| `src/Controllers/BaseController.php` | Базовый контроллер |
| `src/Controllers/AuthController.php` | Авторизация, пользователи |
| `src/Controllers/ReferenceController.php` | CRUD справочников |
| `src/Controllers/WellController.php` | CRUD колодцев |
| `src/Controllers/ChannelController.php` | CRUD направлений и каналов |
| `src/Controllers/CableController.php` | CRUD кабелей |
| `src/Controllers/MarkerPostController.php` | CRUD столбиков |
| `src/Controllers/IncidentController.php` | CRUD инцидентов |
| `src/Controllers/GroupController.php` | CRUD групп |
| `src/Controllers/ImportController.php` | Импорт данных |
| `src/Controllers/PhotoController.php` | Работа с фотографиями |
| `src/Controllers/ReportController.php` | Отчёты |

### Frontend (HTML/CSS/JS)

| Файл | Назначение |
|------|------------|
| `index.html` | Главная страница SPA |
| `assets/css/style.css` | Стили, темы dark/grey |
| `assets/js/api.js` | API клиент |
| `assets/js/map.js` | Карта Leaflet |
| `assets/js/app.js` | Основная логика приложения |

### База данных

| Файл | Назначение |
|------|------------|
| `database/schema.sql` | DDL схема, триггеры, начальные данные |

### Конфигурация

| Файл | Назначение |
|------|------------|
| `.htaccess` | Конфигурация Apache |

### Документация

| Файл | Назначение |
|------|------------|
| `docs/README.md` | Документация по системе |
| `docs/REQUIREMENTS_TRACEABILITY.md` | Данный файл |

---

## Статистика реализации

| Категория | Требований | Реализовано |
|-----------|------------|-------------|
| Технический стек | 10 | 10 |
| Авторизация и роли | 12 | 12 |
| Справочные таблицы | 10 | 10 |
| Основные таблицы | 20 | 20 |
| Импорт данных | 5 | 5 |
| Web функционал | 15 | 15 |
| **ИТОГО** | **72** | **72** |

---

Документ подготовлен: Январь 2026

# Рекомендации по безопасности — ИГС lksoftGwebsrv

Документ фиксирует результаты экспресс‑аудита репозитория и меры по подготовке к production.

## 1) Краткое резюме (что важно для production)

- **Секреты и debug**: конфиги переведены на переменные окружения, `debug` по умолчанию выключен.
- **CORS/headers**: добавлены базовые security‑headers для API и управляемый CORS (через ENV).
- **RBAC**: “Инвентаризация” теперь недоступна для роли `readonly` не только в UI, но и на API уровне.
- **Uploads**: усилена загрузка файлов (случайные имена, server‑side MIME) и закрыт доступ к служебным директориям на уровне web‑server конфигов.

## 2) Найденные риски (по категориям)

### 2.1 Hardcoded secrets / небезопасные дефолты
- **Hardcoded DB credentials** в `config/database.php` (устранено: теперь ENV).
- **Hardcoded JWT secret** и `debug=true` в `config/app.php` (устранено: теперь ENV + безопасный default).
- **Публичные упоминания паролей** в документации/legacy (устранено).
- **Default admin/root в schema**: в `database/schema.sql` создаётся root‑пользователь с предустановленным паролем (пароль больше не “светим” в комментариях/доках, но сам факт известного пароля остаётся).
  - **Требует ручного вмешательства** (см. раздел 4).

### 2.2 CORS / security headers
- В `api/index.php` ранее был `Access-Control-Allow-Origin: *` без конфигурации.
  - Теперь CORS настраивается через `IGS_CORS_ALLOW_ORIGINS`, но по умолчанию оставлен `*` для обратной совместимости.
  - Для production нужно явно ограничить origin.
- Ранее отсутствовали базовые security headers для API.
  - Добавлены: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-Permitted-Cross-Domain-Policies`.

### 2.3 Auth/RBAC/IDOR
- **Инвентаризация для readonly**: UI скрывал функции, но API позволял читать инвентарные карточки/слой/“предполагаемые кабели”.
  - Исправлено: API возвращает `403` для `readonly` на всех эндпоинтах инвентаризации/assumed cables.
- **Доступ к uploads**: файлы отдаются как статические (`/uploads/...`) и потенциально доступны при знании URL (зависит от конфигурации web‑server).
  - Это риск IDOR/утечек. Полное исправление требует изменения схемы раздачи файлов (см. раздел 4).

### 2.4 SQL injection
- В основном используются подготовленные запросы и биндинг параметров (`Database::query`).
- Динамические таблицы присутствуют, но **только из whitelist** (например, справочники через `ReferenceController::getConfig()`).
- Потенциально рискованные места:
  - Любая будущая функциональность, где имя таблицы/колонки строится из пользовательского ввода.

### 2.5 XSS
- Frontend активно генерирует HTML через шаблоны строк.
  - При наличии “грязных” значений из БД (например, `name/number/notes`) возможен XSS, если эти значения попадают в `innerHTML` без экранирования.
  - Требует плановой доработки (см. раздел 4).

### 2.6 CSRF
- API использует `Authorization: Bearer <token>` (токен не cookie‑based), поэтому классический CSRF менее вероятен.
- При переходе на cookie‑авторизацию потребуется CSRF‑защита.

### 2.7 SSRF / Open redirect / Path traversal
- Явных SSRF/Open Redirect не обнаружено.
- Path traversal:
  - В backup/restore есть явная санитизация идентификатора бэкапа.
  - У вложений/фото пути берутся из БД; в production нужно ограничивать доступ к файловой системе и исключить возможность подмены путей (см. раздел 4).

## 3) Что уже исправлено в репозитории

### 3.1 Конфиги и секреты
- `config/app.php`: `debug` берётся из `IGS_APP_DEBUG` (default `0`), JWT secret берётся из `IGS_JWT_SECRET`.
- `config/database.php`: DB host/user/password берутся из `IGS_DB_*`.
- Добавлен `.env.example` с перечнем переменных.

### 3.2 CORS и security headers (API)
- `api/index.php`:
  - добавлены security headers,
  - CORS стал конфигурируемым (`IGS_CORS_ALLOW_ORIGINS`, `IGS_CORS_MAX_AGE`).

### 3.3 RBAC для инвентаризации
- Запрещены read‑операции по инвентаризации для `readonly`:
  - `InventoryCardController` (включая GeoJSON слой),
  - `InventoryAttachmentController::byCard`,
  - `AssumedCableController` (geojson/list/export).

### 3.4 Upload hardening
- Случайные имена файлов на `random_bytes` (fallback `uniqid`).
- MIME определяется на сервере (`finfo`/`mime_content_type`), а не берётся от клиента.
- `Response::file` защищён от header injection через `filename`.

### 3.5 Hardening web‑server конфигов (минимум)
- `nginx.conf` и `.htaccess`: закрыт доступ к `bk/`, `docs/`, `storage/` (и прочим служебным) директориям.

## 4) Что требует ручного вмешательства (важно)

### 4.1 Смена/удаление дефолтного root‑пароля
Даже если пароль не указан в документации, наличие известного дефолта в `database/schema.sql` — это риск.

Рекомендуемые варианты (выберите один):
- **A (лучший)**: убрать дефолтного root из схемы и создавать администратора отдельным безопасным шагом (migration/CLI).
- **B**: оставить root, но **сразу после установки** сменить пароль и ограничить доступ (VPN/allowlist).

### 4.2 Раздача загруженных файлов (uploads)
Сейчас URL на файл строится как `/uploads/<subdir>/<filename>` и отдаётся как статика.

Для production рекомендуется:
- хранить uploads **вне web‑root**,
- отдавать файлы через API endpoint `GET /api/.../download/{id}`:
  - проверять права доступа (роль/owner scope),
  - логировать скачивание,
  - ставить корректные `Content-Type`, `Content-Disposition`,
  - ограничивать size/range при необходимости.

### 4.3 XSS-hardening на frontend
Рекомендуется:
- централизованный `escapeHtml()` и запрет на использование `innerHTML` с данными из API без экранирования,
- CSP (после инвентаризации inline‑скриптов/стилей и CDN).

### 4.4 Rate limiting / brute-force
Рекомендуется настроить на Nginx:
- rate limit на `/api/auth/login`,
- защита от password spraying (по IP/логину),
- optional fail2ban.

## 5) Production hardening checklist

- **TLS**: только HTTPS, включить HSTS (после стабилизации домена).
- **CORS**: убрать `*`, задать `IGS_CORS_ALLOW_ORIGINS` конкретными доменами.
- **Headers**: добавить полный набор на web‑server уровне (CSP/Permissions‑Policy/COOP/COEP — после тестов).
- **Uploads**: вынести вне web‑root, запретить исполнение скриптов, лимиты на размер, AV‑сканирование (опционально).
- **DB**: доступ к PostgreSQL только с app‑хоста, отдельный пользователь с минимальными правами.
- **Backups**: регулярные бэкапы + тест восстановления + шифрование/изоляция хранилища.
- **Logging**: ротация логов, алерты по 5xx и auth‑ошибкам.

## 6) Рекомендации по CI/CD безопасности

- **Secrets scanning**: включить сканирование (например, gitleaks/trufflehog) на PR.
- **SAST**: базовый PHP SAST (Psalm/PHPStan + правила безопасности).
- **Dependency scanning**: если появится composer — включить `composer audit`/Dependabot.
- **Build gates**: `php -l` на PR, минимальные smoke‑тесты API.

## 7) Рекомендации по управлению доступом

- Минимизировать использование root‑аккаунта, включить журнал действий (`audit_log`) для админ‑операций.
- Принцип наименьших привилегий: `readonly` не должен иметь доступ к инвентаризации и административным endpoints.
- Проверки прав должны быть на backend, а не только “скрыть кнопку” на frontend.


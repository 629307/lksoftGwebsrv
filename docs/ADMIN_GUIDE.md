# Руководство системного администратора — ИГС lksoftGwebsrv

Документ описывает установку, настройку окружения, развёртывание и эксплуатацию системы в dev/prod.

## 1) Установка системы

### Требования
- **OS**: Linux (рекомендовано Ubuntu LTS)
- **Web‑server**: Nginx (рекомендовано) или Apache
- **PHP**: 8.1+ (минимум 8.0) + расширения:
  - `pdo_pgsql`, `json`, `mbstring`
  - для изображений: `gd` (если используется обработка)
- **PostgreSQL**: 13+ (рекомендовано 14/15) + **PostGIS**

### Размещение приложения
Рекомендуемый путь на сервере:
- `/var/www/html/lksoftGwebsrv`

Важные каталоги:
- `uploads/` — загрузки (фото, документы). Должен быть **записываемым** для пользователя веб‑сервера.
- `storage/` — служебные скрипты/логи (в зависимости от конфигурации).

### Установка зависимостей PHP
В репозитории присутствует `vendor/` (autoload). Если проект переводится на Composer — используйте стандартную установку.

## 2) Настройка окружения (env, ключи, доступы)

### Конфигурационные файлы
- `config/app.php` — параметры приложения (debug/timezone/лимиты/секреты).
- `config/database.php` — подключение к PostgreSQL.

### Переменные окружения (рекомендуется для prod)
Для production **не храните секреты в репозитории**. Используйте переменные окружения на уровне systemd/контейнера/CI.

Рекомендуемые переменные:
- **База данных**
  - `IGS_DB_HOST`
  - `IGS_DB_PORT`
  - `IGS_DB_NAME`
  - `IGS_DB_USER`
  - `IGS_DB_PASSWORD`
- **Приложение**
  - `IGS_APP_DEBUG` (`0/1`)
  - `IGS_APP_TIMEZONE` (например, `Asia/Yekaterinburg`)
  - `IGS_JWT_SECRET` (если функционал JWT используется/будет использоваться)
  - `IGS_UPLOAD_MAX_BYTES` (например, `52428800`)

### Права доступа к файлам
- Владелец кода: `root:root` или отдельный пользователь деплоя (read‑only).
- Запись разрешена только в:
  - `uploads/`
  - (опционально) `storage/` если пишутся логи/бэкапы

Пример:
```bash
chown -R root:root /var/www/html/lksoftGwebsrv
chown -R www-data:www-data /var/www/html/lksoftGwebsrv/uploads
chmod -R 750 /var/www/html/lksoftGwebsrv
chmod -R 770 /var/www/html/lksoftGwebsrv/uploads
```

## 3) Развёртывание (prod/dev)

### Nginx (рекомендуемый вариант)
В репозитории есть пример: `nginx.conf`.

Ключевые моменты:
- Статика отдаётся напрямую (`assets/`, `index.html`).
- Все запросы `/api/*` направляются в `api/index.php`.
- Для загрузок увеличить `client_max_body_size`.

### Apache
Используется `.htaccess` с `mod_rewrite`:
- `/api/*` → `api/index.php`
- прочее → `index.html` (SPA)

### Dev‑окружение
Минимально нужно:
- рабочее подключение к PostgreSQL
- корректный reverse‑proxy/rewrites для `/api`
- включённый CORS (если фронтенд и API на разных хостах)

### Prod‑окружение (обязательно)
- HTTPS (TLS) + HSTS (если домен постоянный)
- ограниченный CORS (по списку доменов)
- security headers на уровне Nginx/Apache
- ограничение размера upload, rate limiting для `/api/auth/login`
- отключить `debug` и вывод stack trace в ответы

## 4) Настройка пользователей и ролей

### Где хранятся роли
В БД таблицы `roles` и `users`. Пользователь имеет `role_id` и (опционально) `owner_id` (для ограничений доступа в роли `readonly`).

### Общая модель прав
- `admin`: полный доступ.
- `user`: рабочий доступ, но часть системных настроек недоступна.
- `readonly`: только просмотр; многие действия (создание/редактирование/удаление/инвентаризация) ограничены.
- `root`: технический аккаунт (логин `root`), может менять часть глобальных настроек.

Практика:
- после развёртывания убедиться, что **пароли изменены**, доступ к root ограничен (IP allowlist/VPN).

## 5) Резервное копирование

### Бэкап БД (pg_dump)
Рекомендуется ежедневный бэкап + хранение минимум 7–30 дней.

```bash
export PGPASSWORD="***"
pg_dump -h "$IGS_DB_HOST" -U "$IGS_DB_USER" -d "$IGS_DB_NAME" \
  --format=custom --file="/backups/lksoftgwebsrv_$(date +%F).dump"
unset PGPASSWORD
```

### Бэкап загруженных файлов
`uploads/` копировать отдельно (rsync/backup agent).

## 6) Восстановление

### Восстановление БД
```bash
export PGPASSWORD="***"
pg_restore -h "$IGS_DB_HOST" -U "$IGS_DB_USER" -d "$IGS_DB_NAME" --clean "/backups/FILE.dump"
unset PGPASSWORD
```

### Восстановление uploads
Вернуть каталог `uploads/` из архива и проверить права.

## 7) Логи и мониторинг

### Nginx/Apache
- access/error логи веб‑сервера.
- включить ротацию (logrotate).

### Приложение
API логирует исключения (см. `api/index.php` и `src/Core/Logger.php`).
Рекомендация:
- направлять логи в syslog/journald или отдельный файл в `storage/` (с ротацией).

### Мониторинг
Минимальный набор:
- uptime web‑сервера и PHP‑FPM
- доступность PostgreSQL
- размер диска (особенно `uploads/`)
- алерты по 5xx/ошибкам авторизации

## 8) Обновление системы

Рекомендуемый процесс:
1. Сделать бэкап БД + `uploads/`
2. Обновить код (git pull / deploy artifact)
3. Прогнать smoke‑проверку API (`/api/auth/login`, `/api/auth/me`, `/api/wells/geojson`)
4. При необходимости выполнить миграции (если появятся)

## 9) Безопасность (ключи, доступы, firewall, CORS)

### Ротация ключей/паролей
- Пароли пользователей (особенно `root`) менять по регламенту.
- Секреты (DB password, JWT secret) хранить вне репозитория, менять при утечке.

### Firewall / network
- PostgreSQL доступен только приложению (security group/iptables).
- Админ‑разделы доступны только из доверенных сетей (VPN/office).

### CORS
Если фронтенд и API на разных доменах — разрешайте **только** нужные Origin.
В противном случае используйте same‑origin и отключайте wildcard `*`.

### Security headers
Рекомендуемые заголовки (на уровне веб‑сервера):
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: same-origin`
- `Permissions-Policy: geolocation=(self)` (или по политике организации)
- CSP внедрять осторожно (из‑за CDN и inline‑кода)


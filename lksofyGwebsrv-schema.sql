-- ============================================================
-- ИГС (Информационная Географическая Система) - lksoftGwebsrv
-- All-in-one bootstrap script: schema + all migrations
--
-- Запуск (пример):
--   psql -h <host> -U <user> -d <db> -f lksofyGwebsrv-schema.sql
--
-- Важно:
-- - Этот файл является "точкой входа" и использует psql-include (\i),
--   поэтому должен выполняться через psql.
-- - Содержимое миграций НЕ дублируется здесь вручную, чтобы избежать рассинхронизации.
-- ============================================================

\set ON_ERROR_STOP on

\echo '== IGS lksoftGwebsrv: apply base schema =='
\i database/schema.sql

\echo '== IGS lksoftGwebsrv: apply migrations =='
\i database/migration_v2.sql
\i database/migration_v3.sql
\i database/migration_v4.sql
\i database/migration_v5.sql
\i database/migration_v6.sql
\i database/migration_v7.sql
\i database/migration_v8.sql
\i database/migration_v9.sql
\i database/migration_v10.sql
\i database/migration_v12.sql
\i database/migration_v13.sql
\i database/migration_v14.sql
\i database/migration_v15.sql
\i database/migration_v17.sql
\i database/migration_v18.sql
\i database/migration_v19.sql
\i database/migration_v20.sql
\i database/migration_v21.sql
\i database/migration_v22.sql

\echo '== IGS lksoftGwebsrv: post-finalization patches =='

-- Дефолтная ссылка на ресурс пересчёта координат:
-- Обновляем ТОЛЬКО если значение пустое или равняется старому дефолту.
INSERT INTO app_settings(code, value, updated_at)
VALUES ('url_geoproj', 'https://wgs-msk.soilbox.app/', NOW())
ON CONFLICT (code) DO UPDATE
SET value = EXCLUDED.value,
    updated_at = NOW()
WHERE app_settings.value IS NULL
   OR app_settings.value = ''
   OR app_settings.value = 'https://geoproj.ru/';

\echo '== IGS lksoftGwebsrv: done =='


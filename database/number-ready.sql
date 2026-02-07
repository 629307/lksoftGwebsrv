-- ============================================================
-- number-ready.sql
-- Приведение номеров существующих объектов к новой схеме нумерации (ручной запуск).
--
-- Новая схема:
--   <object_types.number_code>-<owners.code>-<seq>(-suffix)
--
-- ВНИМАНИЕ:
-- - Скрипт НЕ учитывает суффиксы (suffix) и присваивает номера без суффикса.
-- - seq назначается подряд от 1 по порядку id в рамках (owner_id, type_id/object_type_id).
-- - Перед запуском сделайте резервную копию базы.
-- ============================================================

BEGIN;

-- На всякий случай: number_code по умолчанию = code
UPDATE object_types
SET number_code = code
WHERE number_code IS NULL OR number_code = '';

-- ========================
-- Колодцы (wells)
-- ========================
WITH base AS (
    SELECT
        w.id,
        w.owner_id,
        w.type_id,
        o.code AS owner_code,
        COALESCE(NULLIF(ot.number_code, ''), ot.code) AS num_code,
        CASE WHEN split_part(w.number, '-', 3) ~ '^[0-9]+$' THEN split_part(w.number, '-', 3)::int ELSE NULL END AS old_seq
    FROM wells w
    JOIN owners o ON w.owner_id = o.id
    JOIN object_types ot ON w.type_id = ot.id
),
assigned AS (
    SELECT
        id,
        owner_code,
        num_code,
        row_number() OVER (PARTITION BY owner_id, type_id ORDER BY id) AS seq
    FROM base
)
UPDATE wells w
SET number = a.num_code || '-' || a.owner_code || '-' || a.seq::text
FROM assigned a
WHERE w.id = a.id;

-- ========================
-- Столбики (marker_posts)
-- ========================
WITH base AS (
    SELECT
        mp.id,
        mp.owner_id,
        mp.type_id,
        o.code AS owner_code,
        COALESCE(NULLIF(ot.number_code, ''), ot.code) AS num_code,
        CASE WHEN split_part(mp.number, '-', 3) ~ '^[0-9]+$' THEN split_part(mp.number, '-', 3)::int ELSE NULL END AS old_seq
    FROM marker_posts mp
    JOIN owners o ON mp.owner_id = o.id
    JOIN object_types ot ON mp.type_id = ot.id
),
assigned AS (
    SELECT
        id,
        owner_code,
        num_code,
        row_number() OVER (PARTITION BY owner_id, type_id ORDER BY id) AS seq
    FROM base
)
UPDATE marker_posts mp
SET number = a.num_code || '-' || a.owner_code || '-' || a.seq::text
FROM assigned a
WHERE mp.id = a.id;

-- ========================
-- Кабели (cables)
-- ========================
WITH base AS (
    SELECT
        c.id,
        c.owner_id,
        c.object_type_id,
        o.code AS owner_code,
        COALESCE(NULLIF(ot.number_code, ''), ot.code) AS num_code,
        CASE WHEN split_part(c.number, '-', 3) ~ '^[0-9]+$' THEN split_part(c.number, '-', 3)::int ELSE NULL END AS old_seq
    FROM cables c
    JOIN owners o ON c.owner_id = o.id
    JOIN object_types ot ON c.object_type_id = ot.id
),
assigned AS (
    SELECT
        id,
        owner_code,
        num_code,
        object_type_id,
        row_number() OVER (PARTITION BY owner_id, object_type_id ORDER BY id) AS seq
    FROM base
)
UPDATE cables c
SET number = a.num_code || '-' || a.owner_code || '-' || a.seq::text
FROM assigned a
WHERE c.id = a.id;

-- ========================
-- Направления: номер = <номер начального колодца>-<номер конечного колодца>
-- ========================
UPDATE channel_directions cd
SET number = CONCAT(sw.number, '-', ew.number),
    updated_at = NOW()
FROM wells sw, wells ew
WHERE cd.start_well_id = sw.id
  AND cd.end_well_id = ew.id;

COMMIT;


-- ============================================================
-- Миграция v10.0 - ТУ: вложения (документы/изображения)
-- ============================================================

CREATE TABLE IF NOT EXISTS group_attachments (
    id SERIAL PRIMARY KEY,
    group_id INTEGER NOT NULL REFERENCES object_groups(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255),
    file_path TEXT NOT NULL,
    file_size INTEGER,
    mime_type VARCHAR(100),
    description TEXT,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_group_attachments_group_id ON group_attachments(group_id);


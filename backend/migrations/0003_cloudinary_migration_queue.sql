-- Historical image import queue, additive and reversible. No changes to Xeption URLs.
-- Each source has a stable destination media UUID before the first upload.
CREATE TABLE IF NOT EXISTS media_migrations (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  folder TEXT NOT NULL,
  source_url TEXT NOT NULL,
  media_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','copied','dead','blocked','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  copied_at TEXT,
  UNIQUE (tenant, source_url)
);
CREATE INDEX IF NOT EXISTS idx_media_migration_status
  ON media_migrations(status, attempts, created_at);

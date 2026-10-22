-- Trigenys Storage media registry. Ids are immutable and tenant-owned.
CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY NOT NULL,
  tenant TEXT NOT NULL,
  folder TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','ready','deleted')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public','private')),
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_media_tenant_status ON media(tenant,status);
CREATE INDEX IF NOT EXISTS idx_media_created_at ON media(created_at);

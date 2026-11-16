-- End-user ownership for tenants authenticating users directly (e.g. Firebase ID tokens).
-- Additive and nullable: backend-authorized rows stay valid and their insert path does not use it.
ALTER TABLE media ADD COLUMN owner_subject TEXT;
CREATE INDEX IF NOT EXISTS idx_media_owner ON media(tenant,owner_subject,visibility,status);

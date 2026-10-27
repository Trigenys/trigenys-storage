# Historical Cloudinary backfill — controlled pilot

**Scope:** public product **images only**; not videos, troc customer uploads, private data or Cloudinary account deletions.

## Safety contract

1. Inventory source URLs from Xeption's own DB; enqueue only explicit approved, distinct Cloudinary URL entries into D1 media_migrations (no row rewrites). No automatic scanning or open proxy endpoint.
2. The scheduled Worker requires MIGRATION_ENABLED=true AND a tenant-specific MIGRATION_SOURCES_JSON allowlist. The host is exactly res.cloudinary.com, the cloud name and source folder prefix must match the config; reject query strings, redirects, encoded paths, credentials, arbitrary transformations and external domains.
3. Fetch a single stable derivative (f_webp,q_85,w_2048,c_limit), cap response and body at 8 MiB, check the WebP RIFF magic/length. This creates at most one new Cloudinary transformation per original candidate, potentially consuming some remaining credits.
4. Use a preassigned UUID and service-generated R2 key. D1 media_migrations has UNIQUE(tenant,source_url); retries do not allocate a second media ID. A copied file is checked again before a job can be marked copied.
5. Only publish D1 media as ready when R2 contains a valid object. Keep error codes but never save response bodies or credentials.
6. 404/410 source => dead; 403/401/429 => blocked, **stop that batch** (Cloudinary may have disabled the account). Never replace a DB URL for such an item.
7. Migration is paused by default. A temporary scheduled trigger runs at most FIVE jobs per execution and reads zero old images when queue is empty. Remove the cron and MIGRATION_ENABLED after backfill is complete.

## Launch checklist

- [ ] Review PR and green CI, then merge into main.
- [ ] Apply additive backend/migrations/0003_cloudinary_migration_queue.sql to existing storage D1. Run it twice to confirm no drift.
- [ ] Verify Cloudflare deployment, bindings and schema.
- [ ] Seed ONLY a small pilot (3 distinct product image URLs) with new UUIDv4 identifiers; stage source URL, folder=products, tenant=xeption, media_id. Deduplicate with D1 unique constraint.
- [ ] Configure MIGRATION_SOURCES_JSON as Worker secret: {"xeption":{"cloud":"dli0kdkg9","prefix":"xeption"}}.
- [ ] Enable MIGRATION_ENABLED (Worker secret = true) once the queue is inspected; protect or remove temporary schedule outside active migration windows.
- [ ] Inspect D1 statuses, confirm source bytes and R2 GET, confirm public media URL and image fidelity. **Do not use D1 media ready alone as sole proof of correct content.**
- [ ] Take a backup/manifest of every original row and URL BEFORE updating Supabase references. Use compare-and-swap updates: match product ID AND exact original URL, including array elements where present. Record source URL, destination URL, source record, column, timestamp and rollback SQL.
- [ ] Incrementally update a small subset of actual product rows ONLY after verification, inspect Xeption production image rendering, then continue measured batches.
- [ ] Keep legacy Cloudinary URLs and mediaOptimization.ts compatible throughout cutover.
- [ ] Monitor 403 quota denials and paid Cloudinary credits. Stop if there is a Cloudinary outage, input/output mismatch, high error rate, content changes, or R2 quota concern.

## Operational status query

    SELECT status,COUNT(*) AS jobs FROM media_migrations GROUP BY status ORDER BY status;
    SELECT source_url,media_id FROM media_migrations WHERE status='copied' ORDER BY copied_at LIMIT 5;

The public serving URL is computed only from approved storage origin + /v1/media/{tenant}/{media_id}. Do not publish job source URL logs.

## RAIDER decisions

- **Adopt:** existing D1, R2, Worker, project automation and immutable public-media API.
- **Adapt:** a private D1-controlled queue and bounded scheduled handler, rather than importing through a browser or inventing client-side privileged routes.
- **Idempotent:** UUID per source, uniqueness, retry/no-op validation.
- **Durable and retroactive:** source URLs remain unchanged until verified compare-and-swap; rollback from a versioned manifest.
- **Engineering-grade:** strict URL allowlist, bytes/type/size/timeout checks, per-batch limits, resumable states and error codes.
- **Scoped execution:** only backend tests run for migration source.

# Storage Worker v1 — integration contract

This is the **Cloudflare Worker application**. The generated Node HTTP skeleton at the repo root is an AppFactory bootstrap and is not the storage runtime.

## Infrastructure

- Worker: \`trigenys-storage-api\` (provision through the repository's canonical \`.github/workflows/appfactory-infrastructure.yml\`, using AppFactory OIDC)
- R2: private bucket \`trigenys-storage-media\`, binding \`MEDIA_BUCKET\`
- D1: database \`trigenys-storage-registry\`, binding \`DB\`
- D1 migrations: \`migrations/0001_media_registry.sql\`, \`migrations/0002_media_variants.sql\` (apply in order before deploying the Worker)
- Both D1 and R2 must remain private; **never** attach an R2 public domain.
- Deployments must preserve existing Worker secrets (\`wrangler --keep-vars\`). Missing secrets cause authorization to fail closed.

## Server-only secrets

\`TOKEN_SIGNING_SECRET\` — random 32+ character Worker secret, never copied to browser or source control.

\`TENANT_CONFIG_JSON\` — one Worker secret containing a JSON map with per-tenant **server-only** \`secret\` (32+ characters), optionally \`maxBytes\` and \`allowedOrigins\`. Example *shape*, not a usable credential:

\`\`\`json
{
  "xeption": {
    "secret": "<random value installed both in Worker secret and Xeption's Supabase Edge secrets>",
    "maxBytes": 8388608
  }
}
\`\`\`

Important: the secret is **not** a public application key. Xeption's Supabase Edge Function authenticates to the Worker using its own tenant secret. Adding a tenant requires deliberately rotating/updating the Worker secret and the tenant's trusted backend, not a source-code fork. No secret can be obtained back from this repository.

## API flow

1. The **authenticated Xeption user** asks its **Supabase Edge Function** to authorize a prospective image. Xeption validates user identity, product ownership and authorization; the browser never receives \`X-Tenant-Secret\`.
2. Xeption's Edge Function calls \`POST /v1/uploads/authorize\` over HTTPS, with \`X-Tenant-Secret\`, and a JSON body such as
   \`\`\`json
   {"tenant":"xeption","folder":"products","contentType":"image/webp","maxBytes":4000000}
   \`\`\`
   \`maxBytes\` is the exact maximum accepted for this upload, bounded by the tenant's allowance (8 MiB global cap).
3. The Worker issues \`mediaId\`, \`uploadUrl\`, \`mediaUrl\`, \`token\` and an expiry (3 minutes).
4. The Edge Function returns only the short-lived signed token/paths to the authenticated browser.
5. The browser converts the original image to WebP and calls \`PUT /v1/uploads/xeption/{mediaId}\`, with \`Authorization: Bearer {token}\`, \`Content-Type: image/webp\` and binary content.
6. The Worker validates the token's HMAC, tenant, ID, scope, expiry, WebP container signature and byte size; it claims the D1 ID, writes the private R2 object, and marks the D1 record \`ready\`. Replaying the token after a completed upload returns \`409 TOKEN_ALREADY_USED\`; ask the Edge Function for a fresh intent.
7. Public media is available at \`GET /v1/media/xeption/{mediaId}\` only if D1 says the object is ready and public. Cache can safely be immutable because IDs and object keys are never overwritten.

Error envelope: \`{"error":"MACHINE_READABLE_CODE"}\`, with 4xx for rejected client input/credentials and 503 for storage failures. Requesting the media endpoint returns relative URLs; convert them to absolute URLs using the **configured public Worker origin** at the trusted app boundary.

**Note:** the present v1 supports public WebP images only. Private media, video, signed reads, domain allowlists, quota enforcement, tenant self-service and legacy migration are not implemented. Do not represent them as released.

## Existing Xeption media

Keep \`mediaOptimization.ts\` and all Cloudinary URLs untouched during coexistence. New uploads should switch only after the whole token → upload → read flow is proven. Inventory and backfill old assets separately. No destructive changes to Cloudinary.

## Security and RAIDER

- The API does not authenticate end users; **Xeption's trusted backend must check end-user permissions before issuing an upload intent**.
- The Worker authenticates the tenant secret and issues an HMAC token; token generation is never exposed directly to the browser without Xeption's backend.
- Browser upload is single-purpose and has no permission to select arbitrary R2 keys.
- Cross-tenant public access is intentionally possible for **public** media URLs, but a media ID cannot be used with a different tenant segment.
- Rate limiting, per-tenant quota enforcement and automated orphan reconciliation are follow-up hardening tasks before general availability.
- Use project RAIDER acceptance checklist, scoped CI, a reviewed migration and a Cloudflare health + signed-upload smoke test before enabling Xeption traffic.

## Local checks

\`\`\`bash
cd backend
npm install
npm run check
npx wrangler deploy --config wrangler.production.jsonc --dry-run
\`\`\`

## Cloudflare Workers Cache (edge-fronting, not Cache API)

Public `GET /v1/media/{tenant}/{id}` responses use `Cache-Control: public, max-age=31536000, immutable`. The production Wrangler configuration enables `cache.enabled=true`, which enables **Workers Cache** in front of the Worker on `workers.dev` as well as custom domains. On a `HIT`, the Worker does not run and neither R2 nor D1 is queried. On a `MISS`, it runs and the image is cached. The cache is tiered and tied to Worker version by default; we deliberately do **not** enable cross-version caching. The cache key includes path and query, so new clients must not append arbitrary cache-busting parameters.

The service adds `Cache-Tag` values `trigenys-storage`, `tenant-{tenant}` and `media-{tenant}-{id}` to support scoped invalidation before future deletion or privacy changes. A future delete endpoint **must purge the Worker cache first** (and consider browser caches, which may retain public immutable copies). Any media that may need revocation must never be served as immutable public content.

Security: /health, authorization errors, missing media and all JSON API responses explicitly use `Cache-Control: no-store`; POST/PUT cannot be cached by Workers Cache. Never return private or authenticated images with public cache headers. Do not use `caches.default` here: it only reduces backend reads, not Worker invocations, and is region-local rather than tiered.

Smoke test **with a real public uploaded image URL** from two separate uncached HTTP clients: request it twice (avoid request `Authorization` headers), inspect `Cf-Cache-Status` for `MISS` then `HIT`, and confirm no stale/private content is served. `HEAD` can populate the cache, but a successful GET on a fresh media URL is the stronger end-to-end test. Treat no header / `BYPASS` as unverified; note that first requests to different versions or cache keys may be `MISS`.

Cloudflare documentation: https://developers.cloudflare.com/workers/cache/ ; requires Wrangler >=4.69.0. Cache hits also reduce paid Worker invocations; this is different from the low-level Cache API.

## Resized variants (`w320`, `w800`)

The Worker never resizes. After uploading the original, the client may upload smaller WebP renditions with the **same token** (within its lifetime):
`PUT /v1/uploads/{tenant}/{id}/w320` and `/w800`. Each rendition is accepted once (409 afterwards, or before the original is ready).
`GET /v1/media/{tenant}/{id}/w320` serves the rendition immutably; when it does not exist (older media, failed upload, unmigrated registry) it serves the original with `max-age=300`, so variant URLs are always safe to emit.


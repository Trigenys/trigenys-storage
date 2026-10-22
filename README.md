# Trigenys Storage

Reusable multi-tenant media storage for Trigenys applications. **Xeption is the first intended tenant; the service must be reusable by future apps without forks.**

> **State:** AppFactory created the public `typescript-api` service repository. Its generated Node/TypeScript bootstrap is in place; the R2 bucket, D1 media registry, Cloudflare Worker, upload/delivery endpoints and Xeption integration are **planned, not deployed**.

## Architecture target

- **Worker:** `trigenys-storage-api` for upload validation and public media delivery.
- **R2:** private `trigenys-storage-media` bucket; server-generated `tenants/{tenant}/{folder}/{uuid}.webp` keys.
- **D1:** tenant-owned metadata and opaque media IDs; no client-controlled object key.
- **Upload:** Xeption Supabase Edge Function signs a brief upload intent; browser converts eligible images to WebP and uploads directly; Worker validates signature, replay, content and size.
- **Read:** versioned public `GET /v1/media/{tenant}/{id}` for media explicitly marked public, with appropriate caching; R2 remains private.
- **Compatibility:** keep existing Cloudinary URLs working during adoption. Migrate historical assets separately with tested fallback/rollback.

These are design targets, not proof of provisioning. See [RAIDER adoption](docs/engineering/raider-adoption.md).

## Project management & quality

- **AppFactory Project Automation:** [delivery runbook](docs/engineering/project-automation.md); canonical config at `.github/project-config.json`; synchronization is triggered by Issue/PR events.
- **Board:** Trigenys Storage Development, phases Foundation → API Contract → Integrations → Hardening → Production.
- **RAIDER upstream:** [EagleFox31/project-registry](https://github.com/EagleFox31/project-registry/blob/main/RAIDER.md). Apply Reusable, Agnostic, Idempotent, Durable/Non-regressive, Engineering-grade, Retroactive and its failure-memory/change-scoped-CI rules.
- **Engineering agent contract:** [AGENTS.md](AGENTS.md); [lessons learned](docs/engineering/lessons-learned.md).
- **Roadmap:** [GitHub Issues](https://github.com/Trigenys/trigenys-storage/issues).

## Current scaffold

- Node.js 24, TypeScript, native HTTP server, Node test runner.
- `GET /health` is currently the **only** implemented endpoint.
- AppFactory Project Automation and reusable release workflow are preconfigured; no `PROJECT_TOKEN` repo secret is required.
- Cloudflare hosting, persistence and product-specific runtime secrets are not provisioned by the generic preset.

```bash
npm install
npm run dev
npm run check
npm run build
node dist/src/index.js
```

Do not confuse the generated Node server with a production Cloudflare Worker. Changes to resource ownership, migrations, tenant security and the production cutover must follow review + the RAIDER proof-of-done checklist.

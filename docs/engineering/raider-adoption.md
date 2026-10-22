# RAIDER adoption — Trigenys Storage

**Canonical standard:** [EagleFox31/project-registry/RAIDER.md](https://github.com/EagleFox31/project-registry/blob/main/RAIDER.md). This document applies the upstream standard to Trigenys Storage; it does **not** fork or redefine RAIDER.

**Status:** Engineering policy and target architecture; this document does not imply that R2, D1, a Worker, or any media endpoint has been deployed.

## System boundary

A shared media service for independently configured Trigenys applications (initial tenant: `xeption`). The bucket is private, tenant credentials remain server-side, and media keys are service-generated. Clients must not select R2 keys, read other tenants' metadata, or write existing objects by guessing identifiers.

Proposed target:

- Cloudflare Worker `trigenys-storage-api` serving a versioned media contract.
- Private R2 bucket `trigenys-storage-media` for binaries; no public bucket endpoint.
- D1 registry for opaque media IDs, tenant ownership, object key, MIME type, byte size, checksum, created timestamp, lifecycle/deletion status.
- Browser uploads authorized by a short-lived, tenant-scoped token issued through the consuming app's trusted backend; no tenant secret in the browser.
- Public read only for explicitly public media, e.g. product photos; private objects must never become publicly readable by default.
- Optional dedicated domain `media.trigenys.com` subject to DNS, routing and cache review.
- Existing Cloudinary URLs stay usable during coexistence; migration must be separately reviewed and reversible.

## RAIDER acceptance rules

| Principle | Storage-specific proof |
| --- | --- |
| **R — Reusable** | Tenant onboarding is declarative; no `if (tenant === "xeption")` branches or copied upload APIs. |
| **A — Agnostic** | Domain logic uses storage/metadata ports; Cloudflare R2 and D1 remain adapters. Cloudflare resource IDs and origins come from deployment bindings/config, never from source assumptions. |
| **I — Idempotent** | Provisioning inspects/reuses owned resources; retries do not duplicate media records or issue collisions. Rerun/no-drift tests required. |
| **D — Durable** | Public media IDs and versioned API contracts are stable. Legacy Cloudinary URLs and existing Xeption flows remain functional throughout staged rollout. Failure memory is kept in `docs/engineering/lessons-learned.md`. |
| **E — Engineering-grade** | Default-deny authorization, bounded upload tokens, magic-byte validation, size limits, rate limits, observability without secrets, unit/integration/contract tests, and scoped CI gates. |
| **R — Retroactive** | Existing clients can opt in without destructive reset; rollback switches future uploads back while already issued URLs remain accounted for. |

## Required change workflow

1. **Reuse-first reconnaissance:** search upstream RAIDER, AppFactory Project Automation, relevant Cloudflare SDKs, R2/D1 patterns and security practices; record Adopt/Adapt/Learn/Build in design issues or ADRs before nontrivial code.
2. **Contract-first:** define request/response/error schemas, tenant boundaries, token claims, object visibility, media lifecycle and limits before implementing adapters.
3. **Plan → review → apply** for infrastructure creation, migrations, production secrets and changes to public routing; never claim provisioned resources without provider evidence.
4. **Least privilege:** per-tenant server-only credentials; upload credentials narrowly scoped to tenant, object intent, expiry and a one-time nonce or equivalent replay protection. Do not log credentials or tokens.
5. **Change-scoped execution:** run only relevant checks. Source/contract/security changes must run tests; docs-only changes must not trigger production deploys or releases. Shared configuration changes fan out to dependents.
6. **Failure memory:** after incidents or significant near misses, capture impact, root cause, prevention and a reproducible guardrail in `docs/engineering/lessons-learned.md`.
7. **Retroactive safety:** test a new tenant and an existing Cloudinary-backed client, repeat provisioning to prove no-op convergence, and verify a rollback before cutting over.

## Definition of Done (every material PR)

- [ ] Links a scoped GitHub Issue managed through AppFactory Project Automation.
- [ ] States the RAIDER implications, known exceptions, and Adopt/Adapt/Learn/Build rationale.
- [ ] Adds or updates tests for tenant isolation, unauthorized access, replay, limits, error contracts and regression as applicable.
- [ ] Has evidence for happy path, failed path, retry/no-op and brownfield compatibility as applicable.
- [ ] Updates affected API docs, operational runbooks and any needed migration/rollback instructions.
- [ ] Meets change-scoped CI gates; no unrelated deploy or release.
- [ ] Records meaningful failure/near miss with prevention; otherwise confirms memory was reviewed.
- [ ] Obtains human review before destructive, production or paid infrastructure operations.

## Sources of truth

- RAIDER specification: <https://github.com/EagleFox31/project-registry/blob/main/RAIDER.md>
- Trigenys engineering skills (reference, not an auto-installed dependency): <https://github.com/Trigenys/trigenys-engineering-os>
- Project automation engine: <https://github.com/EagleFox31/appfactory-project-automation>
- Project configuration: `.github/project-config.json`
- Agent instructions: `AGENTS.md`

## Linked work

Closes #<!-- issue number; remove Closes if this PR does not fully resolve the Issue -->

Project phase: <!-- Foundation / API Contract / Integrations / Hardening / Production -->

## What changed and why

<!-- Keep this short. Explain the actual affected surface and relevant consumer contracts. -->

## RAIDER checks

Upstream: https://github.com/EagleFox31/project-registry/blob/main/RAIDER.md
Storage rules: https://github.com/Trigenys/trigenys-storage/blob/main/docs/engineering/raider-adoption.md

- [ ] **R — Reusable:** multi-tenant and configuration-driven, no Xeption-specific fork.
- [ ] **A — Agnostic:** no hard-coded resource identifiers; domain and adapters are separate.
- [ ] **I — Idempotent:** repeat/retry/no-drift behavior demonstrated when applicable.
- [ ] **D — Durable:** existing contracts, Cloudinary URLs and backward compatibility preserved or migrated intentionally.
- [ ] **E — Engineering-grade:** auth, least privilege, error cases, security, tests, and cost/observability as applicable.
- [ ] **E — Scoped execution:** relevant CI passed; no unrelated build/deployment/release triggered.
- [ ] **R — Retroactive:** existing tenant/client path and rollback considered.
- [ ] Reviewed `docs/engineering/lessons-learned.md` and recorded new failure/near miss with a guardrail if relevant.

## Reuse-first decision

<!-- Adopt / Adapt / Learn / Build; alternatives considered; links to relevant OSS/docs/ADR. -->

## Evidence

<!-- Tests run and results; API/contract testing; unauthorized tenant, expired/replayed intent, limits as applicable. -->

## Deployment / migration / rollback

<!-- Not applicable if no production impact. Destructive, production and paid resource changes require human approval. -->

## Exceptions

<!-- Explicitly list justified RAIDER exceptions, or "None". -->

# Agent instructions

This repository follows the **canonical Trigenys RAIDER Engineering Standard** from [EagleFox31/project-registry/RAIDER.md](https://github.com/EagleFox31/project-registry/blob/main/RAIDER.md). Do not fork, reinterpret or silently weaken it.

Read before substantial changes:
1. [Storage-specific RAIDER acceptance gates](docs/engineering/raider-adoption.md)
2. [AppFactory Project Automation delivery rules](docs/engineering/project-automation.md)
3. [Failure memory](docs/engineering/lessons-learned.md)
4. [Architecture](docs/architecture.md)

## Execution contract

- **Reuse first:** inspect relevant tools, existing infrastructure, consumer contracts and the upstream ecosystem. State Adopt / Adapt / Learn / Build reasoning.
- **Reusable + agnostic:** no Xeption-specific forks or hard-coded GitHub owner, Cloudflare ID, branch or tenant; keep transport, domain, R2, D1 and token/signing adapters separate.
- **Idempotent:** inspect → compare → reconcile. Repeated provisioning, retries and duplicate events must not produce duplicated media, Projects or infrastructure.
- **Durable + retroactive:** keep preexisting Cloudinary links functional during rollout; preserve unrelated resources and provide rollback rather than destructive migration.
- **Engineering-grade:** least privilege, explicit versioned contracts, adversarial tenant isolation tests, bounded signed upload intents and error handling that does not leak credentials.
- **Scoped CI:** apply proportionate test/build/deploy/release gates by impact. An Issue or documentation-only change must not trigger a production deployment.
- **Failure memory:** before risky changes, inspect `docs/engineering/lessons-learned.md`. Record incidents/meaningful near misses with cause and prevention.

## Collaboration & delivery

Track each material piece of work in a GitHub Issue linked to **Trigenys Storage Development** via the preinstalled AppFactory Project Automation workflow. Use `.github/project-config.json` and embedded `appfactory-project` Issue metadata; do not duplicate the engine or introduce a per-repository `PROJECT_TOKEN`.

A PR should reference its Issue and substantiate RAIDER acceptance criteria, tests, compatibility, rollback, and any exceptions. Human review is required for production, destructive and paid resource mutations. The repository remains an unprovisioned generic API scaffold until Cloudflare resources and the actual Worker application are implemented and verified.

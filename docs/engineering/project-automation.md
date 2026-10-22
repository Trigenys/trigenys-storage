# Delivery via AppFactory Project Automation

**Project:** `Trigenys Storage Development` (GitHub organization: `Trigenys`).

The generated `.github/workflows/project-automation.yml` invokes the existing reusable AppFactory workflow through the short-lived GitHub Actions OIDC broker. **Do not** create a repository `PROJECT_TOKEN`, duplicate the broker, or copy the Project engine here.

## Project policy

- **Phases:** `Foundation`, `API Contract`, `Integrations`, `Hardening`, `Production`.
- **Status:** `Backlog → Ready → In Progress → Review → Validation → Done` (owned by the shared template).
- **Priorities:** `P0`–`P3`; **work type:** `Product`, `Feature`, `Engineering`, `UX`, `Security`, `Quality`, `Documentation`, `Bug`; **size:** `XS`–`XL`.
- Authoritative Project schema is `.github/project-config.json`; the external Action owns reconciliation and lifecycle.

Create a focused Issue for each deliverable. Include this **optional embedded metadata** for deterministic field mapping:

```html
<!-- appfactory-project
priority: P1
workType: Engineering
phase: Foundation
size: M
-->
```

Use `Closes #<number>` in a PR only when it actually closes the linked Issue. For significant changes, link the RAIDER adoption document and state tests, rollback, and risks.

## Bootstrapping & verification

1. GitHub **Actions → Project automation → Run workflow**, leave `issue_number` empty to create/reconcile the board and import open Issues.
2. Issue opened/reopened/edited/closed triggers synchronization; PR events move linked work through review/done where applicable.
3. Use manual `issue_number` resync only for an affected Issue. Reruns must converge rather than duplicate a board or item.
4. Verify a successful Project automation run **and** the actual Project link; workflow presence alone is not proof of a provisioned board.
5. If broker OAuth authorization is missing, authorize the project owner at <https://appfactory-project-token-broker.lawrynnjennifer.workers.dev/authorize>; no per-repo PAT or secret is needed.

## Change isolation

- Project board updates must not deploy the storage Worker.
- Production release remains manual until an approved deployment contract and release gates exist.
- Cloudflare provisioning and migrations must not run as side effects of Issue changes.
- Track infrastructure and application releases independently from Project state synchronization.

See [RAIDER adoption](./raider-adoption.md), the canonical [Project Registry RAIDER](https://github.com/EagleFox31/project-registry/blob/main/RAIDER.md), and the shared [AppFactory Project Automation](https://github.com/EagleFox31/appfactory-project-automation).

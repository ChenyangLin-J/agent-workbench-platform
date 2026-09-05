# Agent Workbench Platform Documentation

This is the durable documentation entry for the shared package. Read only the route needed for the current task.

| Task | Read | Purpose |
| --- | --- | --- |
| Start a new Workbench or decide whether it needs a repository | [`operations/START_A_WORKBENCH.md`](operations/START_A_WORKBENCH.md) | Environment-first decision, minimum owned assets, and consumer upgrade boundary |
| Understand ownership or decide where a change belongs | [`architecture.md`](architecture.md) | Stable Platform/consumer boundary and host contracts |
| Build the runnable minimal host or isolated environments | [`specs/runnable-minimal-host.md`](specs/runnable-minimal-host.md) | Active CLI, manifest, isolation, and adoption design |
| Design Session files, attachments, artifacts, storage, or cleanup | [`specs/session-resources-and-storage.md`](specs/session-resources-and-storage.md) | Active resource model, lifecycle, Host adapter, retention, and migration design |
| Create, inspect, run, or stop a local Environment | [`operations/ENVIRONMENTS.md`](operations/ENVIRONMENTS.md) | Profile examples, lifecycle commands, provider guarantees, and verification |
| Continue the Agent Terminal shared-UI migration | [`specs/agent-terminal-migration.md`](specs/agent-terminal-migration.md) | Active scope, order, acceptance, and deletion gate |
| Converge Minimal Host and full-consumer Session behavior | [`specs/consumer-host-convergence.md`](specs/consumer-host-convergence.md), [`mockups/consumer-host-convergence.html`](mockups/consumer-host-convergence.html) | Active headless Host Kit slices, reviewable UI reference, adoption gates, and extension boundary |
| Change a version, publish a tag, or upgrade a consumer | [`operations/RELEASING.md`](operations/RELEASING.md) | Release, canary, evidence, and rollback workflow |
| Use or install the package | [`../README.md`](../README.md) | Public entry points and development commands |
| Verify implementation behavior | [`../test/`](../test/) | Executable contract truth |

## Lifecycle

- `architecture.md` describes current stable contracts. It does not track consumer pins, temporary migration progress, or release history.
- `specs/` contains only active migrations and unresolved designs. Once a spec is implemented, cancelled, or absorbed, remove it from the active index and archive it only when its history is still useful.
- `operations/` contains repeatable workflows, not one release's transcript. Git tags and GitHub Releases are the package release record; consumer repositories keep their own adoption evidence.
- `README.md` stays a concise public entry. Detailed product behavior belongs to the owning consumer, not this repository.

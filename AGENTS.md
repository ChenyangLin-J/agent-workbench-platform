# Agent Workbench Platform Rules

## Scope

- This repository is the product-neutral `@agent-workbench/platform` package. Product navigation, projects, tasks, memories, credential values, accounts, profiles, deployment policy, persistent data, and host authorization belong in consumer repositories.
- Current consumer shapes are Personal Workbench, the independent minimal Data Skill Lab, Agent Terminal Web, and DataMama's constrained Agent host. Solvely Workbench is a frozen reference. Data Skill Lab lives in its own repository and its contracts must remain project-free; DataMama owns Superset, identity, data policy, product extensions and deployment.
- Consumers must supply their own App Server connection, stores, data directory, browser profile, capability Profile, product context, side-effect handlers, and authorization decisions.

## Before changing code

1. Run `git status --short` and preserve existing work.
2. Read `docs/README.md`, then the task-specific document it routes to.
3. Check the impact on public exports, Runtime/Feature contracts, shared UI, host adapters, persisted envelopes, capability schema/lock, credential and path safety, semantic compatibility, and affected consumers.
4. Do not modify a consumer repository unless the task explicitly includes that consumer.

## Contract boundaries

- Runtime and Feature contracts must not depend on DOM or product objects.
- Shared UI receives product context and side effects through props, actions, adapters, stores, or extension slots; it must not read a consumer database or local product state.
- Platform may define process lifecycle primitives, but discovery and planning stay side-effect free. Browser discovery must not start a process; stateful Browser calls remain serialized, Provider instances return to zero when idle, and teardown stays bounded.
- Manifests, public plans, locks, health results, logs, fixtures, and docs must not contain credential values. Platform passes credential references only.
- Preserve both project-free and project-scoped behavior. A project model can never be required to create or run a Session.

## Verification and release

- Runtime, Feature, UI, Browser, Capability, schema, or public export changes require `npm test` and the relevant project-free/project-scoped regression fixtures.
- A package-bearing change under `src/`, `scripts/`, `package.json`, or `package-lock.json` must use a new package version before merge. The merged commit is an immutable consumer candidate but is not automatically a stable release. Promote an accepted candidate explicitly; do not reuse or move an existing tag.
- Automated Platform tests and consumer acceptance are separate. Shared interaction changes require the mounted consumers selected by the impact gate; Personal owns its Host-adapter acceptance, DataMama owns constrained Minimal Host acceptance, Data Skill Lab owns project-free isolation/Profile validation, and Agent Terminal owns its migration regression before duplicate implementation is removed.
- Read `docs/operations/RELEASING.md` before changing a release version, asking a consumer to test a candidate ref, or promoting a stable tag.

## Documentation

- `README.md` is the public package entry, `docs/architecture.md` is the stable current contract, `docs/specs/` contains only active migrations or unresolved designs, and `docs/operations/` contains repeatable workflows.
- Keep consumer versions and migration progress out of stable architecture. Put them in the active spec or the consumer's own evidence.
- Update current documents directly; do not create V2, final, or latest variants.
- Add every durable document to `docs/README.md`. Archive or remove a spec when its decisions are fully implemented; do not leave completed work looking active.

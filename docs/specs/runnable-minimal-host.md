# Runnable Minimal Host and Isolated Environments

Lifecycle: active implementation and adoption spec. The project-free Host and offline strong-isolation milestone are implemented on `feature/runnable-minimal-host`; Data Skill Lab adoption and enforcing broker work remain open. This spec does not define a Data Skill evaluation product.

## Objective

Allow `@agent-workbench/platform` to run a minimal, project-free Workbench directly. A consumer should be able to create an isolated environment from a declarative Profile, start the built-in Session host, inspect its effective contract, and stop or resume it without copying Personal Workbench.

The same mechanism should support a simple local Workbench, a constrained Data Skill Lab, and future lightweight hosts. Domain behavior remains optional and consumer-owned.

## Terms

| Term | Meaning |
| --- | --- |
| Minimal Host | Platform-provided HTTP/streaming host and Session UI with no project, task, memory, evaluation, or domain model |
| Environment | A named instance with its own effective Profile, Runtime, state paths, capability lock, isolation provider and lifecycle |
| Run | One immutable environment configuration plus mutable Session/output state created under it |
| Session | A Runtime conversation inside a Run; it does not require a project |
| Consumer Profile | Consumer-owned declaration of capabilities, feature visibility, isolation requirements and host adapters |
| Evaluator | Optional external component that compares outputs or reads Gold; it is not part of the Minimal Host contract |

## Product boundary

Platform provides:

- a built-in project-free Session host and minimal page shell;
- Runtime/App Server lifecycle primitives and instance-scoped stores;
- environment manifest resolution, validation and inspection;
- Profile/Capability lock resolution;
- isolation-provider contracts and honest effective-isolation reporting;
- explicit extension points for a consumer's routes, panels, tools and evidence exporters.

Consumers provide:

- domain capabilities, MCP endpoints, CLI bindings and credential references;
- product navigation, vocabulary, retention and deployment policy;
- optional evaluation cases, policies, Gold, scoring and reports;
- authorization for external actions and access to domain data.

The Minimal Host must not require or create `policies/`, `evaluations/`, `gold/`, project registries, task stores or business context. A consumer may keep any optional assets in its own layout or in an entirely separate evaluator system.

## Commands

```text
agent-workbench env create --profile <profile>
agent-workbench env run <environment-or-run>
agent-workbench env inspect <environment-or-run>
agent-workbench env stop <environment-or-run>
```

`env create` creates instance data, not a new source repository. A future app scaffold, if justified by repeated consumer setup, is a separate concern for products that need custom code.

## Current milestone

Implemented in Platform:

- strict Profile normalization, stable hashing and secret-value rejection;
- atomic Environment/Run creation, contained paths, symlink escape checks and retained project-free Session state;
- `env create`, `run`, `inspect` and `stop` plus the built-in Session UI and Codex Runtime lifecycle;
- effective isolation derived from nine enforcement facets rather than provider self-report;
- a real Docker ephemeral provider for offline, empty-capability Profiles, including exact owned-resource cleanup and a repeatable Docker smoke test;
- an explicit non-isolated development provider for trusted local work.

Deliberately blocked rather than downgraded:

- short-lived Codex or domain credentials;
- allowlisted model/data network access;
- non-empty Capability snapshot staging;
- read/write external effects and domain data adapters.

Those four boundaries need enforcing brokers before Data Skill Lab can use the strong provider for a real Candidate/Baseline run. Platform automated tests and the offline Docker smoke are complete; independent consumer canary and manual browser acceptance remain release gates.

## Environment manifest

The resolved manifest records only reproducibility and enforcement facts:

- schema, Platform and Runtime versions;
- source Profile identity and hash;
- Runtime, state, workspace and temporary paths;
- feature configuration and resolved Capability lock;
- isolation provider, requested level and effective enforcement;
- allowed filesystem roots, environment keys, network targets and credential references;
- process identifiers, ports and lifecycle timestamps;
- optional consumer extension metadata.

The manifest must not contain credential values, inherited secret variables, Gold, expected answers, or another Run's state. Consumer extensions are namespaced and cannot weaken the resolved isolation policy silently.

## Isolation contract

Platform distinguishes three levels and reports the effective level in `inspect`:

| Level | Enforcement | Allowed use |
| --- | --- | --- |
| Development | Separate paths and Profile plus instruction-level boundaries | Trusted local development only; must not be described as isolated |
| Guarded host | OS-enforced filesystem/process boundary, environment allowlist, constrained credentials and network/tool guards | Trusted internal capabilities when the host guard is supported and verified |
| Ephemeral machine | Disposable container or VM identity, filesystem and network with short-lived credentials | Untrusted capabilities or evaluations requiring strong blindness |

A Profile may require a minimum level. Startup fails rather than silently downgrading when the selected provider cannot satisfy it.

Every isolated provider must cover:

1. **Runtime and state**: unique Runtime home, Session/state database, ports, process ownership and temporary paths; no host or sibling Session discovery.
2. **Filesystem**: explicit readable and writable roots, realpath/symlink enforcement, run-to-run denial and controlled cleanup.
3. **Environment**: construct from an allowlist; do not spread the parent environment. Use isolated `HOME`, `PATH` and temporary directories.
4. **Capabilities and execution**: load only the resolved Skill/MCP/CLI lock; enforce tool and command restrictions outside prompt text.
5. **Credentials and network**: inject references or short-lived least-privilege material at startup, restrict destinations/actions, redact output, and remove material on stop.
6. **External effects**: require the Profile to declare allowed read/write classes; a manifest statement such as `readOnly` is not enforcement by itself.
7. **Cross-run contamination**: prevent access to previous Runs, alternative Skills, expected answers and evaluator-only assets.

An environment can remain useful without being fully offline. Required model and data services are explicit controlled channels, not exceptions hidden inside inherited host access.

## Minimal Host surface

The first host includes only:

- environment identity and effective isolation summary;
- create/open/list the Run's Sessions;
- `SessionWorkspace` transcript, Composer, requests, interruption and supported attachments;
- Runtime health and explicit stop;
- optional host extensions declared by the Consumer Profile.

Projects, tasks, assets, memory, Side Chat, Subagents, Browser, Capability mutation and evidence dashboards are hidden unless the Profile explicitly enables an existing Platform feature or a consumer extension. The built-in host does not invent fallback domain objects to satisfy its UI.

## Data Skill Lab adoption

Data Skill Lab becomes a thin Consumer Profile of the runnable host:

- Candidate or Baseline selects the exact Skill snapshot and lock.
- OpenMetadata and query access are optional declared capabilities.
- The Run records Skill hash, model, Runtime, Platform, capability and data-access configuration.
- Gold and scoring remain outside the execution environment and may be owned by a separate Evaluator.
- Read-only data access must be enforced by credentials and adapters, not only developer instructions.

The current Personal implementation is an incubation source. Its environment builder, atomic Run creation, snapshot hashing and tests can be ported; its Personal server, project store, full page shell, `PAW_*` contract and inherited host environment are not the target architecture.

Existing Personal Lab Runs are not moved wholesale. Runtime homes and authentication copies remain quarantined until a separate retention decision; only explicitly sanitized manifests and evidence may be imported.

## Implementation order

1. Checkpoint active Platform and Personal work; do not extract from a changing worktree.
2. Define and test the manifest schema, isolation levels and provider interface in Platform.
3. Add the project-free Minimal Host and CLI using existing Runtime, UI and Capability primitives.
4. Prove that failed enforcement blocks startup; add a guarded-host provider only when a supported OS contract is concrete.
5. Implement the offline ephemeral container provider required as the strong-isolation base.
6. Add credential, egress, Capability staging and effect/data brokers without weakening effective-isolation reporting.
7. Port Data Skill Lab as a thin Profile and run Candidate/Baseline parity against the existing implementation.
8. After acceptance, remove Personal's Lab host integration while preserving the chosen historical evidence boundary.

Do not pre-emptively move Personal adapter code into Platform. Add a shared abstraction only when the Minimal Host implementation demonstrates the product-neutral contract and tests it without Personal fixtures.

## Acceptance

- A fresh environment starts and completes a Session without a project registry or Personal source checkout.
- `inspect` shows requested and effective isolation, versions, paths and locks without secret values.
- A Run cannot enumerate host/sibling Sessions, Skills, files or undeclared environment variables.
- Symlink and path traversal attempts cannot escape allowed roots.
- Disabled capabilities are unavailable at Runtime, not merely hidden in the UI.
- Startup fails when required filesystem, network, credential or command enforcement cannot be installed.
- Stopping removes transient credentials and child processes without deleting retained Session/evidence state.
- The same Minimal Host passes project-free Platform tests and at least one independently defined Consumer Profile.

## Open decisions

- Whether a guarded-host provider has enough value to support before the broker-backed Docker path.
- Short-lived Codex authentication and destination-bound egress broker contracts.
- Capability snapshot and domain data/effect adapter contracts.
- Default Run retention and the boundary between retained Session state and disposable credentials.
- Whether evidence export becomes a generic optional extension after a second consumer demonstrates the same contract.

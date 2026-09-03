# Runnable Minimal Host and Isolated Environments

Lifecycle: implemented contract with unresolved provider/retention decisions. The project-free Host, offline strong-isolation base, immutable Runtime-enforced Skill allowlist, immutable trusted read-only MCP packages, fixed Codex model broker, read-only adapter sidecars, Personal Data Skill Lab Candidate/Baseline parity, and legacy-host retirement are complete. This spec does not define a Data Skill evaluation product.

## Objective

Allow `@agent-workbench/platform` to run a minimal, project-free Workbench directly. A consumer should be able to create an isolated environment from a declarative Profile, start the built-in Session host, inspect its effective contract, and stop or resume it without copying Personal Workbench.

The same mechanism should support a simple local Workbench, a constrained Data Skill Lab, and future lightweight hosts. Domain behavior remains optional and consumer-owned.

## Terms

| Term | Meaning |
| --- | --- |
| Minimal Host | Platform-provided HTTP/streaming host and Session UI with no project, task, memory, evaluation, or domain model |
| Environment | A named instance with its own effective Profile, Runtime, state paths, capability lock, isolation provider and lifecycle |
| Run | One execution revision of an immutable Environment configuration, with its own Runtime bindings, queue, processes and workspace |
| Session | A durable conversation that does not require a project and may remain readable across Runs |
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
agent-workbench env migrate-sessions <stopped-run> --bindings <private-bindings>
agent-workbench env inspect <environment-or-run>
agent-workbench env stop <environment-or-run>
```

`env create` creates instance data, not a new source repository. A future app scaffold, if justified by repeated consumer setup, is a separate concern for products that need custom code.

## Current milestone

Implemented in Platform:

- strict Profile normalization, stable hashing and secret-value rejection;
- atomic Environment/Run creation, contained paths, symlink escape checks and retained project-free Session state;
- optional consumer-owned Session transcript/Resource roots, separate Run-local Runtime bindings and queued Turns, and a source-retaining migration from one stopped Run;
- `env create`, `run`, `inspect` and `stop` plus the built-in Session UI and Codex Runtime lifecycle;
- effective isolation derived from nine enforcement facets rather than provider self-report;
- a real Docker ephemeral provider for offline Profiles and immutable `skill-source` snapshots, including exact owned-resource cleanup and a repeatable Docker smoke test;
- a fixed model egress sidecar that stages either an unexpired ChatGPT access token or one consumer-bound OpenAI-compatible gateway key, never exposes the upstream credential to the workload, and permits only Responses routes;
- an authenticated fixed-target host proxy relay for Docker hosts that require `HTTP(S)_PROXY`, without copying controller proxy credentials into the workload or manifest;
- Environment-time Skill snapshot staging, frontmatter-name capture, per-Run hash verification, a read-only workload mount and a fail-closed Codex Runtime allowlist that exposes no host source path;
- controller-only Environment Bindings plus isolated OpenMetadata and BigQuery sidecars that enforce fixed targets, exact read effects, tool/query allowlists and resource ceilings without exposing data credentials to the workload;
- a product-neutral `module-mcp-read` loader that snapshots a consumer-owned dependency-free ESM package, runs it in its own read-only sidecar, stages only its declared credentials, restricts its injected HTTP client to declared HTTPS targets and exposes only the exact startup-verified tool allowlist;
- an explicit non-isolated development provider for trusted local work.

Deliberately blocked rather than downgraded:

- Capability kinds other than `skill-source`, trusted `mcp-server` snapshots and the supported read-only adapter kinds;
- write effects, arbitrary data targets and undeclared adapter implementations.

Codex model access is enforceable either through the exact `credentials.codex-native` plus `https://chatgpt.com/backend-api/codex` pairing, or through a Profile-declared OpenAI-compatible Responses gateway whose key comes from a private consumer binding. Arbitrary workload egress, embedded Profile credentials and refresh-token transfer remain rejected. Local `skill-source` locks are enforceable through immutable snapshots plus Runtime inventory validation. Built-in adapters and reviewed consumer-owned `module-mcp-read` packages support read-only data-backed Runs; write effects and undeclared services still fail closed.

On 2026-08-31, an independently defined one-Skill Profile completed a real `gpt-5.6-sol` Session in the Docker `ephemeral-machine` provider and returned the immutable Skill marker `CORE_V080_CANARY_OK`. The canary also verified zero browser console errors/warnings, a 390 px viewport without horizontal overflow, exact stopped-resource cleanup, an empty transient-credential directory after stop, and a manifest containing no access, refresh, service-token or proxy values. This closed the project-free real-model and Minimal Host browser gates. Personal later ran released v0.9 Candidate and no-Skill Baseline Profiles with the same OpenMetadata/BigQuery prompt; both returned the same table and query result with exact cleanup. The former host-process implementation matched the neutral business result only by exposing `bq` to the Agent, and was removed after the comparison.

## Environment manifest

The resolved manifest records only reproducibility and enforcement facts:

- schema, Platform and Runtime versions;
- source Profile identity and hash;
- Runtime, Run-local state, managed-resource, optional portable Session state/resource, workspace and temporary paths;
- feature configuration, resolved Capability lock and content-addressed snapshot metadata;
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
7. **Cross-run contamination**: prevent access to previous Runtime bindings, workspaces, alternative Skills, expected answers and evaluator-only assets. An explicitly bound portable Session store is the only cross-Run data surface and remains subject to Host authorization.

An environment can remain useful without being fully offline. Required model and data services are explicit controlled channels, not exceptions hidden inside inherited host access.

## Minimal Host surface

The first host includes only:

- create/open/list authorized Sessions; by default these are Run-scoped, while a consumer-bound portable store can expose retained history from earlier Runs;
- `SessionWorkspace` transcript, Composer, requests, interruption and supported attachments;
- persistent queued Turns with delete/recovery, plus independent message Edit/Fork branches when the Profile flags and Runtime capabilities allow them;
- an optional read-only cross-owner Observer for operational diagnosis, disabled unless the Consumer Profile declares a trusted observer header;
- optional host extensions declared by the Consumer Profile.

Run identity, isolation evidence and lifecycle controls remain available through `env inspect` and `env stop`; they are operational concerns and are not shown in the default user-facing Session surface. The host automatically opens the newest available Session and renders only controls backed by an available action.

Live synchronization is part of this minimum surface, not an optional product feature. The Host sends event-stream heartbeats; the client reconnects with replay from the last observed event id and polls the authoritative Session while it is running or waiting. The transcript exposes persisted commentary and a collapsed technical-progress summary so a transient stream failure cannot leave the page permanently showing stale work.

The Observer lists Sessions across owners. Its default page shows one Turn timeline with persisted user/assistant messages, externally emitted commentary, and expandable structured execution steps. New Runtime items retain the available tool or command name, redacted input, result or error, and reported duration; older records remain readable but cannot recover fields that were never persisted. Fixed Run stdout/stderr tails are exposed only through a separate bounded diagnostic API. The Observer is read-only, enforces the normal Host token plus the configured observer header, removes known credentials and Run-root paths, and streams only change notifications before the client refetches the redacted projection. The observer contract does not expose hidden chain-of-thought or arbitrary files. A Consumer gateway owns administrator authorization and must strip any browser-supplied observer header before adding its trusted claim.

When `features.attachments` is enabled, the Minimal Host stages uploaded files through the Platform `ResourceStore` under the effective Session resource root. That is the current Run's private `resources` root by default or the consumer-bound portable root when configured. A Turn may reference only resources previously uploaded to that same Session; Runtime acceptance commits them as Session-durable resources and the persisted transcript contains normalized descriptors, not host paths. A rejected Turn leaves its staged resources recoverable for retry. The first accepted user message also replaces the default Session title while preserving titles explicitly supplied by a consumer.

Portable persistence deliberately does not make Runtime threads portable. `sessions.json` and managed Resources are durable facts; `session-runtime.json`, Runtime homes and queued Turns remain inside one Run. When a new Run reads a Session created by an earlier Run, list/detail remain available, Composer and mutation routes return `HOST_SESSION_CONTINUATION_REQUIRED`, and no Runtime thread is created. A future continue/fork action may explicitly rehydrate context, but a GET must never create a blank replacement thread.

`steer`, `queuedTurns`, `messageEdit`, and `messageFork` are independent Profile controls; disabling one removes its action without implying that the others are disabled. Projects, tasks, assets, memory, Side Chat, Subagents, Browser, Capability mutation and evidence dashboards are hidden unless the Profile explicitly enables an existing Platform feature or a consumer extension. The built-in host does not invent fallback domain objects to satisfy its UI.

## Data Skill Lab adoption

Data Skill Lab becomes a thin Consumer Profile of the runnable host:

- Candidate or Baseline selects the exact Skill snapshot and lock.
- OpenMetadata and query access are optional declared capabilities.
- The Run records Skill hash, model, Runtime, Platform, capability and data-access configuration.
- Gold and scoring remain outside the execution environment and may be owned by a separate Evaluator.
- Read-only data access must be enforced by credentials and adapters, not only developer instructions.

The current Personal implementation is an incubation source. Its environment builder, atomic Run creation, snapshot hashing and tests can be ported; its Personal server, project store, full page shell, `PAW_*` contract and inherited host environment are not the target architecture.

Historical Personal host-process Lab Runs are not moved or restarted. Their Runtime homes and authentication copies remain quarantined local evidence until a separate retention decision; only explicitly sanitized manifests and evidence may be imported.

### Read-only adapter contract

The first data-backed Profile supports two built-in read-only adapter kinds and one trusted consumer-module kind. It is not an arbitrary URL, command or MCP proxy facility.

- `openmetadata-mcp-read` owns the upstream bearer credential, fixed HTTPS target and explicit tool allowlist. It exposes a Run-local MCP endpoint, filters `tools/list`, and rejects every non-allowlisted `tools/call` before contacting the upstream server.
- `bigquery-read` owns Google ADC and exposes only `dry_run_query` and `run_query`. Every execution first performs a BigQuery dry-run, requires `statementType = SELECT`, checks all `referencedTables` against the Profile project allowlist, and applies fixed byte and row ceilings. The workload never receives `bq`, ADC or a general Google API channel.
- `module-mcp-read` loads one immutable `mcp-server` ESM snapshot into its own sidecar. The package must export `createMcpHandler`, have no staged `node_modules`, use the Platform-supplied target-restricted fetch function, and return exactly the tool catalog declared by the Profile. Platform handles only `initialize`, `ping`, `tools/list` and allowlisted `tools/call`; the consumer-reviewed module remains responsible for proving that each allowed tool is semantically read-only.

Each built-in adapter is a `read-only-adapter` lock entry; each module adapter is an `mcp-server` lock entry with a matching immutable source. Every adapter has one matching safe declaration under `capabilities.adapters`. The Profile must declare the exact credential references, fixed network targets and read-effect names required by those adapters; undeclared or surplus credentials, targets, write effects and adapter definitions fail closed.

Credential values are supplied separately through a controller-only Environment Bindings document. Bindings may point to an environment variable or a private regular file, but values and source paths never enter the Profile, Environment/Run manifest or workload. The Docker provider stages a private per-Run copy into the corresponding adapter secret mount, and stop removes it with all other transient credentials.

Each adapter runs in its own read-only, capability-dropped sidecar. The workload can reach only the Run-local MCP endpoint on the unique internal network. The adapter sidecar alone has an external network leg; when the host requires an HTTP proxy, it receives its own per-Run authenticated relay credential restricted to that adapter's fixed target hosts. Model and data adapters never share relay credentials.

## Implementation order

1. Checkpoint active Platform and Personal work; do not extract from a changing worktree.
2. Define and test the manifest schema, isolation levels and provider interface in Platform.
3. Add the project-free Minimal Host and CLI using existing Runtime, UI and Capability primitives.
4. Prove that failed enforcement blocks startup; add a guarded-host provider only when a supported OS contract is concrete.
5. Implement the offline ephemeral container provider required as the strong-isolation base.
6. Add the fixed short-lived Codex credential/egress broker without weakening effective-isolation reporting.
7. Add immutable `skill-source` snapshot staging without exposing controller paths to the workload.
8. Define and implement product-neutral read-only effect/data adapter contracts.
9. Port Data Skill Lab data access as a thin Profile and run Candidate/Baseline parity against the existing implementation.
10. After acceptance, remove Personal's Lab host integration while preserving the chosen historical evidence boundary.

Do not move Personal evaluation policy into Platform or reintroduce its removed host integration. New adapter kinds require a product-neutral enforcement contract, Platform-only fixtures, a real Docker boundary test, and an independent consumer canary.

## Acceptance

- A fresh environment starts and completes a Session without a project registry or Personal source checkout.
- `inspect` shows requested and effective isolation, versions, paths and locks without secret values.
- A Run cannot enumerate host/sibling Sessions, Skills, files or undeclared environment variables.
- Symlink and path traversal attempts cannot escape allowed roots.
- Disabled capabilities are unavailable at Runtime, not merely hidden in the UI.
- Startup fails when required filesystem, network, credential or command enforcement cannot be installed.
- Stopping removes transient credentials and child processes without deleting retained Session/evidence state.
- The same Minimal Host passes project-free Platform tests and at least one independently defined Consumer Profile.

The project-free and data-backed canaries satisfy these Host-level acceptance items. Personal's released-package Candidate/Baseline runs proved OpenMetadata search, BigQuery dry-run/execution, write-tool rejection, credential non-disclosure, result parity and exact cleanup. Domain answer quality remains consumer evaluation work, not a Platform isolation claim.

## Open decisions

- Whether a guarded-host provider has enough value to support before the broker-backed Docker path.
- Default Run retention and the boundary between retained Session state and disposable credentials.
- Whether evidence export becomes a generic optional extension after a second consumer demonstrates the same contract.

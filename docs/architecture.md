# Agent Workbench Platform Architecture

`@agent-workbench/platform` is a product-neutral package for composing independent Codex workbenches. It owns reusable Agent semantics and UI; every consumer remains a separate product with separate data, authorization, deployment, and product objects.

## Layers

```text
@agent-workbench/platform/runtime
  App Server connections, Session/Turn/request semantics, approvals, inputs

@agent-workbench/platform/features
  Side Chat, Subagent and other complete feature contracts

@agent-workbench/platform/ui
  SessionWorkspace, SessionBrowser and shared React feature panels

@agent-workbench/platform/plugins + capabilities
  product-neutral manifests, registry, dependency resolution, install plans and locks

@agent-workbench/platform/environment
  project-free Minimal Host, Environment/Run manifests, lifecycle and isolation providers

consumer host
  stores, adapters, product context, authorization, side effects, navigation and deployment
```

Runtime and Feature contracts do not depend on DOM. React is the current shared renderer, not the Runtime itself. A second package is justified only by a real consumer boundary, not by directory aesthetics.

## Consumer shapes

| Consumer | Shape | Product-owned concerns | What it proves about Platform |
| --- | --- | --- | --- |
| Personal Workbench | Long-lived, project-oriented full product | Projects, matters, formal state, local files, Personal capabilities and services | Shared features compose inside a complex product |
| Data Skill Lab | Independent minimal Workbench with one candidate Skill or a baseline | Run creation, Skill snapshot, constrained capability allowlist, evaluation evidence and isolated Runtime | A Session can run without a project model or Personal state |
| Agent Terminal Web | Terminal-oriented, mobile-first, multi-host product | PTY, Terminal navigation, memory, hosts, accounts and sharing | Shared Session UI composes inside a different interaction shell |
| Superset Side Agent | Future lightweight embedded host | Dashboard, chart, filters and Superset authorization context | Feature profiles can expose a deliberately smaller surface |

Solvely Workbench is a frozen compatibility reference, not an active migration target.

Data Skill Lab currently incubates inside the Personal repository and still launches Personal host code. That source location is temporary implementation debt, not product ownership. Platform contracts used by the Lab must remain project-free; extracting its minimal host is a separate consumer task and does not move evaluation policy into Platform.

## Ownership

| Platform owns | Consumer owns |
| --- | --- |
| Session, Turn, request, queue, interrupt and replay semantics | Product navigation, objects, labels and status |
| Provider-neutral Runtime and Feature contracts | App Server processes, connection ownership and service lifecycle |
| Side Chat and Subagent state/action semantics | Persistent stores and product-specific retention policy |
| Attachment metadata, limits, input and transcript envelopes | Attachment bytes, URLs, path authorization and file actions |
| Shared Session/Feature React UI and extension slots | Page shell, theme, placement and business extensions |
| Capability schema, common catalog, dependency resolution, plans and portable locks | Product Profile, custom catalog, host checks, install handlers and authentication |
| Environment/Run schema, Minimal Host, lifecycle/provider enforcement, immutable Skill snapshots and the fixed Codex model broker | Profile selection, domain credentials/data adapters, retention and deployment |
| Browser Provider lifecycle primitives and product-neutral proxy behavior | Browser profile, MCP endpoint, authorization and user-facing controls |
| Project-free and project-scoped contract fixtures | Consumer integration, end-to-end and manual acceptance evidence |

Platform never reads a product database, chooses a package manager, stores credential values, or invents a project/task model. Consumers pass context through adapters, actions, stores, Profiles, and extension slots.

## Shared invariants

### Session and UI

- A Session can exist with no project. Project-scoped consumers may add `contextId` and labels without placing product fields in Core records.
- `SessionBrowser` and `SessionWorkspace` own common list, transcript, Composer, queue, approval, attachment, Subagent, Realtime and responsive interaction semantics.
- Products own full-text search backends, navigation and any content rendered through extension slots.
- Host file actions receive the original authorized reference. Platform renders and normalizes metadata but does not grant filesystem access.

### Side Chat and Subagent

- Side Chat is an explicit fork with its own lifecycle and persistence adapter. Closing, switching Session, refreshing, Runtime expiry, and explicit deletion remain different actions.
- Subagents come from Runtime parent/child relationships and are not represented as Side Chats. Products choose visibility and placement, not parsing semantics.

### Capabilities and credentials

- Common capabilities are disabled by default. Consumers merge their custom catalog without shadowing a common id.
- Installation follows a side-effect-free `plan` and an explicitly confirmed `execute`. Platform never invokes a real package manager or login flow by itself.
- Profiles and health adapters use credential references. Manifests, locks, public results and logs reject credential values.

### Browser Provider

- Discovery and tool inventory are process-free. The first real tool call may start a consumer-configured Provider.
- Stateful calls are serialized. Provider instances return to zero when idle and teardown is bounded; a consumer may separately choose to retain its browser window.
- The consumer owns profile directories, endpoints, path allowlists and every external action authorization.

### Runnable environments

- Creating an Environment creates instance state, not source code. A consumer needs another repository only when it adds product-specific routes, adapters, UI, persistence or deployment.
- The built-in Host runs Sessions without projects, tasks, memory, evaluation policy or a consumer checkout. `policies/`, `evaluations/` and `gold/` are optional consumer/evaluator assets and are never required Host directories.
- Requested isolation is not evidence. The effective level is derived from provider enforcement facets and startup fails when it is below the Profile minimum.
- Development mode is useful but explicitly non-isolated. The Docker provider proves strong isolation for offline Runs, immutable `skill-source` snapshots, and one fixed Codex model channel backed by an unexpired ChatGPT access token. A Skill source is copied at Environment creation and hash-verified into each Run; only that Run copy is mounted read-only and the host source path is removed from the workload Profile. The workload never receives `auth.json`, the upstream access token or a refresh token; a broker-only sidecar owns the credential and fixed upstream. Other Capability kinds, credentials, network targets and external effects still fail closed.
- Each Run owns its Runtime home, Session state, workspace, temporary paths and transient credential directory. Stop removes transient credentials and child resources while retaining the Run manifest and Session state.

## Placement test

Put a change in Platform only when its state and behavior can be expressed without a product object and at least two consumer shapes should share it. Put it in a consumer when it depends on product data, authorization, deployment, storage, vocabulary, or evaluation policy.

When a change crosses the boundary, Platform defines the contract and the consumer implements the adapter. Do not make Platform import consumer code or make one consumer read a sibling Platform checkout.

## Verification boundary

- Platform automated tests cover the public contract, including project-free and project-scoped fixtures.
- Personal is the canary for shared full-product Session and UI behavior.
- Data Skill Lab is the canary for minimal, project-free and constrained-capability composition.
- Agent Terminal owns PTY, mobile shell and multi-host regression while adopting shared Session surfaces.
- Automatic tests establish contract correctness; consumer browser or workflow acceptance establishes that the product remains usable. One does not replace the other.

Release and consumer adoption gates are defined in [`operations/RELEASING.md`](operations/RELEASING.md). Active Agent Terminal migration scope is defined separately in [`specs/agent-terminal-migration.md`](specs/agent-terminal-migration.md).

# Agent Workbench Platform Architecture

`@agent-workbench/platform` is a product-neutral package for composing independent Codex workbenches. It owns reusable Agent semantics and UI; every consumer remains a separate product with separate data, authorization, deployment, and product objects.

## Layers

```text
@agent-workbench/platform/runtime
  App Server connections, Session/Turn/request semantics, approvals, inputs

@agent-workbench/platform/features
  Side Chat, Subagent and other complete feature contracts

@agent-workbench/platform/session-client
  retry-safe client operations and reusable headless Session application state

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
| Data Skill Lab | Independent evaluation Environment with one candidate Skill or a baseline | Profile inputs, cases, evidence and generated Run root | A Session can run without a project model or Personal state |
| Agent Terminal Web | Terminal-oriented, mobile-first, multi-host product | PTY, Terminal navigation, memory, hosts, accounts and sharing | Shared Session UI composes inside a different interaction shell |
| DataMama | Internal data product using a constrained Agent host | Identity, sharing, Dashboard/Superset context, data policy, product extensions and deployment | A lightweight consumer can combine shared Sessions with domain context |

Solvely Workbench is a frozen compatibility reference, not an active migration target.

Data Skill Lab is maintained outside the Personal repository and all of its modes are thin Profiles of the Core Minimal Host. Platform stays project-free, while Gold, scoring and evaluation policy remain outside Core.

## Ownership

| Platform owns | Consumer owns |
| --- | --- |
| Session, Turn, request, queue, interrupt and replay semantics | Product navigation, objects, labels and status |
| Provider-neutral Runtime and Feature contracts, including reconnectable WebSocket transport and explicit compaction requests | App Server process ownership, idle policy and service lifecycle |
| Side Chat and Subagent state/action semantics | Persistent stores and product-specific retention policy |
| Attachment metadata, limits, input and transcript envelopes | Attachment bytes, URLs, path authorization and file actions |
| Shared Session/Feature React UI and extension slots | Page shell, theme, placement and business extensions |
| Capability schema, common catalog, dependency resolution, plans and portable locks | Product Profile, custom catalog, host checks, install handlers and authentication |
| Environment/Run schema, Minimal Host, lifecycle/provider enforcement, portable Session/Run-state separation, immutable Skill snapshots, fixed Codex model broker and built-in read-only adapter enforcement | Profile selection, data allowlists, Session storage root and authorization, evaluation policy, retention and deployment |
| Browser Provider lifecycle primitives and product-neutral proxy behavior | Browser profile, MCP endpoint, authorization and user-facing controls |
| Project-free and project-scoped contract fixtures | Consumer integration, end-to-end and manual acceptance evidence |

Platform never reads a product database, chooses a package manager, stores credential values, or invents a project/task model. Consumers pass context through adapters, actions, stores, Profiles, and extension slots.

## Shared invariants

### Session and UI

- A Session can exist with no project. Project-scoped consumers may add `contextId` and labels without placing product fields in Core records.
- Minimal Host Session creation accepts an optional bounded initial Composer draft and an owner-scoped idempotency key. The draft is portable unsent state: it survives refresh, is cleared when the first user Turn is accepted, and is excluded from Session lists, shared projections, Observer output and Runtime input until the user submits it.
- Minimal Host Turn submission also accepts an optional owner-and-Session-scoped idempotency key. The private store reserves the request before Runtime side effects, replays an accepted response for the same payload, rejects key reuse with a different payload, and never exposes the reservation ledger through list, owner-detail, shared or Observer projections.
- `SessionClientOperationController` supplies product-neutral browser mutation identity. A client retains the same key for an unchanged target and payload until the response is known, while transport, authentication, persistence and user-facing error policy remain consumer-owned.
- `SessionBrowser` and `SessionWorkspace` own common list, transcript, Composer, queue, approval, attachment, Subagent, Realtime and responsive interaction semantics.
- Completed commentary remains grouped by Turn, but the newest completed process starts expanded so content visible during execution does not disappear at the completion boundary; disclosure state remains user-controlled. Message-body images retain their aspect ratio and use bounded thumbnail dimensions. A host-resolved image link keeps the shared keyboard/click behavior and opens through the existing file action instead of granting Platform filesystem access. Image files open in a viewport-centered lightbox with a dimmed, blurred backdrop and bounded contain sizing; non-image documents keep the side-panel preview.
- `steer`, `queuedTurns`, `messageEdit`, and `messageFork` are separate feature-profile choices. The UI requires both the relevant flag and a supplied action; Runtime capabilities remain the execution authority.
- Edit and Fork create a new Session branch and never replace the source Session's Runtime binding. In the Minimal Host, a successful Edit archives the source Session so the owner sees only the replacement in the active list, while Fork keeps both Sessions active; archived sources remain available to the cross-owner Observer. An owned portable Session from an earlier Run remains read-only for direct continuation but keeps Edit/Fork: the branch starts a fresh current-Run Runtime with bounded retained history instead of reusing a stale Runtime binding. Platform plans the branch and owns provider-neutral queue recovery; a consumer still owns authorization, storage adapters, product linking and navigation to the new Session.
- Minimal Host can consume a bounded, Gateway-verified shared-Session access envelope. It projects only explicitly granted read-only transcripts/resources and can create a new-owner continuation by copying visible content into a fresh Runtime; consumers still own identity, Share/link state, revocation, audit and envelope paging.
- The Minimal Host treats live Session synchronization as correctness: its event stream sends heartbeats, the client reconnects with the last observed event id, and running or waiting Sessions poll authoritative state until they leave that state. Persisted technical progress remains available through the shared collapsed detail surface.
- The Minimal Host's cross-owner Observer is a read-only operational surface that is disabled unless a consumer configures a trusted authorization header. Its default page is intentionally limited to a searchable Session list and the persisted process for each Turn: user input, externally emitted commentary, structured tool/command steps, and the final answer. Bounded redacted Run logs remain available from a separate diagnostic API instead of crowding the process page. The event stream carries invalidation notices rather than raw Runtime payloads. Consumers own the administrator grant and must remove browser-supplied claims at their gateway. Hidden model reasoning is never part of this contract.
- Composer classifies dropped directories separately from uploadable files. The whole Session detail surface routes file drags to that shared interaction, including the opaque Finder preview phase; consumers opt in through `actions.onResolveDroppedDirectories` and retain local-path authorization and fallback policy.
- Composer remains a direct text editor and never substitutes a formatted preview for the user's draft. Ordinary clipboard HTML wrappers use the exact plain-text value; structurally complex clipboard content becomes an attachment through the existing staged Resource flow instead of adding a second editing mode.
- Products own full-text search backends, navigation and any content rendered through extension slots.
- Host file actions receive the original authorized reference. Platform renders and normalizes metadata but does not grant filesystem access.

### Side Chat and Subagent

- Side Chat is an explicit fork with its own lifecycle and persistence adapter. Closing, switching Session, refreshing, Runtime expiry, and explicit deletion remain different actions. Platform supplies the lifecycle controller and React panel; consumers translate provider events and bind stores.
- Subagents come from Runtime parent/child relationships and are not represented as Side Chats. Platform supplies both embedded and auxiliary-panel UI; products choose visibility, placement and navigation, not parsing semantics.

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
- Development mode is useful but explicitly non-isolated. The Docker provider proves strong isolation for offline Runs, immutable `skill-source` snapshots, one fixed Codex model channel, and locked OpenMetadata/BigQuery read-only adapters. Skill sources are hash-verified, mounted read-only and Runtime-allowlisted. Model and data credentials stay in separate sidecars; the workload receives only Run-local service channels. BigQuery execution is dry-run gated by statement type, referenced-project allowlist and byte/row ceilings; OpenMetadata is tool-allowlisted before upstream contact. Exact credential, network and effect declarations fail closed. For self-contained `ephemeral-machine` Runs, including enforced read-only adapters, Docker is the executable sandbox and nested Codex command approvals are disabled.
- Each Run owns its Runtime home, Runtime bindings, queued Turns, workspace, temporary paths and transient credential directory. By default its Session transcript and managed resources remain Run-scoped for compatibility; a consumer may instead bind them to one private stable root shared by successive Runs. A Session from an earlier Run is readable there but is not silently attached to a blank Runtime thread. Stop removes transient credentials and child resources while retaining durable state.

## Placement test

Put a change in Platform only when its state and behavior can be expressed without a product object and at least two consumer shapes should share it. Put it in a consumer when it depends on product data, authorization, deployment, storage, vocabulary, or evaluation policy.

When a change crosses the boundary, Platform defines the contract and the consumer implements the adapter. Do not make Platform import consumer code or make one consumer read a sibling Platform checkout.

## Verification boundary

- Platform automated tests cover the public contract, including project-free and project-scoped fixtures.
- Personal is the canary for shared full-product Session and UI behavior.
- Data Skill Lab is the canary for minimal, project-free and constrained-capability composition.
- Agent Terminal owns PTY, mobile shell and multi-host regression while adopting shared Session surfaces.
- Automatic tests establish contract correctness; consumer browser or workflow acceptance establishes that the product remains usable. One does not replace the other.
- A successful consumer canary is compatibility evidence, not adoption. Formal adoption requires that consumer's package and lockfile to pin the released tag and its own acceptance record to name the same version.

Release and consumer adoption gates are defined in [`operations/RELEASING.md`](operations/RELEASING.md). Active Agent Terminal migration scope is defined separately in [`specs/agent-terminal-migration.md`](specs/agent-terminal-migration.md).

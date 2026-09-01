# Session Resources and Storage Lifecycle

Lifecycle: active design. This spec proposes the shared resource model, storage adapter, lifecycle, and migration contract. It does not authorize moving or deleting existing consumer data.

## Objective

Give every Workbench the same reliable behavior for files and generated outputs without making Platform own a consumer's physical storage, authorization, backup, or product retention decisions.

The user-visible contract is:

- a file or folder shown as attached remains represented after Send, refresh, resume, and archive;
- a failed Send does not silently discard the draft resource;
- a Session transcript references stable resource identities, not incidental filesystem paths;
- generated outputs remain openable after temporary tool or Browser output is cleaned up;
- workspace files remain in their authoritative workspace unless an explicit snapshot or import is requested;
- inspection and cleanup are explainable, scoped, reversible before purge, and safe to run repeatedly.

Platform must provide the vocabulary, schemas, state machine, reference filesystem store, promotion flow, UI semantics, and conformance tests needed to make that contract portable. Consumers still choose where bytes live, who may read them, how long optional classes are retained, and how storage is backed up or encrypted.

## Current implementation slice

Implemented in the active Platform worktree:

- `agent-workbench.resource/v1` normalization and public package exports;
- `FilesystemResourceStore` staging, atomic records, Session/Run ownership checks, commit, external-handle registration, temporary-output staging, integrity-checked idempotent promotion, usage inspection, and side-effect-free expired-draft/transient planning;
- a distinct retained `resources` root in Environment Run manifests and Docker mounts;
- Minimal Host attachment staging before Send and Session-durable commit only after Runtime acceptance;
- authorized `workspace-directory` registration, reauthorization at Runtime resolve, and persistent directory chips;
- stable Resource metadata in Session messages with no public storage path;
- failed-Turn recovery and cross-Session rejection tests.

Still unresolved or unimplemented: explicit reference-edge recording, quarantine/purge, consumer compatibility adapters, and migration of existing stores. No cleanup is enabled by this slice.

## Why this belongs in Platform

Attachment and artifact behavior is part of Session correctness, not product vocabulary. A project-free Minimal Host, Personal Workbench, and Agent Terminal all need the same answers to these questions:

- What did the user attach to this Turn?
- Is the resource managed by the Workbench or merely referenced from a workspace?
- Can the Runtime access it without exposing an unrestricted host path to the UI?
- Does archive, unsubscribe, Run stop, or Session delete change its lifetime?
- When can Browser output, previews, logs, drafts, and caches be collected?
- How is an output promoted before a transcript promises that it is durable?

The current stable boundary says Platform owns attachment envelopes while consumers own attachment bytes and retention. That remains true at the deployment boundary, but is too weak as an implementation contract: each Host can otherwise invent different naming, promotion, orphan handling, and deletion behavior. This spec refines the boundary by making the common mechanics a Platform capability with consumer-supplied roots and policy.

```text
Session UI / transcript
        |
        | public resource/v1 descriptors and actions
        v
Platform Resource Coordinator
   |              |                 |
   | managed      | external        | provider input/history
   v              v                 v
ResourceStore   Workspace adapter   Runtime adapter
   |              |                 |
   +------- consumer authorization, roots, and policy -------+
```

## Terms

| Term | Meaning |
| --- | --- |
| Resource | A typed item referenced by a Session, Turn, Run, or workspace, with a stable Platform identity |
| Managed resource | Content whose bytes are controlled through a `ResourceStore` |
| External reference | An authorized pointer to content owned elsewhere, such as a workspace file; it is not copied by default |
| Attachment | A user-supplied managed resource committed to a Turn |
| Artifact | A generated or tool-produced resource intentionally exposed as a durable result |
| Staged resource | A draft upload that is not yet committed to a Turn |
| Promotion | The atomic act of turning temporary output into a durable resource before publishing its reference |
| Collector | The Platform lifecycle service that plans, quarantines, and eventually purges eligible managed resources |
| Storage Profile | The consumer declaration that maps logical roots and retention classes to a concrete deployment |

## Reference: what Codex demonstrates

Codex is a useful behavior reference, not a storage API that Platform can copy verbatim.

Officially documented behavior establishes four relevant separations:

1. Codex core owns Thread lifecycle and persistence. App Server can create, resume, fork, archive, and delete Threads and lets clients reconstruct a consistent event history.
2. A Thread records its working directory, while Codex reads and edits the current working tree. Project files are therefore workspace state, not blobs embedded into the transcript.
3. Archive is an organizational operation. In App Server it moves the persisted rollout into archived Sessions; unsubscribe only unloads a Thread after an inactivity grace period; delete is a distinct permanent operation.
4. Rich clients preview documents, spreadsheets, images, HTML, and other generated files alongside a chat, while the CLI reports output paths in the working directory. Presentation can vary without changing file ownership.

Observed on 2026-09-01 on one macOS installation of ChatGPT/Codex, version `26.818.41509` with `codex-cli 0.149.0-alpha.4.1`:

- `~/.codex` contains Runtime history and state, including active and archived Session rollouts, state databases, attachments, and visualizations;
- `~/Library/Application Support/Codex` contains the desktop shell and Chromium-style browser state;
- `~/Library/Caches/Codex` and `~/Library/Caches/com.openai.codex` contain disposable app caches;
- `~/Library/Logs/com.openai.codex` contains diagnostics;
- active Session rollouts are date-partitioned JSONL records, while archive uses a separate active/archived location;
- the local attachment area observed during this audit is a small UUID-keyed store used for pasted text, not a documented general-purpose Resource Store.

These paths are implementation observations, may change between releases, and must not become a Platform dependency. The design lesson is the separation of Runtime history, workspace content, managed resources, shell state, caches, and logs. It is not the literal directory names.

References:

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Projects and chats](https://learn.chatgpt.com/docs/projects)
- [Work with files](https://learn.chatgpt.com/docs/artifacts-viewer)
- [Introducing the Codex app](https://openai.com/index/introducing-the-codex-app/)
- [How OpenAI built the Codex App Server](https://openai.com/index/unlocking-the-codex-harness/)

## Resource classes

Platform defines the following classes. A consumer may add namespaced metadata, but it cannot redefine these meanings.

| Class | Content ownership | Normal owner | Default durability | Examples |
| --- | --- | --- | --- | --- |
| `workspace-file` | External | Workspace | Follows workspace | Source file, checked-in spec, generated spreadsheet saved into a project |
| `workspace-directory` | External | Workspace | Follows workspace | Dropped project folder or secondary readable root |
| `session-input` | Managed | Session and Turn | Session durable | Uploaded image, document, pasted text represented as a file |
| `session-artifact` | Managed or external snapshot | Session and Turn | Session durable | Exported report, promoted screenshot, generated document outside a workspace |
| `visualization` | Managed artifact subtype | Session and Turn | Session durable | HTML visualization plus its declared assets |
| `transient-output` | Managed temporary | Run or tool invocation | Disposable after promotion or grace | Browser snapshots, intermediate logs, conversion output |
| `diagnostic-evidence` | Managed or external | Run or consumer | Policy bounded | Smoke screenshots, trace bundles, validation logs |
| `ui-state` | Host-private | Consumer installation | Product policy | Desktop shell state, local preferences, Browser profile |
| `cache` | Host-private | Runtime or consumer | Regenerable | Model cache, preview cache, browser cache |
| `runtime-record` | Runtime-provider private | Thread/Session | Runtime policy | Rollout JSONL, Runtime state database, queue state |

Credentials and transient secret material are not Resources. They use the Environment credential lifecycle and must never be copied into a Resource Store, manifest, transcript, preview, or diagnostic bundle.

### Workspace references are not uploads

A pasted path or dropped directory is a `workspace-file` or `workspace-directory` reference when the Host authorizes it. Platform UI must never present a directory as successfully uploaded and then silently remove it on Send.

The required interaction is:

1. Composer classifies files, directories, text, and URLs before showing a chip.
2. A local-capable Host resolves a directory or path into an opaque authorized reference and returns display metadata.
3. The chip remains in the Composer until the Turn is accepted. After acceptance it appears in the user message.
4. If the Host cannot authorize or resolve the reference, the chip shows an actionable error and Send is blocked for that item.
5. A remote Host must not infer that a client-local path exists on the Runtime machine.

Recursive directory upload is a different feature. If added, it must be explicit, show file count and total size before transfer, enforce exclusions and limits, and produce a managed import or archive. Directory drag must not trigger implicit recursive upload.

## Public resource descriptor

Session UI, transcript adapters, and consumer extensions exchange a public descriptor. They do not exchange a storage path.

```json
{
  "schema": "agent-workbench.resource/v1",
  "id": "res_01J...",
  "kind": "session-input",
  "mode": "managed",
  "owner": {
    "sessionId": "ses_01J...",
    "turnId": "turn_01J...",
    "runId": "run_01J..."
  },
  "display": {
    "name": "design.png",
    "mimeType": "image/png",
    "size": 234577
  },
  "integrity": {
    "algorithm": "sha256",
    "digest": "optional-lowercase-hex"
  },
  "origin": {
    "type": "upload",
    "createdAt": "2026-09-01T14:39:06.000Z"
  },
  "lifecycle": {
    "class": "session-durable",
    "state": "ready"
  },
  "capabilities": {
    "preview": true,
    "download": true,
    "openInWorkspace": false
  }
}
```

Required rules:

- `id` is stable and globally unique within one Host installation.
- `kind`, `mode`, owner, display metadata, origin, and lifecycle are explicit.
- `session-input`, `session-artifact`, and `visualization` descriptors must identify their Session owner.
- A committed Turn reference includes `turnId`; a staged draft uses a Host-private `draftId` until commit.
- A digest is recommended for managed immutable content and required before content-addressed deduplication.
- Display names are untrusted text. They never select the on-disk path.
- Absolute paths, signed URLs, credential material, and internal storage keys are absent from the public descriptor.
- The descriptor is immutable except for lifecycle state, capability projection, and append-only ownership/reference metadata. Replacing content creates a new resource identity or revision.

An external reference uses `mode: "external"` and the same public fields. Its Host-private record additionally contains an authorization handle and current version evidence. The UI receives only a display label and opaque resource id.

## Host-private record

`ResourceStore` keeps a private record beside or inside its metadata store. It may include:

- storage backend and opaque content key;
- authorized workspace path or provider object id;
- staging and quarantine locations;
- reference counts or explicit reference edges;
- scan result, executable flag, and preview restrictions;
- policy timestamps and collection reason;
- migration source identity and journal state.

The record is never injected into model text wholesale. A Host resolves the minimum required representation immediately before Runtime submission. For example, a Runtime that accepts `localImage` may receive a private staged path, while the Platform transcript continues to store `res_...` plus normalized metadata. Runtime-provider rollouts may contain provider-specific paths; those rollouts stay Runtime-private and are not the portable transcript contract.

## ResourceStore contract

Platform ships a product-neutral `ResourceStore` interface and a filesystem reference implementation. The exact JavaScript signatures can be finalized with the schema, but the capability surface is fixed by this spec:

| Operation | Required behavior |
| --- | --- |
| `stage` | Stream bytes into a private staging location, enforce declared size/type limits, and return a staged descriptor |
| `stageTransient` | Claim generated bytes as Run/Session-owned temporary output with no durable preview or download promise by default |
| `commit` | Atomically bind a staged resource to a Session/Turn and make it `ready` |
| `registerExternal` | Create an opaque authorized workspace/provider reference without copying content |
| `get` / `list` | Return authorized public descriptors by id or owner; never reveal another Session's resource |
| `open` | Stream managed content with range support after Host authorization |
| `resolveForRuntime` | Produce the minimum provider-specific input needed for one authorized Turn |
| `promote` | Atomically copy or claim temporary output into a durable class before a reference is published |
| `recordReferences` | Persist explicit edges from transcript items, previews, evidence, or exports |
| `inspectUsage` | Report counts and bytes by class, owner, age, and lifecycle state without reading content |
| `planCollection` | Produce a side-effect-free list of exact eligible targets and reasons |
| `quarantine` | Make planned managed content unavailable while preserving a recovery window |
| `purge` | Permanently remove only expired quarantine entries and their private metadata |

The filesystem implementation must provide:

- generated ids and storage names independent from display names;
- contained realpaths, symlink escape denial, and cross-Session authorization checks;
- private directory and file permissions appropriate to the host OS;
- streaming writes to a temporary file followed by atomic rename;
- atomic metadata updates and crash-recoverable migration/collection journals;
- optional digest calculation and deduplication without changing resource identity;
- idempotent commit, promotion, quarantine, and purge operations;
- no recursive delete rooted in an unresolved variable, workspace root, or source checkout.

Consumers may provide an object store, database-backed store, encrypted store, or remote provider implementation. Every implementation must pass the same conformance suite.

## Lifecycle

### State machine

```text
  staged -- commit -----------------------> ready
     |                                        |
     | abandoned / draft expired              | explicit owner deletion
     v                                        v
  orphaned -- collection plan ----------> quarantined -- grace + recheck --> purged
     ^                                        ^
     | temporary output expires               | explicit owner deletion
     |                                        |
  transient -- select --> promotable -- atomic promotion --> promoted
```

`promoted` is a durable form of `ready`; an implementation may store it as lifecycle metadata rather than a separate physical directory. `deleted` may be exposed as a tombstone alias for `quarantined` or `purged`, but callers must be able to distinguish recoverable from permanent deletion.

### Composer and Turn commit

- Upload begins in `staged`; the Composer owns a draft reference.
- The Composer shows progress and errors and cannot label an incomplete item as attached.
- On a successful Turn acceptance, Host commit binds all staged resources to that Turn before the optimistic Composer state is cleared.
- The transcript renders committed descriptors from the accepted user message, not from transient Composer memory.
- If request construction or submission fails, staged chips remain recoverable and the error is visible.
- Refresh may restore staged draft resources within their configured draft grace period.
- Retry is idempotent: it must not create duplicate committed bytes or duplicate transcript references.

### Generated outputs and promotion

Tool and Browser output starts as `transient-output` unless it is already an authoritative workspace file. Before an assistant message, preview, or download action promises a durable result, the Host must do one of the following:

- register the authoritative workspace file as an external resource, including version evidence; or
- promote the temporary content into `session-artifact` or `visualization` and receive a durable descriptor.

Publishing a raw temporary path is invalid. If promotion fails, the Turn may still complete, but the UI must describe the artifact failure instead of showing a dead link.

The filesystem reference store claims generated bytes with `stageTransient`, initially disables public preview/download capabilities, and accepts `promote` only for `session-artifact` or `visualization`. Promotion verifies the producing Run when one is recorded, rejects cross-Session targets, rechecks size and SHA-256 integrity, and atomically updates the existing resource record to `session-durable/promoted` without changing its id or blob. A retry with the same Session, Turn, and kind returns the same descriptor; a conflicting durable target fails explicitly. `commit` refuses to bind a transient resource directly.

### Archive, unload, stop, and delete

These operations have deliberately different meanings:

| Operation | Resource effect |
| --- | --- |
| Unsubscribe or unload Session | None |
| Interrupt Turn | Committed input remains; incomplete temporary output follows transient policy |
| Archive Session | None; archive is organization, not deletion |
| Unarchive Session | None |
| Stop Run | Remove Environment credentials and ephemeral processes; retain Session-durable resources; transient output follows Run policy |
| Delete Session | After Runtime deletion succeeds, tombstone owned managed resources and quarantine them according to policy |
| Remove workspace/project association | Do not delete workspace content or Session resources |
| Clear cache | May remove only `cache` and rebuildable previews |

Runtime deletion and resource deletion are separate operations coordinated by the Host. A failed half of the operation remains journaled and retryable. A consumer that does not expose Session deletion must not use archive as a substitute.

## Retention Profile

Platform defines policy semantics and a conservative reference profile. Consumers choose or override policy values and must expose the effective profile through inspection.

| Policy class | Reference behavior |
| --- | --- |
| `session-durable` | No time-based automatic deletion while its Session record exists, including archive |
| `draft` | Eligible as orphan after 7 days without a commit or draft heartbeat |
| `transient` | Eligible 7 days after producing Run/operation ends, unless promoted or referenced |
| `diagnostic` | Eligible after 30 days unless explicitly pinned by a consumer evidence record |
| `quarantine` | Recoverable for 30 days before purge |
| `cache` | No durability promise; size-bounded LRU and explicit clear are allowed |
| `credential` | Not a Resource; remove at Run stop or earlier according to Environment contract |

Safety rules take precedence over TTL:

- no referenced `session-durable` resource is collected because of age or quota pressure;
- archive never starts a retention clock;
- a collector first emits an inspection/plan result and changes no data;
- quarantine rechecks ownership, references, age, and active leases;
- purge only accepts exact ids already in quarantine whose grace period elapsed;
- quota enforcement targets cache, expired transient output, and expired diagnostics before refusing new uploads;
- quota enforcement never silently deletes a committed attachment or artifact;
- policies are evaluated against monotonic Host records where possible and tolerate clock changes;
- cleanup audit records contain ids, class, size, reason, and timestamps, not content or secret paths.

A consumer may retain resources longer, disable automatic collection, or set tighter staging/transient limits. It may not describe a class as Session durable while automatically deleting it from an archived or merely inactive Session.

## Logical storage roots

Platform defines roles, not universal absolute paths:

| Logical root | Contents | Durability |
| --- | --- | --- |
| `stateRoot` | Consumer state and Resource metadata | Durable |
| `runtimeRoot` | Provider Thread/Session history and Runtime databases | Runtime-defined durable |
| `resourceRoot` | Managed blobs, staging, metadata journals, quarantine | Policy durable |
| `workspaceRoot` | External authoritative files or isolated Run workspace | Workspace/Run-defined |
| `browserProfileRoot` | Cookies, login/profile state, Browser provider data | Consumer security policy |
| `cacheRoot` | Rebuildable caches and previews | Disposable |
| `logRoot` | Operational diagnostics | Bounded |
| `tempRoot` | Process-local temporary files and sockets | Ephemeral |

A single-machine reference layout may place these below one supplied application-data directory, but the roots remain distinct in the manifest and inspection output. Native apps should map cache and log roles to OS-appropriate locations when possible. Containers may map them to separate volumes or ephemeral mounts.

Production persistent state must not default to the package source checkout. A consumer may use an ignored repository-local `data/` or `.workbench-data/` root for development, but it must still preserve the logical separation above and report its effective roots. Platform documentation and code must never assume Personal's directory names.

No public manifest or Session descriptor contains credential values. Path-bearing inspection output is Host-authorized operational data and is not automatically forwarded to the model or browser client.

## Ownership boundary

| Concern | Platform | Runtime provider | Consumer / Host | Workspace owner |
| --- | --- | --- | --- | --- |
| Resource taxonomy and public descriptor | Owns | Maps provider items when needed | May add namespaced metadata | — |
| Attachment Composer and transcript behavior | Owns | Accepts resolved inputs | Wires actions and authorization | — |
| Thread history, resume, archive, delete | Normalizes UI semantics | Owns persistence and provider operations | Owns process/service lifecycle | — |
| Managed bytes | Supplies interface and reference store | May keep provider-private files | Supplies physical roots/backend | — |
| Workspace file content | Represents by opaque reference | Reads/edits through sandbox | Authorizes roots and actions | Owns truth and versioning |
| Promotion and reference graph | Owns protocol and implementation | Emits candidate output | Configures store and policy | May remain authoritative |
| Retention classes and collector safety | Owns semantics, baseline, planner, conformance | Declares provider cleanup effects | Selects overrides, quotas, schedules | Owns workspace retention |
| Preview/download URLs | Owns descriptor/action semantics | — | Owns HTTP route, auth, expiry | — |
| Encryption, backup, residency | Exposes adapter points | Provider-specific | Owns | Workspace-specific |
| Evidence selection | Provides resource class | — | Owns product/evaluation policy | — |

Platform therefore handles files as a shared capability, but does not centralize every consumer's files into a Platform-owned global directory or service.

## Public UI requirements

- Attachment chips display name, type, size or resolution when known, upload state, and a removable/error state.
- A directory chip is visually and semantically distinct from a file upload.
- Send is disabled only for unresolved or failed resources, with the blocking reason shown.
- After Send, committed resources render inside the user message even while the assistant is running.
- Resource actions are capability-driven: preview, download, reveal/open in workspace, copy authorized reference, and remove are shown only when backed by the Host.
- Copying a path is available only for authorized local workspace references. Managed uploads expose a resource action, not their private storage path.
- Missing, quarantined, or unauthorized content renders an explicit state; it never disappears from transcript history.
- Archive does not change resource presentation. Deleted Sessions are not recoverable through an attachment URL after authorization is revoked.
- Browser output galleries and diagnostics are not mixed into the default Session attachment list unless promoted or explicitly linked.

## Security requirements

- Treat filename, MIME type, extension, and preview markup as untrusted.
- Enforce byte limits while streaming, before committing content.
- Detect archive bombs and recursive directory limits in any future import flow.
- Serve downloads with safe content disposition and explicit MIME headers.
- Render active HTML/visualizations in the Platform sandbox contract; never open uploaded HTML with application origin privileges.
- Deny traversal, symlink escape, special devices, sockets, and cross-Session id substitution.
- Reauthorize external references at each open and Runtime resolve; a stale opaque id does not grant permanent path access.
- Resource URLs are authenticated Host routes or short-lived signed URLs. The descriptor itself is not a bearer credential.
- Do not include resource content, secret paths, or signed URLs in logs, cleanup reports, analytics, or error telemetry.
- Malware/content scanning is an adapter capability. Its absence must be inspectable; it is not implied by a successful upload.

## Implementation order

1. Add the `agent-workbench.resource/v1` schema, lifecycle enums, and contract fixtures without moving existing data.
2. Add the `ResourceStore` interface, filesystem reference store, authorization hooks, and conformance suite.
3. Route Minimal Host attachment storage through the reference store instead of maintaining a Host-specific copy.
4. Move shared Composer draft/commit behavior and transcript resource rendering onto stable resource ids.
5. Add external workspace/directory registration and explicit resolver errors for unsupported local paths.
6. Route Browser screenshots, generated downloads, and visualizations through the implemented transient-output promotion primitive in each consumer Host.
7. Extend the implemented usage inspection and draft/transient dry-run collection planning with reference edges. Ship quarantine only after that evidence; ship quarantine before purge.
8. Adopt in consumers with compatibility adapters and dual-read validation. Each consumer owns its migration schedule and evidence.
9. After two independent consumer canaries, absorb the settled boundary into `docs/architecture.md` and remove this active spec.

No step in this order authorizes cleanup of current Browser profiles, Runtime homes, attachments, screenshots, evidence, or repository files.

## Migration contract

Existing stores migrate in place or through a new root only after an inventory proves:

- every source payload has either a valid manifest/reference or an explicit orphan classification;
- every committed transcript reference resolves before and after migration;
- ids, display metadata, content length, and digest remain stable;
- source and destination ownership and permissions are correct;
- interrupted migration resumes from an append-only journal;
- rollback can restore reads to the previous adapter without deleting the source;
- transient Browser output referenced by a transcript is promoted before any cleanup;
- Runtime history remains under the Runtime provider and is not rewritten as Resource metadata.

Recommended adoption modes:

1. `inventory`: read-only report of classes, bytes, missing payloads, and orphan candidates;
2. `compat-read`: existing records are projected as `resource/v1` without changing writes;
3. `dual-read`: new writes use `ResourceStore`, reads verify both paths where a legacy record exists;
4. `cutover`: new store is authoritative, legacy source stays intact through a consumer-defined rollback window;
5. `retire`: source deletion requires a separate reviewed collection plan.

Migration code belongs with the consumer adapter when it knows a consumer-specific layout. Generic manifest import and integrity verification belong in Platform.

## Acceptance

- A project-free Host and a project-scoped Host pass the same ResourceStore conformance suite.
- A file attached before Send appears in the accepted user message and survives refresh, Runtime reconnect, Session resume, archive, and unarchive.
- A failed Send preserves the staged resource and visible error; retry creates one committed reference.
- A dropped directory becomes an authorized external reference or an explicit unsupported error; it never masquerades as an uploaded file.
- A resource id from Session A cannot be opened or submitted from Session B without an explicit shared-owner policy.
- Workspace files are not copied by default and continue to follow workspace truth.
- Temporary Browser/tool output cannot be published as a durable link until promotion succeeds.
- Archive, unsubscribe, Run stop, Session delete, cache clear, quarantine, and purge have the distinct effects defined above.
- Usage inspection and collection planning perform no writes and identify exact ids, bytes, class, age, and reason.
- Quarantine and purge are idempotent, scoped, journaled, and never act on unresolved paths or active references.
- Public descriptors, transcripts, manifests, logs, and cleanup evidence contain no credentials, signed URLs, or private storage paths.
- A compatibility migration proves zero missing committed payloads and a tested rollback before any source retirement.

## Open decisions

- Whether `resource/v1` revisions use a new id per version or one id plus immutable revision ids.
- Whether the first filesystem store uses content-addressed blobs by default or keeps digest-based deduplication optional.
- How Runtime providers that persist local paths should expose portable resource references during export/import.
- Whether shared resources across Sessions require a first-class collection/asset owner or only explicit multiple reference edges.
- Whether Browser profile state can be split cleanly from Chromium-managed caches on every provider.
- Which scan interface and preview allowlist become mandatory before enabling arbitrary document preview in the Minimal Host.
- Whether permanent Session deletion is one Host transaction or an explicit two-step Runtime-delete/resource-delete workflow in the public API.

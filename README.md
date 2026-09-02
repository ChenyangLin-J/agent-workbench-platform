# Agent Workbench Platform

Shared, product-neutral building blocks for independent Codex workbench applications.

The package lets multiple products reuse one implementation while keeping their repositories, accounts, data, deployments, and product organization separate.

Start with the [`docs/README.md`](docs/README.md) documentation map. The stable shared boundary is defined in [`docs/architecture.md`](docs/architecture.md); active consumer migrations live in `docs/specs/`.

## Included

- Codex App Server connections for stdio and WebSocket transports, including cross-Session search and in-Session occurrence search
- Provider-neutral Session Kernel with queue, steer, interrupt, request, and replay contracts
- Session presentation, searchable/archivable Session list, message history paging, queue, image/inline-visualization rendering, Composer, status, and responsive React UI
- Codex-native Sub Agent discovery, metadata, active-Turn interruption, and thread-tree normalization
- Product-neutral Side Chat controller, state model, persistence and Runtime adapter contracts, and React panel
- Shared Resource descriptors, staged/committed attachment lifecycle, filesystem ResourceStore, transcript envelopes, App Server text/file inputs, approvals, and Realtime browser contracts
- Product-configurable Session capabilities: Realtime visible/hidden and Sub Agents hidden/summary/full
- On-demand shared MCP and Playwright Browser Provider primitives
- Product-neutral capability plugins: skill sources, MCP servers, CLI tools, and credential providers
- A versioned common Capability Registry, schema, dependency resolver, install plan, portable lock, host-backed Capability Manager, and React management panel
- Codex connection preparation, Skill-root inventory validation, execution-profile translation, and grouped/incremental Session pagination policy
- A runnable, project-free Minimal Host with Environment manifests, lifecycle CLI, immutable Skill and trusted read-only MCP snapshots, honest isolation reporting, fixed Codex model access, and isolated read-only adapter sidecars

## Product boundary

This repository does not contain product navigation, project or task management, credential values, account state, deployment configuration, persistent browser profiles, product-specific Skills, or product-specific memory and orchestration policies. Consumers provide those through adapters, custom Capability catalogs, Profiles, and UI extensions.

## Install

Pin a release tag from any GitHub or GitLab consumer:

```json
{
  "dependencies": {
    "@agent-workbench/platform": "https://github.com/ChenyangLin-J/agent-workbench-platform/archive/refs/tags/vX.Y.Z.tar.gz"
  }
}
```

Replace `vX.Y.Z` with an existing release tag. Consumers may automatically accept a newer patch in their current minor line after their own tests pass; minor and major upgrades require product-level review. The complete version, release, consumer-canary, and rollback workflow is in [`docs/operations/RELEASING.md`](docs/operations/RELEASING.md).

Consumers provide React and their own compatible Codex CLI version. This lets independent products keep separate accounts and upgrade from `0.145.x` to `0.147.x` without forking Core:

```json
{
  "dependencies": {
    "@openai/codex": "0.147.0",
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  }
}
```

## Entry points

- `@agent-workbench/platform`
- `@agent-workbench/platform/session`
- `@agent-workbench/platform/subagents`
- `@agent-workbench/platform/attachments`
- `@agent-workbench/platform/resources`
- `@agent-workbench/platform/filesystem-resource-store`
- `@agent-workbench/platform/capabilities`
- `@agent-workbench/platform/plugins`
- `@agent-workbench/platform/capability-registry`
- `@agent-workbench/platform/capability-installer`
- `@agent-workbench/platform/capability-manager`
- `@agent-workbench/platform/features/side-chat`
- `@agent-workbench/platform/ui-hooks`
- `@agent-workbench/platform/runtime`
- `@agent-workbench/platform/runtime/core`
- `@agent-workbench/platform/environment`
- `@agent-workbench/platform/browser-provider`
- `@agent-workbench/platform/realtime-controller`
- `@agent-workbench/platform/ui`
- `@agent-workbench/platform/styles.css`

## UI ownership

`SessionBrowser` and `SessionWorkspace` provide the standard Session search/list/archive interaction, cursor-driven list loading, transcript and earlier-message paging, lazy technical-detail loading, queued turns, requests, Composer, click/drag/paste attachment upload, model/reasoning/access selectors, model-advertised Fast service tier, user-message Edit/Fork actions, status, Sub Agent, and Realtime UI. While a Turn is running, its stop control sits in the Composer action row immediately before “下一轮”, keeping the execution action next to the queue/steer controls in both full products and the Minimal Host. Time grouping uses incremental pagination; context and attention grouping continue loading lightweight pages until the grouped index is complete. `SessionList` exposes the exact same list implementation for products that already own the Session detail surface. The shared list supports consumer-provided context/time/status grouping, rich execution states, favorites, separate end and archive actions, host filter extensions, and product-owned full-text-search/history entry points. Shared transcript rendering supports safe Markdown for both user and Agent messages, Codex `\\[...\\]` / `\\(...\\)` math through KaTeX, and both the legacy `::codex-inline-vis` directive and current `visualize` content reference; directives inside fenced or indented code remain literal examples. Products resolve visualization paths through `actions.visualizationUrl` and remain responsible for their own allowlist. Local absolute and `./` / `../` file links stay delegated to the host for authorized in-page preview; absolute paths use a `file:///...` browser href instead of being resolved against the Workbench origin. They expose an overlaid folder reveal button only while the link is hovered or keyboard-focused, so the hidden action never reserves inline text space; products opt in with `actions.onRevealLink`, keep path authorization and operating-system behavior in the host, and may override the label with `labels.revealFile`. Agent commentary stays in the transcript while its Turn is running; after the Turn reaches a terminal status, consecutive commentary messages in that Turn share one compact disclosure without mixing command or tool details into the conversation. File selection uses the browser input event and snapshots its live `FileList` before resetting the field, so the current upload is retained and the same file can be selected again. Pasted clipboard files and images become attachments. Rich clipboard HTML is converted to GFM Markdown so headings, emphasis, lists, links and tables survive the textarea and transcript; a paste of at least 1,000 characters, or one that would exceed the Composer limit, becomes a timestamped Markdown or plain-text attachment while ordinary short content remains inline. Platform owns the versioned attachment envelope, preserves stable attachment identity and metadata in the transcript, and exposes host-owned attachment/image open actions; products still own file storage, preview URLs and Session/path authorization. `actions.onUploadAttachments` may report each file's progress through the optional `onProgress` callback, while failed cards remain retryable without blocking a text-only submission. The shared file drawer previews image, PDF, audio, spreadsheet, Markdown, code, text, and sandboxed HTML; managed Resource previews are labelled as Session artifacts, hosts opt into local edit/reveal/external actions, and technical items can expose host-owned `artifacts` through open/reveal actions. The shared Playwright proxy pins its child process to the configured output directory and rewrites generated artifact links to absolute local paths, so screenshots and PDFs do not inherit an unrelated consumer working directory. When a reader scrolls more than 200 pixels away from the latest Session content, a floating shortcut appears above the Composer; new content changes it to an unobtrusive “有新消息” pill without taking over the reader's scroll position. Products supply the model catalog and implement `actions.onExecutionProfileChange` to apply execution settings through their Runtime adapter. `SideChatPanel` provides the shared Side Chat tabs, retained transcript, configuration and composer while the product supplies persistence and Runtime actions. Products mark eligible messages with `canEdit` / `canFork`, implement `actions.onEditMessage` / `actions.onForkMessage`, and supply grouping labels, archive and paging actions, and their own navigation. They can append product-specific content after a standard message with `extensions.renderAfterMessage`; Core does not know about projects, analysis cards, reports, or artifact canvases.

`FilesystemResourceStore` now supplies the product-neutral default storage mechanics: public `resource/v1` descriptors, staged uploads, Session authorization, atomic commit after Runtime acceptance, private content keys, temporary-output staging, integrity-checked and idempotent promotion into durable Session artifacts or visualizations, usage inspection, and dry-run draft/transient collection planning. Consumers still choose the physical root or an alternative backend and own preview/download authorization, backup, encryption, quotas, and retention overrides.

Directory drops are classified separately from uploadable files. A product may implement `actions.onResolveDroppedDirectories({ directories })` and return `{ resources, references, warning }`; each directory descriptor contains `name`, a best-effort `pathHint`, and the original browser `file` when available. A hint is never authorization. A Host can return authorized `workspace-directory` Resources for persistent directory chips, while legacy consumers may return strings or `{ text }` references for the Composer. The host retains path authorization and fallback policy. Without that optional action, directories are rejected visibly instead of becoming false-ready attachments, and ordinary files in the same drop continue through the upload lifecycle.

The same Session surface is desktop- and mobile-safe: the list becomes a drawer on narrow screens, touch-only controls remain reachable without hover, Composer inputs avoid iOS focus zoom, safe-area padding protects the bottom controls, and an explicit submission follows new output while `visualViewport` changes around the software keyboard. Phone-sized transcripts wrap long code and tables instead of clipping them. The shared file reader keeps Markdown in a reading layout, images inside the Workbench, and code in a horizontally scrollable line-number view; hosts may pass `highlightLine` (or retain a `#L42` / `:42` reference) to focus an exact line. Consumers must include `viewport-fit=cover` in their viewport metadata for safe-area insets to take effect.

Markdown documents can resolve relative images through the synchronous, host-owned `actions.documentResourceUrl({ file, href })` adapter, open relative document links with the current file as context, and navigate generated heading anchors inside the drawer. Hosts may opt into inline Markdown editing with `actions.onSaveDocument({ file, content, version })`; Platform preserves unsaved text and displays conflicts, while the host remains responsible for path authorization, optimistic version checks, serialization, atomic persistence, and returning the updated file snapshot.

## Capability plugins

`@agent-workbench/platform/plugins` provides a process-free registry for four declarative plugin kinds: `skill-source`, `mcp-server`, `cli-tool`, and `credential-provider`. Every plugin manifest has an `id`, `kind`, and `version`. `CapabilityPluginRegistry` supplies `register`, `unregister`, `list`, and `get`; registration rejects duplicate ids.

`resolveCapabilityPluginProfile(base, productOverlay)` merges `plugins` maps by plugin id. An overlay can replace `enabled`, `config`, and `credentialRefs`, so the same base profile works for project-free and project-scoped products without making projects part of Platform. Profiles contain credential references only; credential values and secret-like manifest, config, and health fields are rejected. `checkCapabilityPluginHealth(registry, profile)` runs each enabled optional plugin `check` and returns uniform `healthy`, `degraded`, `disabled`, or `error` results, including an explicit error for a profile entry whose plugin is not registered. The registry never launches tools, resolves credentials, reads product state, or performs network/process work.

The common catalog is stored in `capabilities/registry.json` and validated by `schemas/capability.schema.json`. Every common capability is disabled by default. A consumer merges this catalog with one or more `custom` catalogs using `mergeCapabilityCatalogs`; custom ids cannot shadow common ids. `resolveCapabilityInstallPlan` applies the consumer Profile, closes declared dependencies, and distinguishes `install`, `update`, `ready`, and `disabled` states against an optional prior lock. `createCapabilityLock` emits only stable ids, kinds, scopes, and versions, so it can be committed and moved between hosts without carrying absolute paths or secrets.

`@agent-workbench/platform/capability-installer` adds a product-neutral two-phase action dispatcher. Consumers register handlers by installation strategy; `plan()` is side-effect free and returns `ready`, `action-required`, `manual`, or `unsupported`, while `execute()` refuses confirmation-required work until the consumer supplies explicit confirmation. Public plans and results reject credential-value fields.

`@agent-workbench/platform/capability-manager` combines a catalog, host Profile/Lock store, health adapter, and installer into dependency-safe snapshots and mutations. `CapabilityPanel` renders the same normalized state in each React host. Skill-source components can be expanded and opened through the optional `actions.onInspectComponent(capabilityId, componentId)` host callback, while the consumer remains responsible for secure file resolution and read-only content. Platform owns the state semantics and confirmation flow; the consumer still owns persistence, host checks, package-manager execution, authentication, and navigation placement.

Platform never chooses or invokes a package manager by itself. Consumers still own authentication flows, local paths, MCP endpoints, persistence, and every side effect. The same common capability may therefore bind to Personal Browser on one product and Agent Terminal Playwright on another while keeping the stable `mcp.browser` id.

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm test
```

To start a new Workbench, first use the [`Workbench decision guide`](docs/operations/START_A_WORKBENCH.md) to choose between an Environment and a consumer repository. For the built-in project-free Host, follow the [`Environment runbook`](docs/operations/ENVIRONMENTS.md). Creating an Environment creates isolated instance data; it does not create a repository. A separate consumer repository is needed only when the product adds custom source code, routes, adapters, or deployment.

When updating `@playwright/mcp`, regenerate the versioned tool manifest:

```bash
npm run update:playwright-tools
```

## License

MIT

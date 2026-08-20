# Agent Workbench Platform

Shared, product-neutral building blocks for independent Codex workbench applications.

The package lets multiple products reuse one implementation while keeping their repositories, accounts, data, deployments, and product organization separate.

The current shared boundary and consumer migration order are defined in [`docs/architecture.md`](docs/architecture.md).

## Included

- Codex App Server connections for stdio and WebSocket transports
- Provider-neutral Session Kernel with queue, steer, interrupt, request, and replay contracts
- Session presentation, searchable/archivable Session list, message history paging, queue, image/inline-visualization rendering, Composer, status, and responsive React UI
- Codex-native Sub Agent discovery, metadata, active-Turn interruption, and thread-tree normalization
- Product-neutral Side Chat controller, state model, persistence and Runtime adapter contracts, and React panel
- Shared attachment metadata, limits, App Server inputs, approvals, and Realtime browser contracts
- Product-configurable Session capabilities: Realtime visible/hidden and Sub Agents hidden/summary/full
- On-demand shared MCP and Playwright Browser Provider primitives

## Product boundary

This repository does not contain product navigation, project or task management, credentials, account state, deployment configuration, persistent browser profiles, or product-specific memory and orchestration policies. Consumers provide those through adapters and UI extensions.

## Install

Pin a release tag from any GitHub or GitLab consumer:

```json
{
  "dependencies": {
    "@agent-workbench/platform": "https://github.com/ChenyangLin-J/agent-workbench-platform/archive/refs/tags/v0.3.9.tar.gz"
  }
}
```

Release tags follow semantic compatibility boundaries. Consumers may automatically accept a newer patch in their current minor line after their own tests pass; minor and major upgrades require product-level review. A package change on `main` must bump `package.json`: GitHub Actions tests it, creates the matching tag and release, and rejects package changes that reuse an existing version.

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
- `@agent-workbench/platform/capabilities`
- `@agent-workbench/platform/features/side-chat`
- `@agent-workbench/platform/ui-hooks`
- `@agent-workbench/platform/runtime`
- `@agent-workbench/platform/runtime/core`
- `@agent-workbench/platform/browser-provider`
- `@agent-workbench/platform/realtime-controller`
- `@agent-workbench/platform/ui`
- `@agent-workbench/platform/styles.css`

## UI ownership

`SessionBrowser` and `SessionWorkspace` provide the standard Session search/list/archive interaction, cursor-driven incremental list loading, transcript and earlier-message paging, lazy technical-detail loading, queued turns, requests, Composer, click/drag/paste attachment upload, model/reasoning/access selectors, model-advertised Fast service tier, user-message Edit/Fork actions, status, Sub Agent, and Realtime UI. Shared transcript rendering supports Codex `\\[...\\]` / `\\(...\\)` math through KaTeX and both the legacy `::codex-inline-vis` directive and current `visualize` content reference; directives inside fenced or indented code remain literal examples. Products resolve visualization paths through `actions.visualizationUrl` and remain responsible for their own allowlist. Agent commentary stays in the transcript while its Turn is running; after the Turn reaches a terminal status, consecutive commentary messages in that Turn share one compact disclosure without mixing command or tool details into the conversation. File selection uses the browser input event and snapshots its live `FileList` before resetting the field, so the current upload is retained and the same file can be selected again. Pasted clipboard files and images become attachments; a text paste of at least 1,000 characters, or one that would exceed the Composer limit, becomes a timestamped UTF-8 TXT attachment while ordinary text paste remains inline. Products supply the model catalog and implement `actions.onExecutionProfileChange` to apply execution settings through their Runtime adapter. `SideChatPanel` provides the shared Side Chat tabs, retained transcript, configuration and composer while the product supplies persistence and Runtime actions. Products mark eligible messages with `canEdit` / `canFork`, implement `actions.onEditMessage` / `actions.onForkMessage`, and supply grouping labels, archive and paging actions, and their own navigation. They can append product-specific content after a standard message with `extensions.renderAfterMessage`; Core does not know about projects, analysis cards, reports, or artifact canvases.

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm test
```

When updating `@playwright/mcp`, regenerate the versioned tool manifest:

```bash
npm run update:playwright-tools
```

## License

MIT

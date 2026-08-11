# Agent Workbench Platform

Shared, product-neutral building blocks for independent Codex workbench applications.

The package lets multiple products reuse one implementation while keeping their repositories, accounts, data, deployments, and product organization separate.

## Included

- Codex App Server connections for stdio and WebSocket transports
- Provider-neutral Session Kernel with queue, steer, interrupt, request, and replay contracts
- Session presentation, message stream, image/inline-visualization rendering, Composer, status, and responsive React UI
- Codex-native Sub Agent discovery, metadata, active-Turn interruption, and thread-tree normalization
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
    "@agent-workbench/platform": "https://github.com/ChenyangLin-J/agent-workbench-platform/archive/refs/tags/v0.2.1.tar.gz"
  }
}
```

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
- `@agent-workbench/platform/runtime`
- `@agent-workbench/platform/runtime/core`
- `@agent-workbench/platform/browser-provider`
- `@agent-workbench/platform/realtime-controller`
- `@agent-workbench/platform/ui`
- `@agent-workbench/platform/styles.css`

## UI ownership

`SessionBrowser` and `SessionWorkspace` provide the standard Session list, transcript, requests, Composer, attachments, status, Sub Agent, and Realtime UI. Products that keep an existing visual skin can reuse the same request state machine through `useSessionUserInput`. A product keeps its own navigation and can append product-specific content after a standard message with `extensions.renderAfterMessage`; Core does not know about projects, analysis cards, reports, or artifact canvases.

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

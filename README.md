# Agent Workbench Platform

Shared, product-neutral building blocks for independent Codex workbench applications.

The package lets multiple products reuse one implementation while keeping their repositories, accounts, data, deployments, and product organization separate.

## Included

- Codex App Server connections for stdio and WebSocket transports
- Provider-neutral Session Kernel with queue, steer, interrupt, request, and replay contracts
- Session presentation, message stream, Composer, status, and responsive React UI
- Codex-native Sub Agent discovery, metadata, active-Turn interruption, and thread-tree normalization
- Attachments, approvals, and Realtime V3 browser contracts
- On-demand shared MCP and Playwright Browser Provider primitives

## Product boundary

This repository does not contain product navigation, project or task management, credentials, account state, deployment configuration, persistent browser profiles, or product-specific memory and orchestration policies. Consumers provide those through adapters and UI extensions.

## Install

Pin a release tag from any GitHub or GitLab consumer:

```json
{
  "dependencies": {
    "@agent-workbench/platform": "git+https://github.com/ChenyangLin-J/agent-workbench-platform.git#v0.1.1"
  }
}
```

React consumers also provide the peer dependencies:

```json
{
  "dependencies": {
    "react": "^19.2.0",
    "react-dom": "^19.2.0"
  }
}
```

## Entry points

- `@agent-workbench/platform`
- `@agent-workbench/platform/session`
- `@agent-workbench/platform/subagents`
- `@agent-workbench/platform/runtime`
- `@agent-workbench/platform/runtime/core`
- `@agent-workbench/platform/browser-provider`
- `@agent-workbench/platform/realtime-controller`
- `@agent-workbench/platform/ui`
- `@agent-workbench/platform/styles.css`

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

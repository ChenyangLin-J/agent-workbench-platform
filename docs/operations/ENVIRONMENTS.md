# Runnable Environment Operations

Use this workflow to start the Platform-provided, project-free Minimal Host. An Environment is instance data and policy; it is not a source repository.

## Requirements

- Node.js 22 or newer and an installed package checkout.
- Docker only for the `docker` provider.
- A separate consumer repository only when custom routes, adapters, UI, product state or deployment are required.

## Create a Profile

Development mode can run the full Codex Session path, but it is not isolated. `environmentKeys` names variables that may be copied from the launching process; values never belong in the Profile or manifest.

```json
{
  "schema": "agent-workbench.environment-profile/v1",
  "id": "local-workbench",
  "isolation": {
    "provider": "development",
    "minimumLevel": "development",
    "environmentKeys": ["OPENAI_API_KEY"]
  }
}
```

For a strongly isolated offline Host, use Docker:

```json
{
  "schema": "agent-workbench.environment-profile/v1",
  "id": "offline-container",
  "features": { "attachments": false },
  "isolation": {
    "provider": "docker",
    "minimumLevel": "ephemeral-machine"
  }
}
```

The Docker provider currently rejects non-empty credential references, network targets, Capability locks and external effects. It also rejects noncanonical, symlinked, unavailable or sibling-state-exposing mount roots. This is intentional: model-backed or data-backed isolated Runs require an enforcing credential broker, egress proxy, Capability snapshot staging and effect/data adapter before they may report strong isolation.

## Lifecycle

```bash
agent-workbench env create --profile ./profile.json
agent-workbench env run <environment-id-or-path>
agent-workbench env inspect <environment-id-run-id-or-path>
agent-workbench env stop <environment-id-run-id-or-path>
```

Use `--root <directory>` on every command to replace the default `~/.agent-workbench/environments`. `env run` on an Environment creates a new immutable Run; running an existing stopped Run resumes its retained Session state. `env stop` on an Environment stops its active Runs.

The generated layout is:

```text
<storage>/<environment>/
├── environment.json
├── profile.json
└── runs/<run>/
    ├── manifest.json
    ├── runtime/
    ├── state/
    ├── workspace/
    ├── tmp/
    └── credentials/
```

The Host does not create `policies/`, `evaluations/` or `gold/`. A consumer or separate Evaluator may own those when its domain needs them.

## What to trust

`env inspect` is the public evidence surface. Check `requestedLevel`, `effectiveLevel`, every enforcement facet, resolved paths, versions and Capability lock. Do not infer isolation from the provider name or from a successful process start.

Docker Runs use a read-only workload container with dropped capabilities, no-new-privileges, process/memory/CPU limits, per-Run mounts and a unique internal-only network. A separate constrained ingress sidecar exposes only the fixed Host upstream on `127.0.0.1`; the workload has no published port or general egress path. The manifest records exact container, network and image identities for owned cleanup.

Stopping a Run removes its child resources and recreates an empty private transient-credential directory. It retains the manifest, Runtime and Session state. Retention or deletion of that state is consumer policy and is not an implicit part of `stop`.

## Verification

```bash
npm test
npm run test:docker-environment
```

The second command requires a running Docker daemon. It verifies the real container/network controls and exact cleanup; it does not prove a model turn because the strong provider is deliberately offline until the credential and egress brokers exist.

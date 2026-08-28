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

The Docker provider supports an empty Capability lock or immutable local `skill-source` snapshots. It rejects other Capability kinds, external effects, unsupported credential/network combinations, and noncanonical, symlinked, unavailable or sibling-state-exposing mount roots. A Skill Profile declares a portable lock plus a controller-only source path:

```json
{
  "capabilities": {
    "lock": {
      "capabilities": [
        { "id": "skills.candidate", "kind": "skill-source", "scope": "custom", "version": "1" }
      ]
    },
    "sources": [
      { "id": "skills.candidate", "path": "./candidate-skill" }
    ]
  }
}
```

The source must be a directory containing `SKILL.md`. Environment creation rejects symlinks, package/VCS cache directories, common credential filenames and private-key formats, and enforces size limits. It copies the source once into an Environment snapshot; later source edits do not change that Environment. Every Run receives a new hash-verified copy. Docker mounts only the Run copy read-only, and removes `capabilities.sources` from the workload Profile. The host-side stored Profile remains private controller state.

The one supported networked profile is a fixed Codex model channel:

```json
{
  "schema": "agent-workbench.environment-profile/v1",
  "id": "brokered-codex",
  "runtime": {
    "provider": "codex",
    "model": "gpt-5.6-sol"
  },
  "isolation": {
    "provider": "docker",
    "minimumLevel": "ephemeral-machine",
    "credentialReferences": ["credentials.codex-native"],
    "networkTargets": ["https://chatgpt.com/backend-api/codex"]
  }
}
```

Launch `env create` and `env run` with `CODEX_HOME` pointing at a logged-in Codex Runtime. The broker accepts only a private, unexpired ChatGPT `auth.json` whose access token has at least five minutes remaining. It deliberately rejects long-lived API keys. Only the access token, account id and expiry are staged into the broker-only secret mount; `auth.json` and the refresh token are never copied. The workload receives a per-Run service token for the fixed `/responses` and `/responses/compact` routes, and that token is excluded from Agent shell environments.

The broker does not refresh an expiring token. Refresh the source Codex login before creating a new Run. OpenMetadata, BigQuery and other data/service access still require consumer-owned enforcing adapters before they may report strong isolation.

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
├── capabilities/
├── environment.json
├── profile.json
└── runs/<run>/
    ├── capabilities/
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

Docker Runs use a read-only workload container with dropped capabilities, no-new-privileges, process/memory/CPU limits, per-Run mounts, read-only Skill snapshots and a unique internal-only network. A constrained ingress sidecar exposes only the fixed Host upstream on `127.0.0.1`. When model access is enabled, a second broker sidecar owns the short-lived upstream credential and can reach only the fixed ChatGPT Codex base URL; the workload still has no published port or general egress path. The manifest records exact container, network, image and snapshot identities for owned cleanup and reproducibility without credential values or host Skill source paths.

Stopping a Run removes its child resources and recreates an empty private transient-credential directory. It retains the manifest, Runtime and Session state. Retention or deletion of that state is consumer policy and is not an implicit part of `stop`.

## Verification

```bash
npm test
npm run test:docker-environment
```

The second command requires a running Docker daemon. It verifies both the offline path and a brokered Skill-snapshot path using a fake unexpired JWT without contacting OpenAI. It checks immutable snapshot behavior, the read-only snapshot mount, source-path removal, real workload/ingress/egress container controls, secret-mount separation, Runtime config parsing, refresh-token exclusion and exact cleanup. A real model turn remains consumer canary evidence and is not run automatically against a user's account.

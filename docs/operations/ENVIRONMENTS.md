# Runnable Environment Operations

Use this workflow to start the Platform-provided, project-free Minimal Host. An Environment is instance data and policy; it is not a source repository.

## Requirements

- Node.js 22 or newer and an installed package checkout.
- Docker only for the `docker` provider.
- Docker Environment storage and local Skill sources must be under a host path shared with the Docker daemon. On Docker Desktop for macOS, prefer a directory under `/Users`; an unshared `/tmp` or `/private/tmp` path will fail closed at container startup.
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

The Docker provider supports an empty Capability lock, immutable local `skill-source` snapshots, immutable trusted `mcp-server` snapshots, and the read-only adapter kinds documented below. It rejects other Capability kinds, unsupported effect/credential/network combinations, and noncanonical, symlinked, unavailable or sibling-state-exposing mount roots. A Skill Profile declares a portable lock plus a controller-only source path:

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

`SKILL.md` must contain a valid lowercase frontmatter `name`. The snapshot records that name, and Session startup calls the Codex Skill inventory API before creating a thread. Startup fails if a locked Skill is missing or an enabled Skill outside the immutable lock remains visible; a read-only mount by itself is not treated as Runtime enablement evidence.

An `mcp-server` source is also copied once at Environment creation and hash-verified for every Run. It must be a dependency-free ESM package with a lowercase `package.json` name and `type: "module"`. MCP snapshots are mounted only into their adapter sidecar and are never registered as Codex Skills.

Model access uses a fixed Codex channel:

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

The broker does not refresh an expiring token. Refresh the source Codex login before creating a new Run.

An Environment may instead declare one fixed OpenAI-compatible Responses gateway. The API key remains in a consumer-owned environment binding and is staged only into the model-egress sidecar:

```json
{
  "runtime": {
    "provider": "codex",
    "model": "gateway-model",
    "modelGateway": {
      "type": "openai-compatible-responses",
      "baseUrl": "https://gateway.example/v1",
      "credentialReference": "credentials.model-gateway"
    }
  },
  "isolation": {
    "provider": "docker",
    "minimumLevel": "ephemeral-machine",
    "credentialReferences": ["credentials.model-gateway"],
    "networkTargets": ["https://gateway.example/v1"]
  }
}
```

Bind `credentials.model-gateway` to a private environment key in the same bindings file used by `env create` and `env run`. The workload sees only a per-Run service token and the Run-local broker URL; it never receives the gateway key or arbitrary egress.

## Read-only data adapters

Version 0.9 adds two enforcing adapter kinds: `openmetadata-mcp-read` and `bigquery-read`. Each adapter has a matching `read-only-adapter` lock entry. The Profile declares only fixed targets, read effects, credential references and allowlists; credential locations live in a separate private bindings file.

Version 0.13 adds `module-mcp-read` for a consumer's reviewed, dependency-free read-only integration. Its matching lock entry is `mcp-server`; the adapter declares one snapshot entrypoint, an exact tool allowlist, fixed HTTPS targets, a namespaced read effect and the environment names mapped to private credential references. Platform snapshots the package, stages its credentials only into its sidecar, passes it a target-restricted fetch function, verifies that its startup tool catalog exactly matches the Profile, and rejects all other MCP methods and tool names before dispatch.

The injected fetch function follows the standard Fetch `Response` body contract (`body`, `text()`, `json()`, and `arrayBuffer()`) and observes the caller's `AbortSignal`. Consumer modules should still bound response size and timeout at their semantic layer.

This is a trusted-code extension, not an arbitrary plugin sandbox: the reviewed module is part of the adapter's enforcement boundary and must use the injected fetch function rather than opening its own sockets or child processes. Business packages and their account configuration remain in the consumer repository; Platform contains only the loader, isolation and validation contract.

```json
{
  "schema": "agent-workbench.environment-bindings/v1",
  "credentials": {
    "credentials.openmetadata-pat": { "source": "environment", "key": "OPENMETADATA_PAT" },
    "credentials.google-adc": { "source": "file", "path": "/private/controller/application_default_credentials.json" }
  }
}
```

The bindings file must be a `0600` regular file, not a symlink, and contains no credential values. OpenMetadata accepts only an environment binding; BigQuery accepts only a private ADC file binding. Pass the same file when the provider inspects or stages credentials:

```bash
agent-workbench env create --profile ./profile.json --bindings ./bindings.json
agent-workbench env run <environment> --bindings ./bindings.json
```

OpenMetadata fixes one HTTPS target and a non-empty subset of `search_metadata`, `get_entity_details`, and `get_entity_lineage`. Its sidecar filters discovery and rejects every other tool call before upstream contact. BigQuery fixes a billing project, readable-project allowlist, `maximumBytesBilled`, and `maximumRows`. It exposes only `dry_run_query` and `run_query`; execution repeats the dry run, requires BigQuery to classify the exact SQL as `SELECT`, rejects referenced projects outside the allowlist, and then uses the fixed BigQuery REST endpoint. The workload receives neither PAT, ADC nor `bq`.

The Profile's `credentialReferences`, `networkTargets`, and `externalEffects` must exactly equal the union required by the model broker and declared adapters. Surplus declarations fail closed like missing ones. Bindings and upstream values never enter the public manifest.

If the launching host has `HTTPS_PROXY` or `HTTP_PROXY`, the Docker Supervisor does not copy that controller setting or its credentials into the workload. It starts a per-Run authenticated CONNECT relay that accepts only `chatgpt.com:443`, and gives only the model-egress sidecar a random short-lived relay credential. The relay and credential disappear on stop. The current relay accepts an `http://` upstream proxy; unsupported proxy schemes fail startup explicitly.

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
    ├── resources/
    ├── workspace/
    ├── tmp/
    └── credentials/
```

The Host does not create `policies/`, `evaluations/` or `gold/`. A consumer or separate Evaluator may own those when its domain needs them.

## What to trust

`env inspect` is the public evidence surface. Check `requestedLevel`, `effectiveLevel`, every enforcement facet, resolved paths, versions and Capability lock. Credential, network, Capability and external-effect modes distinguish offline, model-brokered and data-backed Runs. Do not infer isolation from the provider name or a successful process start.

Docker Runs use a read-only workload container with dropped capabilities, no-new-privileges, process/memory/CPU limits, per-Run mounts, read-only Skill snapshots and a unique internal-only network. A constrained ingress sidecar exposes only the fixed Host upstream on `127.0.0.1`. The model broker and every data adapter use separate read-only sidecars, secret mounts, service tokens and fixed-target relays; the workload still has no published port or general egress path. The manifest records exact container, network, image, snapshot and safe adapter identities without credential values or host Skill source paths.

For an `ephemeral-machine` Run with `no-external-effects` or the enforced `read-only-data-adapter-allowlist`, Docker is the executable sandbox boundary. Codex therefore runs with `danger-full-access` and no per-command approval *inside that container*; nesting bubblewrap is not required and is not assumed to work on Docker Desktop. This does not grant host access: outer mounts, constructed environment, dropped capabilities, internal network, fixed brokers and per-Run identity remain the enforcement facts. Development mode and unenforced external effects keep interactive approval. Domain credentials must stay in enforcing sidecars.

Stopping a Run removes its child processes and provider-owned ephemeral resources, then recreates an empty private transient-credential directory. It retains the manifest, Runtime, Session state, and managed `resources` store. Retention or deletion of that state is consumer policy and is not an implicit part of `stop`.

## Verification

```bash
npm test
npm run test:docker-environment
npm run test:docker-data-adapters
```

The Docker commands require a running daemon. `test:docker-environment` verifies offline and brokered Skill-snapshot paths without contacting OpenAI. `test:docker-data-adapters` starts a BigQuery sidecar with fake ADC, proves the workload sees only `dry_run_query` / `run_query`, rejects an undeclared tool at the adapter boundary, checks mount separation and cleans every owned resource. Real model/data calls remain consumer canary evidence and are not run automatically against user accounts.

import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { lstat, realpath, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { codexModelBrokerRequest, createCodexNativeCredentialBroker } from './codex-credential.js';
import { capabilitySnapshotsReady, verifyCapabilitySnapshots } from './capability-snapshots.js';
import { createDataAdapterCredentialBroker, dataAdapterRequest } from './data-adapters.js';
import { defineIsolationProvider, providerError } from './providers.js';
import { isPathContained } from './paths.js';

const execFileAsync = promisify(execFile);
const SAFE_ENVIRONMENT_KEYS = new Set(['LANG', 'LC_ALL', 'TZ']);

export function createDockerIsolationProvider({
  dockerCommand = 'docker',
  spawnProcess = spawn,
  inspectDocker = defaultDockerInspection,
  credentialBroker = createCodexNativeCredentialBroker(),
  dataAdapterCredentialBroker = createDataAdapterCredentialBroker(),
} = {}) {
  return defineIsolationProvider({
    id: 'docker',
    async inspect(context = {}) {
      const profile = context.profile;
      const broker = await credentialBroker.inspect({ profile });
      const dataBroker = await dataAdapterCredentialBroker.inspect({ profile });
      let capabilitySnapshots = context.capabilitySnapshots || [];
      let capabilityReason = null;
      if (capabilitySnapshotsReady(profile, capabilitySnapshots) && capabilitySnapshots.length) {
        try {
          await verifyCapabilitySnapshots({
            sourceRoot: context.capabilitySnapshotRoot || context.paths?.capabilities,
            snapshots: capabilitySnapshots,
          });
        } catch (error) {
          capabilitySnapshots = [];
          capabilityReason = `Capability snapshot verification failed (${error.code || 'error'}).`;
        }
      }
      const facts = dockerProfileFacts(profile, {
        modelBrokerReady: broker.ready,
        dataAdapterBrokerReady: dataBroker.ready,
        capabilitySnapshots,
      });
      const filesystem = await dockerFilesystemFacts(profile, context);
      const docker = await inspectDocker(dockerCommand);
      const available = docker.available && facts.ready && filesystem.ready;
      const enforced = (condition = true) => docker.available && condition;
      const mode = (condition, satisfied, unsatisfied) => !docker.available
        ? 'docker-unavailable'
        : condition ? satisfied : unsatisfied;
      return {
        available,
        ...(available
          ? {}
          : { reason: [
              ...docker.reasons,
              ...facts.reasons,
              ...filesystem.reasons,
              ...(capabilityReason ? [capabilityReason] : []),
              ...(broker.reason ? [broker.reason] : []),
              ...(dataBroker.reason ? [dataBroker.reason] : []),
            ].join(' ') }),
        enforcement: {
          filesystem: { enforced: enforced(filesystem.ready), mode: mode(filesystem.ready, 'canonical-container-mount-allowlist', 'invalid-mount-boundary') },
          process: { enforced: enforced(), mode: mode(true, 'container-pid-namespace-and-limits', 'docker-unavailable') },
          environment: { enforced: enforced(facts.environment), mode: mode(facts.environment, 'constructed-container-env', 'unsupported-env-injection') },
          capabilities: { enforced: enforced(facts.capabilities), mode: mode(facts.capabilities, facts.capabilityMode, 'capability-staging-required') },
          credentials: {
            enforced: enforced(facts.credentials),
            mode: mode(
              facts.credentials,
              facts.modelBroker && facts.dataAdapters ? 'isolated-model-and-data-credential-brokers'
                : facts.modelBroker ? 'isolated-model-credential-broker'
                  : facts.dataAdapters ? 'isolated-data-adapter-credentials' : 'no-credentials',
              'credential-broker-required',
            ),
          },
          network: {
            enforced: enforced(facts.network),
            mode: mode(
              facts.network,
              facts.modelBroker
                ? facts.dataAdapters
                  ? 'internal-network-with-fixed-ingress-model-and-data-sidecars'
                  : 'internal-network-with-fixed-ingress-and-model-egress-sidecars'
                : facts.dataAdapters
                  ? 'internal-network-with-fixed-ingress-and-data-sidecars'
                  : 'internal-network-with-fixed-ingress-sidecar',
              'egress-proxy-required',
            ),
          },
          externalEffects: {
            enforced: enforced(facts.externalEffects),
            mode: mode(facts.externalEffects, facts.dataAdapters ? 'read-only-data-adapter-allowlist' : 'no-external-effects', 'effect-adapter-required'),
          },
          crossRun: { enforced: enforced(), mode: mode(true, 'unique-container-network-and-run-mounts', 'docker-unavailable') },
          ephemeralIdentity: { enforced: enforced(), mode: mode(true, 'auto-removed-container', 'docker-unavailable') },
        },
      };
    },
    async start({ launch, manifest, profile } = {}) {
      validateLaunch(launch);
      const args = launch.args.map((argument) => argument === '--internal-host' ? '--internal-docker-supervisor' : argument);
      if (!args.includes('--internal-docker-supervisor')) {
        throw providerError('DOCKER_SUPERVISOR_ENTRY_MISSING', 'Docker provider requires the internal container supervisor entry point.');
      }
      const brokerRequest = codexModelBrokerRequest(profile);
      const adapterRequest = dataAdapterRequest(profile);
      let stagedBrokerDirectory = null;
      let stagedAdapterDirectory = null;
      let stdout;
      let stderr;
      let child;
      try {
        if (brokerRequest.requested) {
          const inspection = await credentialBroker.inspect({ profile });
          if (!inspection.ready) {
            throw providerError('CODEX_CREDENTIAL_BROKER_UNAVAILABLE', inspection.reason || 'Codex credential broker is unavailable.');
          }
          stagedBrokerDirectory = join(manifest.paths.credentials, 'broker');
          await credentialBroker.stage({ profile, directory: stagedBrokerDirectory });
        }
        if (adapterRequest.requested) {
          const inspection = await dataAdapterCredentialBroker.inspect({ profile });
          if (!inspection.ready) {
            throw providerError('DATA_ADAPTER_CREDENTIAL_BROKER_UNAVAILABLE', inspection.reason || 'Data adapter credential broker is unavailable.');
          }
          stagedAdapterDirectory = join(manifest.paths.credentials, 'data-adapters');
          await dataAdapterCredentialBroker.stage({ profile, directory: stagedAdapterDirectory });
        }
        stdout = openSync(launch.stdoutPath, 'a', 0o600);
        stderr = openSync(launch.stderrPath, 'a', 0o600);
        const dockerEnvironment = await resolveDockerEnvironment(dockerCommand);
        child = spawnProcess(launch.command, args, {
          cwd: launch.cwd,
          env: {
            ...launch.environment,
            ...dockerEnvironment,
            ...controllerProxyEnvironment(process.env),
            AGENT_WORKBENCH_DOCKER_COMMAND: dockerCommand,
          },
          detached: true,
          shell: false,
          stdio: ['ignore', stdout, stderr],
        });
        if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
          throw providerError('DOCKER_SUPERVISOR_LAUNCH_FAILED', 'Docker supervisor did not return a valid process id.');
        }
      } catch (error) {
        await Promise.all([
          stagedBrokerDirectory ? rm(stagedBrokerDirectory, { recursive: true, force: true }) : null,
          stagedAdapterDirectory ? rm(stagedAdapterDirectory, { recursive: true, force: true }) : null,
        ]);
        throw error;
      } finally {
        if (stdout !== undefined) closeSync(stdout);
        if (stderr !== undefined) closeSync(stderr);
      }
      child.unref?.();
      return {
        pid: child.pid,
        processGroupId: child.pid,
        expectedArguments: args,
        startupTimeoutMs: 5 * 60_000,
      };
    },
    async stop({ pid, processGroupId = pid, verifyOwnership, manifest } = {}) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
        throw providerError('ISOLATION_PROCESS_INVALID', 'Refusing to stop an invalid Docker supervisor process.');
      }
      if (typeof verifyOwnership === 'function' && await verifyOwnership({ pid, processGroupId })) {
        try {
          // Signal only the supervisor. Its `docker wait` child must stay alive long
          // enough to observe the owned workload's graceful exit and clean sidecars.
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          if (error?.code !== 'ESRCH') throw error;
        }
        return { stopped: true };
      }
      const recovered = await recoverOwnedDockerResources(dockerCommand, manifest);
      if (recovered) return { stopped: true, recovered: true };
      throw providerError('ISOLATION_PROCESS_UNOWNED', `Refusing to stop unverified Docker supervisor ${pid}.`);
    },
  });
}

function controllerProxyEnvironment(environment) {
  const proxy = environment.HTTPS_PROXY || environment.https_proxy || environment.HTTP_PROXY || environment.http_proxy;
  return proxy ? { AGENT_WORKBENCH_HOST_HTTPS_PROXY: proxy } : {};
}

async function dockerFilesystemFacts(profile = {}, context = {}) {
  const reasons = [];
  const paths = [
    ...(profile.isolation?.filesystem?.readableRoots || []),
    ...(profile.isolation?.filesystem?.writableRoots || []),
  ];
  const environmentRoot = context.paths?.runs
    ? context.paths.root
    : context.paths?.root ? dirname(dirname(context.paths.root)) : null;
  for (const path of paths) {
    if (path === '/' || /[,\n\r]/.test(path)) {
      reasons.push(`Unsafe container mount root: ${path}.`);
      continue;
    }
    try {
      const [info, canonical, target] = await Promise.all([lstat(path), realpath(path), stat(path)]);
      if (info.isSymbolicLink() || canonical !== resolve(path)) reasons.push(`Container mount root must be canonical and not a symlink: ${path}.`);
      if (!target.isDirectory()) reasons.push(`Container mount root must be a directory: ${path}.`);
      if (environmentRoot && isPathContained(path, environmentRoot)) {
        reasons.push(`Container mount root would expose Environment or sibling Run state: ${path}.`);
      }
    } catch (error) {
      reasons.push(`Container mount root is unavailable: ${path} (${error.code || 'error'}).`);
    }
  }
  return { ready: reasons.length === 0, reasons };
}

async function recoverOwnedDockerResources(dockerCommand, manifest) {
  const state = manifest?.process?.providerState;
  if (!state || manifest?.isolation?.provider !== 'docker') return false;
  let found = false;
  const adapterContainerIds = Array.isArray(state.dataAdapters)
    ? state.dataAdapters.map((adapter) => adapter?.containerId).filter(Boolean)
    : [];
  for (const id of [state.containerId, state.ingressId, state.egressId, ...adapterContainerIds].filter(Boolean)) {
    let label;
    try {
      ({ stdout: label } = await execFileAsync(dockerCommand, ['inspect', '--format', '{{index .Config.Labels "ai.agent-workbench.run"}}', id], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }));
    } catch {
      continue;
    }
    if (String(label).trim() !== manifest.id) {
      throw providerError('DOCKER_CONTAINER_UNOWNED', `Refusing to remove unowned container ${id}.`);
    }
    found = true;
    await execFileAsync(dockerCommand, ['rm', '--force', id], { timeout: 20_000, maxBuffer: 1024 * 1024 });
  }
  if (state.networkName) {
    let label;
    try {
      ({ stdout: label } = await execFileAsync(dockerCommand, ['network', 'inspect', '--format', '{{index .Labels "ai.agent-workbench.run"}}', state.networkName], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      }));
    } catch {
      label = null;
    }
    if (label != null) {
      if (String(label).trim() !== manifest.id) {
        throw providerError('DOCKER_NETWORK_UNOWNED', `Refusing to remove unowned network ${state.networkName}.`);
      }
      found = true;
      await execFileAsync(dockerCommand, ['network', 'rm', state.networkName], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    }
  }
  return found;
}

async function resolveDockerEnvironment(dockerCommand) {
  const environment = {};
  for (const key of ['DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) {
    if (typeof process.env[key] === 'string' && process.env[key]) environment[key] = process.env[key];
  }
  if (!environment.DOCKER_HOST) {
    try {
      const { stdout } = await execFileAsync(dockerCommand, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const host = String(stdout).trim();
      if (host) environment.DOCKER_HOST = host;
    } catch {
      // docker info in inspect() remains the source of the user-facing availability error.
    }
  }
  return environment;
}

export function dockerProfileFacts(profile = {}, {
  modelBrokerReady = false,
  dataAdapterBrokerReady = false,
  capabilitySnapshots = [],
} = {}) {
  const reasons = [];
  const environmentKeys = profile.isolation?.environmentKeys || [];
  const unsafeEnvironmentKeys = environmentKeys.filter((key) => !SAFE_ENVIRONMENT_KEYS.has(key));
  const environment = unsafeEnvironmentKeys.length === 0;
  if (!environment) reasons.push(`Container environment keys require a secret-safe broker: ${unsafeEnvironmentKeys.join(', ')}.`);
  const lockEntries = profile.capabilities?.lock?.capabilities || [];
  const emptyCapabilityLock = lockEntries.length === 0;
  const supportedCapabilityKinds = lockEntries.every((entry) => ['skill-source', 'read-only-adapter'].includes(entry.kind));
  const capabilities = supportedCapabilityKinds && capabilitySnapshotsReady(profile, capabilitySnapshots);
  if (!capabilities) reasons.push('Container capability snapshots are not staged yet.');
  const brokerRequest = codexModelBrokerRequest(profile);
  const adapterRequest = dataAdapterRequest(profile);
  const expectedCredentials = [
    ...(brokerRequest.requested ? [brokerRequest.credentialReference].filter(Boolean) : []),
    ...adapterRequest.credentialReferences,
  ];
  const expectedNetwork = [
    ...(brokerRequest.requested ? [brokerRequest.target].filter(Boolean) : []),
    ...adapterRequest.networkTargets,
  ];
  const credentials = exactStringSet(profile.isolation?.credentialReferences, expectedCredentials)
    && (!brokerRequest.requested || (brokerRequest.supported && modelBrokerReady))
    && (!adapterRequest.requested || (adapterRequest.supported && dataAdapterBrokerReady));
  if (!credentials) reasons.push('Container credential references require the supported isolated model credential broker.');
  const network = exactStringSet(profile.isolation?.networkTargets, expectedNetwork)
    && (!brokerRequest.requested || (brokerRequest.supported && modelBrokerReady))
    && (!adapterRequest.requested || adapterRequest.supported);
  if (!network) reasons.push('Container network targets require the supported fixed model egress broker.');
  const externalEffects = exactStringSet(profile.isolation?.externalEffects?.read, adapterRequest.externalEffects.read)
    && exactStringSet(profile.isolation?.externalEffects?.write, []);
  if (!externalEffects) reasons.push('Declared external effects require an enforcing capability adapter.');
  const hasSkill = lockEntries.some((entry) => entry.kind === 'skill-source');
  return {
    environment,
    capabilities,
    capabilityMode: emptyCapabilityLock ? 'empty-capability-lock'
      : adapterRequest.requested && hasSkill ? 'immutable-skill-snapshots-and-read-only-adapters'
        : adapterRequest.requested ? 'locked-read-only-adapters' : 'immutable-skill-snapshots',
    credentials,
    network,
    externalEffects,
    modelBroker: brokerRequest.requested && brokerRequest.supported && modelBrokerReady,
    dataAdapters: adapterRequest.requested && adapterRequest.supported && dataAdapterBrokerReady,
    ready: environment && capabilities && credentials && network && externalEffects,
    reasons,
  };
}

function exactStringSet(actual = [], expected = []) {
  const left = [...new Set(actual || [])].sort();
  const right = [...new Set(expected || [])].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function defaultDockerInspection(dockerCommand) {
  try {
    const { stdout } = await execFileAsync(dockerCommand, ['info', '--format', '{{.ServerVersion}}'], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const version = String(stdout).trim();
    return version
      ? { available: true, version, reasons: [] }
      : { available: false, version: null, reasons: ['Docker daemon did not report a version.'] };
  } catch (error) {
    return { available: false, version: null, reasons: [`Docker daemon is unavailable: ${error.message}.`] };
  }
}

function validateLaunch(launch) {
  if (!launch || typeof launch !== 'object') throw new TypeError('Docker isolation launch descriptor is required');
  for (const name of ['command', 'cwd', 'stdoutPath', 'stderrPath']) {
    if (typeof launch[name] !== 'string' || !launch[name]) throw new TypeError(`Docker isolation launch ${name} is required`);
  }
  if (!Array.isArray(launch.args) || launch.args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Docker isolation launch args must be strings');
  }
  if (!launch.environment || typeof launch.environment !== 'object') throw new TypeError('Docker isolation launch environment is required');
}

import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import { createDockerIsolationProvider } from './docker-provider.js';
import { codexModelBrokerRequest, readStagedCodexCredential } from './codex-credential.js';
import { environmentProfileHash } from './contracts.js';
import {
  removeHostIdentity,
  removeTransientCredentials,
  writeHostIdentity,
} from './process.js';
import { inspectIsolationProvider } from './providers.js';
import {
  markRunStopped,
  readEnvironmentManifest,
  readStoredEnvironmentProfile,
} from './store.js';

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOCKERFILE = join(PACKAGE_ROOT, 'containers', 'minimal-host.Dockerfile');
const CONTAINER_PORT = 4178;
const INGRESS_PORT = 4180;
const MODEL_EGRESS_PORT = 4190;
const MODEL_BROKER_ENV_KEY = 'AGENT_WORKBENCH_MODEL_BROKER_TOKEN';

export async function runDockerSupervisor(runTarget, {
  dockerCommand = process.env.AGENT_WORKBENCH_DOCKER_COMMAND || 'docker',
  requestedPort = 0,
} = {}) {
  const manifest = await readEnvironmentManifest(runTarget);
  if (manifest.kind !== 'run') throw new TypeError('Docker supervisor requires a Run target');
  manifest.paths.capabilities ||= join(manifest.paths.root, 'capabilities');
  manifest.capabilities.snapshots ||= [];
  await mkdir(manifest.paths.capabilities, { recursive: true, mode: 0o700 });
  const profile = await readStoredEnvironmentProfile(manifest.paths.root);
  const stagedBrokerCredentialPath = join(manifest.paths.credentials, 'broker', 'model.json');
  const provider = createDockerIsolationProvider({
    dockerCommand,
    credentialBroker: {
      async inspect() {
        if (!codexModelBrokerRequest(profile).requested) return { ready: true, requested: false };
        try {
          const credential = await readStagedCodexCredential(stagedBrokerCredentialPath);
          return { ready: true, requested: true, target: credential.target, expiresAt: credential.expiresAt };
        } catch {
          return { ready: false, requested: true, reason: 'The staged Codex model credential is unavailable.' };
        }
      },
      async stage() {
        throw new Error('Docker supervisor cannot stage host credentials.');
      },
    },
  });
  const inspection = await inspectIsolationProvider(provider, {
    phase: 'docker-supervisor',
    manifest,
    profile,
    paths: manifest.paths,
    capabilitySnapshots: manifest.capabilities.snapshots,
    capabilitySnapshotRoot: manifest.paths.capabilities,
  });
  if (!inspection.available || inspection.effectiveLevel !== 'ephemeral-machine') {
    throw supervisorError('ISOLATION_REQUIREMENT_UNSATISFIED', inspection.reason || 'Docker isolation is not enforceable.');
  }
  const accessToken = process.env.AGENT_WORKBENCH_HOST_TOKEN;
  if (!accessToken) throw supervisorError('ENVIRONMENT_HOST_TOKEN_MISSING', 'Docker supervisor requires a transient Host token.');
  const suffix = createHash('sha256').update(manifest.id).digest('hex').slice(0, 16);
  const containerName = `awb-${suffix}-workload`;
  const ingressName = `awb-${suffix}-ingress`;
  const egressName = `awb-${suffix}-model-egress`;
  const networkName = `awb-net-${suffix}`;
  const image = await ensureImage(dockerCommand);
  const workloadSecretRoot = join(manifest.paths.credentials, 'workload');
  const brokerSecretRoot = join(manifest.paths.credentials, 'broker');
  const configRoot = join(workloadSecretRoot, 'config');
  const tokenPath = join(workloadSecretRoot, 'host-token');
  const brokerTokenPath = join(workloadSecretRoot, 'model-broker-token');
  const brokerServiceTokenPath = join(brokerSecretRoot, 'service-token');
  const brokerCredentialPath = stagedBrokerCredentialPath;
  const brokerStateRoot = join(manifest.paths.state, 'model-broker');
  const brokerReadyPath = join(brokerStateRoot, 'ready.json');
  const readyPath = join(manifest.paths.state, 'container-ready.json');
  const brokerRequest = codexModelBrokerRequest(profile);
  const modelCredential = brokerRequest.requested
    ? await readStagedCodexCredential(brokerCredentialPath)
    : null;
  const modelBroker = modelCredential ? {
    baseUrl: `http://${egressName}:${MODEL_EGRESS_PORT}`,
    envKey: MODEL_BROKER_ENV_KEY,
    target: modelCredential.target,
    expiresAt: modelCredential.expiresAt,
  } : null;
  const workloadProfile = containerProfile(profile);
  await Promise.all([rm(readyPath, { force: true }), rm(brokerReadyPath, { force: true })]);
  await mkdir(configRoot, { recursive: true, mode: 0o700 });
  if (modelBroker) await mkdir(brokerStateRoot, { recursive: true, mode: 0o700 });
  await writeFile(tokenPath, `${accessToken}\n`, { mode: 0o600, flag: 'wx' });
  if (modelBroker) {
    const serviceToken = randomBytes(32).toString('base64url');
    await Promise.all([
      writeFile(brokerTokenPath, `${serviceToken}\n`, { mode: 0o600, flag: 'wx' }),
      writeFile(brokerServiceTokenPath, `${serviceToken}\n`, { mode: 0o600, flag: 'wx' }),
    ]);
  }
  const containerManifest = containerRunManifest(manifest, workloadProfile, inspection, { modelBroker });
  await writeFile(join(configRoot, 'manifest.json'), `${JSON.stringify(containerManifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await writeFile(join(configRoot, 'profile.json'), `${JSON.stringify(workloadProfile, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  let containerId = null;
  let ingressId = null;
  let egressId = null;
  let stopping = false;
  let failure = null;

  async function cleanup() {
    if (stopping) return;
    stopping = true;
    if (containerId) await stopOwnedContainer(dockerCommand, containerId, manifest.id).catch(() => {});
    if (ingressId) await stopOwnedContainer(dockerCommand, ingressId, manifest.id).catch(() => {});
    if (egressId) await stopOwnedContainer(dockerCommand, egressId, manifest.id).catch(() => {});
    await removeOwnedNetwork(dockerCommand, networkName, manifest.id).catch(() => {});
    await removeTransientCredentials(manifest).catch(() => {});
    await removeHostIdentity(manifest).catch(() => {});
    await markRunStopped(manifest.paths.root, { failure }).catch(() => {});
  }

  const onSignal = () => void cleanup().finally(() => process.exit(0));
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  try {
    await dockerExec(dockerCommand, [
      'network', 'create', '--internal',
      '--label', `ai.agent-workbench.run=${manifest.id}`,
      networkName,
    ]);
    if (modelBroker) {
      egressId = (await dockerExec(dockerCommand, dockerModelEgressArguments({
        image: image.tag,
        egressName,
        runId: manifest.id,
        brokerSecretRoot,
        brokerStateRoot,
      }))).trim();
      await dockerExec(dockerCommand, ['network', 'connect', networkName, egressId]);
      await waitForModelBrokerReady({
        readyPath: brokerReadyPath,
        manifest,
        credential: modelCredential,
        dockerCommand,
        egressId,
      });
    }
    const runArgs = dockerRunArguments({
      manifest,
      profile: workloadProfile,
      image: image.tag,
      containerName,
      networkName,
      workloadSecretRoot,
      configRoot,
      modelBroker,
    });
    containerId = (await dockerExec(dockerCommand, runArgs)).trim();
    ingressId = (await dockerExec(dockerCommand, dockerIngressArguments({
      image: image.tag,
      ingressName,
      runId: manifest.id,
      requestedPort,
      upstreamHost: containerName,
    }))).trim();
    await dockerExec(dockerCommand, ['network', 'connect', networkName, ingressId]);
    const hostPort = await waitForPublishedPort(dockerCommand, ingressName, INGRESS_PORT);
    await waitForContainerReady({
      readyPath,
      manifest,
      hostPort,
      accessToken,
      dockerCommand,
      containerId,
      ingressId,
    });
    await writeHostIdentity(manifest, {
      port: hostPort,
      inspection,
      providerState: {
        containerId,
        containerName,
        ingressId,
        ingressName,
        ...(egressId ? { egressId, egressName } : {}),
        networkName,
        networkMode: 'internal-with-fixed-ingress',
        image: image.tag,
        imageId: image.id,
        ...(modelBroker ? {
          modelBrokerTarget: modelBroker.target,
          modelCredentialExpiresAt: modelBroker.expiresAt,
        } : {}),
      },
    });
    const exitCode = Number((await dockerExec(dockerCommand, ['wait', containerId], { timeout: 0 })).trim());
    if (exitCode !== 0) failure = supervisorError('ENVIRONMENT_CONTAINER_EXITED', `Minimal Host container exited with ${exitCode}.`);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanup();
  }
}

function containerRunManifest(manifest, profile, inspection, { modelBroker = null } = {}) {
  const root = '/run/workbench';
  const paths = {
    root,
    runtime: `${root}/runtime`,
    state: `${root}/state`,
    workspace: `${root}/workspace`,
    temporary: `${root}/tmp`,
    credentials: '/run/credentials',
    capabilities: `${root}/capabilities`,
  };
  return {
    ...manifest,
    status: 'created',
    profile: {
      id: manifest.profile.id,
      hash: environmentProfileHash(profile),
      source: { type: 'controller-snapshot' },
    },
    runtime: {
      ...manifest.runtime,
      ...(modelBroker ? { modelBroker: { baseUrl: modelBroker.baseUrl, envKey: modelBroker.envKey } } : {}),
    },
    paths,
    isolation: {
      ...manifest.isolation,
      available: inspection.available,
      effectiveLevel: inspection.effectiveLevel,
      enforcement: inspection.enforcement,
      filesystem: {
        readableRoots: [...new Set([
          ...profile.isolation.filesystem.readableRoots,
          root,
          `${root}/config`,
          paths.capabilities,
          '/run/credentials',
        ])],
        writableRoots: [...new Set([...profile.isolation.filesystem.writableRoots, paths.runtime, paths.state, paths.workspace, paths.temporary])],
      },
    },
    process: { pid: null, port: null, providerState: {} },
    lifecycle: { ...manifest.lifecycle, startedAt: null, stoppedAt: null, failure: null },
  };
}

function dockerRunArguments({ manifest, profile, image, containerName, networkName, workloadSecretRoot, configRoot, modelBroker }) {
  const args = [
    'run', '--detach',
    '--name', containerName,
    '--label', `ai.agent-workbench.run=${manifest.id}`,
    '--network', networkName,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--memory', '4g',
    '--cpus', '2',
    '--user', `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
    '--tmpfs', '/run/workbench/tmp:rw,nosuid,size=512m',
    '--mount', mount(manifest.paths.runtime, '/run/workbench/runtime', false),
    '--mount', mount(manifest.paths.state, '/run/workbench/state', false),
    '--mount', mount(manifest.paths.workspace, '/run/workbench/workspace', false),
    '--mount', mount(manifest.paths.capabilities, '/run/workbench/capabilities', true),
    '--mount', mount(workloadSecretRoot, '/run/credentials', true),
    '--mount', mount(configRoot, '/run/workbench/config', true),
    '--env', 'HOME=/run/workbench/runtime/home',
    '--env', 'TMPDIR=/run/workbench/tmp',
    '--env', 'NODE_ENV=production',
    '--env', 'AGENT_WORKBENCH_CONTAINER_ISOLATION=ephemeral-machine',
    '--env', 'AGENT_WORKBENCH_BIND_HOST=0.0.0.0',
    '--env', 'AGENT_WORKBENCH_PARENT_MANAGES_LIFECYCLE=1',
    '--env', 'AGENT_WORKBENCH_PROFILE_PATH=/run/workbench/config/profile.json',
    '--env', 'AGENT_WORKBENCH_HOST_TOKEN_FILE=/run/credentials/host-token',
    '--env', 'AGENT_WORKBENCH_READY_FILE=/run/workbench/state/container-ready.json',
  ];
  if (modelBroker) {
    args.push('--env', 'AGENT_WORKBENCH_MODEL_BROKER_TOKEN_FILE=/run/credentials/model-broker-token');
  }
  for (const path of profile.isolation.filesystem.readableRoots) {
    args.push('--mount', mount(path, path, true));
  }
  for (const path of profile.isolation.filesystem.writableRoots) {
    args.push('--mount', mount(path, path, false));
  }
  for (const key of profile.isolation.environmentKeys) {
    if (process.env[key] != null) args.push('--env', `${key}=${process.env[key]}`);
  }
  args.push(image, '--internal-host', '/run/workbench/config/manifest.json', '--port', String(CONTAINER_PORT));
  return args;
}

function containerProfile(profile) {
  return {
    ...profile,
    capabilities: {
      lock: profile.capabilities.lock,
      sources: [],
    },
  };
}

function dockerModelEgressArguments({ image, egressName, runId, brokerSecretRoot, brokerStateRoot }) {
  return [
    'run', '--detach',
    '--name', egressName,
    '--label', `ai.agent-workbench.run=${runId}`,
    '--network', 'bridge',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '64',
    '--memory', '256m',
    '--cpus', '0.5',
    '--user', `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    '--mount', mount(brokerSecretRoot, '/run/secrets', true),
    '--mount', mount(brokerStateRoot, '/run/broker-state', false),
    image,
    '--internal-model-egress',
    '--credential-file', '/run/secrets/model.json',
    '--service-token-file', '/run/secrets/service-token',
    '--ready-file', '/run/broker-state/ready.json',
    '--run-id', runId,
    '--port', String(MODEL_EGRESS_PORT),
  ];
}

function dockerIngressArguments({ image, ingressName, runId, requestedPort, upstreamHost }) {
  const publish = requestedPort
    ? `127.0.0.1:${requestedPort}:${INGRESS_PORT}`
    : `127.0.0.1::${INGRESS_PORT}`;
  return [
    'run', '--detach',
    '--name', ingressName,
    '--label', `ai.agent-workbench.run=${runId}`,
    '--network', 'bridge',
    '--publish', publish,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '64',
    '--memory', '256m',
    '--cpus', '0.5',
    '--user', '65534:65534',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
    image,
    '--internal-ingress-proxy',
    '--upstream-host', upstreamHost,
    '--upstream-port', String(CONTAINER_PORT),
    '--port', String(INGRESS_PORT),
  ];
}

async function ensureImage(dockerCommand) {
  const packageDocument = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  const sourceHash = await packageSourceHash();
  const tag = `agent-workbench-minimal-host:${packageDocument.version}-${sourceHash.slice(0, 12)}`;
  try {
    const id = (await dockerExec(dockerCommand, ['image', 'inspect', '--format', '{{.Id}}', tag])).trim();
    if (id) return { tag, id };
  } catch {
    // Build the immutable local package version when it is not cached.
  }
  let buildError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await dockerSpawn(dockerCommand, ['build', '--file', DOCKERFILE, '--tag', tag, PACKAGE_ROOT]);
      buildError = null;
      break;
    } catch (error) {
      buildError = error;
      if (attempt < 2) await delay(1_000 * (attempt + 1));
    }
  }
  if (buildError) throw buildError;
  const id = (await dockerExec(dockerCommand, ['image', 'inspect', '--format', '{{.Id}}', tag])).trim();
  if (!id) throw supervisorError('DOCKER_IMAGE_BUILD_FAILED', `Docker image ${tag} was not created.`);
  return { tag, id };
}

async function packageSourceHash() {
  const hash = createHash('sha256');
  for (const relativePath of [
    '.dockerignore',
    'package.json',
    'package-lock.json',
    'containers/minimal-host.Dockerfile',
  ]) {
    hash.update(relativePath).update('\0').update(await readFile(join(PACKAGE_ROOT, relativePath)));
  }
  for (const directory of ['bin', 'capabilities', 'schemas', 'src']) {
    for (const path of await filesBelow(join(PACKAGE_ROOT, directory))) {
      const relativePath = path.slice(PACKAGE_ROOT.length + 1);
      hash.update(relativePath).update('\0').update(await readFile(path));
    }
  }
  return hash.digest('hex');
}

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(path));
    else if (entry.isFile()) result.push(path);
  }
  return result.sort();
}

async function waitForPublishedPort(dockerCommand, containerName, containerPort) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const output = await dockerExec(dockerCommand, ['port', containerName, `${containerPort}/tcp`]).catch(() => '');
    const match = String(output).match(/(?:127\.0\.0\.1|\[::1\]):(\d+)$/m);
    if (match) return Number(match[1]);
    await delay(50);
  }
  throw supervisorError('DOCKER_PORT_UNAVAILABLE', 'Docker did not publish the fixed ingress port on loopback.');
}

async function waitForModelBrokerReady({ readyPath, manifest, credential, dockerCommand, egressId }) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const running = (await dockerExec(dockerCommand, ['inspect', '--format', '{{.State.Running}}', egressId])).trim();
    if (running !== 'true') {
      const logs = await dockerLogs(dockerCommand, egressId).catch(() => '');
      if (logs) process.stderr.write(`${logs.slice(-12_000)}\n`);
      throw supervisorError('MODEL_BROKER_EXITED', 'Fixed model egress broker exited during startup.');
    }
    try {
      const ready = JSON.parse(await readFile(readyPath, 'utf8'));
      if (ready.runId !== manifest.id || ready.target !== credential.target || ready.expiresAt !== credential.expiresAt) {
        throw supervisorError('MODEL_BROKER_IDENTITY_MISMATCH', 'Model broker ready evidence does not match this Run.');
      }
      return;
    } catch (error) {
      if (error?.code && error.code !== 'ENOENT') throw error;
    }
    await delay(50);
  }
  throw supervisorError('MODEL_BROKER_START_TIMEOUT', 'Fixed model egress broker did not become ready.');
}

async function waitForContainerReady({ readyPath, manifest, hostPort, accessToken, dockerCommand, containerId, ingressId }) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const running = (await dockerExec(dockerCommand, ['inspect', '--format', '{{.State.Running}}', containerId])).trim();
    if (running !== 'true') {
      const logs = await dockerLogs(dockerCommand, containerId).catch(() => '');
      if (logs) process.stderr.write(`${logs.slice(-12_000)}\n`);
      throw supervisorError('ENVIRONMENT_CONTAINER_EXITED', 'Minimal Host container exited during startup.');
    }
    const ingressRunning = (await dockerExec(dockerCommand, ['inspect', '--format', '{{.State.Running}}', ingressId])).trim();
    if (ingressRunning !== 'true') {
      const logs = await dockerLogs(dockerCommand, ingressId).catch(() => '');
      if (logs) process.stderr.write(`${logs.slice(-12_000)}\n`);
      throw supervisorError('ENVIRONMENT_INGRESS_EXITED', 'Fixed ingress sidecar exited during startup.');
    }
    try {
      const ready = JSON.parse(await readFile(readyPath, 'utf8'));
      if (ready.runId !== manifest.id) throw supervisorError('ENVIRONMENT_CONTAINER_IDENTITY_MISMATCH', 'Container ready file belongs to another Run.');
      const response = await fetch(`http://127.0.0.1:${hostPort}/api/health`, {
        headers: { 'x-agent-workbench-token': accessToken },
      });
      if (response.ok) return;
    } catch (error) {
      if (error?.code && error.code !== 'ENOENT') throw error;
    }
    await delay(50);
  }
  throw supervisorError('ENVIRONMENT_CONTAINER_START_TIMEOUT', 'Minimal Host container did not become ready.');
}

async function stopOwnedContainer(dockerCommand, containerId, runId) {
  const label = (await dockerExec(dockerCommand, ['inspect', '--format', '{{index .Config.Labels "ai.agent-workbench.run"}}', containerId])).trim();
  if (label !== runId) throw supervisorError('DOCKER_CONTAINER_UNOWNED', `Refusing to stop unowned container ${containerId}.`);
  const running = (await dockerExec(dockerCommand, ['inspect', '--format', '{{.State.Running}}', containerId])).trim();
  if (running === 'true') await dockerExec(dockerCommand, ['stop', '--time', '10', containerId]);
  await dockerExec(dockerCommand, ['rm', '--force', containerId]);
}

async function removeOwnedNetwork(dockerCommand, networkName, runId) {
  let label;
  try {
    label = (await dockerExec(dockerCommand, ['network', 'inspect', '--format', '{{index .Labels "ai.agent-workbench.run"}}', networkName])).trim();
  } catch {
    return;
  }
  if (label !== runId) throw supervisorError('DOCKER_NETWORK_UNOWNED', `Refusing to remove unowned network ${networkName}.`);
  await dockerExec(dockerCommand, ['network', 'rm', networkName]);
}

function mount(source, target, readonly) {
  return `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`;
}

async function dockerExec(command, args, { timeout = 30_000 } = {}) {
  const options = { maxBuffer: 5 * 1024 * 1024 };
  if (timeout > 0) options.timeout = timeout;
  const { stdout } = await execFileAsync(command, args, options);
  return stdout;
}

async function dockerLogs(command, containerId) {
  const { stdout, stderr } = await execFileAsync(command, ['logs', '--tail', '120', containerId], {
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return `${stdout || ''}${stderr || ''}`;
}

function dockerSpawn(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(supervisorError('DOCKER_COMMAND_FAILED', `${command} ${args[0]} exited with ${code}.`)));
  });
}

function supervisorError(code, message) {
  return Object.assign(new Error(message), { code });
}

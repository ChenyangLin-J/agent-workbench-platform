import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { CODEX_PROVIDER_VERSION } from '../runtime/core/version.js';
import {
  ENVIRONMENT_MANIFEST_SCHEMA,
  assertNoSecretMaterial,
  environmentProfileHash,
  normalizeEnvironmentProfile,
  stableStringify,
} from './contracts.js';
import {
  IsolationProviderRegistry,
  createDevelopmentIsolationProvider,
  inspectIsolationProvider,
} from './providers.js';
import { isPathContained, resolveContainedPath } from './paths.js';
import { copyCapabilitySnapshots, stageCapabilitySnapshots } from './capability-snapshots.js';

const PACKAGE_JSON_URL = new URL('../../package.json', import.meta.url);
const PLATFORM_VERSION = JSON.parse(await readFile(PACKAGE_JSON_URL, 'utf8')).version;
const ENVIRONMENT_FILE = 'environment.json';
const RUN_FILE = 'manifest.json';

export async function createEnvironment({
  storageRoot,
  profile,
  profileSource = null,
  providers = [createDevelopmentIsolationProvider()],
  environmentId = null,
  now = () => new Date(),
  uuid = randomUUID,
  platformVersion = PLATFORM_VERSION,
  runtimeVersion = CODEX_PROVIDER_VERSION,
} = {}) {
  if (typeof storageRoot !== 'string' || !storageRoot.trim()) throw new TypeError('storageRoot is required');
  const source = normalizeProfileSource(profileSource);
  const normalizedProfile = normalizeEnvironmentProfile(profile, {
    baseDirectory: source.type === 'file' ? dirname(source.path) : process.cwd(),
  });
  const registry = providerRegistry(providers);
  const provider = registry.get(normalizedProfile.isolation.provider);
  const createdAt = isoTime(now());

  await mkdir(resolve(storageRoot), { recursive: true, mode: 0o700 });
  const canonicalStorageRoot = await realpath(resolve(storageRoot));
  const id = environmentId == null
    ? generatedId(normalizedProfile.id, createdAt, uuid())
    : instanceId(environmentId, 'environment id');
  const environmentRoot = join(canonicalStorageRoot, id);
  const temporaryRoot = join(canonicalStorageRoot, `.${id}.creating-${uuid()}`);
  const paths = {
    root: environmentRoot,
    runs: join(environmentRoot, 'runs'),
    capabilities: join(environmentRoot, 'capabilities'),
  };

  await assertMissing(environmentRoot, `Environment already exists: ${id}`);
  await mkdir(temporaryRoot, { recursive: false, mode: 0o700 });
  try {
    await mkdir(join(temporaryRoot, 'runs'), { mode: 0o700 });
    const capabilitySnapshots = await stageCapabilitySnapshots({
      profile: normalizedProfile,
      targetRoot: join(temporaryRoot, 'capabilities'),
    });
    const inspection = await inspectIsolationProvider(provider, {
      phase: 'create',
      profile: normalizedProfile,
      paths,
      capabilitySnapshots,
      capabilitySnapshotRoot: join(temporaryRoot, 'capabilities'),
    });
    const manifest = environmentManifest({
      id,
      profile: normalizedProfile,
      source,
      paths,
      inspection,
      capabilitySnapshots,
      createdAt,
      platformVersion,
      runtimeVersion,
    });
    await writeJsonExclusive(join(temporaryRoot, 'profile.json'), normalizedProfile);
    await writeJsonExclusive(join(temporaryRoot, ENVIRONMENT_FILE), manifest);
    await rename(temporaryRoot, environmentRoot);
    return structuredClone(manifest);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function createEnvironmentRun(environmentTarget, {
  providers = [createDevelopmentIsolationProvider()],
  runId = null,
  now = () => new Date(),
  uuid = randomUUID,
} = {}) {
  const environment = await readEnvironmentManifest(environmentTarget);
  if (environment.kind !== 'environment') throw new TypeError('createEnvironmentRun requires an environment target');
  const environmentRoot = await realpath(environment.paths.root);
  const runsRoot = await resolveContainedPath(environmentRoot, environment.paths.runs);
  const profileDocument = JSON.parse(await readFile(await resolveContainedPath(environmentRoot, 'profile.json'), 'utf8'));
  const profile = normalizeEnvironmentProfile(profileDocument, { baseDirectory: environmentRoot });
  if (environment.profile.hash !== environmentProfileHash(profile)) {
    throw environmentError('ENVIRONMENT_PROFILE_CHANGED', 'The stored environment Profile does not match its manifest.');
  }
  const registry = providerRegistry(providers);
  const provider = registry.get(profile.isolation.provider);
  const createdAt = isoTime(now());
  const id = runId == null ? generatedId('run', createdAt, uuid()) : instanceId(runId, 'run id');
  const runRoot = join(runsRoot, id);
  const temporaryRoot = join(runsRoot, `.${id}.creating-${uuid()}`);
  const paths = runPaths(runRoot);

  await assertMissing(runRoot, `Run already exists: ${id}`);
  await mkdir(temporaryRoot, { recursive: false, mode: 0o700 });
  try {
    for (const name of ['runtime', 'state', 'workspace', 'tmp', 'credentials', 'capabilities']) {
      await mkdir(join(temporaryRoot, name), { mode: 0o700 });
    }
    const storedCapabilitySnapshots = environment.capabilities.snapshots || [];
    const capabilitySnapshots = await copyCapabilitySnapshots({
      sourceRoot: storedCapabilitySnapshots.length
        ? await resolveContainedPath(environmentRoot, environment.paths.capabilities)
        : null,
      targetRoot: join(temporaryRoot, 'capabilities'),
      snapshots: storedCapabilitySnapshots,
    });
    const inspection = await inspectIsolationProvider(provider, {
      phase: 'run-create',
      environment,
      profile,
      paths,
      capabilitySnapshots,
      capabilitySnapshotRoot: join(temporaryRoot, 'capabilities'),
    });
    const manifest = runManifest({
      environment,
      profile,
      id,
      paths,
      inspection,
      capabilitySnapshots,
      createdAt,
    });
    await writeJsonExclusive(join(temporaryRoot, RUN_FILE), manifest);
    await rename(temporaryRoot, runRoot);
    return structuredClone(manifest);
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function readEnvironmentManifest(target) {
  const manifestPath = await findManifest(target);
  const document = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateStoredManifest(document, manifestPath);
  return structuredClone(document);
}

export async function inspectEnvironment(target) {
  const manifest = await readEnvironmentManifest(target);
  assertNoSecretMaterial(manifest, 'environment manifest');
  return manifest;
}

export async function readStoredEnvironmentProfile(target) {
  const manifest = await readEnvironmentManifest(target);
  const environmentRoot = manifest.kind === 'environment'
    ? manifest.paths.root
    : dirname(dirname(manifest.paths.root));
  const profilePath = await resolveContainedPath(environmentRoot, 'profile.json');
  const profile = normalizeEnvironmentProfile(JSON.parse(await readFile(profilePath, 'utf8')), {
    baseDirectory: environmentRoot,
  });
  if (manifest.profile.hash !== environmentProfileHash(profile)) {
    throw environmentError('ENVIRONMENT_PROFILE_CHANGED', 'The stored environment Profile does not match its manifest.');
  }
  return profile;
}

export async function markRunStarted(runTarget, {
  pid,
  port,
  providerState = {},
  inspection = null,
  startedAt = new Date(),
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('run pid must be a positive integer');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('run port must be valid');
  assertNoSecretMaterial(providerState, 'provider state');
  return mutateRun(runTarget, (manifest) => {
    if (!['created', 'stopped', 'failed'].includes(manifest.status)) {
      throw environmentError('ENVIRONMENT_RUN_ALREADY_ACTIVE', `Cannot start Run from ${manifest.status}.`);
    }
    const timestamp = isoTime(startedAt);
    return {
      ...manifest,
      status: 'running',
      process: { pid, port, providerState: structuredClone(providerState) },
      isolation: inspection ? {
        ...manifest.isolation,
        provider: inspection.provider,
        effectiveLevel: inspection.effectiveLevel,
        available: inspection.available,
        enforcement: inspection.enforcement,
        ...(inspection.reason == null ? {} : { reason: inspection.reason }),
      } : manifest.isolation,
      lifecycle: { ...manifest.lifecycle, startedAt: timestamp, stoppedAt: null, failure: null },
    };
  });
}

export async function markRunStopped(runTarget, {
  stoppedAt = new Date(),
  failure = null,
} = {}) {
  return mutateRun(runTarget, (manifest) => ({
    ...manifest,
    status: failure == null ? 'stopped' : 'failed',
    process: { pid: null, port: null, providerState: {} },
    lifecycle: {
      ...manifest.lifecycle,
      stoppedAt: isoTime(stoppedAt),
      failure: failure == null ? null : safeFailure(failure),
    },
  }));
}

export async function findManifest(target) {
  if (typeof target !== 'string' || !target.trim()) throw new TypeError('environment target is required');
  const absolute = resolve(target);
  const info = await stat(absolute);
  if (info.isFile()) return realpath(absolute);
  if (!info.isDirectory()) throw new TypeError(`environment target must be a file or directory: ${absolute}`);
  for (const filename of [RUN_FILE, ENVIRONMENT_FILE]) {
    const candidate = join(absolute, filename);
    try {
      return await realpath(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  throw environmentError('ENVIRONMENT_MANIFEST_NOT_FOUND', `No environment manifest found in ${absolute}.`);
}

function environmentManifest({
  id,
  profile,
  source,
  paths,
  inspection,
  capabilitySnapshots,
  createdAt,
  platformVersion,
  runtimeVersion,
}) {
  const manifest = {
    schema: ENVIRONMENT_MANIFEST_SCHEMA,
    kind: 'environment',
    id,
    status: 'created',
    versions: { platform: String(platformVersion), runtime: String(runtimeVersion) },
    profile: {
      id: profile.id,
      hash: environmentProfileHash(profile),
      source,
    },
    runtime: profile.runtime,
    features: profile.features,
    capabilities: {
      lock: profile.capabilities.lock,
      hash: sha256(profile.capabilities.lock),
      snapshots: capabilitySnapshots,
    },
    isolation: isolationManifest(profile, inspection, paths),
    paths,
    extensions: profile.extensions,
    lifecycle: { createdAt },
  };
  assertNoSecretMaterial(manifest, 'environment manifest');
  return manifest;
}

function runManifest({ environment, profile, id, paths, inspection, capabilitySnapshots, createdAt }) {
  const manifest = {
    schema: ENVIRONMENT_MANIFEST_SCHEMA,
    kind: 'run',
    id,
    environmentId: environment.id,
    status: 'created',
    versions: environment.versions,
    profile: environment.profile,
    runtime: environment.runtime,
    features: environment.features,
    capabilities: { ...environment.capabilities, snapshots: capabilitySnapshots },
    isolation: isolationManifest(profile, inspection, paths),
    paths,
    process: { pid: null, port: null, providerState: {} },
    extensions: environment.extensions,
    lifecycle: { createdAt, startedAt: null, stoppedAt: null, failure: null },
  };
  assertNoSecretMaterial(manifest, 'Run manifest');
  return manifest;
}

function isolationManifest(profile, inspection, paths) {
  return {
    provider: profile.isolation.provider,
    requestedLevel: profile.isolation.minimumLevel,
    effectiveLevel: inspection.effectiveLevel,
    available: inspection.available,
    ...(inspection.reason == null ? {} : { reason: inspection.reason }),
    enforcement: inspection.enforcement,
    filesystem: {
      readableRoots: uniqueSorted([
        ...profile.isolation.filesystem.readableRoots,
        ...['capabilities'].map((name) => paths[name]).filter(Boolean),
      ]),
      writableRoots: uniqueSorted([
        ...profile.isolation.filesystem.writableRoots,
        ...['runs', 'runtime', 'state', 'workspace', 'temporary', 'credentials']
          .map((name) => paths[name])
          .filter(Boolean),
      ]),
    },
    environmentKeys: profile.isolation.environmentKeys,
    networkTargets: profile.isolation.networkTargets,
    credentialReferences: profile.isolation.credentialReferences,
    externalEffects: profile.isolation.externalEffects,
  };
}

function runPaths(root) {
  return {
    root,
    runtime: join(root, 'runtime'),
    state: join(root, 'state'),
    workspace: join(root, 'workspace'),
    temporary: join(root, 'tmp'),
    credentials: join(root, 'credentials'),
    capabilities: join(root, 'capabilities'),
  };
}

async function mutateRun(target, updater) {
  const manifestPath = await findManifest(target);
  const current = await readEnvironmentManifest(manifestPath);
  if (current.kind !== 'run') throw new TypeError('Run target is required');
  if (!isPathContained(current.paths.root, manifestPath)) {
    throw environmentError('ENVIRONMENT_MANIFEST_OUTSIDE_RUN', 'Run manifest is outside its declared root.');
  }
  const next = updater(current);
  validateStoredManifest(next, manifestPath);
  assertNoSecretMaterial(next, 'Run manifest');
  await writeJsonAtomic(manifestPath, next);
  return structuredClone(next);
}

function validateStoredManifest(document, manifestPath) {
  if (!document || typeof document !== 'object' || document.schema !== ENVIRONMENT_MANIFEST_SCHEMA) {
    throw environmentError('ENVIRONMENT_MANIFEST_INVALID', `Invalid environment manifest: ${manifestPath}`);
  }
  if (!['environment', 'run'].includes(document.kind)) {
    throw environmentError('ENVIRONMENT_MANIFEST_INVALID', `Unsupported environment manifest kind: ${document.kind}`);
  }
  if (!document.paths?.root || !isPathContained(document.paths.root, manifestPath)) {
    throw environmentError('ENVIRONMENT_MANIFEST_PATH_MISMATCH', 'Manifest is outside its declared environment root.');
  }
  assertNoSecretMaterial(document, 'environment manifest');
}

function normalizeProfileSource(profileSource) {
  if (profileSource == null) return { type: 'inline' };
  if (typeof profileSource !== 'string' || !profileSource.trim()) throw new TypeError('profileSource must be a file path');
  return { type: 'file', path: resolve(profileSource) };
}

function providerRegistry(providers) {
  if (providers instanceof IsolationProviderRegistry) return providers;
  return new IsolationProviderRegistry(providers);
}

async function writeJsonExclusive(path, value) {
  assertNoSecretMaterial(value, basename(path));
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = join(dirname(path), `.${basename(path)}.writing-${randomUUID()}`);
  try {
    await writeJsonExclusive(temporary, value);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function assertMissing(path, message) {
  try {
    await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw environmentError('ENVIRONMENT_ALREADY_EXISTS', message);
}

function generatedId(prefix, date, value) {
  const timestamp = date.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'z').toLowerCase();
  return instanceId(`${prefix}-${timestamp}-${String(value).replaceAll('-', '').slice(0, 10).toLowerCase()}`, 'generated id');
}

function instanceId(value, label) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,95}$/.test(value)) {
    throw new TypeError(`${label} must use 2-96 lowercase letters, digits, or hyphens`);
  }
  return value;
}

function isoTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('lifecycle time must be a valid date');
  return date.toISOString();
}

function sha256(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function uniqueSorted(values) {
  return [...new Set(values.map((value) => resolve(value)))].sort();
}

function safeFailure(failure) {
  const code = String(failure?.code || 'ENVIRONMENT_RUN_FAILED');
  const message = String(failure?.message || failure || 'Run failed.');
  return { code, message };
}

function environmentError(code, message, details = undefined) {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

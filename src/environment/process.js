import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertIsolationSatisfied,
  inspectIsolationProvider,
} from './providers.js';
import {
  findManifest,
  markRunStarted,
  markRunStopped,
  readEnvironmentManifest,
  readStoredEnvironmentProfile,
} from './store.js';
import { isPathContained } from './paths.js';

const execFileAsync = promisify(execFile);
const HOST_IDENTITY_FILE = 'host.json';

export async function launchEnvironmentRun(runTarget, {
  provider,
  executable,
  internalHostScript,
  port = 0,
  sourceEnvironment = process.env,
  wait = delay,
  startupTimeoutMs = 20_000,
} = {}) {
  const manifest = await readEnvironmentManifest(runTarget);
  if (manifest.kind !== 'run') throw new TypeError('Run target is required');
  if (manifest.status === 'running') {
    if (await verifyRunProcessOwnership(manifest)) return { manifest, reused: true, url: hostUrl(manifest) };
    throw processError('ENVIRONMENT_RUN_STALE', `Run ${manifest.id} claims to be running without its owned Host process.`);
  }
  const profile = await readStoredEnvironmentProfile(manifest.paths.root);
  const inspection = await inspectIsolationProvider(provider, {
    phase: 'run-start',
    manifest,
    profile,
    paths: manifest.paths,
  });
  assertIsolationSatisfied(inspection, profile.isolation.minimumLevel);
  if (typeof executable !== 'string' || !executable) throw new TypeError('Host executable is required');
  if (typeof internalHostScript !== 'string' || !internalHostScript) throw new TypeError('internalHostScript is required');
  const accessToken = randomBytes(32).toString('base64url');
  await mkdir(manifest.paths.state, { recursive: true, mode: 0o700 });
  const launch = {
    command: executable,
    args: [internalHostScript, '--internal-host', manifest.paths.root, '--port', String(port)],
    cwd: manifest.paths.workspace,
    environment: hostEnvironment(manifest, profile, sourceEnvironment, accessToken),
    stdoutPath: join(manifest.paths.state, 'host.stdout.log'),
    stderrPath: join(manifest.paths.state, 'host.stderr.log'),
  };
  const started = await provider.start({ manifest, profile, inspection, launch });
  const ownership = {
    pid: started.pid,
    processGroupId: started.processGroupId || started.pid,
    expectedArguments: started.expectedArguments || launch.args,
  };
  try {
    const identity = await waitForHostIdentity(manifest, ownership, {
      wait,
      startupTimeoutMs: Math.max(startupTimeoutMs, started.startupTimeoutMs || 0),
    });
    const response = await fetch(`http://127.0.0.1:${identity.port}/api/health`, {
      headers: { 'x-agent-workbench-token': accessToken },
    });
    if (!response.ok) throw processError('ENVIRONMENT_HOST_UNHEALTHY', `Minimal Host health check failed (${response.status}).`);
    return {
      manifest: await readEnvironmentManifest(manifest.paths.root),
      reused: false,
      url: `http://127.0.0.1:${identity.port}`,
    };
  } catch (error) {
    await provider.stop({
      ...ownership,
      verifyOwnership: () => verifyProcessLaunch(ownership),
    }).catch(() => {});
    await markRunStopped(manifest.paths.root, { failure: error }).catch(() => {});
    throw error;
  }
}

export async function stopEnvironmentRun(runTarget, { provider, wait = delay } = {}) {
  const manifest = await readEnvironmentManifest(runTarget);
  if (manifest.kind !== 'run') throw new TypeError('Run target is required');
  if (manifest.status !== 'running' || !manifest.process?.pid) {
    return { manifest, stopped: false, reason: 'not-running' };
  }
  const ownership = {
    pid: manifest.process.pid,
    processGroupId: manifest.process.providerState?.processGroupId || manifest.process.pid,
    runRoot: manifest.paths.root,
  };
  await provider.stop({
    ...ownership,
    manifest,
    verifyOwnership: () => verifyRunProcessOwnership(manifest),
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await readEnvironmentManifest(manifest.paths.root);
    if (current.status !== 'running') return { manifest: current, stopped: true };
    if (!await processExists(ownership.pid)) break;
    await wait(50);
  }
  await removeTransientCredentials(manifest);
  return { manifest: await markRunStopped(manifest.paths.root), stopped: true };
}

export async function writeHostIdentity(manifest, { port, inspection, providerState = {} } = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new TypeError('Host port is invalid');
  const processGroupId = await currentProcessGroupId();
  const identity = {
    schemaVersion: 1,
    runId: manifest.id,
    pid: process.pid,
    processGroupId,
    port,
    startedAt: new Date().toISOString(),
  };
  await writeFile(hostIdentityPath(manifest), `${JSON.stringify(identity, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  await markRunStarted(manifest.paths.root, {
    pid: process.pid,
    port,
    providerState: {
      processGroupId,
      identityFile: hostIdentityPath(manifest),
      ...providerState,
    },
    inspection,
  });
  return identity;
}

export async function removeHostIdentity(manifest) {
  await rm(hostIdentityPath(manifest), { force: true });
}

export async function removeTransientCredentials(manifest) {
  const credentials = resolve(manifest.paths.credentials);
  if (!isPathContained(manifest.paths.root, credentials) || credentials === resolve(manifest.paths.root)) {
    throw processError('ENVIRONMENT_CREDENTIAL_PATH_INVALID', 'Credential path is outside the Run root.');
  }
  await rm(credentials, { recursive: true, force: true });
  await mkdir(credentials, { recursive: true, mode: 0o700 });
}

export async function verifyRunProcessOwnership(manifest) {
  const pid = Number(manifest?.process?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !await processExists(pid)) return false;
  let identity;
  try {
    identity = JSON.parse(await readFile(hostIdentityPath(manifest), 'utf8'));
  } catch {
    return false;
  }
  if (identity.runId !== manifest.id || identity.pid !== pid) return false;
  const record = await processRecord(pid);
  if (!record || record.processGroupId !== identity.processGroupId) return false;
  return (record.command.includes('--internal-host') || record.command.includes('--internal-docker-supervisor'))
    && record.command.includes(manifest.paths.root);
}

export async function listEnvironmentRuns(environmentTarget) {
  const environment = await readEnvironmentManifest(environmentTarget);
  if (environment.kind !== 'environment') throw new TypeError('Environment target is required');
  const entries = await readdir(environment.paths.runs, { withFileTypes: true });
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    try {
      runs.push(await readEnvironmentManifest(join(environment.paths.runs, entry.name)));
    } catch {
      // An incomplete or foreign directory is not an Environment Run.
    }
  }
  return runs.sort((left, right) => Date.parse(right.lifecycle.createdAt) - Date.parse(left.lifecycle.createdAt));
}

export async function resolveEnvironmentTarget(target, { storageRoot } = {}) {
  if (typeof target !== 'string' || !target.trim()) throw new TypeError('environment target is required');
  try {
    return dirname(await findManifest(target));
  } catch (error) {
    if (!storageRoot || !['ENOENT', 'ENVIRONMENT_MANIFEST_NOT_FOUND'].includes(error?.code)) throw error;
  }
  const environmentCandidate = join(resolve(storageRoot), target);
  try {
    return dirname(await findManifest(environmentCandidate));
  } catch (error) {
    if (!['ENOENT', 'ENVIRONMENT_MANIFEST_NOT_FOUND'].includes(error?.code)) throw error;
  }
  const environments = await readdir(resolve(storageRoot), { withFileTypes: true });
  const matches = [];
  for (const environment of environments) {
    if (!environment.isDirectory() || environment.name.startsWith('.')) continue;
    const candidate = join(resolve(storageRoot), environment.name, 'runs', target);
    try {
      matches.push(dirname(await findManifest(candidate)));
    } catch (error) {
      if (!['ENOENT', 'ENVIRONMENT_MANIFEST_NOT_FOUND'].includes(error?.code)) throw error;
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw processError('ENVIRONMENT_TARGET_AMBIGUOUS', `Run id is ambiguous: ${target}`);
  throw processError('ENVIRONMENT_TARGET_NOT_FOUND', `Environment or Run not found: ${target}`);
}

function hostEnvironment(manifest, profile, source, accessToken) {
  const environment = {};
  for (const key of unique(['LANG', 'LC_ALL', 'PATH', ...profile.isolation.environmentKeys])) {
    if (typeof source[key] === 'string') environment[key] = source[key];
  }
  environment.HOME = join(manifest.paths.runtime, 'home');
  environment.TMPDIR = manifest.paths.temporary;
  environment.NODE_ENV = 'production';
  environment.AGENT_WORKBENCH_HOST_TOKEN = accessToken;
  return environment;
}

async function waitForHostIdentity(manifest, ownership, { wait, startupTimeoutMs }) {
  const attempts = Math.max(1, Math.ceil(startupTimeoutMs / 50));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!await processExists(ownership.pid)) {
      throw processError('ENVIRONMENT_HOST_EXITED', `Minimal Host process ${ownership.pid} exited during startup.`);
    }
    try {
      const identity = JSON.parse(await readFile(hostIdentityPath(manifest), 'utf8'));
      if (identity.pid !== ownership.pid || identity.runId !== manifest.id) {
        throw processError('ENVIRONMENT_HOST_IDENTITY_MISMATCH', 'Minimal Host identity does not match the launched Run.');
      }
      return identity;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await wait(50);
  }
  throw processError('ENVIRONMENT_HOST_START_TIMEOUT', 'Minimal Host did not report ready before the startup timeout.');
}

async function verifyProcessLaunch({ pid, processGroupId, expectedArguments }) {
  const record = await processRecord(pid);
  return Boolean(record
    && record.processGroupId === processGroupId
    && expectedArguments.every((argument) => record.command.includes(argument)));
}

async function currentProcessGroupId() {
  return (await processRecord(process.pid))?.processGroupId || process.pid;
}

async function processRecord(pid) {
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'pid=,pgid=,command=', '-p', String(pid)]);
    const match = String(stdout).trim().match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/);
    return match ? { pid: Number(match[1]), processGroupId: Number(match[2]), command: match[3] } : null;
  } catch {
    return null;
  }
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

function hostIdentityPath(manifest) {
  return join(manifest.paths.state, HOST_IDENTITY_FILE);
}

function hostUrl(manifest) {
  return manifest.process?.port ? `http://127.0.0.1:${manifest.process.port}` : null;
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function processError(code, message) {
  return Object.assign(new Error(message), { code });
}

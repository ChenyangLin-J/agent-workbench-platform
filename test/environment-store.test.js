import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDevelopmentIsolationProvider,
  createEnvironment,
  createEnvironmentRun,
  defineIsolationProvider,
  inspectEnvironment,
  launchEnvironmentRun,
  markRunStarted,
  markRunStopped,
} from '../src/environment/index.js';

function fixedClock() {
  return new Date('2026-08-28T01:02:03.000Z');
}

function ids() {
  let sequence = 0;
  return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

test('environment and Run manifests are created atomically with private instance paths', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'awb-env-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const uuid = ids();
  const environment = await createEnvironment({
    storageRoot,
    profile: { id: 'minimal-host' },
    now: fixedClock,
    uuid,
  });
  assert.equal(environment.kind, 'environment');
  assert.equal(environment.isolation.effectiveLevel, 'development');
  assert.equal(environment.paths.root.startsWith(await realpath(storageRoot)), true);
  assert.equal((await stat(environment.paths.root)).mode & 0o077, 0);
  assert.equal((await stat(join(environment.paths.root, 'environment.json'))).mode & 0o077, 0);
  const run = await createEnvironmentRun(environment.paths.root, { now: fixedClock, uuid });
  assert.equal(run.kind, 'run');
  assert.equal(run.environmentId, environment.id);
  assert.equal(run.process.pid, null);
  for (const path of Object.values(run.paths)) await access(path);
  assert.deepEqual(await inspectEnvironment(run.paths.root), run);
});

test('manifests never persist credential values and reject profile tampering', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'awb-env-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  await assert.rejects(() => createEnvironment({
    storageRoot,
    profile: { id: 'unsafe-host', extensions: { 'ai.ddit.unsafe': { password: 'plain-text' } } },
  }), /must not contain credential values/);
  const environment = await createEnvironment({ storageRoot, profile: { id: 'safe-host' } });
  const storedProfilePath = join(environment.paths.root, 'profile.json');
  const storedProfile = JSON.parse(await readFile(storedProfilePath, 'utf8'));
  storedProfile.title = 'tampered';
  await writeFile(storedProfilePath, `${JSON.stringify(storedProfile)}\n`);
  await assert.rejects(() => createEnvironmentRun(environment.paths.root), {
    code: 'ENVIRONMENT_PROFILE_CHANGED',
  });
});

test('an empty-capability Environment created before snapshot paths still creates a Run', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'awb-env-legacy-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const environment = await createEnvironment({ storageRoot, profile: { id: 'legacy-empty' } });
  const manifestPath = join(environment.paths.root, 'environment.json');
  const legacyManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  delete legacyManifest.paths.capabilities;
  delete legacyManifest.capabilities.snapshots;
  await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, { mode: 0o600 });
  await rm(environment.paths.capabilities, { recursive: true, force: true });
  const run = await createEnvironmentRun(environment.paths.root);
  assert.deepEqual(run.capabilities.snapshots, []);
  await access(run.paths.capabilities);
});

test('Run lifecycle writes only safe process identity and clears provider state on stop', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'awb-env-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const provider = createDevelopmentIsolationProvider();
  const environment = await createEnvironment({ storageRoot, profile: { id: 'lifecycle' }, providers: [provider] });
  const run = await createEnvironmentRun(environment.paths.root, { providers: [provider] });
  const started = await markRunStarted(run.paths.root, { pid: 42, port: 3210, providerState: { processGroup: 42 } });
  assert.equal(started.status, 'running');
  assert.equal(started.process.pid, 42);
  await assert.rejects(() => markRunStarted(run.paths.root, { pid: 43, port: 3211 }), {
    code: 'ENVIRONMENT_RUN_ALREADY_ACTIVE',
  });
  const stopped = await markRunStopped(run.paths.root);
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(stopped.process, { pid: null, port: null, providerState: {} });
});

test('failed provider startup clears staged credentials and records only a safe failure', async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'awb-env-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const enforcement = Object.fromEntries([
    'filesystem', 'process', 'environment', 'capabilities', 'credentials',
    'network', 'externalEffects', 'crossRun', 'ephemeralIdentity',
  ].map((name) => [name, { enforced: true, mode: `test-${name}` }]));
  const provider = defineIsolationProvider({
    id: 'failing',
    async inspect() { return { available: true, enforcement }; },
    async start({ manifest }) {
      await writeFile(join(manifest.paths.credentials, 'transient-secret'), 'must-be-removed', { mode: 0o600 });
      throw Object.assign(new Error('provider startup failed safely'), { code: 'PROVIDER_START_FAILED' });
    },
    async stop() {},
  });
  const environment = await createEnvironment({
    storageRoot,
    profile: { id: 'failed-start', isolation: { provider: 'failing', minimumLevel: 'ephemeral-machine' } },
    providers: [provider],
  });
  const run = await createEnvironmentRun(environment.paths.root, { providers: [provider] });
  await assert.rejects(() => launchEnvironmentRun(run.paths.root, {
    provider,
    executable: process.execPath,
    internalHostScript: '/tmp/unused-host.js',
  }), { code: 'PROVIDER_START_FAILED' });
  assert.deepEqual(await readdir(run.paths.credentials), []);
  const failed = await inspectEnvironment(run.paths.root);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.lifecycle.failure, {
    code: 'PROVIDER_START_FAILED',
    message: 'provider startup failed safely',
  });
  assert.equal(JSON.stringify(failed).includes('must-be-removed'), false);
});

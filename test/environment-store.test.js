import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createDevelopmentIsolationProvider,
  createEnvironment,
  createEnvironmentRun,
  inspectEnvironment,
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

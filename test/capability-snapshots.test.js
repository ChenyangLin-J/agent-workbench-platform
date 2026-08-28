import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createEnvironment,
  createEnvironmentRun,
  createDockerIsolationProvider,
  launchEnvironmentRun,
  prepareMinimalRuntimeConfiguration,
} from '../src/environment/index.js';

test('Environment and Run stage immutable Skill snapshots without exposing source paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-capability-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'candidate-skill');
  await mkdir(join(source, 'references'), { recursive: true, mode: 0o700 });
  await writeFile(join(source, 'SKILL.md'), skill('original'), { mode: 0o600 });
  await writeFile(join(source, 'references', 'guide.md'), 'original guide\n', { mode: 0o600 });
  const environment = await createEnvironment({
    storageRoot: join(root, 'environments'),
    profile: skillProfile(source),
  });
  assert.equal(environment.capabilities.snapshots.length, 1);
  assert.equal(JSON.stringify(environment).includes(source), false);
  const snapshot = environment.capabilities.snapshots[0];
  assert.equal(await readFile(join(environment.paths.capabilities, snapshot.directory, 'SKILL.md'), 'utf8'), skill('original'));

  await writeFile(join(source, 'SKILL.md'), skill('changed-after-environment'), { mode: 0o600 });
  const run = await createEnvironmentRun(environment.paths.root);
  assert.deepEqual(run.capabilities.snapshots, environment.capabilities.snapshots);
  assert.equal(await readFile(join(run.paths.capabilities, snapshot.directory, 'SKILL.md'), 'utf8'), skill('original'));

  await mkdir(join(run.paths.runtime, 'codex-home'), { recursive: true, mode: 0o700 });
  const prepared = await prepareMinimalRuntimeConfiguration({ manifest: run });
  const config = await readFile(prepared.configPath, 'utf8');
  assert.match(config, new RegExp(`${escapeRegExp(join(run.paths.capabilities, snapshot.directory, 'SKILL.md'))}`));
  assert.equal(config.includes(source), false);
  assert.deepEqual(prepared.environment, {});
});

test('Run creation rejects a changed Environment capability snapshot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-capability-tamper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'candidate-skill');
  await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'SKILL.md'), skill('original'), { mode: 0o600 });
  const environment = await createEnvironment({ storageRoot: join(root, 'environments'), profile: skillProfile(source) });
  const snapshot = environment.capabilities.snapshots[0];
  await writeFile(join(environment.paths.capabilities, snapshot.directory, 'SKILL.md'), skill('tampered'), { mode: 0o600 });
  await assert.rejects(() => createEnvironmentRun(environment.paths.root), {
    code: 'CAPABILITY_SNAPSHOT_HASH_MISMATCH',
  });
});

test('Docker launch re-verifies the Run snapshot before starting a process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-capability-launch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'candidate-skill');
  await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'SKILL.md'), skill('original'), { mode: 0o600 });
  const provider = createDockerIsolationProvider({
    inspectDocker: async () => ({ available: true, version: 'test', reasons: [] }),
  });
  const profile = skillProfile(source);
  profile.isolation = { provider: 'docker', minimumLevel: 'ephemeral-machine' };
  const environment = await createEnvironment({
    storageRoot: join(root, 'environments'),
    profile,
    providers: [provider],
  });
  const run = await createEnvironmentRun(environment.paths.root, { providers: [provider] });
  const snapshot = run.capabilities.snapshots[0];
  await writeFile(join(run.paths.capabilities, snapshot.directory, 'SKILL.md'), skill('tampered'), { mode: 0o600 });
  await assert.rejects(() => launchEnvironmentRun(run.paths.root, {
    provider,
    executable: process.execPath,
    internalHostScript: '/tmp/must-not-start.js',
  }), { code: 'ISOLATION_PROVIDER_UNAVAILABLE' });
});

test('Skill snapshot staging rejects symlinks and common secret files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-capability-unsafe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'candidate-skill');
  await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'SKILL.md'), skill('unsafe'), { mode: 0o600 });
  await writeFile(join(root, 'outside.md'), 'outside\n', { mode: 0o600 });
  await symlink(join(root, 'outside.md'), join(source, 'linked.md'));
  await assert.rejects(() => createEnvironment({
    storageRoot: join(root, 'symlink-environments'),
    profile: skillProfile(source),
  }), { code: 'CAPABILITY_SNAPSHOT_SYMLINK' });
  await rm(join(source, 'linked.md'));
  await writeFile(join(source, '.env'), 'SECRET=must-not-stage\n', { mode: 0o600 });
  await assert.rejects(() => createEnvironment({
    storageRoot: join(root, 'secret-environments'),
    profile: skillProfile(source),
  }), { code: 'CAPABILITY_SNAPSHOT_SECRET_FILE' });
});

function skillProfile(source) {
  return {
    id: 'snapshot-skill',
    capabilities: {
      lock: {
        capabilities: [{ id: 'skills.snapshot', kind: 'skill-source', scope: 'custom', version: '1' }],
      },
      sources: [{ id: 'skills.snapshot', path: source }],
    },
  };
}

function skill(marker) {
  return `---\nname: snapshot-skill\ndescription: ${marker}\n---\n\n# Snapshot\n`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

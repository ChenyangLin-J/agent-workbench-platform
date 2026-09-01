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
import { prepareMinimalCapabilitySkills } from '../src/environment/codex-runtime.js';

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
  assert.equal(snapshot.name, 'snapshot-skill');
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

test('Skill snapshot staging requires a valid frontmatter name', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-capability-name-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'candidate-skill');
  await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'SKILL.md'), '---\ndescription: missing name\n---\n', { mode: 0o600 });
  await assert.rejects(() => createEnvironment({
    storageRoot: join(root, 'environments'),
    profile: skillProfile(source),
  }), { code: 'CAPABILITY_SNAPSHOT_MANIFEST_INVALID' });
});

test('Environment snapshots module MCP packages but does not register them as Codex Skills', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-mcp-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'solver-read');
  await mkdir(source, { mode: 0o700 });
  await writeFile(join(source, 'package.json'), '{"name":"solver-read","type":"module"}\n', { mode: 0o600 });
  await writeFile(join(source, 'adapter.mjs'), 'export function createMcpHandler() {}\n', { mode: 0o600 });
  const environment = await createEnvironment({
    storageRoot: join(root, 'environments'),
    profile: {
      id: 'mcp-snapshot',
      capabilities: {
        lock: { capabilities: [{ id: 'adapters.solver', kind: 'mcp-server', scope: 'experiment', version: '1' }] },
        sources: [{ id: 'adapters.solver', path: source }],
        adapters: [{
          id: 'adapters.solver', kind: 'module-mcp-read', server: 'solver', entrypoint: 'adapter.mjs',
          credentialEnvironment: { SOLVER_TOKEN: 'credentials.solver-token' },
          networkTargets: ['https://solver.example.test/api'], effect: 'experiment.read',
          allowedTools: ['query_solver_engine'],
        }],
      },
    },
  });
  assert.equal(environment.capabilities.snapshots[0].name, 'solver-read');
  assert.equal(environment.capabilities.snapshots[0].kind, 'mcp-server');
  const run = await createEnvironmentRun(environment.paths.root);
  await mkdir(join(run.paths.runtime, 'codex-home'), { recursive: true, mode: 0o700 });
  const adapterDirectory = Buffer.from('adapters.solver').toString('hex').slice(0, 48);
  const tokenDirectory = join(run.paths.credentials, 'data-adapters', adapterDirectory);
  await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(tokenDirectory, 'service-token'), `${'x'.repeat(40)}\n`, { mode: 0o600 });
  run.runtime.dataAdapters = [{
    server: 'solver', url: 'http://awb-0000000000000000-data-1:4200/mcp',
    tokenEnvKey: 'AGENT_WORKBENCH_DATA_ADAPTER_1_TOKEN',
    tokenFile: join(tokenDirectory, 'service-token'), enabledTools: ['query_solver_engine'],
  }];
  const prepared = await prepareMinimalRuntimeConfiguration({ manifest: run });
  const config = await readFile(prepared.configPath, 'utf8');
  assert.match(config, /\[mcp_servers\."solver"\]/);
  assert.equal(config.includes('SKILL.md'), false);
});

test('Minimal Runtime disables Skills outside the immutable snapshot lock', async () => {
  const directory = '0'.repeat(24);
  const allowedPath = `/capabilities/${directory}/SKILL.md`;
  let unexpectedEnabled = true;
  const requests = [];
  const connection = { request: async (method, params) => {
    requests.push({ method, params });
    if (method === 'skills/config/write') {
      unexpectedEnabled = false;
      return {};
    }
    if (method === 'skills/list') return { data: [{ skills: [
      { name: 'snapshot-skill', path: allowedPath, enabled: true },
      ...(unexpectedEnabled ? [{ name: 'unlocked-skill', path: '/other/SKILL.md', enabled: true }] : []),
    ] }] };
    return {};
  } };
  const manifest = {
    paths: { capabilities: '/capabilities', workspace: '/workspace' },
    capabilities: { snapshots: [{ name: 'snapshot-skill', kind: 'skill-source', directory }] },
  };
  const status = await prepareMinimalCapabilitySkills(connection, manifest);
  assert.equal(status.ready, true);
  assert.deepEqual(status.skills, [{ name: 'snapshot-skill', path: allowedPath }]);
  assert.deepEqual(requests.map((request) => request.method), [
    'skills/extraRoots/set',
    'skills/list',
    'skills/config/write',
    'skills/extraRoots/set',
    'skills/list',
  ]);

  await assert.rejects(() => prepareMinimalCapabilitySkills({
    request: async (method) => method === 'skills/list' ? { data: [{ skills: [] }] } : {},
  }, manifest), { code: 'CAPABILITY_SKILL_ALLOWLIST_UNSATISFIED' });
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

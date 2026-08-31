import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  IsolationProviderRegistry,
  assertIsolationSatisfied,
  createDevelopmentIsolationProvider,
  defineIsolationProvider,
  deriveEffectiveIsolationLevel,
  environmentProfileHash,
  inspectIsolationProvider,
  normalizeEnvironmentProfile,
  resolveContainedPath,
} from '../src/environment/index.js';

const COMPLETE_GUARD = Object.fromEntries([
  'filesystem',
  'process',
  'environment',
  'capabilities',
  'credentials',
  'network',
  'externalEffects',
  'crossRun',
].map((name) => [name, { enforced: true, mode: `test-${name}` }]));

test('profile normalization is minimal, stable, and keeps optional evaluator assets out', () => {
  assert.equal('sources' in normalizeEnvironmentProfile({ id: 'legacy-empty-profile' }).capabilities, false);
  const profile = normalizeEnvironmentProfile({
    schema: 'agent-workbench.environment-profile/v1',
    id: 'data-skill-lab',
    runtime: { provider: 'codex', model: 'gpt-test' },
    capabilities: { lock: {
      version: 1,
      profileId: 'lab',
      catalogVersion: 2,
      capabilities: [{ id: 'skills.data', kind: 'skill-source', scope: 'custom', version: 'abc' }],
    }, sources: [{ id: 'skills.data', path: './candidate-skill' }] },
    isolation: {
      provider: 'container',
      minimumLevel: 'ephemeral-machine',
      filesystem: { readableRoots: ['./fixtures'] },
      environmentKeys: ['LANG'],
      credentialReferences: ['codex-session'],
      networkTargets: ['api.openai.com:443'],
      externalEffects: { read: ['warehouse'], write: [] },
    },
    extensions: { 'ai.ddit.lab': { candidateLabel: 'candidate' } },
  }, { baseDirectory: '/profiles' });
  assert.equal(profile.features.sessionWorkspace, true);
  assert.equal(profile.features.evidenceDashboard, false);
  assert.deepEqual(profile.isolation.filesystem.readableRoots, ['/profiles/fixtures']);
  assert.deepEqual(profile.capabilities.sources, [{ id: 'skills.data', path: '/profiles/candidate-skill' }]);
  assert.equal(JSON.stringify(profile).includes('gold'), false);
  assert.equal(environmentProfileHash(profile), environmentProfileHash(structuredClone(profile)));
});

test('profiles reject unknown fields and embedded credential values', () => {
  assert.throws(() => normalizeEnvironmentProfile({ id: 'example', gold: ['answer'] }), /unsupported field: gold/);
  assert.throws(() => normalizeEnvironmentProfile({
    id: 'example',
    extensions: { 'ai.ddit.example': { apiKey: 'secret-value' } },
  }), /must not contain credential values/);
  assert.throws(() => normalizeEnvironmentProfile({
    id: 'example',
    extensions: { 'ai.ddit.example': { databasePassword: 'secret-value' } },
  }), /must not contain credential values/);
  assert.throws(() => normalizeEnvironmentProfile({
    id: 'example',
    capabilities: { sources: [{ id: 'skills.unlocked', path: './skill' }] },
  }), /not present in the lock/);
});

test('profile normalization binds locked read-only adapters without credential values', () => {
  const profile = normalizeEnvironmentProfile({
    id: 'read-only-data',
    capabilities: {
      lock: { capabilities: [
        { id: 'adapters.metadata', kind: 'read-only-adapter', scope: 'data', version: '1' },
        { id: 'adapters.warehouse', kind: 'read-only-adapter', scope: 'data', version: '1' },
      ] },
      adapters: [
        {
          id: 'adapters.metadata',
          kind: 'openmetadata-mcp-read',
          server: 'openmetadata',
          target: 'https://metadata.example.test/mcp',
          credentialReference: 'credentials.metadata-pat',
          effect: 'metadata.read',
          allowedTools: ['search_metadata', 'get_entity_details'],
        },
        {
          id: 'adapters.warehouse',
          kind: 'bigquery-read',
          server: 'bigquery',
          credentialReference: 'credentials.google-adc',
          effect: 'warehouse.read',
          billingProject: 'billing-project',
          allowedProjects: ['source-project'],
          maximumBytesBilled: 1024,
          maximumRows: 20,
        },
      ],
    },
  });
  assert.equal(profile.capabilities.adapters.length, 2);
  assert.equal('sources' in profile.capabilities, false);
  assert.equal(JSON.stringify(profile).includes('token-value'), false);
  assert.throws(() => normalizeEnvironmentProfile({
    id: 'missing-adapter',
    capabilities: { lock: { capabilities: [
      { id: 'adapters.missing', kind: 'read-only-adapter', scope: 'data', version: '1' },
    ] } },
  }), /has no adapter declaration/);
  assert.throws(() => normalizeEnvironmentProfile({
    id: 'write-tool',
    capabilities: {
      lock: { capabilities: [
        { id: 'adapters.metadata', kind: 'read-only-adapter', scope: 'data', version: '1' },
      ] },
      adapters: [{
        id: 'adapters.metadata',
        kind: 'openmetadata-mcp-read',
        server: 'openmetadata',
        target: 'https://metadata.example.test/mcp',
        credentialReference: 'credentials.metadata-pat',
        effect: 'metadata.read',
        allowedTools: ['patch_entity'],
      }],
    },
  }), /built-in read allowlist/);
});

test('effective isolation is derived from every enforcement facet', () => {
  assert.equal(deriveEffectiveIsolationLevel(COMPLETE_GUARD), 'guarded-host');
  assert.equal(deriveEffectiveIsolationLevel({
    ...COMPLETE_GUARD,
    ephemeralIdentity: { enforced: true, mode: 'throwaway-container' },
  }), 'ephemeral-machine');
  assert.equal(deriveEffectiveIsolationLevel({
    ...COMPLETE_GUARD,
    network: { enforced: false, mode: 'host-network' },
  }), 'development');
});

test('provider inspection refuses unavailable or insufficient isolation', async () => {
  const development = createDevelopmentIsolationProvider();
  const inspection = await inspectIsolationProvider(development, {});
  assert.equal(inspection.effectiveLevel, 'development');
  assert.throws(() => assertIsolationSatisfied(inspection, 'guarded-host'), {
    code: 'ISOLATION_REQUIREMENT_UNSATISFIED',
  });
  const registry = new IsolationProviderRegistry([development]);
  assert.equal(registry.get('development'), development);
  assert.throws(() => registry.get('missing'), { code: 'ISOLATION_PROVIDER_NOT_FOUND' });
});

test('provider cannot self-assert a stronger level than its enforcement proves', async () => {
  const provider = defineIsolationProvider({
    id: 'dishonest',
    async inspect() { return { available: true, effectiveLevel: 'ephemeral-machine', enforcement: {} }; },
    async start() {},
    async stop() {},
  });
  const inspection = await inspectIsolationProvider(provider, {});
  assert.equal(inspection.effectiveLevel, 'development');
});

test('contained path resolution blocks traversal and symlink escape', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'awb-paths-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'environment');
  const outside = join(base, 'outside');
  await mkdir(join(root, 'workspace'), { recursive: true });
  await mkdir(outside);
  await symlink(outside, join(root, 'workspace', 'escape'));
  assert.equal(await resolveContainedPath(root, 'workspace/new.txt', { allowMissing: true }), join(await realpath(root), 'workspace/new.txt'));
  await assert.rejects(() => resolveContainedPath(root, '../outside'), { code: 'ENVIRONMENT_PATH_ESCAPE' });
  await assert.rejects(() => resolveContainedPath(root, 'workspace/escape/file.txt', { allowMissing: true }), {
    code: 'ENVIRONMENT_PATH_ESCAPE',
  });
});

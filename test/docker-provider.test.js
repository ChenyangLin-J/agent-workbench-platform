import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BIGQUERY_API_TARGET,
  CHATGPT_CODEX_BASE_URL,
  GOOGLE_OAUTH_TARGET,
  dockerProfileFacts,
  createDockerIsolationProvider,
  inspectIsolationProvider,
  normalizeEnvironmentProfile,
} from '../src/environment/index.js';

test('Docker provider proves ephemeral isolation only for enforceable offline Profiles', async () => {
  const profile = normalizeEnvironmentProfile({
    id: 'offline-container',
    isolation: { provider: 'docker', minimumLevel: 'ephemeral-machine' },
  });
  const provider = createDockerIsolationProvider({
    inspectDocker: async () => ({ available: true, version: 'test', reasons: [] }),
  });
  const inspection = await inspectIsolationProvider(provider, { profile });
  assert.equal(inspection.available, true);
  assert.equal(inspection.effectiveLevel, 'ephemeral-machine');
  assert.equal(Object.values(inspection.enforcement).every((facet) => facet.enforced), true);
  assert.equal(inspection.enforcement.credentials.mode, 'no-credentials');
  assert.equal(inspection.enforcement.network.mode, 'internal-network-with-fixed-ingress-sidecar');
});

test('Docker provider reports no effective isolation when the daemon is unavailable', async () => {
  const profile = normalizeEnvironmentProfile({
    id: 'offline-container',
    isolation: { provider: 'docker', minimumLevel: 'ephemeral-machine' },
  });
  const inspection = await inspectIsolationProvider(createDockerIsolationProvider({
    inspectDocker: async () => ({ available: false, version: null, reasons: ['Docker is stopped.'] }),
  }), { profile });
  assert.equal(inspection.available, false);
  assert.equal(inspection.effectiveLevel, 'development');
  assert.equal(Object.values(inspection.enforcement).some((facet) => facet.enforced), false);
});

test('Docker provider accepts only a ready fixed Codex model broker', async () => {
  const profile = normalizeEnvironmentProfile({
    id: 'brokered-container',
    runtime: { provider: 'codex', model: 'gpt-test' },
    isolation: {
      provider: 'docker',
      minimumLevel: 'ephemeral-machine',
      credentialReferences: ['credentials.codex-native'],
      networkTargets: [CHATGPT_CODEX_BASE_URL],
    },
  });
  const ready = await inspectIsolationProvider(createDockerIsolationProvider({
    inspectDocker: async () => ({ available: true, version: 'test', reasons: [] }),
    credentialBroker: { inspect: async () => ({ ready: true, requested: true }), stage: async () => {} },
  }), { profile });
  assert.equal(ready.available, true);
  assert.equal(ready.effectiveLevel, 'ephemeral-machine');
  assert.equal(ready.enforcement.credentials.mode, 'short-lived-codex-credential-broker');
  assert.equal(ready.enforcement.network.mode, 'internal-network-with-fixed-ingress-and-model-egress-sidecars');
  const unavailable = await inspectIsolationProvider(createDockerIsolationProvider({
    inspectDocker: async () => ({ available: true, version: 'test', reasons: [] }),
    credentialBroker: { inspect: async () => ({ ready: false, requested: true, reason: 'credential expired' }), stage: async () => {} },
  }), { profile });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.effectiveLevel, 'development');
  assert.match(unavailable.reason, /credential expired/);
});

test('Docker provider fails closed when network, credentials, capabilities, or effects need brokers', async () => {
  const profile = normalizeEnvironmentProfile({
    id: 'broker-required',
    capabilities: { lock: {
      capabilities: [{ id: 'skills.data', kind: 'skill-source', scope: 'custom', version: '1' }],
    } },
    isolation: {
      provider: 'docker',
      minimumLevel: 'ephemeral-machine',
      environmentKeys: ['OPENAI_API_KEY'],
      networkTargets: ['api.openai.com:443'],
      credentialReferences: ['codex-session'],
      externalEffects: { read: ['warehouse'] },
    },
  });
  const facts = dockerProfileFacts(profile);
  assert.equal(facts.ready, false);
  const inspection = await inspectIsolationProvider(createDockerIsolationProvider({
    inspectDocker: async () => ({ available: true, version: 'test', reasons: [] }),
  }), { profile });
  assert.equal(inspection.available, false);
  assert.equal(inspection.effectiveLevel, 'development');
  assert.match(inspection.reason, /credential broker/);
  assert.match(inspection.reason, /egress broker/);
});

test('Docker provider accepts an exact immutable Skill snapshot set', () => {
  const profile = normalizeEnvironmentProfile({
    id: 'snapshot-container',
    capabilities: { lock: {
      capabilities: [{ id: 'skills.data', kind: 'skill-source', scope: 'custom', version: '1' }],
    } },
    isolation: { provider: 'docker', minimumLevel: 'ephemeral-machine' },
  });
  const facts = dockerProfileFacts(profile, {
    capabilitySnapshots: [{
      id: 'skills.data',
      name: 'data-skill',
      kind: 'skill-source',
      scope: 'custom',
      version: '1',
      directory: '0'.repeat(24),
      sha256: 'a'.repeat(64),
      files: 1,
      bytes: 10,
    }],
  });
  assert.equal(facts.capabilities, true);
  assert.equal(facts.capabilityMode, 'immutable-skill-snapshots');
  assert.equal(facts.ready, true);
  assert.equal(dockerProfileFacts(profile, { capabilitySnapshots: [] }).ready, false);
});

test('Docker provider accepts only exact read-only adapter isolation declarations', async () => {
  const profileDocument = {
    id: 'data-adapter-container',
    capabilities: {
      lock: { capabilities: [
        { id: 'adapters.warehouse', kind: 'read-only-adapter', scope: 'data', version: '1' },
      ] },
      adapters: [{
        id: 'adapters.warehouse',
        kind: 'bigquery-read',
        server: 'bigquery',
        credentialReference: 'credentials.google-adc',
        effect: 'warehouse.read',
        billingProject: 'billing-project',
        allowedProjects: ['source-project'],
      }],
    },
    isolation: {
      provider: 'docker',
      minimumLevel: 'ephemeral-machine',
      credentialReferences: ['credentials.google-adc'],
      networkTargets: [BIGQUERY_API_TARGET, GOOGLE_OAUTH_TARGET],
      externalEffects: { read: ['warehouse.read'], write: [] },
    },
  };
  const profile = normalizeEnvironmentProfile(profileDocument);
  const provider = createDockerIsolationProvider({
    inspectDocker: async () => ({ available: true, version: 'test', reasons: [] }),
    dataAdapterCredentialBroker: { inspect: async () => ({ ready: true, requested: true }), stage: async () => {} },
  });
  const inspection = await inspectIsolationProvider(provider, { profile });
  assert.equal(inspection.available, true);
  assert.equal(inspection.enforcement.externalEffects.mode, 'read-only-data-adapter-allowlist');
  assert.equal(inspection.enforcement.credentials.mode, 'isolated-data-adapter-credentials');
  const surplus = normalizeEnvironmentProfile({
    ...profileDocument,
    isolation: {
      ...profileDocument.isolation,
      networkTargets: [...profileDocument.isolation.networkTargets, 'https://storage.googleapis.com'],
    },
  });
  const rejected = await inspectIsolationProvider(provider, { profile: surplus });
  assert.equal(rejected.available, false);
  assert.equal(rejected.enforcement.network.enforced, false);
});

test('Docker provider clears model credentials when data credential staging fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-docker-stage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentials = join(root, 'credentials');
  await mkdir(credentials);
  const profile = normalizeEnvironmentProfile({
    id: 'combined-brokers',
    runtime: { provider: 'codex', model: 'gpt-test' },
    capabilities: {
      lock: { capabilities: [
        { id: 'adapters.warehouse', kind: 'read-only-adapter', scope: 'data', version: '1' },
      ] },
      adapters: [{
        id: 'adapters.warehouse',
        kind: 'bigquery-read',
        server: 'bigquery',
        credentialReference: 'credentials.google-adc',
        effect: 'warehouse.read',
        billingProject: 'billing-project',
        allowedProjects: ['source-project'],
      }],
    },
    isolation: {
      provider: 'docker',
      minimumLevel: 'ephemeral-machine',
      credentialReferences: ['credentials.codex-native', 'credentials.google-adc'],
      networkTargets: [CHATGPT_CODEX_BASE_URL, BIGQUERY_API_TARGET, GOOGLE_OAUTH_TARGET],
      externalEffects: { read: ['warehouse.read'], write: [] },
    },
  });
  const provider = createDockerIsolationProvider({
    credentialBroker: {
      inspect: async () => ({ ready: true, requested: true }),
      async stage({ directory }) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'credential.json'), 'transient-model-secret', { mode: 0o600 });
      },
    },
    dataAdapterCredentialBroker: {
      inspect: async () => ({ ready: true, requested: true }),
      async stage() { throw new Error('fixture data credential staging failed'); },
    },
  });
  await assert.rejects(() => provider.start({
    profile,
    manifest: { paths: { credentials } },
    launch: {
      command: process.execPath,
      args: ['/fixture/entry.js', '--internal-host'],
      cwd: root,
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      environment: {},
    },
  }), /fixture data credential staging failed/);
  await assert.rejects(() => stat(join(credentials, 'broker')), { code: 'ENOENT' });
  await assert.rejects(() => stat(join(credentials, 'data-adapters')), { code: 'ENOENT' });
});

test('Docker provider rejects symlinked or sibling-exposing mount roots', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-docker-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environmentRoot = join(root, 'environment');
  const runsRoot = join(environmentRoot, 'runs');
  const runRoot = join(runsRoot, 'run-one');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(runRoot, { recursive: true }), mkdir(outside)]);
  const link = join(root, 'linked');
  await symlink(outside, link);
  const provider = createDockerIsolationProvider({
    inspectDocker: async () => ({ available: true, version: 'test', reasons: [] }),
  });
  const symlinkProfile = normalizeEnvironmentProfile({
    id: 'symlink-mount',
    isolation: { provider: 'docker', minimumLevel: 'ephemeral-machine', filesystem: { readableRoots: [link] } },
  });
  const symlinkInspection = await inspectIsolationProvider(provider, { profile: symlinkProfile, paths: { root: runRoot } });
  assert.equal(symlinkInspection.available, false);
  assert.equal(symlinkInspection.enforcement.filesystem.enforced, false);
  const siblingProfile = normalizeEnvironmentProfile({
    id: 'sibling-mount',
    isolation: { provider: 'docker', minimumLevel: 'ephemeral-machine', filesystem: { readableRoots: [root] } },
  });
  const siblingInspection = await inspectIsolationProvider(provider, { profile: siblingProfile, paths: { root: runRoot } });
  assert.equal(siblingInspection.available, false);
  assert.match(siblingInspection.reason, /sibling Run state/);
});

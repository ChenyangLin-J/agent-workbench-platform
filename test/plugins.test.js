import assert from 'node:assert/strict';
import test from 'node:test';

import { CapabilityPluginRegistry, checkCapabilityPluginHealth, resolveCapabilityPluginProfile } from '../src/plugins.js';

function registry() {
  const value = new CapabilityPluginRegistry();
  value.register({ id: 'shared-skills', kind: 'skill-source', version: '1.0.0' });
  value.register({ manifest: { id: 'host-mcp', kind: 'mcp-server', version: '2.0.0' }, check: async ({ config, credentialRefs }) => {
    assert.deepEqual(credentialRefs, ['vault:host-mcp']);
    return config.url === 'https://product.example' ? { status: 'healthy', detail: 'reachable' } : false;
  } });
  value.register({ manifest: { id: 'local-cli', kind: 'cli-tool', version: '1.0.0' }, check: () => { throw new Error('not installed'); } });
  value.register({ id: 'identity', kind: 'credential-provider', version: '1.0.0' });
  return value;
}

test('registry validates all capability kinds and duplicate ids', () => {
  const plugins = registry();
  assert.deepEqual(plugins.list().map((plugin) => plugin.id), ['shared-skills', 'host-mcp', 'local-cli', 'identity']);
  assert.equal(plugins.get('host-mcp').kind, 'mcp-server');
  assert.equal(plugins.unregister('identity').id, 'identity');
  assert.equal(plugins.get('identity'), null);
  assert.throws(() => plugins.register({ id: 'host-mcp', kind: 'mcp-server', version: '3.0.0' }), { code: 'PLUGIN_DUPLICATE_ID' });
  assert.throws(() => plugins.register({ id: 'unsafe', kind: 'mcp-server', version: '1.0.0', config: { token: 'secret' } }), /credentialRefs/);
});

test('profile resolver supports project-free base profiles and product overlays', () => {
  const profile = resolveCapabilityPluginProfile({ plugins: {
    'shared-skills': { enabled: true, config: { root: '/skills' } },
    'host-mcp': { config: { url: 'https://base.example' }, credentialRefs: ['vault:host-mcp'] },
  } }, { plugins: { 'shared-skills': { enabled: false }, 'host-mcp': { config: { url: 'https://product.example' } } } });
  assert.deepEqual(profile.plugins['shared-skills'], { id: 'shared-skills', enabled: false, config: { root: '/skills' }, credentialRefs: [] });
  assert.deepEqual(profile.plugins['host-mcp'], { id: 'host-mcp', enabled: true, config: { url: 'https://product.example' }, credentialRefs: ['vault:host-mcp'] });
});

test('profile resolver supports project-scoped product overlays without project data', () => {
  const profile = resolveCapabilityPluginProfile({ 'host-mcp': { config: { url: 'https://base.example' } } }, { 'host-mcp': { enabled: false, credentialRefs: ['vault:host-mcp'] } });
  assert.equal(profile.plugins['host-mcp'].enabled, false);
  assert.deepEqual(profile.plugins['host-mcp'].credentialRefs, ['vault:host-mcp']);
  assert.equal('projectId' in profile, false);
  assert.throws(() => resolveCapabilityPluginProfile({ 'host-mcp': { token: 'secret' } }), /credentialRefs/);
});

test('health check reports disabled, healthy, degraded, and errors without credential values', async () => {
  const health = await checkCapabilityPluginHealth(registry(), { plugins: {
    'shared-skills': { enabled: false },
    'host-mcp': { config: { url: 'https://product.example' }, credentialRefs: ['vault:host-mcp'] },
  } });
  assert.deepEqual(health.map(({ id, status }) => ({ id, status })), [
    { id: 'shared-skills', status: 'disabled' }, { id: 'host-mcp', status: 'healthy' },
    { id: 'local-cli', status: 'error' }, { id: 'identity', status: 'healthy' },
  ]);
  assert.equal(health[1].detail, 'reachable');
  assert.match(health[2].error.message, /not installed/);

  const degraded = await checkCapabilityPluginHealth(registry(), { plugins: {
    'host-mcp': { config: { url: 'https://unreachable.example' }, credentialRefs: ['vault:host-mcp'] },
  } });
  assert.equal(degraded.find((item) => item.id === 'host-mcp').status, 'degraded');
});

test('health check reports profile plugins that are not installed', async () => {
  const health = await checkCapabilityPluginHealth(registry(), { plugins: {
    'missing-cli': { enabled: true, config: { command: 'missing' } },
  } });
  assert.deepEqual(health.at(-1), {
    id: 'missing-cli',
    kind: null,
    status: 'error',
    error: { code: 'PLUGIN_NOT_REGISTERED', message: 'plugin is not registered: missing-cli' },
  });
});

test('secret-like values are rejected inside arrays and health output', async () => {
  assert.throws(() => resolveCapabilityPluginProfile({ plugins: {
    'host-mcp': { config: { headers: [{ token: 'secret' }] } },
  } }), /credentialRefs/);

  const plugins = new CapabilityPluginRegistry();
  plugins.register({
    manifest: { id: 'unsafe-health', kind: 'credential-provider', version: '1.0.0' },
    check: () => ({ status: 'healthy', token: 'secret' }),
  });
  const [health] = await checkCapabilityPluginHealth(plugins);
  assert.equal(health.status, 'error');
  assert.match(health.error.message, /credentialRefs/);
  assert.equal(JSON.stringify(health).includes('secret'), false);
});

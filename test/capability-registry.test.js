import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCapabilityLock,
  loadCommonCapabilityCatalog,
  mergeCapabilityCatalogs,
  normalizeCapabilityCatalog,
  resolveCapabilityInstallPlan,
} from '../src/capability-registry.js';

test('bundled common catalog is product-neutral and disabled by default', () => {
  const catalog = loadCommonCapabilityCatalog();
  assert.equal(catalog.capabilities.length, 18);
  assert.equal(catalog.capabilities.every((item) => item.scope === 'common'), true);
  assert.equal(catalog.capabilities.every((item) => item.defaultEnabled === false), true);
  assert.equal(catalog.capabilities.some((item) => item.id === 'mcp.browser'), true);
});

test('custom catalogs merge without shadowing common ids', () => {
  const common = loadCommonCapabilityCatalog();
  const custom = { version: 1, capabilities: [{
    id: 'skills.personal', kind: 'skill-source', version: '1.0.0', scope: 'custom', source: { type: 'local', path: 'capabilities/plugins/personal' },
  }] };
  const merged = mergeCapabilityCatalogs(common, custom);
  assert.equal(merged.capabilities.length, common.capabilities.length + 1);
  assert.throws(() => mergeCapabilityCatalogs(common, { version: 1, capabilities: [{
    id: 'cli.git', kind: 'cli-tool', version: 'custom', scope: 'custom', source: { type: 'command', command: 'git' },
  }] }), { code: 'CAPABILITY_DUPLICATE_ID' });
});

test('install plan selects profile entries, closes dependencies, and creates a portable lock', () => {
  const catalog = mergeCapabilityCatalogs(loadCommonCapabilityCatalog(), { version: 1, capabilities: [{
    id: 'skills.personal', kind: 'skill-source', version: '1.0.0', scope: 'custom', source: { type: 'local', path: 'capabilities/plugins/personal' },
  }] });
  const plan = resolveCapabilityInstallPlan(catalog, { plugins: {
    'skills.personal': { enabled: true },
    'cli.npm': { enabled: true },
  } });
  assert.equal(plan.capabilities.find((item) => item.id === 'skills.personal').action, 'install');
  assert.equal(plan.capabilities.find((item) => item.id === 'cli.npm').enabled, true);
  assert.equal(plan.capabilities.find((item) => item.id === 'cli.node').enabled, true);
  assert.equal(plan.capabilities.find((item) => item.id === 'cli.git').enabled, false);
  const lock = createCapabilityLock(plan, { profileId: 'personal' });
  assert.deepEqual(lock.capabilities.map((item) => item.id), ['cli.node', 'cli.npm', 'skills.personal']);
  assert.equal(JSON.stringify(lock).includes('/Users/'), false);
});

test('install plan rejects unknown ids and explicitly disabled dependencies', () => {
  const catalog = loadCommonCapabilityCatalog();
  assert.throws(() => resolveCapabilityInstallPlan(catalog, { plugins: { missing: { enabled: true } } }), { code: 'CAPABILITY_NOT_REGISTERED' });
  assert.throws(() => resolveCapabilityInstallPlan(catalog, { plugins: {
    'cli.npm': { enabled: true },
    'cli.node': { enabled: false },
  } }), { code: 'CAPABILITY_DEPENDENCY_DISABLED' });
});

test('catalog normalization rejects custom scope in the common registry', () => {
  assert.throws(() => normalizeCapabilityCatalog({ version: 1, capabilities: [{
    id: 'skills.custom', kind: 'skill-source', version: '1', scope: 'custom', source: { type: 'local', path: 'skills' },
  }] }, { requiredScope: 'common' }), /must use common scope/);
});

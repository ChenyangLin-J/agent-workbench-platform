import assert from 'node:assert/strict';
import test from 'node:test';

import { CapabilityInstaller } from '../src/capability-installer.js';
import { CapabilityManager } from '../src/capability-manager.js';
import { createCapabilityLock, resolveCapabilityInstallPlan } from '../src/capability-registry.js';

function fixture() {
  const catalog = { version: 1, capabilities: [
    { id: 'cli.runtime', title: 'Runtime', kind: 'cli-tool', version: '1.0.0', scope: 'common', defaultEnabled: false },
    { id: 'skills.bundle', title: 'Bundle', kind: 'skill-source', version: '1.0.0', scope: 'custom', defaultEnabled: false, dependencies: ['cli.runtime'], components: ['one'] },
  ] };
  let profile = { id: 'fixture', plugins: { 'cli.runtime': { enabled: false }, 'skills.bundle': { enabled: false } } };
  let lock = createCapabilityLock(resolveCapabilityInstallPlan(catalog, profile), { profileId: profile.id });
  const saves = [];
  const store = {
    load: async () => ({ profile, lock }),
    save: async (next) => {
      profile = structuredClone(next.profile);
      lock = structuredClone(next.lock);
      saves.push(structuredClone(next));
    },
  };
  const installer = new CapabilityInstaller().register('manual', {
    plan: (manifest, { context }) => context.available
      ? { status: 'ready', title: manifest.title }
      : { status: 'manual', title: manifest.title },
  });
  const manager = new CapabilityManager({
    catalog,
    store,
    installer,
    check: async (manifest) => ({ status: manifest.id === 'cli.runtime' ? 'healthy' : 'degraded', detail: manifest.id }),
  });
  return { manager, saves, state: () => ({ profile, lock }) };
}

test('Capability Manager owns dependency-safe state and portable snapshots through a host store', async () => {
  const value = fixture();
  const initial = await value.manager.snapshot();
  assert.deepEqual(initial.counts, { common: 1, custom: 1, enabled: 0, healthy: 0 });
  const enabled = await value.manager.setEnabled('skills.bundle', true);
  assert.equal(enabled.capabilities.find((item) => item.id === 'cli.runtime').enabled, true);
  assert.equal(enabled.capabilities.find((item) => item.id === 'cli.runtime').requiredBy[0], 'skills.bundle');
  assert.deepEqual(value.state().lock.capabilities.map((item) => item.id), ['cli.runtime', 'skills.bundle']);
  assert.equal(value.saves.length, 1);
  await assert.rejects(value.manager.setEnabled('cli.runtime', false), { code: 'CAPABILITY_DEPENDENCY_DISABLED' });
  assert.equal(value.saves.length, 1);
  const plan = await value.manager.planAction('skills.bundle');
  assert.equal(plan.status, 'manual');
});

test('Capability Manager rejects product state and operations outside the shared catalog contract', async () => {
  const { manager } = fixture();
  await assert.rejects(manager.setEnabled('missing', true), { code: 'CAPABILITY_NOT_FOUND' });
  await assert.rejects(manager.planAction('cli.runtime', 'authenticate'), { code: 'CAPABILITY_OPERATION_UNSUPPORTED' });
});

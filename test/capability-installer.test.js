import assert from 'node:assert/strict';
import test from 'node:test';

import { CapabilityInstaller } from '../src/capability-installer.js';

const manifest = {
  id: 'cli.example',
  kind: 'cli-tool',
  version: '1.0.0',
  installation: { strategy: 'fake-package' },
};

test('capability installer separates planning from confirmed host mutation', async () => {
  let executions = 0;
  const installer = new CapabilityInstaller().register('fake-package', {
    plan: () => ({
      status: 'action-required',
      title: 'Install example',
      detail: 'Writes to the test host.',
      command: { executable: 'fake-pkg', args: ['install', 'example'] },
    }),
    execute: async (_manifest, { plan }) => {
      executions += 1;
      assert.equal(plan.command.executable, 'fake-pkg');
      return { status: 'completed', detail: 'Installed.', restartRequired: true };
    },
  });

  const plan = await installer.plan(manifest);
  assert.equal(plan.status, 'action-required');
  assert.equal(plan.confirmationRequired, true);
  assert.equal(executions, 0);
  await assert.rejects(() => installer.execute(manifest), { code: 'CAPABILITY_ACTION_CONFIRMATION_REQUIRED' });
  assert.equal(executions, 0);
  const result = await installer.execute(manifest, { confirmed: true });
  assert.deepEqual(result, {
    capabilityId: 'cli.example',
    operation: 'install',
    status: 'completed',
    detail: 'Installed.',
    restartRequired: true,
  });
  assert.equal(executions, 1);
});

test('capability installer keeps unsupported and manual strategies side-effect free', async () => {
  const installer = new CapabilityInstaller().register('manual', {
    plan: () => ({ status: 'manual', title: 'Manual setup', detail: 'Follow host documentation.' }),
  });
  const unsupported = await installer.plan({ ...manifest, installation: { strategy: 'missing' } });
  assert.equal(unsupported.status, 'unsupported');
  const manual = await installer.execute({ ...manifest, installation: { strategy: 'manual' } });
  assert.equal(manual.status, 'manual');
});

test('capability installer rejects credential values from public plans', async () => {
  const installer = new CapabilityInstaller().register('unsafe', {
    plan: () => ({ status: 'action-required', metadata: { token: 'do-not-return' } }),
  });
  await assert.rejects(
    () => installer.plan({ ...manifest, installation: { strategy: 'unsafe' } }),
    /must not contain credential values/,
  );
});

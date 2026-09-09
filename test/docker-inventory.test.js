import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectDockerRunInventory } from '../src/environment/index.js';

test('Docker Run inventory groups sidecars and separates manifest from runtime state', async () => {
  const containers = [
    container('active-run', 'awb-active-workload', '/private/active/runs/active-run/state'),
    container('active-run', 'awb-active-ingress', null, { '4180/tcp': [{ HostIp: '127.0.0.1', HostPort: '4194' }] }),
    container('orphan-run', 'awb-orphan-workload', '/private/orphan/runs/orphan-run/state'),
    container('orphan-run', 'awb-orphan-data-1'),
  ];
  const inventory = await inspectDockerRunInventory({
    executeDocker: dockerFixture(containers),
    readManifest: async (root) => manifest(root.includes('active') ? 'active-run' : 'orphan-run'),
    verifyOwnership: async (run) => run.id === 'active-run',
  });

  assert.deepEqual(inventory.summary, {
    runs: 2,
    active: 1,
    orphaned: 1,
    unresolved: 0,
    containers: 4,
  });
  const active = inventory.runs.find((run) => run.runId === 'active-run');
  assert.equal(active.runtimeState, 'active');
  assert.equal(active.containerCount, 2);
  assert.deepEqual(active.containers.map((item) => item.role), ['ingress', 'workload']);
  assert.equal(active.containers[0].publishedPorts[0].hostPort, '4194');
  const orphan = inventory.runs.find((run) => run.runId === 'orphan-run');
  assert.equal(orphan.runtimeState, 'orphaned');
  assert.deepEqual(orphan.issues, ['RUN_SUPERVISOR_NOT_OWNED']);
});

test('Docker Run inventory reports unresolved resources without guessing a manifest', async () => {
  const containers = [
    container('missing-run', 'awb-missing-data-1'),
    container('mismatch-run', 'awb-mismatch-workload', '/private/mismatch/runs/mismatch-run/state'),
  ];
  const inventory = await inspectDockerRunInventory({
    executeDocker: dockerFixture(containers),
    readManifest: async () => manifest('different-run'),
    verifyOwnership: async () => true,
  });

  assert.equal(inventory.summary.unresolved, 2);
  assert.deepEqual(
    Object.fromEntries(inventory.runs.map((run) => [run.runId, run.issues[0]])),
    {
      'mismatch-run': 'RUN_MANIFEST_ID_MISMATCH',
      'missing-run': 'RUN_MANIFEST_MOUNT_MISSING',
    },
  );
});

test('Docker Run inventory handles an empty daemon without inspect', async () => {
  let calls = 0;
  const inventory = await inspectDockerRunInventory({
    executeDocker: async () => {
      calls += 1;
      return '';
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(inventory.summary, { runs: 0, active: 0, orphaned: 0, unresolved: 0, containers: 0 });
});

function manifest(id) {
  return {
    kind: 'run',
    id,
    status: 'running',
    profile: { id: 'datamama-data-agent-test' },
    lifecycle: { createdAt: '2026-09-01T00:00:00.000Z', startedAt: '2026-09-01T00:00:01.000Z' },
  };
}

function container(runId, name, stateSource = null, ports = {}) {
  return {
    Id: `${name}-container-id`,
    Name: `/${name}`,
    Config: { Image: 'agent-workbench-minimal-host:test', Labels: { 'ai.agent-workbench.run': runId } },
    Mounts: stateSource ? [{ Source: stateSource, Destination: '/run/workbench/state' }] : [],
    NetworkSettings: { Ports: ports },
  };
}

function dockerFixture(containers) {
  return async (_command, args) => {
    if (args[0] === 'container') return containers.map((item) => item.Id.slice(0, 12)).join('\n');
    if (args[0] === 'inspect') return JSON.stringify(containers);
    throw new Error(`Unexpected Docker arguments: ${args.join(' ')}`);
  };
}

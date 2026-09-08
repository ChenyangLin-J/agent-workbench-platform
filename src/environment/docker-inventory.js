import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

import { readEnvironmentManifest } from './store.js';
import { verifyRunProcessOwnership } from './process.js';

const execFileAsync = promisify(execFile);
const RUN_LABEL = 'ai.agent-workbench.run';
const RUN_STATE_MOUNT = '/run/workbench/state';

export async function inspectDockerRunInventory({
  dockerCommand = process.env.AGENT_WORKBENCH_DOCKER_COMMAND || 'docker',
  executeDocker = defaultDockerExecutor,
  readManifest = readEnvironmentManifest,
  verifyOwnership = verifyRunProcessOwnership,
} = {}) {
  const listed = await executeDocker(dockerCommand, [
    'container', 'ls',
    '--filter', `label=${RUN_LABEL}`,
    '--format', '{{.ID}}',
  ]);
  const containerIds = String(listed || '').split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (containerIds.length === 0) return inventoryResult([]);

  const inspected = JSON.parse(await executeDocker(dockerCommand, ['inspect', ...containerIds]));
  if (!Array.isArray(inspected)) throw inventoryError('DOCKER_INVENTORY_INVALID', 'Docker inspect did not return an array.');
  const grouped = new Map();
  for (const container of inspected) {
    const runId = String(container?.Config?.Labels?.[RUN_LABEL] || '').trim();
    if (!runId) continue;
    const entry = grouped.get(runId) || { runId, containers: [], runRoots: new Set() };
    const name = String(container?.Name || '').replace(/^\//, '') || String(container?.Id || '').slice(0, 12);
    const stateMounts = (container?.Mounts || []).filter((mount) => mount?.Destination === RUN_STATE_MOUNT);
    for (const mount of stateMounts) {
      if (typeof mount?.Source === 'string' && mount.Source) entry.runRoots.add(dirname(mount.Source));
    }
    entry.containers.push({
      id: String(container?.Id || '').slice(0, 12),
      name,
      image: String(container?.Config?.Image || ''),
      role: containerRole(name),
      publishedPorts: publishedPorts(container?.NetworkSettings?.Ports),
    });
    grouped.set(runId, entry);
  }

  const runs = await Promise.all([...grouped.values()].map(async (entry) => {
    const containers = entry.containers.sort((left, right) => left.name.localeCompare(right.name));
    const roots = [...entry.runRoots];
    if (roots.length !== 1) {
      return unresolvedEntry(entry.runId, containers, roots.length === 0
        ? 'RUN_MANIFEST_MOUNT_MISSING'
        : 'RUN_MANIFEST_MOUNT_AMBIGUOUS');
    }
    const runRoot = roots[0];
    let manifest;
    try {
      manifest = await readManifest(runRoot);
    } catch (error) {
      return unresolvedEntry(entry.runId, containers, 'RUN_MANIFEST_UNREADABLE', runRoot, error?.code);
    }
    if (manifest?.kind !== 'run' || manifest.id !== entry.runId) {
      return unresolvedEntry(entry.runId, containers, 'RUN_MANIFEST_ID_MISMATCH', runRoot);
    }
    let processOwned = false;
    try {
      processOwned = manifest.status === 'running' && await verifyOwnership(manifest);
    } catch {
      processOwned = false;
    }
    return {
      runId: entry.runId,
      profileId: manifest.profile?.id || null,
      manifestStatus: manifest.status,
      runtimeState: processOwned ? 'active' : 'orphaned',
      processOwned,
      runRoot,
      environmentRoot: dirname(dirname(runRoot)),
      createdAt: manifest.lifecycle?.createdAt || null,
      startedAt: manifest.lifecycle?.startedAt || null,
      containerCount: containers.length,
      containers,
      issues: processOwned ? [] : ['RUN_SUPERVISOR_NOT_OWNED'],
    };
  }));
  runs.sort(compareRuns);
  return inventoryResult(runs);
}

function inventoryResult(runs) {
  return {
    schema: 'agent-workbench.docker-run-inventory/v1',
    generatedAt: new Date().toISOString(),
    summary: {
      runs: runs.length,
      active: runs.filter((run) => run.runtimeState === 'active').length,
      orphaned: runs.filter((run) => run.runtimeState === 'orphaned').length,
      unresolved: runs.filter((run) => run.runtimeState === 'unresolved').length,
      containers: runs.reduce((total, run) => total + run.containerCount, 0),
    },
    runs,
  };
}

function unresolvedEntry(runId, containers, issue, runRoot = null, detail = null) {
  return {
    runId,
    profileId: null,
    manifestStatus: null,
    runtimeState: 'unresolved',
    processOwned: false,
    runRoot,
    environmentRoot: runRoot ? dirname(dirname(runRoot)) : null,
    createdAt: null,
    startedAt: null,
    containerCount: containers.length,
    containers,
    issues: [issue, ...(detail ? [String(detail)] : [])],
  };
}

function containerRole(name) {
  if (name.endsWith('-workload')) return 'workload';
  if (name.endsWith('-ingress')) return 'ingress';
  if (name.endsWith('-model-egress')) return 'model-egress';
  if (/-data-\d+$/.test(name)) return 'data-adapter';
  return 'sidecar';
}

function publishedPorts(ports = {}) {
  const values = [];
  for (const [containerPort, bindings] of Object.entries(ports || {})) {
    for (const binding of bindings || []) {
      values.push({
        containerPort,
        hostIp: binding.HostIp || null,
        hostPort: binding.HostPort || null,
      });
    }
  }
  return values.sort((left, right) => `${left.hostIp}:${left.hostPort}`.localeCompare(`${right.hostIp}:${right.hostPort}`));
}

function compareRuns(left, right) {
  const leftTime = Date.parse(left.startedAt || left.createdAt || 0) || 0;
  const rightTime = Date.parse(right.startedAt || right.createdAt || 0) || 0;
  return rightTime - leftTime || left.runId.localeCompare(right.runId);
}

async function defaultDockerExecutor(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw inventoryError(
      'DOCKER_INVENTORY_FAILED',
      `Docker Run inventory failed (${error?.code || 'error'}).`,
    );
  }
}

function inventoryError(code, message) {
  return Object.assign(new Error(message), { code });
}

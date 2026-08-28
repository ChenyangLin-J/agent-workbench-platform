import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = join(packageRoot, 'bin', 'agent-workbench.js');
const smokeRoot = await mkdtemp(join(process.cwd(), '.agent-workbench-docker-smoke-'));
const storageRoot = join(smokeRoot, 'environments');
const profilePath = join(smokeRoot, 'profile.json');
let environmentRoot = null;
let runRoot = null;

try {
  await writeFile(profilePath, `${JSON.stringify({
    schema: 'agent-workbench.environment-profile/v1',
    id: 'docker-smoke',
    features: { attachments: false },
    isolation: { provider: 'docker', minimumLevel: 'ephemeral-machine' },
  }, null, 2)}\n`, { mode: 0o600 });
  const created = await runCli(['env', 'create', '--profile', profilePath, '--root', storageRoot]);
  environmentRoot = created.environment.paths.root;
  const running = await runCli(['env', 'run', environmentRoot, '--root', storageRoot]);
  runRoot = running.run.paths.root;
  assert.equal(running.run.isolation.effectiveLevel, 'ephemeral-machine');
  assert.equal(Object.values(running.run.isolation.enforcement).every((facet) => facet.enforced), true);
  const state = running.run.process.providerState;
  const [workload, ingress, network] = await Promise.all([
    dockerJson(['inspect', state.containerId]),
    dockerJson(['inspect', state.ingressId]),
    dockerJson(['network', 'inspect', state.networkName]),
  ]);
  const workloadRecord = workload[0];
  const ingressRecord = ingress[0];
  const networkRecord = network[0];
  assert.equal(workloadRecord.HostConfig.ReadonlyRootfs, true);
  assert.equal(workloadRecord.HostConfig.CapDrop.includes('ALL'), true);
  assert.equal(workloadRecord.HostConfig.SecurityOpt.includes('no-new-privileges'), true);
  assert.equal(workloadRecord.HostConfig.PidsLimit, 256);
  assert.deepEqual(Object.keys(workloadRecord.NetworkSettings.Networks), [state.networkName]);
  assert.equal(Object.values(workloadRecord.NetworkSettings.Ports || {}).filter(Boolean).length, 0);
  assert.equal(networkRecord.Internal, true);
  assert.equal(ingressRecord.HostConfig.ReadonlyRootfs, true);
  assert.equal(ingressRecord.HostConfig.CapDrop.includes('ALL'), true);
  assert.deepEqual(Object.keys(ingressRecord.NetworkSettings.Networks).sort(), ['bridge', state.networkName].sort());
  const [binding] = ingressRecord.HostConfig.PortBindings['4180/tcp'];
  assert.equal(binding.HostIp, '127.0.0.1');
  assert.equal(ingressRecord.Args.includes('--internal-ingress-proxy'), true);
  assert.equal(ingressRecord.Args.includes(state.containerName), true);
  const page = await fetch(running.url).then((response) => {
    assert.equal(response.ok, true);
    return response.text();
  });
  assert.match(page, /minimal-host\.js/);
  const stopped = await runCli(['env', 'stop', runRoot, '--root', storageRoot]);
  assert.equal(stopped.stopped, 1);
  assert.equal(stopped.runs[0].status, 'stopped');
  await assert.rejects(() => dockerJson(['inspect', state.containerId]));
  await assert.rejects(() => dockerJson(['inspect', state.ingressId]));
  await assert.rejects(() => dockerJson(['network', 'inspect', state.networkName]));
  process.stdout.write(`${JSON.stringify({
    ok: true,
    isolation: running.run.isolation.effectiveLevel,
    enforcement: Object.fromEntries(Object.entries(running.run.isolation.enforcement).map(([name, facet]) => [name, facet.enforced])),
  }, null, 2)}\n`);
  runRoot = null;
} finally {
  if (runRoot) await runCli(['env', 'stop', runRoot, '--root', storageRoot]).catch(() => {});
  else if (environmentRoot) await runCli(['env', 'stop', environmentRoot, '--root', storageRoot]).catch(() => {});
  await rm(smokeRoot, { recursive: true, force: true });
}

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    timeout: 6 * 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function dockerJson(args) {
  const { stdout } = await execFileAsync('docker', [...args, '--format', '{{json .}}'], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(stdout).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = resolve(new URL('..', import.meta.url).pathname);
const cli = join(packageRoot, 'bin', 'agent-workbench.js');
const root = await mkdtemp(join(packageRoot, '.agent-workbench-docker-data-adapter-'));
let environmentRoot = null;

try {
  const profilePath = join(root, 'profile.json');
  const bindingsPath = join(root, 'bindings.json');
  const adcPath = join(root, 'adc.json');
  await writeJson(adcPath, {
    type: 'authorized_user',
    client_id: 'smoke-client',
    client_secret: 'smoke-secret',
    refresh_token: 'smoke-refresh',
  });
  await writeJson(profilePath, {
    schema: 'agent-workbench.environment-profile/v1',
    id: 'data-adapter-smoke',
    capabilities: {
      lock: {
        capabilities: [{ id: 'adapters.warehouse', kind: 'read-only-adapter', scope: 'data', version: '1' }],
      },
      adapters: [{
        id: 'adapters.warehouse',
        kind: 'bigquery-read',
        server: 'bigquery',
        credentialReference: 'credentials.google-adc',
        effect: 'warehouse.read',
        billingProject: 'billing-project',
        allowedProjects: ['source-project'],
        maximumBytesBilled: 1024,
        maximumRows: 20,
      }],
    },
    isolation: {
      provider: 'docker',
      minimumLevel: 'ephemeral-machine',
      credentialReferences: ['credentials.google-adc'],
      networkTargets: [
        'https://bigquery.googleapis.com/bigquery/v2',
        'https://oauth2.googleapis.com/token',
      ],
      externalEffects: { read: ['warehouse.read'], write: [] },
    },
  });
  await writeJson(bindingsPath, {
    schema: 'agent-workbench.environment-bindings/v1',
    credentials: { 'credentials.google-adc': { source: 'file', path: adcPath } },
  });
  await Promise.all([chmod(adcPath, 0o600), chmod(bindingsPath, 0o600)]);
  const created = await cliJson(['env', 'create', '--profile', profilePath, '--bindings', bindingsPath, '--root', join(root, 'environments')]);
  environmentRoot = created.environment.paths.root;
  const started = await cliJson(['env', 'run', environmentRoot, '--bindings', bindingsPath]);
  assert.equal(started.run.isolation.effectiveLevel, 'ephemeral-machine');
  const state = started.run.process.providerState;
  assert.equal(state.dataAdapters.length, 1);
  const adapter = state.dataAdapters[0];
  const workload = JSON.parse((await docker(['inspect', state.containerId])).stdout)[0];
  const sidecar = JSON.parse((await docker(['inspect', adapter.containerId])).stdout)[0];
  assert.equal(workload.HostConfig.ReadonlyRootfs, true);
  assert.equal(sidecar.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(sidecar.HostConfig.CapDrop, ['ALL']);
  assert.equal(sidecar.Config.Labels['ai.agent-workbench.run'], started.run.id);
  assert.equal(sidecar.Mounts.some((mount) => mount.Destination === '/run/secrets'), true);
  assert.equal(sidecar.Mounts.some((mount) => mount.Destination === '/run/workbench'), false);
  const probeScript = [
    "const fs=require('node:fs')",
    "const token=fs.readFileSync('/run/credentials/data-adapters/" + adapterDirectoryName('adapters.warehouse') + "/service-token','utf8').trim()",
    "const call=(id,method,params)=>fetch('http://" + adapter.containerName + ":4200/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})}).then(r=>r.json())",
    "Promise.all([call(1,'tools/list'),call(2,'tools/call',{name:'delete_table',arguments:{}})]).then(v=>process.stdout.write(JSON.stringify(v)))",
  ].join(';');
  const probe = JSON.parse((await docker(['exec', state.containerId, 'node', '-e', probeScript])).stdout);
  assert.deepEqual(probe[0].result.tools.map((tool) => tool.name), ['dry_run_query', 'run_query']);
  assert.match(probe[1].error.message, /outside the read-only allowlist/);
  const stopped = await cliJson(['env', 'stop', environmentRoot]);
  assert.equal(stopped.stopped, 1);
  const remaining = (await docker(['ps', '--all', '--quiet', '--filter', `label=ai.agent-workbench.run=${started.run.id}`])).stdout.trim();
  assert.equal(remaining, '');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId: started.run.id,
    effectiveIsolation: started.run.isolation.effectiveLevel,
    adapter: { id: adapter.id, kind: adapter.kind, server: adapter.server },
    tools: probe[0].result.tools.map((tool) => tool.name),
    rejectedTool: 'delete_table',
  }, null, 2)}\n`);
} catch (error) {
  if (environmentRoot) {
    const runsRoot = join(environmentRoot, 'runs');
    for (const run of await readdir(runsRoot, { withFileTypes: true }).catch(() => [])) {
      if (!run.isDirectory()) continue;
      for (const name of ['host.stderr.log', 'host.stdout.log']) {
        const log = await readFile(join(runsRoot, run.name, 'state', name), 'utf8').catch(() => '');
        if (log) process.stderr.write(`\n${name}:\n${log}\n`);
      }
    }
  }
  throw error;
} finally {
  if (environmentRoot) await cliJson(['env', 'stop', environmentRoot]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

async function cliJson(args) {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    env: process.env,
    timeout: 6 * 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function docker(args) {
  return execFileAsync(process.env.AGENT_WORKBENCH_DOCKER_COMMAND || 'docker', args, {
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function adapterDirectoryName(id) {
  return Buffer.from(id).toString('hex').slice(0, 48);
}

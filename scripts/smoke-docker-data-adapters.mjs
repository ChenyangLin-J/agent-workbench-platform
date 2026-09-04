import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
  const modulePath = join(root, 'module-mcp');
  await mkdir(modulePath, { mode: 0o700 });
  await writeJson(join(modulePath, 'package.json'), { name: 'module-smoke-read', type: 'module' });
  await writeFile(join(modulePath, 'adapter.mjs'), `
export async function createMcpHandler({ environment }) {
  return async (request) => {
    if (request.method === 'tools/list') return { jsonrpc: '2.0', id: request.id, result: { tools: [
      { name: 'query_smoke_data', description: 'Read-only smoke fixture.', inputSchema: { type: 'object' } },
    ] } };
    if (request.method === 'tools/call') return { jsonrpc: '2.0', id: request.id, result: {
      content: [{ type: 'text', text: environment.MODULE_SMOKE_TOKEN === 'module-smoke-secret' ? 'module-ok' : 'module-missing' }],
      isError: false,
    } };
  };
}
`, { mode: 0o600, flag: 'wx' });
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
        capabilities: [
          { id: 'adapters.module', kind: 'mcp-server', scope: 'data', version: '1' },
          { id: 'adapters.warehouse', kind: 'read-only-adapter', scope: 'data', version: '1' },
        ],
      },
      sources: [{ id: 'adapters.module', path: modulePath }],
      adapters: [
        {
          id: 'adapters.module',
          kind: 'module-mcp-read',
          server: 'module_read',
          entrypoint: 'adapter.mjs',
          credentialEnvironment: { MODULE_SMOKE_TOKEN: 'credentials.module-smoke-token' },
          networkTargets: ['https://module-smoke.example.test'],
          effect: 'module.read',
          allowedTools: ['query_smoke_data'],
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
    isolation: {
      provider: 'docker',
      minimumLevel: 'ephemeral-machine',
      credentialReferences: ['credentials.google-adc', 'credentials.module-smoke-token'],
      networkTargets: [
        'https://bigquery.googleapis.com/bigquery/v2',
        'https://oauth2.googleapis.com/token',
        'https://module-smoke.example.test',
      ],
      externalEffects: { read: ['module.read', 'warehouse.read'], write: [] },
    },
  });
  await writeJson(bindingsPath, {
    schema: 'agent-workbench.environment-bindings/v1',
    credentials: {
      'credentials.google-adc': { source: 'file', path: adcPath },
      'credentials.module-smoke-token': { source: 'environment', key: 'MODULE_SMOKE_TOKEN' },
    },
  });
  await Promise.all([chmod(adcPath, 0o600), chmod(bindingsPath, 0o600)]);
  const created = await cliJson(['env', 'create', '--profile', profilePath, '--bindings', bindingsPath, '--root', join(root, 'environments')]);
  environmentRoot = created.environment.paths.root;
  const started = await cliJson(['env', 'run', environmentRoot, '--bindings', bindingsPath]);
  assert.equal(started.run.isolation.effectiveLevel, 'ephemeral-machine');
  const state = started.run.process.providerState;
  assert.equal(state.dataAdapters.length, 2);
  const adapter = state.dataAdapters.find((entry) => entry.id === 'adapters.warehouse');
  const moduleAdapter = state.dataAdapters.find((entry) => entry.id === 'adapters.module');
  const workload = JSON.parse((await docker(['inspect', state.containerId])).stdout)[0];
  const sidecar = JSON.parse((await docker(['inspect', adapter.containerId])).stdout)[0];
  assert.equal(workload.HostConfig.ReadonlyRootfs, true);
  assert.equal(sidecar.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(sidecar.HostConfig.CapDrop, ['ALL']);
  assert.equal(sidecar.Config.Labels['ai.agent-workbench.run'], started.run.id);
  assert.equal(sidecar.Mounts.some((mount) => mount.Destination === '/run/secrets'), true);
  assert.equal(sidecar.Mounts.some((mount) => mount.Destination === '/run/workbench'), false);
  const moduleSidecar = JSON.parse((await docker(['inspect', moduleAdapter.containerId])).stdout)[0];
  assert.equal(moduleSidecar.HostConfig.ReadonlyRootfs, true);
  assert.equal(moduleSidecar.Mounts.some((mount) => mount.Destination === '/run/capability' && mount.RW === false), true);
  const probeScript = [
    "const fs=require('node:fs')",
    "const token=fs.readFileSync('/run/credentials/data-adapters/" + adapterDirectoryName('adapters.warehouse') + "/service-token','utf8').trim()",
    "const call=(id,method,params)=>fetch('http://" + adapter.containerName + ":4200/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})}).then(r=>r.json())",
    "Promise.all([call(1,'tools/list'),call(2,'tools/call',{name:'delete_table',arguments:{}})]).then(v=>process.stdout.write(JSON.stringify(v)))",
  ].join(';');
  const probe = JSON.parse((await docker(['exec', state.containerId, 'node', '-e', probeScript])).stdout);
  assert.deepEqual(probe[0].result.tools.map((tool) => tool.name), ['dry_run_query', 'run_query']);
  assert.match(probe[1].error.message, /outside the read-only allowlist/);
  const moduleProbeScript = [
    "const fs=require('node:fs')",
    "const token=fs.readFileSync('/run/credentials/data-adapters/" + adapterDirectoryName('adapters.module') + "/service-token','utf8').trim()",
    "const call=(id,method,params)=>fetch('http://" + moduleAdapter.containerName + ":4200/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})})}).then(r=>r.json())",
    "Promise.all([call(1,'tools/list'),call(2,'tools/call',{name:'query_smoke_data',arguments:{}}),call(3,'tools/call',{name:'delete_data',arguments:{}})]).then(v=>process.stdout.write(JSON.stringify(v)))",
  ].join(';');
  const moduleProbe = JSON.parse((await docker(['exec', state.containerId, 'node', '-e', moduleProbeScript])).stdout);
  assert.deepEqual(moduleProbe[0].result.tools.map((tool) => tool.name), ['query_smoke_data']);
  assert.equal(moduleProbe[1].result.content[0].text, 'module-ok');
  assert.match(moduleProbe[2].error.message, /outside the read-only allowlist/);
  const stopped = await cliJson(['env', 'stop', environmentRoot]);
  assert.equal(stopped.stopped, 1);
  const remaining = (await docker(['ps', '--all', '--quiet', '--filter', `label=ai.agent-workbench.run=${started.run.id}`])).stdout.trim();
  assert.equal(remaining, '');
  process.stdout.write(`${JSON.stringify({
    ok: true,
    runId: started.run.id,
    effectiveIsolation: started.run.isolation.effectiveLevel,
    adapters: [
      { id: adapter.id, kind: adapter.kind, server: adapter.server, tools: probe[0].result.tools.map((tool) => tool.name) },
      { id: moduleAdapter.id, kind: moduleAdapter.kind, server: moduleAdapter.server, tools: moduleProbe[0].result.tools.map((tool) => tool.name) },
    ],
    rejectedTools: ['delete_table', 'delete_data'],
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
    env: { ...process.env, MODULE_SMOKE_TOKEN: 'module-smoke-secret' },
    timeout: 12 * 60_000,
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

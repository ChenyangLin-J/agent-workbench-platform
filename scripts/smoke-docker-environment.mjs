import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
let brokerEnvironmentRoot = null;
let brokerRunRoot = null;

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
  runRoot = null;

  const codexHome = join(smokeRoot, 'source-codex-home');
  await mkdir(codexHome, { mode: 0o700 });
  const accessToken = jwt({ exp: Math.floor(Date.now() / 1_000) + 3_600, marker: 'docker-broker-secret' });
  await writeFile(join(codexHome, 'auth.json'), `${JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: accessToken, refresh_token: 'must-never-stage', account_id: 'account-smoke' },
  })}\n`, { mode: 0o600 });
  const candidateSkill = join(smokeRoot, 'candidate-skill');
  const originalSkill = '---\nname: docker-smoke-skill\ndescription: Immutable Docker smoke Skill.\n---\n\n# Docker smoke Skill\n';
  await mkdir(candidateSkill, { mode: 0o700 });
  await writeFile(join(candidateSkill, 'SKILL.md'), originalSkill, { mode: 0o600 });
  const brokerProfilePath = join(smokeRoot, 'broker-profile.json');
  await writeFile(brokerProfilePath, `${JSON.stringify({
    schema: 'agent-workbench.environment-profile/v1',
    id: 'docker-model-broker-smoke',
    runtime: { provider: 'codex', model: 'gpt-test' },
    features: { attachments: false },
    capabilities: {
      lock: {
        capabilities: [{ id: 'skills.docker-smoke', kind: 'skill-source', scope: 'custom', version: '1' }],
      },
      sources: [{ id: 'skills.docker-smoke', path: candidateSkill }],
    },
    isolation: {
      provider: 'docker',
      minimumLevel: 'ephemeral-machine',
      credentialReferences: ['credentials.codex-native'],
      networkTargets: ['https://chatgpt.com/backend-api/codex'],
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const brokerEnvironment = { CODEX_HOME: codexHome };
  const brokerCreated = await runCli(['env', 'create', '--profile', brokerProfilePath, '--root', storageRoot], brokerEnvironment);
  brokerEnvironmentRoot = brokerCreated.environment.paths.root;
  await writeFile(join(candidateSkill, 'SKILL.md'), originalSkill.replace('Immutable', 'Changed after Environment creation'), { mode: 0o600 });
  const brokerRunning = await runCli(['env', 'run', brokerEnvironmentRoot, '--root', storageRoot], brokerEnvironment);
  brokerRunRoot = brokerRunning.run.paths.root;
  assert.equal(brokerRunning.run.isolation.effectiveLevel, 'ephemeral-machine');
  const brokerState = brokerRunning.run.process.providerState;
  const [brokerWorkload, brokerIngress, brokerEgress, brokerNetwork] = await Promise.all([
    dockerJson(['inspect', brokerState.containerId]),
    dockerJson(['inspect', brokerState.ingressId]),
    dockerJson(['inspect', brokerState.egressId]),
    dockerJson(['network', 'inspect', brokerState.networkName]),
  ]);
  const brokerWorkloadRecord = brokerWorkload[0];
  const brokerIngressRecord = brokerIngress[0];
  const brokerEgressRecord = brokerEgress[0];
  assert.deepEqual(Object.keys(brokerWorkloadRecord.NetworkSettings.Networks), [brokerState.networkName]);
  assert.deepEqual(Object.keys(brokerEgressRecord.NetworkSettings.Networks).sort(), ['bridge', brokerState.networkName].sort());
  assert.equal(Object.values(brokerEgressRecord.NetworkSettings.Ports || {}).filter(Boolean).length, 0);
  assert.equal(brokerEgressRecord.HostConfig.ReadonlyRootfs, true);
  assert.equal(brokerEgressRecord.HostConfig.CapDrop.includes('ALL'), true);
  assert.equal(brokerNetwork[0].Internal, true);
  assert.deepEqual(Object.keys(brokerIngressRecord.NetworkSettings.Networks).sort(), ['bridge', brokerState.networkName].sort());
  assert.equal(brokerEgressRecord.Args.includes('--internal-model-egress'), true);
  const capabilityMount = brokerWorkloadRecord.Mounts.find((mount) => mount.Destination === '/run/workbench/capabilities');
  assert.equal(capabilityMount.RW, false);
  assert.equal(capabilityMount.Source, join(brokerRunRoot, 'capabilities'));
  assert.equal(brokerWorkloadRecord.Mounts.find((mount) => mount.Destination === '/run/credentials').Source.endsWith('/workload'), true);
  assert.equal(brokerEgressRecord.Mounts.find((mount) => mount.Destination === '/run/secrets').Source.endsWith('/broker'), true);
  assert.equal(JSON.stringify(brokerRunning.run).includes('docker-broker-secret'), false);
  assert.equal(JSON.stringify(brokerWorkloadRecord).includes('docker-broker-secret'), false);
  assert.equal(JSON.stringify(brokerEgressRecord).includes('docker-broker-secret'), false);
  const capabilitySnapshot = brokerRunning.run.capabilities.snapshots[0];
  assert.equal(await readFile(join(brokerRunRoot, 'capabilities', capabilitySnapshot.directory, 'SKILL.md'), 'utf8'), originalSkill);
  const [containerProfile, containerManifest, runtimeConfig] = await Promise.all([
    readFile(join(brokerRunRoot, 'credentials', 'workload', 'config', 'profile.json'), 'utf8'),
    readFile(join(brokerRunRoot, 'credentials', 'workload', 'config', 'manifest.json'), 'utf8'),
    readFile(join(brokerRunRoot, 'runtime', 'codex-home', 'config.toml'), 'utf8'),
  ]);
  assert.equal(containerProfile.includes(candidateSkill), false);
  assert.equal(containerManifest.includes(candidateSkill), false);
  assert.equal(runtimeConfig.includes(candidateSkill), false);
  assert.equal(containerManifest.includes(brokerProfilePath), false);
  assert.deepEqual(JSON.parse(containerProfile).capabilities.sources, []);
  assert.match(runtimeConfig, new RegExp(`/run/workbench/capabilities/${capabilitySnapshot.directory}/SKILL\\.md`));
  const stagedCredential = JSON.parse(await readFile(join(brokerRunRoot, 'credentials', 'broker', 'model.json'), 'utf8'));
  assert.equal(stagedCredential.accessToken, accessToken);
  assert.equal(JSON.stringify(stagedCredential).includes('must-never-stage'), false);
  const serviceToken = (await readFile(join(brokerRunRoot, 'credentials', 'workload', 'model-broker-token'), 'utf8')).trim();
  await execFileAsync(process.execPath, [join(packageRoot, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'debug', 'models', '--bundled'], {
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      CODEX_HOME: join(brokerRunRoot, 'runtime', 'codex-home'),
      AGENT_WORKBENCH_MODEL_BROKER_TOKEN: serviceToken,
    },
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const brokerStopped = await runCli(['env', 'stop', brokerRunRoot, '--root', storageRoot], brokerEnvironment);
  assert.equal(brokerStopped.stopped, 1);
  assert.deepEqual(await readdir(join(brokerRunRoot, 'credentials')), []);
  await assert.rejects(() => dockerJson(['inspect', brokerState.containerId]));
  await assert.rejects(() => dockerJson(['inspect', brokerState.ingressId]));
  await assert.rejects(() => dockerJson(['inspect', brokerState.egressId]));
  await assert.rejects(() => dockerJson(['network', 'inspect', brokerState.networkName]));
  brokerRunRoot = null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    isolation: running.run.isolation.effectiveLevel,
    enforcement: Object.fromEntries(Object.entries(running.run.isolation.enforcement).map(([name, facet]) => [name, facet.enforced])),
    modelBroker: {
      isolated: true,
      target: brokerState.modelBrokerTarget,
      refreshTokenStaged: false,
    },
    capabilitySnapshot: {
      immutable: true,
      readOnlyMount: true,
      sourcePathExposed: false,
    },
  }, null, 2)}\n`);
} finally {
  if (brokerRunRoot) await runCli(['env', 'stop', brokerRunRoot, '--root', storageRoot], { CODEX_HOME: join(smokeRoot, 'source-codex-home') }).catch(() => {});
  else if (brokerEnvironmentRoot) await runCli(['env', 'stop', brokerEnvironmentRoot, '--root', storageRoot], { CODEX_HOME: join(smokeRoot, 'source-codex-home') }).catch(() => {});
  if (runRoot) await runCli(['env', 'stop', runRoot, '--root', storageRoot]).catch(() => {});
  else if (environmentRoot) await runCli(['env', 'stop', environmentRoot, '--root', storageRoot]).catch(() => {});
  await rm(smokeRoot, { recursive: true, force: true });
}

async function runCli(args, environment = {}) {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: packageRoot,
    env: { ...process.env, ...environment },
    timeout: 12 * 60_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function jwt(payload) {
  return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
}

async function dockerJson(args) {
  const { stdout } = await execFileAsync('docker', [...args, '--format', '{{json .}}'], {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(stdout).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

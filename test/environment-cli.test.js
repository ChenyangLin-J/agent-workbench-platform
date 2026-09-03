import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  EnvironmentSessionStore,
  createEnvironment,
  createEnvironmentRun,
} from '../src/environment/index.js';

const execFileAsync = promisify(execFile);
const CLI = new URL('../bin/agent-workbench.js', import.meta.url).pathname;

test('CLI creates, runs, inspects, and stops a project-free Minimal Host', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-cli-'));
  const storageRoot = join(root, 'environments');
  const profilePath = join(root, 'profile.json');
  await writeFile(profilePath, `${JSON.stringify({
    schema: 'agent-workbench.environment-profile/v1',
    id: 'cli-minimal',
    features: { attachments: false },
    isolation: { provider: 'development', minimumLevel: 'development' },
  }, null, 2)}\n`);
  let runRoot = null;
  t.after(async () => {
    if (runRoot) await cli(['env', 'stop', runRoot, '--root', storageRoot]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const created = await cli(['env', 'create', '--profile', profilePath, '--root', storageRoot, '--id', 'cli-environment']);
  assert.equal(created.environment.kind, 'environment');
  const running = await cli(['env', 'run', created.environment.paths.root, '--root', storageRoot]);
  runRoot = running.run.paths.root;
  assert.equal(running.run.status, 'running');
  assert.equal(running.run.isolation.effectiveLevel, 'development');
  const page = await fetch(running.url).then((response) => response.text());
  assert.match(page, /minimal-host\.js/);
  assert.match(page, /bootstrap\.js/);
  const inspected = await cli(['env', 'inspect', runRoot, '--root', storageRoot]);
  assert.equal(inspected.manifest.process.pid, running.run.process.pid);
  const stopped = await cli(['env', 'stop', runRoot, '--root', storageRoot]);
  assert.equal(stopped.stopped, 1);
  runRoot = null;
});

test('CLI refuses to downgrade an unmet isolation requirement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = join(root, 'environments');
  const profilePath = join(root, 'profile.json');
  await writeFile(profilePath, `${JSON.stringify({
    id: 'guarded-required',
    isolation: { provider: 'development', minimumLevel: 'guarded-host' },
  })}\n`);
  const created = await cli(['env', 'create', '--profile', profilePath, '--root', storageRoot]);
  await assert.rejects(
    () => cli(['env', 'run', created.environment.paths.root, '--root', storageRoot]),
    (error) => error.payload?.error?.code === 'ISOLATION_REQUIREMENT_UNSATISFIED',
  );
});

test('CLI migrates a stopped Run into consumer-owned Session persistence used by the next Run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-cli-session-migration-'));
  const storageRoot = join(root, 'environments');
  let activeRunRoot = null;
  t.after(async () => {
    if (activeRunRoot) await cli(['env', 'stop', activeRunRoot, '--root', storageRoot]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const environment = await createEnvironment({
    storageRoot,
    environmentId: 'portable-cli-environment',
    profile: { id: 'portable-cli-profile' },
  });
  const sourceRun = await createEnvironmentRun(environment.paths.root, { runId: 'portable-source-run' });
  const sourceStore = new EnvironmentSessionStore({ stateRoot: sourceRun.paths.state, runId: sourceRun.id });
  const sourceSession = await sourceStore.create({ title: 'CLI portable Session' });
  await sourceStore.recordUserInput(sourceSession.sessionId, '跨 Run 可见');
  const bindingsPath = join(root, 'bindings.json');
  await writeFile(bindingsPath, `${JSON.stringify({
    schema: 'agent-workbench.environment-bindings/v1',
    credentials: {},
    storage: { sessionPersistence: { root: './portable-session-data' } },
  }, null, 2)}\n`, { mode: 0o600 });

  const migrated = await cli([
    'env', 'migrate-sessions', sourceRun.paths.root,
    '--bindings', bindingsPath,
    '--root', storageRoot,
  ]);
  assert.equal(migrated.migration.sessions, 1);
  const portableRoot = await realpath(join(root, 'portable-session-data'));
  assert.equal(migrated.migration.destinationRoot, portableRoot);

  const running = await cli([
    'env', 'run', environment.paths.root,
    '--bindings', bindingsPath,
    '--root', storageRoot,
  ]);
  activeRunRoot = running.run.paths.root;
  assert.equal(running.run.paths.sessionState, join(portableRoot, 'state'));
  const bootstrap = await fetch(`${running.url}/bootstrap.js`).then((response) => response.text());
  const accessToken = JSON.parse(bootstrap.match(/=(.*);\n$/s)[1]).accessToken;
  const sessions = await fetch(`${running.url}/api/sessions`, {
    headers: { 'x-agent-workbench-token': accessToken },
  }).then((response) => response.json());
  assert.equal(sessions.sessions[0].id, sourceSession.sessionId);
  assert.equal(sessions.sessions[0].runtimeContinuationRequired, true);
});

async function cli(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    try { error.payload = JSON.parse(error.stderr); } catch {}
    throw error;
  }
}

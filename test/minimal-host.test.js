import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessionKernel } from '../src/runtime/core/index.js';
import {
  EnvironmentSessionStore,
  buildMinimalHostAssets,
  createMinimalHost,
  runtimeEnvironment,
} from '../src/environment/index.js';
import { minimalHostSessionPresentation, selectMinimalHostSession } from '../src/environment/host-presentation.js';
import { FakeRuntimeProvider } from './core-testkit.js';

test('Minimal Host creates and runs project-free Sessions through the Core Kernel', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const provider = new FakeRuntimeProvider({ capabilities: { steer: true } });
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const host = createMinimalHost({
    manifest: runManifest(root),
    kernel,
    sessionStore: store,
    accessToken: 'test-token',
  });
  const listening = await host.start();
  t.after(() => host.stop());
  const headers = { 'content-type': 'application/json', 'x-agent-workbench-token': 'test-token' };
  assert.equal((await fetch(`${listening.url}/api/health`, { headers })).status, 200);
  assert.equal((await fetch(`${listening.url}/api/health`)).status, 401);
  const createdResponse = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'Host session' }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()).session;
  assert.equal(created.contextId, 'environment');
  assert.equal(provider.createdSessions[0].cwd, join(root, 'workspace'));
  assert.equal(provider.createdSessions[0].settings.approvalPolicy, 'never');
  assert.equal(provider.createdSessions[0].settings.sandbox, 'danger-full-access');
  const turnResponse = await fetch(`${listening.url}/api/sessions/${created.sessionId}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: 'hello' }),
  });
  assert.equal(turnResponse.status, 202);
  provider.createdSessions[0].emit('event', {
    type: 'item_delta',
    runtimeSessionId: provider.createdSessions[0].runtimeSessionId,
    runtimeTurnId: provider.createdSessions[0].activeTurnId,
    providerEvent: 'item/agentMessage/delta',
    payload: { itemId: 'agent-response', delta: 'hi' },
  });
  let detail;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    detail = await fetch(`${listening.url}/api/sessions/${created.sessionId}`, { headers }).then((response) => response.json());
    if (detail.session.messages.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(detail.session.messages.map((message) => message.content), ['hello', 'hi']);
  assert.equal('projectId' in detail.session, false);
});

test('Minimal Host assets build without consumer source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assets = await buildMinimalHostAssets({ outputDirectory: root });
  const [indexResponse, scriptResponse, stylesheetResponse] = await Promise.all([
    readFile(assets.index, 'utf8'),
    readFile(assets.script, 'utf8'),
    readFile(assets.stylesheet, 'utf8'),
  ]);
  assert.match(indexResponse, /minimal-host\.js\?v=[a-f0-9]{12}/);
  assert.match(indexResponse, /minimal-host\.css\?v=[a-f0-9]{12}/);
  assert.doesNotMatch(indexResponse, /__MINIMAL_HOST_ASSET_VERSION__/);
  assert.match(indexResponse, /rel="icon" href="data:image\/svg\+xml/);
  assert.match(scriptResponse, /runtimeBinding/);
  assert.match(scriptResponse, /awb-host-error/);
  assert.match(scriptResponse, /onToggleList/);
  assert.doesNotMatch(scriptResponse, /Stop Run|Isolation:/);
  assert.doesNotMatch(scriptResponse, /\/api\/environment/);
  assert.ok(scriptResponse.length > 1_000);
  assert.ok(stylesheetResponse.length > 0);

  const runRoot = join(root, 'run');
  const store = new EnvironmentSessionStore({ stateRoot: join(runRoot, 'state') });
  const provider = new FakeRuntimeProvider({ capabilities: { steer: true } });
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const host = createMinimalHost({
    manifest: runManifest(runRoot),
    kernel,
    sessionStore: store,
    assetsRoot: root,
  });
  const listening = await host.start();
  t.after(() => host.stop());
  const servedIndex = await fetch(listening.url);
  assert.match(servedIndex.headers.get('content-security-policy'), /style-src 'self' 'unsafe-inline'/);
  assert.equal(servedIndex.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${listening.url}/minimal-host.js`)).headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${listening.url}/minimal-host.css`)).headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${listening.url}/favicon.ico`)).status, 404);
});

test('Minimal Host presentation selects the newest available Session and preserves a valid selection', () => {
  const sessions = [{ id: 'newest' }, { id: 'older' }];
  assert.equal(selectMinimalHostSession(sessions), 'newest');
  assert.equal(selectMinimalHostSession(sessions, 'older'), 'older');
  assert.equal(selectMinimalHostSession(sessions, 'missing'), 'newest');
  assert.equal(selectMinimalHostSession([], 'missing'), null);
  assert.deepEqual(minimalHostSessionPresentation({ title: 'New Session', contextLabel: 'Environment' }), {
    title: '新对话',
    contextLabel: '',
  });
});

test('Codex Runtime constructs an allowlisted environment without inherited secrets', () => {
  const manifest = runManifest('/tmp/runtime-environment-test');
  manifest.isolation.environmentKeys = ['ALLOWED_VALUE'];
  const environment = runtimeEnvironment(manifest, {
    PATH: '/usr/bin',
    LANG: 'en_US.UTF-8',
    ALLOWED_VALUE: 'visible',
    UNDECLARED_SECRET: 'hidden',
  });
  assert.equal(environment.ALLOWED_VALUE, 'visible');
  assert.equal(environment.UNDECLARED_SECRET, undefined);
  assert.equal(environment.HOME, '/tmp/runtime-environment-test/runtime/home');
  assert.equal(environment.CODEX_HOME, '/tmp/runtime-environment-test/runtime/codex-home');
  assert.equal(environment.TMPDIR, '/tmp/runtime-environment-test/tmp');
});

function runManifest(root) {
  return {
    schema: 'agent-workbench.environment/v1',
    kind: 'run',
    id: 'run-test',
    environmentId: 'environment-test',
    status: 'running',
    versions: { platform: 'test', runtime: 'test' },
    profile: { id: 'minimal', hash: 'hash', source: { type: 'inline' } },
    runtime: { provider: 'fake' },
    features: { sessionWorkspace: true },
    capabilities: { lock: { capabilities: [] }, hash: 'hash' },
    isolation: {
      requestedLevel: 'ephemeral-machine',
      effectiveLevel: 'ephemeral-machine',
      enforcement: { externalEffects: { enforced: true, mode: 'no-external-effects' } },
    },
    paths: {
      root,
      runtime: join(root, 'runtime'),
      state: join(root, 'state'),
      workspace: join(root, 'workspace'),
      temporary: join(root, 'tmp'),
      credentials: join(root, 'credentials'),
    },
    process: { pid: process.pid, port: 0, providerState: {} },
    extensions: {},
    lifecycle: { createdAt: new Date().toISOString(), startedAt: new Date().toISOString() },
  };
}

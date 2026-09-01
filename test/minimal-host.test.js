import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
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
import { FilesystemResourceStore } from '../src/filesystem-resource-store.js';
import { RESOURCE_SCHEMA } from '../src/resources.js';
import { minimalHostSessionPresentation, selectMinimalHostSession } from '../src/environment/host-presentation.js';
import { FakeRuntimeProvider } from './core-testkit.js';
import { resolveMinimalHostUrl } from '../src/environment/host-url.js';

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
  assert.match(indexResponse, /src="\.\/bootstrap\.js"/);
  assert.doesNotMatch(indexResponse, /(?:href|src)="\/minimal-host/);
  assert.doesNotMatch(indexResponse, /__MINIMAL_HOST_ASSET_VERSION__/);
  assert.match(indexResponse, /rel="icon" href="data:image\/svg\+xml/);
  assert.match(scriptResponse, /runtimeBinding/);
  assert.match(scriptResponse, /awb-host-error/);
  assert.match(scriptResponse, /onToggleList/);
  assert.match(scriptResponse, /onUploadAttachments/);
  assert.match(scriptResponse, /onResolveDroppedDirectories/);
  assert.match(scriptResponse, /directory-references/);
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
  const bootstrap = await fetch(`${listening.url}/bootstrap.js`).then((response) => response.text());
  assert.match(bootstrap, /"features":\{"sessionWorkspace":true,"attachments":true\}/);
  assert.equal((await fetch(`${listening.url}/favicon.ico`)).status, 404);
});

test('Minimal Host uploads Session attachments, passes them to Runtime, and derives the initial title', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-attachments-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const provider = new FakeRuntimeProvider();
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const resourceStore = new FilesystemResourceStore({ root: join(root, 'resources') });
  const host = createMinimalHost({ manifest: runManifest(root), kernel, sessionStore: store, resourceStore });
  const listening = await host.start();
  t.after(() => host.stop());
  const headers = { 'content-type': 'application/json' };

  const created = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST',
    headers,
    body: '{}',
  }).then((response) => response.json());
  const sessionId = created.session.sessionId;
  const content = 'ATTACHMENT_CANARY_OK';
  const uploadResponse = await fetch(`${listening.url}/api/sessions/${sessionId}/attachments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      attachment: {
        name: 'canary.txt',
        type: 'text/plain',
        size: Buffer.byteLength(content),
        data: `data:text/plain;base64,${Buffer.from(content).toString('base64')}`,
      },
    }),
  });
  assert.equal(uploadResponse.status, 201);
  const attachment = (await uploadResponse.json()).attachment;
  assert.equal(attachment.resource.schema, RESOURCE_SCHEMA);
  assert.equal(attachment.resource.lifecycle.state, 'staged');
  assert.equal(JSON.stringify(attachment).includes(root), false);

  const turnResponse = await fetch(`${listening.url}/api/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: '读取附件中的校验码', attachments: [attachment] }),
  });
  assert.equal(turnResponse.status, 202);
  assert.deepEqual(provider.createdSessions[0].startedTurns[0].input[0], {
    type: 'text',
    text: '读取附件中的校验码',
  });
  assert.match(provider.createdSessions[0].startedTurns[0].input[1].text, /ATTACHMENT_CANARY_OK/);

  const detail = await fetch(`${listening.url}/api/sessions/${sessionId}`).then((response) => response.json());
  assert.equal(detail.session.title, '读取附件中的校验码');
  assert.equal(JSON.stringify(detail.session.messages[0].attachments).includes(root), false);
  assert.equal(detail.session.messages[0].attachments[0].name, 'canary.txt');
  assert.equal(detail.session.messages[0].attachments[0].resource.lifecycle.state, 'ready');
  assert.equal(
    detail.session.messages[0].attachments[0].resource.owner.turnId,
    provider.createdSessions[0].startedTurns[0].runtimeTurnId,
  );
  const downloaded = await fetch(
    `${listening.url}/api/sessions/${sessionId}/attachments/${attachment.id}/content`,
  );
  assert.equal(await downloaded.text(), content);
  assert.deepEqual(await resourceStore.inspectUsage(), {
    resources: 1,
    bytes: Buffer.byteLength(content),
    byClass: { 'session-durable': 1 },
    byState: { ready: 1 },
  });
});

test('Minimal Host leaves failed Turn attachments staged and rejects cross-Session reuse', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-resource-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const resourceStore = new FilesystemResourceStore({ root: join(root, 'resources') });
  const provider = new FakeRuntimeProvider();
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const host = createMinimalHost({ manifest: runManifest(root), kernel, sessionStore: store, resourceStore });
  const listening = await host.start();
  t.after(() => host.stop());
  const headers = { 'content-type': 'application/json' };

  const first = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST', headers, body: '{}',
  }).then((response) => response.json());
  const second = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST', headers, body: '{}',
  }).then((response) => response.json());
  const sessionId = first.session.sessionId;
  const attachment = await fetch(`${listening.url}/api/sessions/${sessionId}/attachments`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ attachment: {
      name: 'retry.txt',
      type: 'text/plain',
      size: 5,
      data: `data:text/plain;base64,${Buffer.from('retry').toString('base64')}`,
    } }),
  }).then((response) => response.json()).then((body) => body.attachment);

  const crossSession = await fetch(`${listening.url}/api/sessions/${second.session.sessionId}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: '不应读取', attachments: [attachment] }),
  });
  assert.equal(crossSession.status, 403);
  assert.equal((await store.get(second.session.sessionId)).messages.length, 0);

  provider.createdSessions[0].startTurn = async () => {
    throw Object.assign(new Error('Synthetic Runtime rejection'), {
      code: 'SYNTHETIC_RUNTIME_REJECTION',
      status: 409,
    });
  };
  const failedTurn = await fetch(`${listening.url}/api/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: '稍后重试', attachments: [attachment] }),
  });
  assert.equal(failedTurn.status, 409);
  assert.equal((await store.get(sessionId)).messages.length, 0);
  assert.equal((await resourceStore.get(attachment.id, { sessionId })).lifecycle.state, 'staged');
});

test('Minimal Host registers authorized directories as persistent external Resources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-directories-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const referencedDirectory = join(workspace, '资料');
  const unauthorizedDirectory = await mkdtemp(join(tmpdir(), 'awb-host-outside-'));
  t.after(() => rm(unauthorizedDirectory, { recursive: true, force: true }));
  await mkdir(referencedDirectory, { recursive: true });
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const provider = new FakeRuntimeProvider();
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const resourceStore = new FilesystemResourceStore({ root: join(root, 'resources') });
  const host = createMinimalHost({ manifest: runManifest(root), kernel, sessionStore: store, resourceStore });
  const listening = await host.start();
  t.after(() => host.stop());
  const headers = { 'content-type': 'application/json' };
  const created = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST', headers, body: '{}',
  }).then((response) => response.json());
  const sessionId = created.session.sessionId;

  const rejected = await fetch(`${listening.url}/api/sessions/${sessionId}/directory-references`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ directories: [{ name: 'outside', pathHint: unauthorizedDirectory }] }),
  });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error.code, 'DIRECTORY_PATH_UNAUTHORIZED');

  const registeredResponse = await fetch(`${listening.url}/api/sessions/${sessionId}/directory-references`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ directories: [{ name: '资料', pathHint: referencedDirectory }] }),
  });
  assert.equal(registeredResponse.status, 201);
  const directory = (await registeredResponse.json()).resources[0];
  assert.equal(directory.kind, 'directory');
  assert.equal(directory.resource.kind, 'workspace-directory');
  assert.equal(directory.resource.mode, 'external');
  assert.equal(directory.resource.lifecycle.class, 'workspace');
  assert.equal(JSON.stringify(directory).includes(referencedDirectory), false);

  const turnResponse = await fetch(`${listening.url}/api/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: '查看这个文件夹', attachments: [directory] }),
  });
  assert.equal(turnResponse.status, 202);
  const runtimeInput = provider.createdSessions[0].startedTurns[0].input;
  assert.deepEqual(runtimeInput[0], { type: 'text', text: '查看这个文件夹' });
  assert.match(runtimeInput[1].text, /Authorized workspace-directory/);
  assert.equal(runtimeInput[1].text.includes(referencedDirectory), true);

  const detail = await fetch(`${listening.url}/api/sessions/${sessionId}`).then((response) => response.json());
  const persisted = detail.session.messages[0].attachments[0];
  assert.equal(persisted.kind, 'directory');
  assert.equal(persisted.resource.owner.turnId, provider.createdSessions[0].startedTurns[0].runtimeTurnId);
  assert.equal(JSON.stringify(persisted).includes(referencedDirectory), false);

  const staleDirectory = join(workspace, 'stale');
  await mkdir(staleDirectory);
  const stale = await fetch(`${listening.url}/api/sessions/${sessionId}/directory-references`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ directories: [{ name: 'stale', pathHint: staleDirectory }] }),
  }).then((response) => response.json()).then((body) => body.resources[0]);
  await rm(staleDirectory, { recursive: true });
  const staleTurn = await fetch(`${listening.url}/api/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ prompt: '不应读取', attachments: [stale] }),
  });
  assert.equal(staleTurn.status, 404);
  assert.equal((await staleTurn.json()).error.code, 'DIRECTORY_NOT_FOUND');
  assert.equal(provider.createdSessions[0].startedTurns.length, 1);
});

test('Minimal Host inserts accepted user input before synchronously completed Runtime output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-fast-turn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const provider = new FakeRuntimeProvider();
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const host = createMinimalHost({ manifest: runManifest(root), kernel, sessionStore: store });
  const listening = await host.start();
  t.after(() => host.stop());
  const headers = { 'content-type': 'application/json' };
  const created = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST', headers, body: '{}',
  }).then((response) => response.json());
  const runtime = provider.createdSessions[0];
  const originalStartTurn = runtime.startTurn.bind(runtime);
  runtime.startTurn = async (input) => {
    const result = await originalStartTurn(input);
    runtime.emit('event', {
      type: 'item_delta',
      runtimeSessionId: runtime.runtimeSessionId,
      runtimeTurnId: result.runtimeTurnId,
      providerEvent: 'item/agentMessage/delta',
      payload: { itemId: 'fast-answer', delta: '同步完成' },
    });
    runtime.complete(result.runtimeTurnId);
    return result;
  };

  const response = await fetch(`${listening.url}/api/sessions/${created.session.sessionId}/turns`, {
    method: 'POST', headers, body: JSON.stringify({ prompt: '快速问题' }),
  });
  assert.equal(response.status, 202);
  const detail = await store.get(created.session.sessionId);
  assert.deepEqual(detail.messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: '快速问题' },
    { role: 'assistant', content: '同步完成' },
  ]);
  assert.equal(detail.messages[0].turnId, detail.messages[1].turnId);
});

test('Minimal Host client resolves APIs inside its mounted product namespace', () => {
  assert.equal(
    resolveMinimalHostUrl('/api/sessions', { baseUrl: 'https://datamama.example/agent/' }),
    'https://datamama.example/agent/api/sessions',
  );
  assert.equal(
    resolveMinimalHostUrl('api/sessions/session-1/events', { baseUrl: 'http://127.0.0.1:4188/' }),
    'http://127.0.0.1:4188/api/sessions/session-1/events',
  );
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

test('Minimal Host isolates Sessions by a verified owner header', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const provider = new FakeRuntimeProvider();
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const host = createMinimalHost({
    manifest: runManifest(root),
    kernel,
    sessionStore: store,
    accessToken: 'test-token',
    sessionOwnerHeader: 'x-datamama-user-id',
  });
  const listening = await host.start();
  t.after(() => host.stop());
  const headersFor = (ownerId) => ({
    'content-type': 'application/json',
    'x-agent-workbench-token': 'test-token',
    'x-datamama-user-id': ownerId,
  });

  assert.equal((await fetch(`${listening.url}/api/sessions`, {
    headers: { 'x-agent-workbench-token': 'test-token' },
  })).status, 401);
  const first = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST',
    headers: headersFor('user-a'),
    body: '{}',
  }).then((response) => response.json());
  const second = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST',
    headers: headersFor('user-b'),
    body: '{}',
  }).then((response) => response.json());

  const listA = await fetch(`${listening.url}/api/sessions`, {
    headers: headersFor('user-a'),
  }).then((response) => response.json());
  const listB = await fetch(`${listening.url}/api/sessions`, {
    headers: headersFor('user-b'),
  }).then((response) => response.json());
  assert.deepEqual(listA.sessions.map((session) => session.id), [first.session.id]);
  assert.deepEqual(listB.sessions.map((session) => session.id), [second.session.id]);
  assert.equal((await fetch(`${listening.url}/api/sessions/${first.session.id}`, {
    headers: headersFor('user-b'),
  })).status, 404);
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
    features: { sessionWorkspace: true, attachments: true },
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
      resources: join(root, 'resources'),
      workspace: join(root, 'workspace'),
      temporary: join(root, 'tmp'),
      credentials: join(root, 'credentials'),
    },
    process: { pid: process.pid, port: 0, providerState: {} },
    extensions: {},
    lifecycle: { createdAt: new Date().toISOString(), startedAt: new Date().toISOString() },
  };
}

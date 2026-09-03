import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentSessionKernel } from '../src/runtime/core/index.js';
import {
  EnvironmentSessionRuntimeStore,
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

test('Minimal Host creates an idempotent Session with an unsent draft', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-initial-draft-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const provider = new FakeRuntimeProvider();
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const host = createMinimalHost({
    manifest: runManifest(root),
    kernel,
    sessionStore: store,
    sessionOwnerHeader: 'x-session-owner',
    sessionObserverHeader: 'x-session-observer',
  });
  const listening = await host.start();
  t.after(() => host.stop());
  const draft = '我正在看 Solver Engine 的实验 167。\n我需要：';
  const headers = {
    'content-type': 'application/json',
    'x-session-owner': 'user-a',
    'idempotency-key': 'solver-launch:launch-1',
  };
  const create = () => fetch(`${listening.url}/api/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ title: '新对话', draft }),
  });
  const firstResponse = await create();
  const first = (await firstResponse.json()).session;
  const retry = (await (await create()).json()).session;
  assert.equal(firstResponse.status, 201);
  assert.equal(first.sessionId, retry.sessionId);
  assert.equal(first.draft, draft);
  assert.equal(provider.createdSessions.length, 1);

  const conflict = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: '新对话', draft: '不同草稿' }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'SESSION_CREATE_IDEMPOTENCY_CONFLICT');
  const otherOwner = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST',
    headers: { ...headers, 'x-session-owner': 'user-b' },
    body: JSON.stringify({ title: '新对话', draft }),
  }).then((response) => response.json()).then((body) => body.session);
  assert.notEqual(otherOwner.sessionId, first.sessionId);
  assert.equal(provider.createdSessions.length, 2);

  const observed = await fetch(`${listening.url}/api/observer/sessions/${first.sessionId}`, {
    headers: { 'x-session-observer': 'true' },
  }).then((response) => response.json()).then((body) => body.session);
  assert.equal('draft' in observed, false);

  const turnResponse = await fetch(`${listening.url}/api/sessions/${first.sessionId}/turns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-owner': 'user-a' },
    body: JSON.stringify({ prompt: `${draft}分析收入` }),
  });
  assert.equal(turnResponse.status, 202);
  const detail = await fetch(`${listening.url}/api/sessions/${first.sessionId}`, {
    headers: { 'x-session-owner': 'user-a' },
  }).then((response) => response.json()).then((body) => body.session);
  assert.equal(detail.draft, '');
  assert.equal(detail.messages[0].content, `${draft}分析收入`);

  for (const invalidDraft of [{ prompt: 'object' }, 'x'.repeat(12_001)]) {
    const response = await fetch(`${listening.url}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-owner': 'user-a' },
      body: JSON.stringify({ draft: invalidDraft }),
    });
    assert.equal(response.status, 400);
  }
});

test('Minimal Host reads portable Sessions across Runs without reusing stale Runtime bindings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-portable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sharedState = join(root, 'shared-state');
  const sharedResources = new FilesystemResourceStore({ root: join(root, 'shared-resources') });

  const runARoot = join(root, 'run-a');
  const sessionStoreA = new EnvironmentSessionStore({ stateRoot: sharedState, runId: 'run-a' });
  const runtimeStoreA = new EnvironmentSessionRuntimeStore({ stateRoot: join(runARoot, 'state') });
  const providerA = new FakeRuntimeProvider();
  const hostA = createMinimalHost({
    manifest: runManifest(runARoot, 'run-a'),
    kernel: new AgentSessionKernel({ provider: providerA, bindingStore: runtimeStoreA, validateRequest: () => {} }),
    sessionStore: sessionStoreA,
    runtimeStateStore: runtimeStoreA,
    resourceStore: sharedResources,
    sessionOwnerHeader: 'x-session-owner',
  });
  const listeningA = await hostA.start();
  t.after(() => hostA.stop());
  const ownerHeaders = { 'content-type': 'application/json', 'x-session-owner': 'user-a' };
  const created = await fetch(`${listeningA.url}/api/sessions`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ title: '跨 Run 历史' }),
  }).then((response) => response.json()).then((body) => body.session);
  const turnResponse = await fetch(`${listeningA.url}/api/sessions/${created.sessionId}/turns`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ prompt: '保留这条消息' }),
  });
  assert.equal(turnResponse.status, 202);
  const firstTurn = (await turnResponse.json()).result;
  providerA.createdSessions[0].complete(firstTurn.runtimeTurnId);
  await eventually(async () => !(await runtimeStoreA.load(created.sessionId)).activeTurnId);
  const secondTurnResponse = await fetch(`${listeningA.url}/api/sessions/${created.sessionId}/turns`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ prompt: '准备跨 Run 编辑' }),
  });
  assert.equal(secondTurnResponse.status, 202);
  const secondTurn = (await secondTurnResponse.json()).result;
  providerA.createdSessions[0].complete(secondTurn.runtimeTurnId);
  await eventually(async () => !(await runtimeStoreA.load(created.sessionId)).activeTurnId);
  assert.equal((await runtimeStoreA.load(created.sessionId)).runtimeSessionId != null, true);
  await hostA.stop();

  const runBRoot = join(root, 'run-b');
  const sessionStoreB = new EnvironmentSessionStore({ stateRoot: sharedState, runId: 'run-b' });
  const runtimeStoreB = new EnvironmentSessionRuntimeStore({ stateRoot: join(runBRoot, 'state') });
  const providerB = new FakeRuntimeProvider();
  const hostB = createMinimalHost({
    manifest: runManifest(runBRoot, 'run-b'),
    kernel: new AgentSessionKernel({ provider: providerB, bindingStore: runtimeStoreB, validateRequest: () => {} }),
    sessionStore: sessionStoreB,
    runtimeStateStore: runtimeStoreB,
    resourceStore: sharedResources,
    sessionOwnerHeader: 'x-session-owner',
  });
  const listeningB = await hostB.start();
  t.after(() => hostB.stop());

  const listed = await fetch(`${listeningB.url}/api/sessions`, { headers: ownerHeaders }).then((response) => response.json());
  assert.equal(listed.sessions[0].id, created.sessionId);
  assert.equal(listed.sessions[0].runtimeContinuationRequired, true);
  const detail = await fetch(`${listeningB.url}/api/sessions/${created.sessionId}`, { headers: ownerHeaders }).then((response) => response.json());
  assert.deepEqual(detail.session.messages.map((message) => message.content), ['保留这条消息', '准备跨 Run 编辑']);
  assert.equal(detail.session.composerDisabled, true);
  assert.equal(providerB.createdSessions.length, 0);

  const rejected = await fetch(`${listeningB.url}/api/sessions/${created.sessionId}/turns`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ prompt: '不能静默接到空白 Runtime' }),
  });
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error.code, 'HOST_SESSION_CONTINUATION_REQUIRED');
  assert.equal(await runtimeStoreB.load(created.sessionId), null);

  const forkedResponse = await fetch(`${listeningB.url}/api/sessions/${created.sessionId}/branches`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      replaceTurnId: secondTurn.runtimeTurnId,
      prompt: '跨 Run 分叉成功',
      intent: 'fork',
    }),
  });
  assert.equal(forkedResponse.status, 201);
  const forked = await forkedResponse.json();
  assert.equal(forked.sourceArchived, false);
  assert.notEqual(forked.session.sessionId, created.sessionId);
  assert.deepEqual(forked.session.messages.map((message) => message.content), ['保留这条消息', '跨 Run 分叉成功']);
  assert.equal((await sessionStoreB.get(created.sessionId, { ownerId: 'user-a' })).archived, false);
  assert.equal(providerB.createdSessions.length, 1);
  assert.match(providerB.createdSessions[0].startedTurns[0].input[0].text, /保留这条消息/);
  assert.equal(providerB.createdSessions[0].startedTurns[0].input[1].text, '跨 Run 分叉成功');
  assert.equal((await runtimeStoreB.load(forked.session.sessionId)).portableHistory, true);

  const editedResponse = await fetch(`${listeningB.url}/api/sessions/${created.sessionId}/branches`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({
      replaceTurnId: secondTurn.runtimeTurnId,
      prompt: '跨 Run 编辑成功',
      intent: 'edit',
    }),
  });
  assert.equal(editedResponse.status, 201);
  const edited = await editedResponse.json();
  assert.equal(edited.sourceArchived, true);
  assert.notEqual(edited.session.sessionId, created.sessionId);
  assert.deepEqual(edited.session.messages.map((message) => message.content), ['保留这条消息', '跨 Run 编辑成功']);
  assert.equal((await sessionStoreB.get(created.sessionId, { ownerId: 'user-a' })).archived, true);
  assert.equal(providerB.createdSessions.length, 2);
  assert.match(providerB.createdSessions[1].startedTurns[0].input[0].text, /保留这条消息/);
  assert.equal(providerB.createdSessions[1].startedTurns[0].input[1].text, '跨 Run 编辑成功');
  assert.equal((await runtimeStoreB.load(edited.session.sessionId)).portableHistory, true);
  assert.deepEqual(await fetch(`${listeningB.url}/api/sessions`, {
    headers: { 'x-session-owner': 'user-b' },
  }).then((response) => response.json()), { sessions: [] });
  assert.equal((await fetch(`${listeningB.url}/api/sessions/${created.sessionId}`, {
    headers: { 'x-session-owner': 'user-b' },
  })).status, 404);

  const createdInRunB = await fetch(`${listeningB.url}/api/sessions`, {
    method: 'POST',
    headers: ownerHeaders,
    body: JSON.stringify({ title: 'Run B Session' }),
  }).then((response) => response.json()).then((body) => body.session);
  assert.equal(createdInRunB.createdRunId, 'run-b');
  assert.equal((await sessionStoreA.list()).length, 3);
  assert.equal((await runtimeStoreB.load(createdInRunB.sessionId)).runtimeSessionId != null, true);
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
  assert.match(scriptResponse, /api\/observer\/sessions/);
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

test('Minimal Host persists a queued Turn and starts it after the active Turn completes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const provider = new FakeRuntimeProvider({ capabilities: { steer: true } });
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const host = createMinimalHost({ manifest: runManifest(root), kernel, sessionStore: store });
  const listening = await host.start();
  t.after(() => host.stop());
  const headers = { 'content-type': 'application/json' };
  const created = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST', headers, body: '{}',
  }).then((response) => response.json());
  const sessionId = created.session.sessionId;
  const first = await fetch(`${listening.url}/api/sessions/${sessionId}/turns`, {
    method: 'POST', headers, body: JSON.stringify({ prompt: 'first' }),
  }).then((response) => response.json());
  const queuedResponse = await fetch(`${listening.url}/api/sessions/${sessionId}/turns`, {
    method: 'POST', headers, body: JSON.stringify({ prompt: 'second', mode: 'queue' }),
  });
  assert.equal(queuedResponse.status, 202);
  assert.equal((await queuedResponse.json()).queued, true);
  assert.deepEqual((await fetch(`${listening.url}/api/sessions/${sessionId}`).then((response) => response.json()))
    .session.queuedTurns.map((turn) => turn.prompt), ['second']);

  provider.createdSessions[0].complete(first.result.runtimeTurnId);
  await eventually(() => provider.createdSessions[0].startedTurns.length === 2);
  await eventually(async () => !(await store.loadQueuedTurns())[sessionId]?.length);
  const detail = await fetch(`${listening.url}/api/sessions/${sessionId}`).then((response) => response.json());
  assert.deepEqual(detail.session.queuedTurns, []);
  assert.deepEqual(detail.session.messages.filter((message) => message.role === 'user').map((message) => message.content), [
    'first',
    'second',
  ]);
});

test('Minimal Host Edit archives the source after creating an independent replacement Session', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-branch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const provider = new FakeRuntimeProvider({ capabilities: { fork: true } });
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const host = createMinimalHost({
    manifest: runManifest(root),
    kernel,
    sessionStore: store,
    sessionObserverHeader: 'x-test-observer',
  });
  const listening = await host.start();
  t.after(() => host.stop());
  const headers = { 'content-type': 'application/json' };
  const created = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST', headers, body: '{}',
  }).then((response) => response.json());
  const sourceSessionId = created.session.sessionId;
  const first = await fetch(`${listening.url}/api/sessions/${sourceSessionId}/turns`, {
    method: 'POST', headers, body: JSON.stringify({ prompt: 'first' }),
  }).then((response) => response.json());
  const sourceRuntimeId = provider.createdSessions[0].runtimeSessionId;
  provider.createdSessions[0].complete(first.result.runtimeTurnId);
  await eventually(async () => !(await store.get(sourceSessionId)).runtimeBinding.activeTurnId);
  const second = await fetch(`${listening.url}/api/sessions/${sourceSessionId}/turns`, {
    method: 'POST', headers, body: JSON.stringify({ prompt: 'second' }),
  }).then((response) => response.json());
  provider.createdSessions[0].complete(second.result.runtimeTurnId);
  await eventually(async () => !(await store.get(sourceSessionId)).runtimeBinding.activeTurnId);

  const branchResponse = await fetch(`${listening.url}/api/sessions/${sourceSessionId}/branches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      replaceTurnId: second.result.runtimeTurnId,
      prompt: 'replacement',
      intent: 'edit',
    }),
  });
  assert.equal(branchResponse.status, 201);
  const branchBody = await branchResponse.json();
  const branch = branchBody.session;
  assert.equal(branchBody.sourceArchived, true);
  assert.notEqual(branch.sessionId, sourceSessionId);
  const archivedSource = await store.get(sourceSessionId);
  assert.equal(archivedSource.archived, true);
  assert.equal(archivedSource.runtimeBinding.runtimeSessionId, sourceRuntimeId);
  assert.notEqual(branch.runtimeBinding.runtimeSessionId, sourceRuntimeId);
  assert.deepEqual(branch.messages.filter((message) => message.role === 'user').map((message) => message.content), [
    'first',
    'replacement',
  ]);
  const activeList = await fetch(`${listening.url}/api/sessions`, { headers }).then((response) => response.json());
  assert.deepEqual(activeList.sessions.map((session) => session.id), [branch.sessionId]);
  assert.deepEqual(
    new Set((await store.list({ includeArchived: true })).map((session) => session.id)),
    new Set([sourceSessionId, branch.sessionId]),
  );
  const observed = await fetch(`${listening.url}/api/observer/sessions`, {
    headers: { 'x-test-observer': 'true' },
  }).then((response) => response.json());
  assert.deepEqual(new Set(observed.sessions.map((session) => session.id)), new Set([sourceSessionId, branch.sessionId]));
  assert.equal(observed.sessions.find((session) => session.id === sourceSessionId).archived, true);
});

test('Minimal Host Fork keeps the source and branch in the active Session list', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-fork-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const provider = new FakeRuntimeProvider({ capabilities: { fork: true } });
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const host = createMinimalHost({ manifest: runManifest(root), kernel, sessionStore: store });
  const listening = await host.start();
  t.after(() => host.stop());
  const headers = { 'content-type': 'application/json' };
  const created = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST', headers, body: '{}',
  }).then((response) => response.json());
  const sourceSessionId = created.session.sessionId;
  const sourceTurn = await fetch(`${listening.url}/api/sessions/${sourceSessionId}/turns`, {
    method: 'POST', headers, body: JSON.stringify({ prompt: 'original' }),
  }).then((response) => response.json());
  provider.createdSessions[0].complete(sourceTurn.result.runtimeTurnId);
  await eventually(async () => !(await store.get(sourceSessionId)).runtimeBinding.activeTurnId);

  const branchResponse = await fetch(`${listening.url}/api/sessions/${sourceSessionId}/branches`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      replaceTurnId: sourceTurn.result.runtimeTurnId,
      prompt: 'forked',
      intent: 'fork',
    }),
  });
  assert.equal(branchResponse.status, 201);
  const branchBody = await branchResponse.json();
  assert.equal(branchBody.sourceArchived, false);
  assert.equal((await store.get(sourceSessionId)).archived, false);
  const activeList = await fetch(`${listening.url}/api/sessions`, { headers }).then((response) => response.json());
  assert.deepEqual(
    new Set(activeList.sessions.map((session) => session.id)),
    new Set([sourceSessionId, branchBody.session.sessionId]),
  );
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
  assert.deepEqual(minimalHostSessionPresentation({
    title: '收入分析', contextId: 'owned', contextLabel: '我的对话',
  }), {
    title: '收入分析', contextId: 'owned', contextLabel: '',
  });
});

test('Minimal Host isolates Sessions by a verified owner header', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-owner-'));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
  const provider = new FakeRuntimeProvider();
  const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
  const host = createMinimalHost({
    manifest: runManifest(root),
    kernel,
    sessionStore: store,
    accessToken: 'test-token',
    sessionOwnerHeader: 'x-datamama-user-id',
    sessionObserverHeader: 'x-datamama-agent-observer',
  });
  const listening = await host.start();
  t.after(async () => {
    await host.stop();
    await rm(root, { recursive: true, force: true });
  });
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
  assert.equal(listA.sessions[0].ownerId, undefined);
  assert.equal((await fetch(`${listening.url}/api/sessions/${first.session.id}`, {
    headers: headersFor('user-b'),
  })).status, 404);

  const observerHeaders = {
    'x-agent-workbench-token': 'test-token',
    'x-datamama-agent-observer': 'true',
  };
  assert.equal((await fetch(`${listening.url}/api/observer/sessions`, {
    headers: { ...observerHeaders, 'x-datamama-agent-observer': 'false' },
  })).status, 403);
  const observed = await fetch(`${listening.url}/api/observer/sessions`, {
    headers: observerHeaders,
  }).then((response) => response.json());
  assert.deepEqual(
    new Map(observed.sessions.map((session) => [session.id, session.ownerId])),
    new Map([[first.session.id, 'user-a'], [second.session.id, 'user-b']]),
  );
  await store.applyEvent({
    type: 'item_started',
    sessionId: second.session.id,
    runtimeTurnId: 'observer-turn',
    createdAt: '2026-09-03T01:02:03.000Z',
    payload: { item: {
      id: 'observer-tool',
      type: 'mcpToolCall',
      server: 'bigquery',
      tool: 'run_query',
      status: 'inProgress',
      arguments: { query: 'SELECT 1', api_key: 'observer-secret' },
    } },
  });
  await store.applyEvent({
    type: 'item_completed',
    sessionId: second.session.id,
    runtimeTurnId: 'observer-turn',
    createdAt: '2026-09-03T01:02:05.500Z',
    payload: { item: {
      id: 'observer-tool',
      type: 'mcpToolCall',
      server: 'bigquery',
      tool: 'run_query',
      status: 'completed',
      arguments: { query: 'SELECT 1', api_key: 'observer-secret' },
      result: { content: [{ type: 'text', text: `path=${root}/runtime` }] },
      durationMs: 2_500,
    } },
  });
  const observedDetail = await fetch(`${listening.url}/api/observer/sessions/${second.session.id}`, {
    headers: observerHeaders,
  }).then((response) => response.json());
  assert.equal(observedDetail.session.ownerId, 'user-b');
  const observedTool = observedDetail.session.technicalItems[0];
  assert.equal(observedTool.id, 'observer-tool');
  assert.equal(observedTool.turnId, 'observer-turn');
  assert.equal(observedTool.kind, 'mcpToolCall');
  assert.equal(observedTool.title, 'Tool call · bigquery.run_query');
  assert.equal(observedTool.status, 'completed');
  assert.equal(observedTool.durationMs, 2_500);
  assert.equal(observedTool.startedAt, '2026-09-03T01:02:03.000Z');
  assert.equal(observedTool.completedAt, '2026-09-03T01:02:05.500Z');
  assert.match(observedTool.detail, /Input\n/);
  assert.match(observedTool.detail, /"query": "SELECT 1"/);
  assert.match(observedTool.detail, /"api_key": "\[REDACTED\]"/);
  assert.match(observedTool.detail, /Output\n/);
  assert.match(observedTool.detail, /path=\[RUN_ROOT\]\/runtime/);
  assert.equal(observedTool.detail.includes('observer-secret'), false);

  const observerStreamController = new AbortController();
  const observerStream = await fetch(
    `${listening.url}/api/observer/sessions/${second.session.id}/events`,
    { headers: observerHeaders, signal: observerStreamController.signal },
  );
  assert.equal(observerStream.status, 200);
  provider.createdSessions[1].emit('event', {
    type: 'item_started',
    runtimeSessionId: provider.createdSessions[1].runtimeSessionId,
    runtimeTurnId: 'observer-live-turn',
    createdAt: Date.parse('2026-09-03T01:02:06.000Z'),
    payload: { item: {
      id: 'observer-live-tool',
      type: 'mcpToolCall',
      status: 'inProgress',
      text: 'Authorization: Bearer stream-secret',
    } },
  });
  const observerEventText = await readStreamUntil(observerStream.body.getReader(), 'session_changed');
  observerStreamController.abort();
  assert.match(observerEventText, /"type":"session_changed"/);
  assert.equal(observerEventText.includes('stream-secret'), false);
  assert.equal(observerEventText.includes('mcpToolCall'), false);

  await mkdir(join(root, 'runtime'), { recursive: true });
  await writeFile(
    join(root, 'runtime', 'app-server.stderr.log'),
    `Authorization: Bearer private-token\npath=${root}/runtime\napi_key=private-key\n`,
  );
  const diagnostics = await fetch(`${listening.url}/api/observer/logs?lines=999`, {
    headers: observerHeaders,
  }).then((response) => response.json());
  assert.equal(diagnostics.lineLimit, 500);
  const runtimeErrorLog = diagnostics.logs.find((log) => log.source === 'runtime-stderr');
  assert.equal(runtimeErrorLog.available, true);
  assert.match(runtimeErrorLog.content, /Bearer \[REDACTED\]/);
  assert.match(runtimeErrorLog.content, /api_key=\[REDACTED\]/);
  assert.match(runtimeErrorLog.content, /\[RUN_ROOT\]\/runtime/);
  assert.equal(runtimeErrorLog.content.includes('private-token'), false);
  assert.equal(runtimeErrorLog.content.includes('private-key'), false);
});

test('Minimal Host Observer joins portable Sessions with current Run state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-observer-portable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'portable-state'), runId: 'run-portable' });
  const runtimeStore = new EnvironmentSessionRuntimeStore({ stateRoot: join(root, 'runtime-state') });
  const provider = new FakeRuntimeProvider();
  const kernel = new AgentSessionKernel({ provider, bindingStore: runtimeStore, validateRequest: () => {} });
  const created = await store.create({ ownerId: 'user-a', runId: 'run-portable' });
  await runtimeStore.save(created.sessionId, {
    runtimeProvider: 'fake',
    runtimeSessionId: 'runtime-portable',
    activeTurnId: 'turn-active',
    status: 'running',
  });
  const host = createMinimalHost({
    manifest: runManifest(root, 'run-portable'),
    kernel,
    sessionStore: store,
    runtimeStateStore: runtimeStore,
    sessionObserverHeader: 'x-observer',
  });
  const listening = await host.start();
  t.after(() => host.stop());

  const detail = await fetch(`${listening.url}/api/observer/sessions/${created.sessionId}`, {
    headers: { 'x-observer': 'true' },
  }).then((response) => response.json());
  assert.equal(detail.session.ownerId, 'user-a');
  assert.equal(detail.session.runtimeBinding.runtimeSessionId, 'runtime-portable');
  assert.equal(detail.session.runtimeBinding.activeTurnId, 'turn-active');
});

test('Minimal Host projects scoped shared Sessions and continues them into a fresh owner Runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-host-shared-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state'), runId: 'run-shared' });
  const runtimeStore = new EnvironmentSessionRuntimeStore({ stateRoot: join(root, 'runtime-state') });
  const resourceStore = new FilesystemResourceStore({ root: join(root, 'resources') });
  const provider = new FakeRuntimeProvider();
  const kernel = new AgentSessionKernel({ provider, bindingStore: runtimeStore, validateRequest: () => {} });
  const host = createMinimalHost({
    manifest: runManifest(root, 'run-shared'),
    kernel,
    sessionStore: store,
    runtimeStateStore: runtimeStore,
    resourceStore,
    sessionOwnerHeader: 'x-session-owner',
    sessionAccessHeader: 'x-session-access',
  });
  const listening = await host.start();
  t.after(() => host.stop());
  const accessEnvelope = (principalId, sharedSessions = []) => Buffer.from(JSON.stringify({
    v: 1,
    principalId,
    sharedSessions,
  })).toString('base64url');
  const headersFor = (principalId, sharedSessions = []) => ({
    'content-type': 'application/json',
    'x-session-owner': principalId,
    'x-session-access': accessEnvelope(principalId, sharedSessions),
  });

  assert.equal((await fetch(`${listening.url}/api/sessions`, {
    headers: { 'x-session-owner': 'user-a' },
  })).status, 401);
  const source = await fetch(`${listening.url}/api/sessions`, {
    method: 'POST',
    headers: headersFor('user-a'),
    body: JSON.stringify({ title: '共享源' }),
  }).then((response) => response.json()).then((body) => body.session);
  const attachmentContent = '可共享附件';
  const sourceAttachment = await fetch(`${listening.url}/api/sessions/${source.sessionId}/attachments`, {
    method: 'POST',
    headers: headersFor('user-a'),
    body: JSON.stringify({ attachment: {
      name: 'shared.txt',
      type: 'text/plain',
      size: Buffer.byteLength(attachmentContent),
      data: `data:text/plain;base64,${Buffer.from(attachmentContent).toString('base64')}`,
    } }),
  }).then((response) => response.json()).then((body) => body.attachment);
  const sourceTurn = await fetch(`${listening.url}/api/sessions/${source.sessionId}/turns`, {
    method: 'POST',
    headers: headersFor('user-a'),
    body: JSON.stringify({ prompt: '请记住 42', attachments: [sourceAttachment] }),
  }).then((response) => response.json());
  provider.createdSessions[0].complete(sourceTurn.result.runtimeTurnId);
  await eventually(async () => !(await runtimeStore.load(source.sessionId)).activeTurnId);

  const grant = {
    sessionId: source.sessionId,
    shareId: 'share-allowed',
    permissions: ['session.read', 'resource.read', 'session.fork'],
  };
  const sharedHeaders = headersFor('user-b', [grant]);
  const listed = await fetch(`${listening.url}/api/sessions`, { headers: sharedHeaders })
    .then((response) => response.json());
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].access.kind, 'shared');
  assert.equal(listed.sessions[0].contextLabel, '与我共享');
  assert.equal(listed.sessions[0].composerDisabled, true);
  assert.equal('createdRunId' in listed.sessions[0], false);
  assert.equal('messages' in listed.sessions[0], false);

  const detail = await fetch(`${listening.url}/api/sessions/${source.sessionId}`, { headers: sharedHeaders })
    .then((response) => response.json()).then((body) => body.session);
  assert.equal('draft' in detail, false);
  assert.deepEqual(detail.messages.map((message) => message.content), ['请记住 42']);
  assert.equal('turnId' in detail.messages[0], false);
  assert.equal(detail.messages[0].attachments[0].name, 'shared.txt');
  assert.equal(detail.runtimeBinding, null);
  assert.deepEqual(detail.technicalItems, []);
  assert.equal(provider.createdSessions.length, 1);
  assert.equal(await fetch(
    `${listening.url}/api/sessions/${source.sessionId}/attachments/${sourceAttachment.id}/content`,
    { headers: sharedHeaders },
  ).then((response) => response.text()), attachmentContent);

  const rejected = await fetch(`${listening.url}/api/sessions/${source.sessionId}/turns`, {
    method: 'POST',
    headers: sharedHeaders,
    body: JSON.stringify({ prompt: '不应发送' }),
  });
  assert.equal(rejected.status, 403);
  assert.equal((await rejected.json()).error.code, 'SESSION_ACCESS_READ_ONLY');
  assert.equal((await fetch(`${listening.url}/api/sessions/${source.sessionId}`, {
    headers: headersFor('user-c'),
  })).status, 404);

  const continueHeaders = { ...sharedHeaders, 'idempotency-key': 'continue-request-1' };
  const continuedResponse = await fetch(`${listening.url}/api/sessions/${source.sessionId}/continue`, {
    method: 'POST', headers: continueHeaders, body: '{}',
  });
  assert.equal(continuedResponse.status, 201);
  const continued = (await continuedResponse.json()).session;
  assert.notEqual(continued.sessionId, source.sessionId);
  assert.equal(continued.title, '共享源（副本）');
  assert.notEqual(continued.messages[0].attachments[0].id, sourceAttachment.id);
  assert.equal(continued.messages[0].attachments[0].resource.owner.sessionId, continued.sessionId);
  assert.equal(provider.createdSessions.length, 2);
  assert.notEqual(provider.createdSessions[0].runtimeSessionId, provider.createdSessions[1].runtimeSessionId);

  const retried = await fetch(`${listening.url}/api/sessions/${source.sessionId}/continue`, {
    method: 'POST', headers: continueHeaders, body: '{}',
  });
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).session.sessionId, continued.sessionId);
  assert.equal(provider.createdSessions.length, 2);

  const nextTurn = await fetch(`${listening.url}/api/sessions/${continued.sessionId}/turns`, {
    method: 'POST', headers: headersFor('user-b'), body: JSON.stringify({ prompt: '42 是什么？' }),
  });
  assert.equal(nextTurn.status, 202);
  const runtimeInput = provider.createdSessions[1].startedTurns[0].input;
  assert.match(runtimeInput[0].text, /请记住 42/);
  assert.equal(runtimeInput[1].text, '42 是什么？');
  const copiedDetail = await store.get(continued.sessionId, { ownerId: 'user-b' });
  assert.deepEqual(copiedDetail.messages.map((message) => message.content), ['请记住 42', '42 是什么？']);
  assert.equal((await runtimeStore.load(continued.sessionId)).continuationContext, null);
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

function runManifest(root, id = 'run-test') {
  return {
    schema: 'agent-workbench.environment/v1',
    kind: 'run',
    id,
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

async function eventually(predicate, { attempts = 50 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Condition was not met in time');
}

async function readStreamUntil(reader, needle) {
  const decoder = new TextDecoder();
  let content = '';
  try {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { done, value } = await readWithTimeout(reader, 1_000);
      if (done) break;
      content += decoder.decode(value, { stream: true });
      if (content.includes(needle)) return content;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  assert.fail(`Stream did not include ${needle}`);
}

function readWithTimeout(reader, milliseconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Stream read timed out')), milliseconds);
    reader.read().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

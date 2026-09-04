import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { AgentSessionKernel } from '../src/runtime/core/index.js';
import {
  EnvironmentSessionStore,
  buildMinimalHostAssets,
  createMinimalHost,
} from '../src/environment/index.js';
import { FakeRuntimeProvider } from '../test/core-testkit.js';

const root = await mkdtemp(join(tmpdir(), 'awb-browser-smoke-'));
const provider = new FakeRuntimeProvider({ capabilities: { fork: true, steer: true } });
const store = new EnvironmentSessionStore({ stateRoot: join(root, 'state') });
const kernel = new AgentSessionKernel({ provider, bindingStore: store, validateRequest: () => {} });
const assetsRoot = join(root, 'assets');
await buildMinimalHostAssets({ outputDirectory: assetsRoot });
const host = createMinimalHost({
  manifest: runManifest(root),
  kernel,
  sessionStore: store,
  assetsRoot,
  accessToken: 'browser-smoke-token',
  sessionObserverHeader: 'x-browser-observer',
});
const listening = await host.start();
const mountedProxy = createMountProxy(listening.port);
const proxy = mountedProxy.server;
const proxyState = mountedProxy.state;
const proxyAddress = await listen(proxy);
const initialDraft = '我正在看 Solver Engine 的实验「测试」（实验 ID：167，daily 视图）。\n我需要：';
const initialSessionResponse = await fetch(
  `http://127.0.0.1:${proxyAddress.port}/agent/runtime/api/sessions`,
  {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': 'browser-smoke-initial-draft',
      'x-agent-workbench-token': 'browser-smoke-token',
    },
    body: JSON.stringify({ title: '新对话', draft: initialDraft }),
  },
);
if (initialSessionResponse.status !== 201) {
  throw new Error(`Initial draft Session create failed: ${initialSessionResponse.status}`);
}
const initialSession = (await initialSessionResponse.json()).session;
const sourceSessionId = initialSession.sessionId;
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable(),
});

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${proxyAddress.port}/agent/runtime/`);
  await page.getByText('1 个对话', { exact: true }).waitFor();
  const composer = page.getByRole('textbox', { name: '输入问题……' });
  await composer.waitFor();
  if (await composer.inputValue() !== initialDraft) {
    throw new Error('Initial Session draft was not restored into the Composer.');
  }
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '输入问题……');
  await waitFor(() => proxyState.eventConnections >= 2);

  await page.getByLabel('添加图片或附件').setInputFiles({
    name: 'browser-canary.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('BROWSER_ATTACHMENT_CANARY'),
  });
  await page.getByText('已就绪', { exact: false }).waitFor();
  await composer.fill('browser smoke');
  await page.getByRole('button', { name: '发送' }).click();
  await waitFor(() => provider.createdSessions[0]?.startedTurns.length === 1);
  await page.getByRole('button', { name: '停止当前处理' }).waitFor();
  await page.getByRole('button', { name: '下一轮' }).waitFor();
  const composerActionLabels = await page.locator('.cwu-composer-actions button').allTextContents();
  if (composerActionLabels[0]?.trim() !== '停止' || composerActionLabels[1]?.trim() !== '下一轮') {
    throw new Error(`Composer actions are out of order: ${composerActionLabels.join(', ')}`);
  }
  const runtimeInput = provider.createdSessions[0].startedTurns[0].input;
  if (!Array.isArray(runtimeInput)
    || !runtimeInput.some((item) => String(item?.text || '').includes('BROWSER_ATTACHMENT_CANARY'))) {
    throw new Error('Browser attachment was not passed to Runtime input.');
  }
  await page.getByText('browser smoke', { exact: true }).first().waitFor();

  const runtime = provider.createdSessions[0];
  proxyState.dropEventStreams();
  runtime.emit('event', {
    type: 'item_started',
    runtimeSessionId: runtime.runtimeSessionId,
    runtimeTurnId: runtime.activeTurnId,
    providerEvent: 'item/started',
    createdAt: Date.parse('2026-09-03T10:19:37.000Z'),
    payload: { item: {
      id: 'browser-smoke-commentary',
      type: 'agentMessage',
      phase: 'commentary',
      status: 'inProgress',
      text: 'Preparing browser smoke',
    } },
  });
  runtime.emit('event', {
    type: 'item_started',
    runtimeSessionId: runtime.runtimeSessionId,
    runtimeTurnId: runtime.activeTurnId,
    providerEvent: 'item/started',
    payload: { item: {
      id: 'browser-smoke-tool',
      type: 'mcpToolCall',
      server: 'browser',
      tool: 'browser_query',
      status: 'inProgress',
      arguments: { query: 'browser smoke' },
    } },
  });
  runtime.emit('event', {
    type: 'item_delta',
    runtimeSessionId: runtime.runtimeSessionId,
    runtimeTurnId: runtime.activeTurnId,
    providerEvent: 'item/agentMessage/delta',
    payload: { itemId: 'browser-smoke-response', delta: 'Browser smoke OK' },
  });
  runtime.emit('event', {
    type: 'item_completed',
    runtimeSessionId: runtime.runtimeSessionId,
    runtimeTurnId: runtime.activeTurnId,
    providerEvent: 'item/completed',
    createdAt: Date.parse('2026-09-03T10:19:38.250Z'),
    payload: { item: {
      id: 'browser-smoke-tool',
      type: 'mcpToolCall',
      server: 'browser',
      tool: 'browser_query',
      status: 'completed',
      arguments: { query: 'browser smoke' },
      result: { content: [{ type: 'text', text: 'browser result' }] },
      durationMs: 1_250,
    } },
  });
  runtime.complete();
  await page.getByText('Browser smoke OK', { exact: true }).waitFor();
  const latestProcess = page.locator('details.cwu-commentary-group').last();
  await latestProcess.getByText('Preparing browser smoke', { exact: true }).waitFor();
  if (!await latestProcess.evaluate((details) => details.open)) {
    throw new Error('The latest completed process collapsed after the Turn finished.');
  }
  const technicalDetails = page.getByRole('button', { name: /本轮执行详情/ });
  await technicalDetails.waitFor();
  await technicalDetails.click();
  await page.getByText('Tool call · browser.browser_query', { exact: true }).waitFor();

  const replaySessionResponse = await fetch(
    `http://127.0.0.1:${proxyAddress.port}/agent/runtime/api/sessions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-workbench-token': 'browser-smoke-token',
      },
      body: JSON.stringify({ title: 'observer replay session' }),
    },
  );
  if (replaySessionResponse.status !== 201) {
    throw new Error(`Observer replay Session create failed: ${replaySessionResponse.status}`);
  }
  const replaySession = (await replaySessionResponse.json()).session;
  const replayTurnResponse = await fetch(
    `http://127.0.0.1:${proxyAddress.port}/agent/runtime/api/sessions/${encodeURIComponent(replaySession.sessionId)}/turns`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-agent-workbench-token': 'browser-smoke-token',
      },
      body: JSON.stringify({ prompt: 'observer replay prompt' }),
    },
  );
  if (replayTurnResponse.status !== 202) {
    throw new Error(`Observer replay Turn create failed: ${replayTurnResponse.status}`);
  }
  const replayRuntime = provider.createdSessions[1];
  for (let index = 0; index < 30; index += 1) {
    replayRuntime.emit('event', {
      type: 'item_started',
      runtimeSessionId: replayRuntime.runtimeSessionId,
      runtimeTurnId: replayRuntime.activeTurnId,
      providerEvent: 'item/started',
      payload: { item: {
        id: `observer-replay-${index}`,
        type: 'commandExecution',
        command: `observer replay ${index}`,
        status: 'inProgress',
      } },
    });
  }
  replayRuntime.complete();
  await waitForAsync(async () => !(await store.get(replaySession.sessionId)).runtimeBinding?.activeTurnId);
  await store.archive(replaySession.sessionId);

  const observerPage = await browser.newPage({
    extraHTTPHeaders: { 'x-browser-observer': 'true' },
  });
  await observerPage.goto(
    `http://127.0.0.1:${proxyAddress.port}/agent/runtime/?view=observer&session=${encodeURIComponent(sourceSessionId)}`,
  );
  await observerPage.getByRole('heading', { name: 'Session 过程' }).waitFor();
  await observerPage.getByText('browser smoke', { exact: true }).first().waitFor();
  await observerPage.getByText('Browser smoke OK', { exact: true }).waitFor();
  const observerToolStep = observerPage.locator('.awb-observer-steps summary')
    .filter({ hasText: '调用工具 · browser.browser_query' });
  await observerToolStep.waitFor();
  await observerToolStep.click();
  await observerPage.waitForFunction(() => document.querySelector('.awb-observer-steps pre')
    ?.textContent.includes('browser result'));
  proxyState.observerDetailRequests.set(replaySession.sessionId, 0);
  await observerPage.locator('.awb-observer-session-list button')
    .filter({ hasText: 'observer replay session' })
    .click();
  await observerPage.getByRole('heading', { name: 'observer replay session' }).waitFor();
  await observerPage.waitForTimeout(500);
  const replayDetailRequests = proxyState.observerDetailRequests.get(replaySession.sessionId) || 0;
  if (replayDetailRequests > 3) {
    throw new Error(`Observer replay caused ${replayDetailRequests} detail requests after one selection.`);
  }
  if (process.env.OBSERVER_SCREENSHOT_PATH) {
    await observerPage.screenshot({ path: process.env.OBSERVER_SCREENSHOT_PATH, fullPage: true });
  }
  await observerPage.close();

  await page.locator('.cwu-message.is-user').hover();
  await page.getByRole('button', { name: 'Fork', exact: true }).click();
  await page.getByText('2 个对话', { exact: true }).waitFor();
  await page.getByText('Browser smoke OK', { exact: true }).waitFor();
  const forkedRuntime = provider.createdSessions.at(-1);
  if (forkedRuntime.startedTurns.length !== 0) {
    throw new Error('Fork unexpectedly reran the selected user message.');
  }

  await page.goto(
    `http://127.0.0.1:${proxyAddress.port}/agent/runtime/?session=${encodeURIComponent(sourceSessionId)}`,
  );
  await page.getByText('Browser smoke OK', { exact: true }).waitFor();
  await page.locator('.cwu-message.is-user').hover();
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  const editBox = page.getByRole('textbox', { name: '编辑消息' });
  await editBox.fill('browser smoke edited');
  await page.locator('.cwu-message-editor').getByRole('button', { name: '发送', exact: true }).click();
  await editBox.waitFor({ state: 'detached' });
  await page.getByText('browser smoke edited', { exact: true }).waitFor();
  await page.getByText('2 个对话', { exact: true }).waitFor();
  await page.waitForTimeout(400);
  if (await page.locator('.cwu-transcript').getByText('Browser smoke OK', { exact: true }).count()) {
    throw new Error('Edit kept the replaced answer visible in the replacement Session.');
  }
  const activeSessions = await store.list();
  const allSessions = await store.list({ includeArchived: true });
  const archivedSource = await store.get(sourceSessionId);
  if (activeSessions.length !== 2 || allSessions.length !== 4 || archivedSource.archived !== true) {
    throw new Error('Edit did not archive the source while keeping the Fork copy and replacement Session active.');
  }
  console.log('Minimal Host browser initial draft, attachment, reconnect, polling fallback, visible completed process, progress, title, running actions, copy-only Fork, Edit archival, and read-only Observer smoke passed under /agent/runtime/.');
} finally {
  await browser.close();
  await close(proxy);
  await host.stop();
  await rm(root, { recursive: true, force: true });
}

function createMountProxy(upstreamPort) {
  const activeEventStreams = new Set();
  const state = {
    eventConnections: 0,
    observerDetailRequests: new Map(),
    failNextEventStream: true,
    rejectEventStreams: false,
    dropEventStreams() {
      state.rejectEventStreams = true;
      for (const stream of activeEventStreams) {
        stream.outgoing.destroy();
        stream.upstream.destroy();
      }
      activeEventStreams.clear();
    },
  };
  const server = createServer((incoming, outgoing) => {
    const mountedPath = incoming.url || '/';
    if (!mountedPath.startsWith('/agent/runtime/')) {
      outgoing.writeHead(404).end('Not found');
      return;
    }
    const path = mountedPath.slice('/agent/runtime'.length) || '/';
    const observerDetail = path.match(/^\/api\/observer\/sessions\/([^/?]+)(?:\?|$)/);
    if (observerDetail) {
      const sessionId = decodeURIComponent(observerDetail[1]);
      state.observerDetailRequests.set(
        sessionId,
        (state.observerDetailRequests.get(sessionId) || 0) + 1,
      );
    }
    const eventStream = /\/api\/sessions\/[^/]+\/events(?:\?|$)/.test(path);
    if (eventStream) {
      state.eventConnections += 1;
      if (state.failNextEventStream) {
        state.failNextEventStream = false;
        outgoing.writeHead(502).end('Synthetic initial event stream failure');
        return;
      }
      if (state.rejectEventStreams) {
        outgoing.writeHead(502).end('Synthetic event stream outage');
        return;
      }
    }
    let upstream;
    upstream = httpRequest({
      host: '127.0.0.1',
      port: upstreamPort,
      method: incoming.method,
      path,
      headers: incoming.headers,
    }, (response) => {
      const active = { outgoing, upstream };
      if (eventStream) activeEventStreams.add(active);
      const cleanup = () => activeEventStreams.delete(active);
      outgoing.once('close', cleanup);
      response.once('close', cleanup);
      outgoing.writeHead(response.statusCode || 500, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', (error) => outgoing.destroy(error));
    incoming.pipe(upstream);
  });
  return { server, state };
}

function browserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error('Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to run the Minimal Host browser smoke.');
  }
  return executable;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  return server.address();
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Browser smoke timed out waiting for Runtime input.');
}

async function waitForAsync(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Browser smoke timed out waiting for persisted Session state.');
}

function runManifest(runRoot) {
  return {
    schema: 'agent-workbench.environment/v1',
    kind: 'run',
    id: 'run-browser-smoke',
    environmentId: 'environment-browser-smoke',
    status: 'running',
    versions: { platform: 'test', runtime: 'test' },
    profile: { id: 'browser-smoke', hash: 'hash', source: { type: 'inline' } },
    runtime: { provider: 'fake' },
    features: { sessionWorkspace: true, attachments: true },
    capabilities: { lock: { capabilities: [] }, hash: 'hash' },
    isolation: {
      requestedLevel: 'ephemeral-machine',
      effectiveLevel: 'ephemeral-machine',
      enforcement: { externalEffects: { enforced: true, mode: 'no-external-effects' } },
    },
    paths: {
      root: runRoot,
      runtime: join(runRoot, 'runtime'),
      state: join(runRoot, 'state'),
      resources: join(runRoot, 'resources'),
      workspace: join(runRoot, 'workspace'),
      temporary: join(runRoot, 'tmp'),
      credentials: join(runRoot, 'credentials'),
    },
    process: { pid: process.pid, port: 0, providerState: {} },
    extensions: {},
    lifecycle: { createdAt: new Date().toISOString(), startedAt: new Date().toISOString() },
  };
}

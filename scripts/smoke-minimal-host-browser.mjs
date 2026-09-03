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
const provider = new FakeRuntimeProvider({ capabilities: { steer: true } });
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
});
const listening = await host.start();
const mountedProxy = createMountProxy(listening.port);
const proxy = mountedProxy.server;
const proxyState = mountedProxy.state;
const proxyAddress = await listen(proxy);
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable(),
});

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${proxyAddress.port}/agent/runtime/`);
  await page.getByRole('button', { name: '新建对话' }).click();
  await page.getByText('1 个对话', { exact: true }).waitFor();
  await waitFor(() => proxyState.eventConnections >= 2);

  await page.getByLabel('添加图片或附件').setInputFiles({
    name: 'browser-canary.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('BROWSER_ATTACHMENT_CANARY'),
  });
  await page.getByText('已就绪', { exact: false }).waitFor();
  await page.getByRole('textbox', { name: '输入问题……' }).fill('browser smoke');
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
      status: 'inProgress',
      text: 'Browser smoke tool',
    } },
  });
  runtime.emit('event', {
    type: 'item_delta',
    runtimeSessionId: runtime.runtimeSessionId,
    runtimeTurnId: runtime.activeTurnId,
    providerEvent: 'item/agentMessage/delta',
    payload: { itemId: 'browser-smoke-response', delta: 'Browser smoke OK' },
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
  await page.getByText('Tool call', { exact: true }).waitFor();
  console.log('Minimal Host browser attachment, reconnect, polling fallback, visible completed process, progress, title, and running-action smoke passed under /agent/runtime/.');
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

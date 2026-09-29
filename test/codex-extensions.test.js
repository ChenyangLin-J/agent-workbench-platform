import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AgentSessionKernel,
  CodexAppServerProvider,
  CodexRuntimeSession,
} from '../src/runtime/core/index.js';
import { FakeRuntimeProvider, InMemoryBindingStore, createFakeAppServer } from './core-testkit.js';
import { AppServerConnection } from '../src/runtime/core/index.js';

function codexProvider(api, options = {}) {
  return new CodexAppServerProvider({
    connection: new AppServerConnection({ childProcess: api.child }),
    ...options,
  });
}

test('thread-scoped extension requests inject the bound thread id', async () => {
  const api = createFakeAppServer({
    onRequest(message, server) {
      if (message.method === 'initialize') return server.respond(message, { userAgent: 'fake' });
      if (message.method === 'thread/start') {
        return server.respond(message, { thread: { id: 'thread-1', turns: [] } });
      }
      server.respond(message, { received: message.params });
    },
  });
  const provider = codexProvider(api);
  const session = provider.createSession({});
  await session.start();
  await session.create({ cwd: '/w' });
  const result = await session.requestExtension('thread/goal/get');
  assert.equal(result.received.threadId, session.runtimeSessionId);
  const overridden = await session.requestExtension('thread/archive', { threadId: 'other-thread' });
  assert.equal(overridden.received.threadId, 'other-thread');
});

test('extension requests reject kernel-owned and unknown methods', async () => {
  const api = createFakeAppServer({
    onRequest(message, server) {
      if (message.method === 'thread/start') {
        return server.respond(message, { thread: { id: 'thread-1', turns: [] } });
      }
      server.respond(message, {});
    },
  });
  const provider = codexProvider(api);
  const session = provider.createSession({});
  await session.start();
  await session.create({});
  await assert.rejects(() => session.requestExtension('turn/start'), /Unsupported Codex extension/);
  await assert.rejects(() => session.requestExtension('made/up'), /Unsupported Codex extension/);
  await assert.rejects(() => provider.requestExtension('thread/start'), /Unsupported Codex extension/);
});

test('a consumer allowlist narrows the extension surface', async () => {
  const api = createFakeAppServer({
    onRequest(message, server) { server.respond(message, { ok: true }); },
  });
  const provider = codexProvider(api, { extensionAllowlist: ['config/read'] });
  assert.equal(provider.extensionScope('config/read'), 'global');
  assert.equal(provider.extensionScope('thread/goal/get'), null);
  await assert.rejects(() => provider.requestExtension('thread/goal/get'), /Unsupported/);
  const result = await provider.requestExtension('config/read', { cwd: '/w' });
  assert.equal(result.ok, true);
});

test('kernel routes global extensions without resuming a released Runtime', async () => {
  const provider = new FakeRuntimeProvider();
  provider.extensionScope = (method) => (method === 'config/read' ? 'global' : 'thread');
  provider.requestExtension = async (method, params) => ({ method, params });
  const store = new InMemoryBindingStore({
    'session-a': {
      runtimeProvider: 'fake',
      runtimeSessionId: 'fake-session-9',
      released: true,
      releaseReason: 'idle-ttl',
    },
  });
  const kernel = new AgentSessionKernel({ provider, bindingStore: store });
  const global = await kernel.extensionRequest('session-a', 'config/read', { cwd: '/w' });
  assert.equal(global.method, 'config/read');
  assert.equal(provider.createdSessions.length, 0, 'global extension must not create a Runtime');

  const runtime = await kernel.extensionRequest('session-a', 'thread/read', {});
  assert.equal(provider.createdSessions.length, 1, 'thread extension resumes a released Runtime');
  assert.equal(runtime.method, 'thread/read');
});

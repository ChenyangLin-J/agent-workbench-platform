import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FakeRuntimeProvider,
  InMemoryBindingStore,
} from './core-testkit.js';

import { AgentSessionKernel } from '../src/runtime/core/index.js';

test('Session Kernel binds product Sessions without exposing provider protocol methods', async (t) => {
  const provider = new FakeRuntimeProvider({ id: 'pi-shape', capabilities: { steer: true } });
  const store = new InMemoryBindingStore();
  const kernel = new AgentSessionKernel({ provider, bindingStore: store });
  t.after(() => kernel.close());
  const attached = await kernel.attach('product-session', { cwd: '/workspace/project' });
  assert.equal(attached.runtimeProvider, 'pi-shape');
  assert.match(attached.runtimeSessionId, /^pi-shape-session-/);
  const binding = await store.load('product-session');
  assert.deepEqual(Object.keys(binding).sort(), [
    'activeTurnId', 'cwd', 'lastError', 'runtimeProvider', 'runtimeSessionId', 'status',
  ]);
  assert.equal(JSON.stringify(binding).includes('threadId'), false);
});

test('provider without steer capability queues a follow-up and starts it after completion', async (t) => {
  const provider = new FakeRuntimeProvider({ capabilities: { steer: false } });
  const kernel = new AgentSessionKernel({ provider, bindingStore: new InMemoryBindingStore() });
  t.after(() => kernel.close());
  const first = await kernel.submit('session-a', 'first');
  const runtime = provider.createdSessions[0];
  const queued = kernel.submit('session-a', 'second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.startedTurns.length, 1);
  assert.equal(kernel.replay('session-a').events.some((event) => event.type === 'turn_queued'), true);
  runtime.complete(first.runtimeTurnId);
  const second = await queued;
  assert.equal(second.deliveryMode, 'queue');
  assert.equal(runtime.startedTurns.length, 2);
  assert.equal(runtime.startedTurns[1].input, 'second');
});

test('provider with steer capability follows up on the exact active Turn', async (t) => {
  const provider = new FakeRuntimeProvider({ capabilities: { steer: true } });
  const kernel = new AgentSessionKernel({ provider, bindingStore: new InMemoryBindingStore() });
  t.after(() => kernel.close());
  const first = await kernel.submit('session-a', 'first');
  const followUp = await kernel.submit('session-a', 'more', { mode: 'auto' });
  const runtime = provider.createdSessions[0];
  assert.equal(followUp.deliveryMode, 'steer');
  assert.deepEqual(runtime.steeredTurns, [{ runtimeTurnId: first.runtimeTurnId, input: 'more' }]);
});

test('requests stay scoped to one product Session and use opaque request tokens', async (t) => {
  const provider = new FakeRuntimeProvider({ capabilities: { steer: true } });
  const kernel = new AgentSessionKernel({
    provider,
    bindingStore: new InMemoryBindingStore(),
    validateRequest: () => {},
  });
  t.after(() => kernel.close());
  await Promise.all([kernel.attach('session-a'), kernel.attach('session-b')]);
  const runtimeA = provider.createdSessions[0];
  const response = runtimeA.openRequest({ payload: { command: 'pwd' } });
  await new Promise((resolve) => setImmediate(resolve));
  const [pending] = kernel.getPendingRequests('session-a');
  assert.match(pending.requestToken, /^request_/);
  assert.deepEqual(kernel.getPendingRequests('session-b'), []);
  await assert.rejects(
    kernel.respondToRequest('session-b', pending.requestToken, { decision: 'decline' }),
    (error) => error.code === 'REQUEST_NOT_FOUND',
  );
  await kernel.respondToRequest('session-a', pending.requestToken, { decision: 'decline' });
  assert.deepEqual(await response, { decision: 'decline' });
});

test('requests fail closed until the product adapter configures a policy', async (t) => {
  const provider = new FakeRuntimeProvider();
  const kernel = new AgentSessionKernel({ provider, bindingStore: new InMemoryBindingStore() });
  t.after(() => kernel.close());
  await kernel.attach('session-a');
  const response = provider.createdSessions[0].openRequest({ payload: { command: 'pwd' } });
  await assert.rejects(response, (error) => error.code === -32_602);
  assert.deepEqual(kernel.getPendingRequests('session-a'), []);
  assert.equal(kernel.replay('session-a').events.some((event) => event.type === 'request_rejected'), true);
});

test('persisted bindings resume through a provider-neutral runtime id', async (t) => {
  const provider = new FakeRuntimeProvider();
  const store = new InMemoryBindingStore({
    'session-a': {
      runtimeProvider: 'fake',
      runtimeSessionId: 'pi-or-other-runtime-session',
      activeTurnId: null,
      cwd: '/workspace/project',
      status: 'idle',
    },
  });
  const kernel = new AgentSessionKernel({ provider, bindingStore: store });
  t.after(() => kernel.close());
  const attached = await kernel.attach('session-a');
  assert.equal(attached.runtimeSessionId, 'pi-or-other-runtime-session');
  assert.equal(provider.createdSessions[0].cwd, '/workspace/project');
});

test('a newly created Runtime Session can be adopted without a resume round trip', async (t) => {
  const provider = new FakeRuntimeProvider();
  const store = new InMemoryBindingStore();
  const kernel = new AgentSessionKernel({ provider, bindingStore: store });
  t.after(() => kernel.close());
  const runtime = provider.createSession({ cwd: '/workspace/new' });
  await runtime.start();
  await runtime.create();
  const adopted = await kernel.adopt(runtime.runtimeSessionId, runtime);
  assert.equal(adopted.runtimeSessionId, runtime.runtimeSessionId);
  assert.equal(provider.createdSessions.length, 1);
  await kernel.submit(runtime.runtimeSessionId, 'first turn');
  assert.equal(provider.createdSessions.length, 1);
});

test('Session Kernel forks into a new product Session without mutating the source binding', async (t) => {
  const provider = new FakeRuntimeProvider({ capabilities: { fork: true } });
  const store = new InMemoryBindingStore();
  const kernel = new AgentSessionKernel({ provider, bindingStore: store });
  t.after(() => kernel.close());
  const source = await kernel.attach('session-source', { cwd: '/workspace/source' });
  const target = await kernel.fork('session-source', 'session-target', { lastTurnId: 'turn-before' });
  assert.equal((await store.load('session-source')).runtimeSessionId, source.runtimeSessionId);
  assert.notEqual(target.runtimeSessionId, source.runtimeSessionId);
  assert.equal((await store.load('session-target')).runtimeSessionId, target.runtimeSessionId);
  assert.equal(provider.createdSessions.length, 2);
  assert.equal(provider.createdSessions[0].runtimeSessionId, source.runtimeSessionId);
  assert.equal(provider.createdSessions[1].runtimeSessionId, target.runtimeSessionId);
});

test('event replay is bounded and signals recovery gaps', async (t) => {
  const provider = new FakeRuntimeProvider();
  const { CoreEventReplayBuffer } = await import('../src/runtime/core/contracts.js');
  const kernel = new AgentSessionKernel({
    provider,
    bindingStore: new InMemoryBindingStore(),
    eventBuffer: new CoreEventReplayBuffer({ limit: 2 }),
  });
  t.after(() => kernel.close());
  await kernel.attach('session-a');
  const runtime = provider.createdSessions[0];
  const turn = await kernel.submit('session-a', 'first');
  runtime.complete(turn.runtimeTurnId);
  await new Promise((resolve) => setImmediate(resolve));
  const replay = kernel.replay('session-a', 0);
  assert.equal(replay.replayGap, true);
  assert.equal(replay.events.length, 2);
});

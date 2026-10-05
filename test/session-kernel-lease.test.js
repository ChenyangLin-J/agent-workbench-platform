import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { AgentSessionKernel } from '../src/runtime/core/index.js';
import { FakeRuntimeProvider, InMemoryBindingStore } from './core-testkit.js';

function kernelOptions({ leaseMs = 60, detachedLeaseMs = 60, store = new InMemoryBindingStore(), provider = new FakeRuntimeProvider({ capabilities: { steer: true } }) } = {}) {
  return { provider, store, kernel: new AgentSessionKernel({ provider, bindingStore: store, runtimeLeaseMs: leaseMs, detachedLeaseMs }) };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('Timed out waiting for condition');
}

test('a late steer rejection keeps the input and starts a new Turn', async (t) => {
  const provider = new FakeRuntimeProvider({ capabilities: { steer: true } });
  const kernel = new AgentSessionKernel({ provider, bindingStore: new InMemoryBindingStore() });
  t.after(() => kernel.close());
  const first = await kernel.submit('session-a', 'first');
  const runtime = provider.createdSessions[0];
  runtime.steerTurn = async () => {
    runtime.activeTurnId = null;
    throw Object.assign(new Error('no active turn'), { code: 'RUNTIME_TURN_NOT_ACTIVE' });
  };
  const followUp = await kernel.submit('session-a', 'follow up');
  assert.equal(followUp.deliveryMode, 'steer-fallback');
  assert.equal(runtime.steeredTurns.length, 0);
  assert.equal(runtime.startedTurns.length, 2);
  assert.equal(runtime.startedTurns[1].input, 'follow up');
  assert.notEqual(followUp.runtimeTurnId, first.runtimeTurnId);
});

test('a late steer rejection while the Turn is still active propagates the error', async (t) => {
  const provider = new FakeRuntimeProvider({ capabilities: { steer: true } });
  const kernel = new AgentSessionKernel({ provider, bindingStore: new InMemoryBindingStore() });
  t.after(() => kernel.close());
  await kernel.submit('session-a', 'first');
  const runtime = provider.createdSessions[0];
  runtime.steerTurn = async () => {
    throw Object.assign(new Error('no active turn'), { code: 'RUNTIME_TURN_NOT_ACTIVE' });
  };
  await assert.rejects(() => kernel.submit('session-a', 'follow up'), /no active turn/);
  assert.equal(runtime.startedTurns.length, 1);
});

test('a follow-up submitted while the first Turn is still starting is queued', async (t) => {
  const provider = new FakeRuntimeProvider({ capabilities: { steer: true } });
  const kernel = new AgentSessionKernel({ provider, bindingStore: new InMemoryBindingStore() });
  t.after(() => kernel.close());
  let sawFirstStart;
  const firstStarting = new Promise((resolve) => { sawFirstStart = resolve; });
  const originalCreate = provider.createSession.bind(provider);
  provider.createSession = (options) => {
    const session = originalCreate(options);
    const startTurn = session.startTurn.bind(session);
    session.startTurn = async (input) => {
      sawFirstStart();
      await delay(60);
      const result = await startTurn(input);
      setTimeout(() => session.complete(result.runtimeTurnId), 10);
      return result;
    };
    return session;
  };
  const first = kernel.submit('session-a', 'first');
  await firstStarting;
  const queued = kernel.submit('session-a', 'during startup');
  const accepted = await queued;
  await first;
  const runtime = provider.createdSessions[0];
  assert.equal(accepted.deliveryMode, 'queue');
  assert.equal(runtime.startedTurns.length, 2);
  assert.equal(runtime.startedTurns[1].input, 'during startup');
});

test('an idle Runtime is released while subscribers stay attached and resumes lazily', async (t) => {
  const { provider, store, kernel } = kernelOptions({ leaseMs: 60 });
  t.after(() => kernel.close());
  await kernel.submit('session-a', 'first');
  const runtime = provider.createdSessions[0];
  const events = [];
  kernel.subscribe('session-a', (event) => events.push(event));
  runtime.complete();
  await waitFor(() => events.some((event) => event.type === 'runtime_released'));
  assert.equal(runtime.closed, true);
  const binding = await store.load('session-a');
  assert.equal(binding.released, true);
  assert.equal(binding.releaseReason, 'idle-ttl');
  assert.equal(binding.runtimeSessionId, runtime.runtimeSessionId);

  const description = await kernel.attach('session-a');
  assert.equal(description.released, true);
  assert.equal(description.status, 'released');
  assert.equal(provider.createdSessions.length, 1, 'attach must not resume a released Runtime');

  const resumed = await kernel.submit('session-a', 'wake it up');
  assert.equal(provider.createdSessions.length, 2, 'submit resumes a released Runtime lazily');
  assert.equal(provider.createdSessions[1].runtimeSessionId, runtime.runtimeSessionId);
  assert.equal(resumed.deliveryMode, 'new');
  assert.equal((await store.load('session-a')).released, false);
});

test('meaningful input renews the idle lease and active work defers expiry', async (t) => {
  const { provider, kernel } = kernelOptions({ leaseMs: 200 });
  t.after(() => kernel.close());
  await kernel.submit('session-a', 'first');
  const runtime = provider.createdSessions[0];
  assert.equal(runtime.activeTurnId != null, true);
  await delay(260);
  assert.equal(runtime.closed, false, 'an active Turn defers idle release');
  runtime.complete();
  kernel.renewRuntimeLease('session-a');
  await delay(160);
  assert.equal(runtime.closed, false, 'meaningful input renews the lease');
  await waitFor(() => runtime.closed);
});

test('a detached Runtime is retained for its lease and reclaimed on attach', async (t) => {
  const { provider, kernel } = kernelOptions({ detachedLeaseMs: 120 });
  t.after(() => kernel.close());
  await kernel.submit('session-a', 'first');
  const runtime = provider.createdSessions[0];
  runtime.complete();
  await kernel.detach('session-a');
  assert.equal(runtime.closed, false, 'detach retains the Runtime for its lease');
  const description = await kernel.attach('session-a');
  assert.equal(description.runtimeSessionId, runtime.runtimeSessionId);
  assert.equal(provider.createdSessions.length, 1, 'reattach reuses the retained Runtime');
});

test('host activity defers idle expiry without requiring a product model', async (t) => {
  const provider = new FakeRuntimeProvider();
  let hostBusy = true;
  const observed = [];
  const kernel = new AgentSessionKernel({
    provider,
    bindingStore: new InMemoryBindingStore(),
    runtimeLeaseMs: 60,
    hasHostActiveWork: (id) => { observed.push(id); return hostBusy; },
  });
  t.after(() => kernel.close());
  const attached = await kernel.attach('project-free');
  assert.ok(attached.runtimeLeaseExpiresAt);
  await delay(180);
  assert.equal(provider.createdSessions[0].closed, false);
  assert.deepEqual([...new Set(observed)], ['project-free']);
  assert.equal(kernel.describeRuntime('project-free').runtimeLeaseExpiresAt, attached.runtimeLeaseExpiresAt);
  hostBusy = false;
  await waitFor(() => provider.createdSessions[0].closed);
  assert.equal(kernel.describeRuntime('project-free').runtimeLeaseExpiresAt, null);
});

test('a replacement waits for unsubscribe and duplicate releases share one operation', async (t) => {
  const { provider, kernel } = kernelOptions({ leaseMs: 60_000 });
  t.after(() => kernel.close());
  await kernel.attach('session-a');
  const oldRuntime = provider.createdSessions[0];
  let finishUnsubscribe;
  let unsubscribeCount = 0;
  oldRuntime.unsubscribe = () => {
    unsubscribeCount += 1;
    return new Promise((resolve) => { finishUnsubscribe = resolve; });
  };
  const release = kernel.releaseRuntime('session-a');
  await waitFor(() => finishUnsubscribe);
  const duplicate = kernel.releaseRuntime('session-a');
  const replacement = kernel.submit('session-a', 'resume after unsubscribe');
  await delay(30);
  assert.equal(provider.createdSessions.length, 1);
  assert.equal(unsubscribeCount, 1);
  finishUnsubscribe();
  await Promise.all([release, duplicate, replacement]);
  assert.equal(provider.createdSessions.length, 2);
  assert.equal(provider.createdSessions[1].runtimeSessionId, oldRuntime.runtimeSessionId);
});

test('a detached Runtime is released after its lease expires', async (t) => {
  const { provider, store, kernel } = kernelOptions({ detachedLeaseMs: 50 });
  t.after(() => kernel.close());
  await kernel.submit('session-a', 'first');
  const runtime = provider.createdSessions[0];
  runtime.complete();
  await kernel.detach('session-a');
  await waitFor(() => runtime.closed);
  const binding = await store.load('session-a');
  assert.equal(binding.released, true);
  assert.equal(binding.releaseReason, 'detached-ttl');
});

test('a Runtime exit interrupts the active Turn and the next attach resumes with a drained queue', async (t) => {
  const provider = new FakeRuntimeProvider({ capabilities: { steer: true } });
  const store = new InMemoryBindingStore();
  const saves = [];
  const save = store.save.bind(store);
  store.save = async (id, binding, options) => {
    const result = await save(id, binding, options);
    saves.push(structuredClone(result));
    return result;
  };
  const kernel = new AgentSessionKernel({ provider, bindingStore: store });
  t.after(() => kernel.close());
  await kernel.submit('session-a', 'first');
  const runtime = provider.createdSessions[0];
  const queued = kernel.submit('session-a', 'queued behind work', { mode: 'queue' });
  const exitEvents = [];
  kernel.subscribe('session-a', (event) => { if (event.type === 'connection_exited') exitEvents.push(event); });
  const interruptedTurnId = runtime.activeTurnId;
  runtime.emit('exit', { runtimeSessionId: runtime.runtimeSessionId, runtimeTurnId: interruptedTurnId, reason: 'connection_exited' });

  const accepted = await queued;
  assert.equal(accepted.deliveryMode, 'queue');
  assert.equal(exitEvents[0].runtimeTurnId, interruptedTurnId);
  assert.ok(
    saves.some((binding) => binding.status === 'interrupted' && binding.activeTurnId === null),
    'the interrupted Turn state is exposed through the persisted binding',
  );
  assert.equal(provider.createdSessions.length, 2, 'attach after exit creates a fresh Runtime that resumes');
  const resumed = provider.createdSessions[1];
  assert.equal(resumed.runtimeSessionId, runtime.runtimeSessionId);
  assert.equal(resumed.startedTurns.length, 1);
  assert.equal(resumed.startedTurns[0].input, 'queued behind work');
});

test('failed unsubscribe rejects a waiting replacement and preserves the attachment for retry', async (t) => {
  const { provider, store, kernel } = kernelOptions({ leaseMs: 60_000 });
  t.after(() => kernel.close());
  await kernel.attach('session-a');
  const runtime = provider.createdSessions[0];
  let rejectUnsubscribe;
  runtime.unsubscribe = () => new Promise((_resolve, reject) => { rejectUnsubscribe = reject; });
  const release = kernel.releaseRuntime('session-a');
  await waitFor(() => rejectUnsubscribe);
  const replacement = kernel.submit('session-a', 'must wait');
  const rejectedRelease = assert.rejects(release, /unsubscribe failed/);
  const rejectedReplacement = assert.rejects(replacement, /unsubscribe failed/);
  rejectUnsubscribe(new Error('unsubscribe failed'));
  await Promise.all([rejectedRelease, rejectedReplacement]);
  assert.equal(runtime.closed, false);
  assert.equal(provider.createdSessions.length, 1);
  assert.equal((await store.load('session-a')).released, false);
  assert.equal(kernel.describeRuntime('session-a').runtimeState, 'live');
  runtime.unsubscribe = async () => ({});
  await kernel.releaseRuntime('session-a');
  assert.equal(runtime.closed, true);
});

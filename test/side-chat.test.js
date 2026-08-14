import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SideChatController,
  normalizeSideChatRecord,
  normalizeSideChatSnapshot,
} from '../src/features/side-chat.js';

class MemorySideChatStore {
  constructor(scope = 'root') {
    this.scope = scope;
    this.records = new Map();
  }

  async list(parentSessionId) {
    return [...this.records.values()].filter((record) => record.parentSessionId === parentSessionId);
  }

  async load(id) {
    const value = this.records.get(id);
    return value ? structuredClone(value) : null;
  }

  async save(record) {
    const value = structuredClone(record);
    this.records.set(value.id, value);
    return structuredClone(value);
  }

  async remove(id) {
    this.records.delete(id);
  }
}

function createRuntime() {
  const calls = [];
  const snapshots = new Map();
  return {
    calls,
    snapshots,
    async fork(parentRuntimeSessionId, options) {
      calls.push(['fork', parentRuntimeSessionId, options]);
      const runtimeSessionId = `side-${parentRuntimeSessionId}`;
      snapshots.set(runtimeSessionId, { status: 'idle', messages: [] });
      return { runtimeSessionId };
    },
    async submit(runtimeSessionId, input, options) {
      calls.push(['submit', runtimeSessionId, input, options]);
      snapshots.set(runtimeSessionId, { status: 'running', activeTurnId: 'turn-1', messages: [] });
      return { runtimeTurnId: 'turn-1' };
    },
    async interrupt(runtimeSessionId, turnId) {
      calls.push(['interrupt', runtimeSessionId, turnId]);
    },
    async readSnapshot(runtimeSessionId) {
      const snapshot = snapshots.get(runtimeSessionId);
      if (!snapshot) throw Object.assign(new Error('missing'), { code: 'RUNTIME_SESSION_NOT_FOUND' });
      return structuredClone(snapshot);
    },
  };
}

test('project-free Side Chat keeps close, refresh and explicit deletion as separate states', async () => {
  let now = 10;
  const store = new MemorySideChatStore();
  const runtime = createRuntime();
  const controller = new SideChatController({ store, runtime, now: () => ++now });
  const created = await controller.create({
    parentSessionId: 'session-1',
    parentRuntimeSessionId: 'thread-1',
    selectedText: 'selected context',
    model: 'gpt-5.6-terra',
  });
  assert.equal(created.status, 'idle');
  assert.equal(created.resumable, true);
  assert.equal(created.selectedText, 'selected context');
  assert.deepEqual(runtime.calls[0], ['fork', 'thread-1', {
    ephemeral: true,
    model: 'gpt-5.6-terra',
    reasoningEffort: null,
  }]);

  const running = await controller.submit(created.id, 'Explain this');
  assert.equal(running.status, 'running');
  assert.equal(running.activeTurnId, 'turn-1');
  assert.equal(running.transcript[0].content, 'Explain this');
  await assert.rejects(() => controller.remove(created.id), { code: 'SIDE_CHAT_TURN_ACTIVE' });

  runtime.snapshots.set(created.runtimeSessionId, {
    status: 'idle',
    messages: [
      { id: 'u1', role: 'user', content: 'Explain this' },
      { id: 'a1', role: 'assistant', content: 'Answer' },
    ],
  });
  const completed = await controller.refresh(created.id);
  assert.equal(completed.status, 'idle');
  assert.equal(completed.transcript[1].content, 'Answer');
  assert.deepEqual(await controller.remove(created.id), { id: created.id, removed: true });
  assert.deepEqual(await controller.list('session-1'), []);
});

test('runtime loss preserves a read-only Side Chat record', async () => {
  const store = new MemorySideChatStore();
  const runtime = createRuntime();
  const controller = new SideChatController({ store, runtime });
  const created = await controller.create({ parentSessionId: 'session-1', parentRuntimeSessionId: 'thread-1' });
  runtime.snapshots.delete(created.runtimeSessionId);

  const expired = await controller.refresh(created.id);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.resumable, false);
  await assert.rejects(() => controller.submit(created.id, 'continue'), { code: 'SIDE_CHAT_EXPIRED' });
  assert.deepEqual(await controller.remove(created.id), { id: created.id, removed: true });
});

test('project-scoped adapters isolate storage without leaking product fields into Core records', async () => {
  const runtime = createRuntime();
  const projectA = new SideChatController({ store: new MemorySideChatStore('project-a'), runtime });
  const projectB = new SideChatController({ store: new MemorySideChatStore('project-b'), runtime });
  const created = await projectA.create({ parentSessionId: 'shared-session-name', parentRuntimeSessionId: 'thread-a' });

  assert.equal((await projectA.list('shared-session-name')).length, 1);
  assert.equal((await projectB.list('shared-session-name')).length, 0);
  assert.equal('projectId' in created, false);
  assert.equal('productContext' in created, false);
});

test('Side Chat normalization keeps provider snapshots product-neutral', () => {
  assert.deepEqual(normalizeSideChatSnapshot({ status: 'inProgress', runtimeTurnId: 'turn-1' }), {
    status: 'running', activeTurnId: 'turn-1', transcript: [], error: null,
  });
  assert.throws(() => normalizeSideChatRecord({ id: 'side' }), /Parent Session id/);
});

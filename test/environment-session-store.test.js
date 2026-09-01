import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EnvironmentSessionStore } from '../src/environment/index.js';

test('project-free Session store persists bindings and Runtime events', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'awb-sessions-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  let uuidSequence = 0;
  let timeSequence = 0;
  const store = new EnvironmentSessionStore({
    stateRoot,
    uuid: () => `id-${++uuidSequence}`,
    now: () => new Date(1_700_000_000_000 + timeSequence++ * 1_000),
  });
  const session = await store.create({ title: 'Minimal test' });
  assert.equal(session.contextId, 'environment');
  assert.equal('projectId' in session, false);
  await store.recordUserInput(session.sessionId, 'hello');
  await store.save(session.sessionId, {
    runtimeProvider: 'fake',
    runtimeSessionId: 'runtime-1',
    activeTurnId: 'turn-1',
    status: 'running',
  });
  await store.applyEvent({
    eventId: 1,
    type: 'turn_started',
    sessionId: session.sessionId,
    runtimeTurnId: 'turn-1',
    createdAt: 1_700_000_004_000,
    payload: {},
  });
  await store.applyEvent({
    eventId: 2,
    type: 'item_delta',
    sessionId: session.sessionId,
    runtimeTurnId: 'turn-1',
    providerEvent: 'item/agentMessage/delta',
    createdAt: 1_700_000_005_000,
    payload: { itemId: 'agent-1', delta: 'world' },
  });
  const view = await store.get(session.sessionId);
  assert.deepEqual(view.messages.map(({ role, content, turnId }) => ({ role, content, turnId })), [
    { role: 'user', content: 'hello', turnId: 'turn-1' },
    { role: 'assistant', content: 'world', turnId: 'turn-1' },
  ]);
  assert.equal((await store.load(session.sessionId)).runtimeSessionId, 'runtime-1');
});

test('Session store serializes concurrent binding updates without losing fields', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'awb-sessions-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot });
  const session = await store.create();
  assert.equal(session.title, '新对话');
  assert.equal(session.contextLabel, '');
  await Promise.all([
    store.save(session.sessionId, { runtimeProvider: 'fake' }),
    store.save(session.sessionId, { runtimeSessionId: 'runtime-2' }),
    store.save(session.sessionId, { status: 'idle' }),
  ]);
  assert.deepEqual(await store.load(session.sessionId), {
    runtimeProvider: 'fake',
    runtimeSessionId: 'runtime-2',
    status: 'idle',
    sessionId: session.sessionId,
    updatedAt: (await store.load(session.sessionId)).updatedAt,
  });
});

test('Session store serializes public reads with active mutations', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'awb-sessions-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot });
  const session = await store.create();
  const operations = [];
  for (let index = 0; index < 40; index += 1) {
    operations.push(store.save(session.sessionId, { status: index % 2 ? 'running' : 'idle' }));
    operations.push(store.list());
    operations.push(store.get(session.sessionId));
    operations.push(store.load(session.sessionId));
  }
  const results = await Promise.all(operations);
  assert.equal(results.filter(Array.isArray).every((sessions) => sessions.length === 1), true);
  assert.equal((await store.get(session.sessionId)).sessionId, session.sessionId);
});

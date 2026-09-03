import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { EnvironmentSessionRuntimeStore, EnvironmentSessionStore } from '../src/environment/index.js';

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

test('Session store derives the default title from the first user input and retains attachment metadata', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'awb-sessions-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot });
  const session = await store.create();
  await store.recordUserInput(session.sessionId, '近 7 天 iOS 纯新用户趋势', {
    attachments: [{
      id: 'attachment-1',
      name: '口径说明.md',
      mimeType: 'text/markdown',
      size: 18,
    }],
  });
  const view = await store.get(session.sessionId);
  assert.equal(view.title, '近 7 天 iOS 纯新用户趋势');
  assert.deepEqual(view.messages[0].attachments, [{
    id: 'attachment-1',
    name: '口径说明.md',
    mimeType: 'text/markdown',
    size: 18,
    kind: 'file',
    inputType: 'mention',
    status: 'ready',
  }]);

  const named = await store.create({ title: '保留自定义标题' });
  await store.recordUserInput(named.sessionId, '不应覆盖标题');
  assert.equal((await store.get(named.sessionId)).title, '保留自定义标题');
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

test('portable Session state keeps execution bindings and queues in the Run-local Runtime store', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-portable-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionStore = new EnvironmentSessionStore({
    stateRoot: join(root, 'shared'),
    runId: 'run-a',
  });
  const runtimeStore = new EnvironmentSessionRuntimeStore({ stateRoot: join(root, 'run-a') });
  const session = await sessionStore.create({ title: 'Portable' });
  assert.equal(session.createdRunId, 'run-a');
  await runtimeStore.save(session.sessionId, { runtimeSessionId: 'runtime-a', status: 'running' });
  await runtimeStore.saveQueuedTurns({ [session.sessionId]: [{ id: 'queued-a' }] });
  assert.equal((await sessionStore.get(session.sessionId)).runtimeBinding, null);
  assert.equal((await runtimeStore.load(session.sessionId)).runtimeSessionId, 'runtime-a');
  assert.deepEqual(await runtimeStore.loadQueuedTurns(), { [session.sessionId]: [{ id: 'queued-a' }] });
  const durableDocument = JSON.parse(await readFile(join(root, 'shared', 'sessions.json'), 'utf8'));
  assert.deepEqual(durableDocument.bindings, {});
  assert.deepEqual(durableDocument.queuedTurns, {});
});

test('two Session store instances serialize shared persistence mutations', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'awb-shared-session-lock-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  let sequence = 0;
  const uuid = () => `shared-${++sequence}`;
  const first = new EnvironmentSessionStore({ stateRoot, crossProcess: true, uuid });
  const second = new EnvironmentSessionStore({ stateRoot, crossProcess: true, uuid });
  await Promise.all([
    first.create({ title: 'First' }),
    second.create({ title: 'Second' }),
  ]);
  assert.deepEqual((await first.list()).map((session) => session.title).sort(), ['First', 'Second']);
});

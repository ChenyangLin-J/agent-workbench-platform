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

test('Session store persists an initial draft and creates once per owner-scoped idempotency key', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'awb-session-draft-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  let sequence = 0;
  const store = new EnvironmentSessionStore({
    stateRoot,
    uuid: () => `draft-${++sequence}`,
  });
  const first = await store.createIdempotent({
    title: '新对话',
    ownerId: 'user-a',
    draft: '我正在看实验 167。\n我需要：',
    idempotencyKey: 'solver-launch:launch-1',
  });
  const retried = await store.createIdempotent({
    title: '新对话',
    ownerId: 'user-a',
    draft: '我正在看实验 167。\n我需要：',
    idempotencyKey: 'solver-launch:launch-1',
  });
  const otherOwner = await store.createIdempotent({
    title: '新对话',
    ownerId: 'user-b',
    draft: '我正在看实验 167。\n我需要：',
    idempotencyKey: 'solver-launch:launch-1',
  });

  assert.equal(first.created, true);
  assert.equal(retried.created, false);
  assert.equal(retried.session.sessionId, first.session.sessionId);
  assert.equal(first.session.draft, '我正在看实验 167。\n我需要：');
  assert.notEqual(otherOwner.session.sessionId, first.session.sessionId);
  assert.equal((await store.list({ ownerId: 'user-a' }))[0].draft, undefined);
  await assert.rejects(
    store.createIdempotent({
      title: '新对话',
      ownerId: 'user-a',
      draft: '不同内容',
      idempotencyKey: 'solver-launch:launch-1',
    }),
    (error) => error.code === 'SESSION_CREATE_IDEMPOTENCY_CONFLICT' && error.status === 409,
  );

  await store.recordUserInput(first.session.sessionId, '请分析实验结果', { ownerId: 'user-a' });
  assert.equal((await store.get(first.session.sessionId, { ownerId: 'user-a' })).draft, '');
});

test('two Session stores converge concurrent idempotent creation', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'awb-session-idempotent-lock-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  let sequence = 0;
  const options = { stateRoot, crossProcess: true, uuid: () => `idempotent-${++sequence}` };
  const first = new EnvironmentSessionStore(options);
  const second = new EnvironmentSessionStore(options);
  const results = await Promise.all([
    first.createIdempotent({ ownerId: 'user-a', draft: 'draft', idempotencyKey: 'launch-1' }),
    second.createIdempotent({ ownerId: 'user-a', draft: 'draft', idempotencyKey: 'launch-1' }),
  ]);
  assert.equal(results.filter((result) => result.created).length, 1);
  assert.equal(new Set(results.map((result) => result.session.sessionId)).size, 1);
  assert.equal((await first.list({ ownerId: 'user-a' })).length, 1);
});

test('Session store reserves and replays one owner-scoped Turn submission', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'awb-turn-idempotent-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot });
  const session = await store.create({ ownerId: 'user-a' });
  const request = {
    ownerId: 'user-a',
    idempotencyKey: 'dashboard-agent:turn-1',
    fingerprint: 'fingerprint-1',
  };

  const first = await store.reserveTurnSubmission(session.sessionId, request);
  const pending = await store.reserveTurnSubmission(session.sessionId, request);
  assert.equal(first.created, true);
  assert.equal(pending.created, false);
  assert.equal(pending.submission.status, 'reserved');

  await store.completeTurnSubmission(session.sessionId, {
    ownerId: 'user-a',
    idempotencyKey: request.idempotencyKey,
    responseStatus: 202,
    response: { result: { runtimeTurnId: 'turn-1' } },
  });
  const replayed = await store.reserveTurnSubmission(session.sessionId, request);
  assert.equal(replayed.created, false);
  assert.equal(replayed.submission.status, 'accepted');
  assert.equal(replayed.submission.response.result.runtimeTurnId, 'turn-1');
  assert.equal('turnSubmissions' in await store.get(session.sessionId, { ownerId: 'user-a' }), false);

  await assert.rejects(
    store.reserveTurnSubmission(session.sessionId, { ...request, fingerprint: 'different' }),
    (error) => error.code === 'SESSION_TURN_IDEMPOTENCY_CONFLICT' && error.status === 409,
  );
  await assert.rejects(
    store.reserveTurnSubmission(session.sessionId, { ...request, ownerId: 'user-b' }),
    (error) => error.code === 'SESSION_NOT_FOUND',
  );
});
test('Session store hides archived Sessions from the owner list while retaining them for history and observation', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'awb-sessions-archive-'));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));
  const store = new EnvironmentSessionStore({ stateRoot });
  const source = await store.create({ title: 'Original', ownerId: 'owner-a' });
  const replacement = await store.create({ title: 'Replacement', ownerId: 'owner-a' });

  const archived = await store.archive(source.sessionId, { ownerId: 'owner-a' });

  assert.equal(archived.archived, true);
  assert.deepEqual((await store.list({ ownerId: 'owner-a' })).map((session) => session.id), [replacement.sessionId]);
  assert.deepEqual(
    new Set((await store.list({ ownerId: 'owner-a', includeArchived: true })).map((session) => session.id)),
    new Set([source.sessionId, replacement.sessionId]),
  );
  assert.equal((await store.get(source.sessionId, { ownerId: 'owner-a' })).archived, true);
  await assert.rejects(
    store.archive(source.sessionId, { ownerId: 'owner-b' }),
    (error) => error.code === 'SESSION_NOT_FOUND',
  );
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

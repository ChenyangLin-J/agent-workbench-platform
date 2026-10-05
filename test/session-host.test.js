import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionHostController, mergeSessionHostSnapshot } from '../src/session-host.js';

test('switching the native thread behind one UI Session discards history from the previous thread', () => {
  const latest = { sessionId: 'web-a', threadId: 'fork-b', messages: [{ id: 'new', content: 'new branch' }] };
  assert.deepEqual(mergeSessionHostSnapshot({ sessionId: 'web-a', threadId: 'source-a', messages: [{ id: 'old' }] }, latest), latest);
});

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const snapshot = (id, revision = 1) => ({ sessionId: id, revision, messages: [], queuedTurns: [], pendingRequests: [] });

test('Creation is usable while an older history list is delayed and its response cannot remove the new row', async () => {
  const history = deferred();
  let lists = 0;
  const host = createSessionHostController({ adapter: {
    listSessions: () => lists++ ? history.promise : Promise.resolve([{ id: 'old' }]),
    readSession: async (id) => snapshot(id),
    createSession: async () => ({ session: { sessionId: 'draft', title: 'New conversation' } }),
  } });
  await host.start();
  const refreshing = host.refreshSessions();
  let completed = false;
  const creating = host.execute('create').then((value) => { completed = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(host.getSnapshot().selectedId, 'draft');
    assert.equal(host.getSnapshot().session.sessionId, 'draft');
    assert.equal(host.getSnapshot().sessions.some((row) => row.sessionId === 'draft'), true);
    assert.equal(completed, true, 'accepted creation must settle before unrelated history responds');
    await host.select('old');
    history.resolve([{ id: 'old' }]);
    await Promise.all([refreshing, creating]);
    assert.equal(host.getSnapshot().selectedId, 'old');
    assert.equal(host.getSnapshot().sessions.some((row) => row.sessionId === 'draft'), true);
  } finally { history.resolve([]); host.dispose(); }
});

test('A delayed accepted creation retains operation identity and respects a newer selection', async () => {
  const creation = deferred();
  let calls = 0;
  const host = createSessionHostController({ adapter: {
    listSessions: async () => [{ id: 'old' }], readSession: async (id) => snapshot(id),
    createSession: () => { calls++; return creation.promise; },
  } });
  await host.start();
  const first = host.execute('create');
  const repeated = host.execute('create');
  await host.select('old');
  creation.resolve({ sessionId: 'draft' });
  await Promise.all([first, repeated]);
  assert.equal(calls, 1);
  assert.equal(host.getSnapshot().selectedId, 'old');
  assert.equal(host.getSnapshot().session.sessionId, 'old');
  assert.equal(host.getSnapshot().sessions.some((row) => row.sessionId === 'draft'), true);
  host.dispose();
});

test('Creation resolving after disposal does not start a read or update the visible state', async () => {
  const creation = deferred();
  let reads = 0;
  const host = createSessionHostController({ adapter: {
    listSessions: async () => [], readSession: async (id) => { reads++; return snapshot(id); },
    createSession: () => creation.promise,
  } });
  await host.start();
  const creating = host.execute('create');
  host.dispose();
  creation.resolve({ sessionId: 'draft' });
  assert.deepEqual(await creating, { sessionId: 'draft' });
  assert.equal(reads, 0);
  assert.equal(host.getSnapshot().selectedId, null);
  assert.deepEqual(host.getSnapshot().sessions, []);
});

test('An operation completed for an earlier selection cannot clear a fresh operation error', async () => {
  const earlier = deferred();
  const host = createSessionHostController({ adapter: {
    listSessions: async () => [], readSession: async (id) => snapshot(id),
    execute: async (id) => { if (id === 'a') return earlier.promise; throw new Error('current operation failed'); },
  } });
  await host.select('a');
  const operation = host.execute('turn', { prompt: 'first' });
  await host.select('b');
  await assert.rejects(host.execute('turn', { prompt: 'second' }), /current operation failed/);
  earlier.resolve({ accepted: true });
  await operation;
  assert.equal(host.getSnapshot().error, 'current operation failed');
  assert.equal(host.getSnapshot().selectedId, 'b');
  host.dispose();
});

for (const context of [null, 'project-a']) {
  test(`Host Kit keeps Session identity and operations in ${context || 'project-free'} mode`, async () => {
    const submitted = [];
    let retries = 0;
    const host = createSessionHostController({ adapter: {
      listSessions: async () => ({ sessions: [{ id: 'web-id', contextId: context }] }),
      readSession: async (id) => snapshot(id),
      createSession: async (payload) => ({ session: { sessionId: 'web-id', contextId: context } }),
      execute: async (id, action, payload, options) => {
        submitted.push({ id, action, payload, key: options.idempotencyKey });
        if (!retries++) throw new Error('Response lost after acceptance');
        return { accepted: true };
      },
    } });
    await host.start();
    await host.execute('create');
    await assert.rejects(host.execute('turn', { prompt: 'hello', attachments: [{ id: 'attachment' }] }), /Response lost/);
    await host.execute('turn', { attachments: [{ id: 'attachment' }], prompt: 'hello' });
    assert.equal(submitted[0].id, 'web-id');
    assert.equal(submitted[0].key, submitted[1].key);
    await host.execute('turn', { prompt: 'hello', attachments: [{ id: 'attachment' }] });
    assert.notEqual(submitted[1].key, submitted[2].key);
    host.dispose();
  });
}

test('Selection releases subscriptions and rejects late snapshots/events, including reselecting the same Session', async () => {
  const reads = new Map();
  const streams = [];
  const host = createSessionHostController({ adapter: {
    listSessions: async () => [],
    readSession: (id) => { const read = deferred(); reads.set(id, read); return read.promise; },
    subscribeSession: (id, callbacks) => { const stream = { id, callbacks, released: false }; streams.push(stream); return () => { stream.released = true; }; },
    applyEvent: (session, event) => ({ ...session, title: event.title }),
  } });
  const a = host.select('a');
  const b = host.select('b');
  reads.get('a').resolve(snapshot('a'));
  reads.get('b').resolve(snapshot('b'));
  await Promise.all([a, b]);
  assert.equal(host.getSnapshot().session.sessionId, 'b');
  const c = host.select('c'); reads.get('c').resolve(snapshot('c')); await c;
  assert.equal(streams[0].released, true);
  streams[0].callbacks.onEvent({ sessionId: 'b', revision: 2, title: 'wrong' });
  assert.equal(host.getSnapshot().session.title, undefined);
  host.dispose();
  assert.equal(streams[1].callbacks.signal.aborted, true);
});

test('Recovery uses an authoritative snapshot then replays only newer revisions', async () => {
  let callbacks;
  let read = snapshot('a', 2);
  const host = createSessionHostController({ initialSessionId: 'a', adapter: {
    listSessions: async () => [], readSession: async () => read,
    subscribeSession: (_id, value) => { callbacks = value; return () => {}; },
    applyEvent: (session, event) => ({ ...session, title: event.title }),
  } });
  await host.start();
  const recovery = deferred(); read = recovery.promise;
  callbacks.onConnection('connected');
  callbacks.onEvent({ sessionId: 'a', revision: 3, title: 'already in snapshot' });
  callbacks.onEvent({ sessionId: 'a', revision: 5, title: 'newer' });
  recovery.resolve({ ...snapshot('a', 4), title: 'snapshot' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.getSnapshot().session.title, 'newer');
  assert.equal(host.getSnapshot().session.revision, 5);
  assert.equal(host.receiveEvent({ sessionId: 'a', revision: 5, title: 'duplicate' }), false);
  assert.equal(host.getSnapshot().connection, 'connected');
  host.dispose();
});

test('Accepted operation remains successful when its follow-up snapshot cannot be read', async () => {
  let reads = 0;
  let submits = 0;
  const host = createSessionHostController({ initialSessionId: 'a', adapter: {
    listSessions: async () => [], readSession: async () => { if (reads++) throw new Error('offline'); return snapshot('a'); },
    execute: async () => { submits++; return { accepted: true }; },
  } });
  await host.start();
  assert.deepEqual(await host.execute('turn', { prompt: 'hello' }), { accepted: true });
  assert.equal(submits, 1);
  host.dispose();
});

test('Snapshot merge preserves earlier messages and replaces authoritative queue/request state', () => {
  const current = { messages: [{ id: 'old', content: 'history' }, { id: 'new', content: 'draft delta' }], pendingRequests: [{ token: 'resolved' }], queuedTurns: [{ id: 'submitted' }], turnsCursor: 'old-page', loadedTurnCount: 8 };
  const latest = { messages: [{ id: 'new', content: 'complete' }], pendingRequests: [], queuedTurns: [], loadedTurnCount: 5, turnsCursor: 'new-page' };
  const merged = mergeSessionHostSnapshot(current, latest);
  assert.equal(merged.messages.length, 2);
  assert.equal(merged.messages[1].content, 'complete');
  assert.deepEqual(merged.queuedTurns, []);
  assert.deepEqual(merged.pendingRequests, []);
  assert.equal(merged.turnsCursor, 'old-page');
});

test('nested product Session metadata does not replace the canonical snapshot or its identity', async () => {
 const host=createSessionHostController({adapter:{listSessions:async()=>[],readSession:async(id)=>({sessionId:id,session:{id:'web-1',sessionId:'thread-1'},messages:[]}),createSession:async()=>({sessionId:'web-1',session:{id:'web-1',sessionId:'thread-1'}}),applyEvent:(snapshot)=>({...snapshot,messages:[{id:'answer',content:'public reply'}]})}});
 await host.start();await host.execute('create');assert.equal(host.getSnapshot().selectedId,'web-1');
 host.receiveEvent({sessionId:'web-1',revision:1});assert.equal(host.getSnapshot().session.messages[0].content,'public reply');host.dispose();
});

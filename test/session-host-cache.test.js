import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionHostController } from '../src/session-host.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const snapshot = (id, revision = 1, extra = {}) => ({ sessionId: id, revision, status: 'completed', messages: [{ id: 'answer', content: `answer ${revision}` }], pendingRequests: [], queuedTurns: [], ...extra });
const cacheKey = body => body.status === 'completed' ? `${body.sessionId}:${body.threadId || ''}` : null;
const adapter = overrides => ({ listSessions: async () => [], readSession: async id => snapshot(id), getSnapshotCacheKey: cacheKey, ...overrides });

// Assertions before resolving the network model the actual first-body boundary,
// independent of when the select promise (fresh snapshot/subscription) settles.
test('warm selection publishes known body immediately and always revalidates before subscribing', async () => {
  const network = deferred(); const subscriptions = []; let slow = false; let reads = 0;
  const host = createSessionHostController({ selectedSnapshotCache: true, adapter: adapter({
    readSession: id => { reads++; return slow && id === 'a' ? network.promise : Promise.resolve(snapshot(id)); },
    subscribeSession: (id, options) => { subscriptions.push({ id, revision: options.afterRevision }); return () => {}; },
  }) });
  await host.select('a'); await host.select('b'); slow = true;
  let settled = false; const returning = host.select('a').then(() => { settled = true; });
  assert.equal(host.getSnapshot().session.messages[0].content, 'answer 1');
  assert.equal(host.getSnapshot().selectedSnapshotCached, true);
  assert.equal(host.getSnapshot().connection, 'connecting');
  assert.equal(settled, false); assert.equal(reads, 3); assert.equal(subscriptions.length, 2);
  network.resolve(snapshot('a', 2)); await returning;
  assert.equal(host.getSnapshot().session.messages[0].content, 'answer 2');
  assert.equal(host.getSnapshot().selectedSnapshotCached, false);
  assert.deepEqual(subscriptions.at(-1), { id: 'a', revision: 2 }); host.dispose();
});

test('newer catalogue invalidates warm body even if adapter accidentally returns the same key', async () => {
  const network = deferred(); let slow = false; let rows = [{ id: 'a', outputRevision: 1 }];
  const host = createSessionHostController({ selectedSnapshotCache: true, adapter: adapter({
    listSessions: async () => rows,
    readSession: id => slow && id === 'a' ? network.promise : Promise.resolve(snapshot(id)),
  }) });
  await host.start(); await host.select('a'); await host.select('b');
  rows = [{ id: 'a', outputRevision: 2 }]; await host.refreshSessions(); slow = true;
  const returning = host.select('a'); assert.equal(host.getSnapshot().session, null);
  network.resolve(snapshot('a', 2)); await returning;
  assert.equal(host.getSnapshot().session.revision, 2); host.dispose();
});

test('a stale warm revalidation cannot overwrite a newer selection or populate another warm visit', async () => {
  const old = deferred(); const latest = deferred(); let aReads = 0;
  const host = createSessionHostController({ selectedSnapshotCache: true, adapter: adapter({
    readSession: id => id !== 'a' || ++aReads === 1 ? Promise.resolve(snapshot(id)) : aReads === 2 ? old.promise : latest.promise,
  }) });
  await host.select('a'); await host.select('b'); const returning = host.select('a');
  assert.equal(host.getSnapshot().session.revision, 1); await host.select('b');
  old.resolve(snapshot('a', 99)); await returning;
  assert.equal(host.getSnapshot().selectedId, 'b');
  const revisit = host.select('a'); assert.equal(host.getSnapshot().session.revision, 1);
  latest.resolve(snapshot('a', 2)); await revisit;
  assert.equal(host.getSnapshot().session.revision, 2); host.dispose();
});

test('binding changes, force selection, and restart reset bypass old bodies and revision domains', async () => {
  const reads = []; let thread = 'old'; let blocking = false;
  const host = createSessionHostController({ selectedSnapshotCache: true, adapter: adapter({
    readSession: id => { if (!blocking) return Promise.resolve(snapshot(id, 20, { threadId: thread })); const read = deferred(); reads.push({ id, ...read }); return read.promise; },
    getSnapshotCacheKey: body => body.threadId === thread ? cacheKey(body) : null,
  }) });
  await host.select('a'); await host.select('b'); thread = 'new'; blocking = true;
  const binding = host.select('a'); assert.equal(host.getSnapshot().session, null);
  reads.at(-1).resolve(snapshot('a', 1, { threadId: 'new' })); await binding;
  const forced = host.select('a', { force: true });
  assert.equal(host.getSnapshot().selectedSnapshotCached, false);
  assert.equal(host.getSnapshot().session.revision, undefined);
  reads.at(-1).resolve(snapshot('a', 0, { threadId: 'new' })); await forced;
  const b = host.select('b'); reads.at(-1).resolve(snapshot('b', 5, { threadId: 'new' })); await b;
  await host.reconcileSelectedSession({ resetRevision: true });
  const restart = host.select('a'); assert.equal(host.getSnapshot().session, null);
  reads.at(-1).resolve(snapshot('a', 0, { threadId: 'new' })); await restart;
  assert.equal(host.getSnapshot().session.revision, 0); host.dispose();
});

for (const [label, options, wait] of [
  ['entry count', { maxEntries: 1 }, false],
  ['byte budget', { maxBytes: 260 }, false],
  ['expiry', { ttlMs: 1 }, true],
]) test(`warm cache has finite ${label} eviction`, async () => {
  const network = deferred(); let slow = false;
  const host = createSessionHostController({ selectedSnapshotCache: options, adapter: adapter({
    readSession: id => slow && id === 'a' ? network.promise : Promise.resolve(snapshot(id)),
  }) });
  await host.select('a'); await host.select('b');
  if (wait) await new Promise(r => setTimeout(r, 5)); slow = true;
  const returning = host.select('a'); assert.equal(host.getSnapshot().session, null);
  network.resolve(snapshot('a')); await returning; host.dispose();
});

for (const [label, extra] of [
  ['active Turn', { activeTurnId: 'turn' }],
  ['approval', { pendingRequests: [{ token: 'approval' }] }],
  ['queued submission', { queuedTurns: [{ id: 'queue' }] }],
  ['running activity', { status: 'running' }],
]) test(`cache does not reuse ${label} execution state`, async () => {
  const network = deferred(); let slow = false;
  const host = createSessionHostController({ selectedSnapshotCache: true, adapter: adapter({
    readSession: id => slow && id === 'a' ? network.promise : Promise.resolve(snapshot(id, 1, id === 'a' ? extra : {})),
  }) });
  await host.select('a'); await host.select('b'); slow = true;
  const returning = host.select('a'); assert.equal(host.getSnapshot().session, null);
  network.resolve(snapshot('a', 2)); await returning; host.dispose();
});

test('in-flight operations invalidate idle cache without inventing running state or losing submission identity', async () => {
  const execution = deferred(); const network = deferred(); let slow = false;
  const host = createSessionHostController({ selectedSnapshotCache: true, submissionFeedback: true, adapter: adapter({
    readSession: id => slow && id === 'a' ? network.promise : Promise.resolve(snapshot(id)),
    submissionMessage: (_, payload) => ({ role: 'user', content: payload.prompt }),
    execute: () => execution.promise,
  }) });
  await host.select('a'); const sending = host.execute('send', { prompt: 'keep identity' });
  const submissionId = host.getSnapshot().session.messages.at(-1).submissionId;
  assert.equal(host.getSnapshot().session.status, 'completed');
  await host.select('b'); slow = true; const returning = host.select('a');
  assert.equal(host.getSnapshot().session, null);
  network.resolve(snapshot('a', 2)); await returning;
  assert.equal(host.getSnapshot().session.messages.at(-1).submissionId, submissionId);
  execution.resolve({ accepted: true }); await sending; host.dispose();
});

test('default selection and opt-in without an authority hook retain cold read behavior', async () => {
  for (const [enabled, authorityHook] of [[false, cacheKey], [true, undefined]]) {
    const network = deferred(); let slow = false;
    const host = createSessionHostController({ selectedSnapshotCache: enabled, adapter: adapter({
      getSnapshotCacheKey: authorityHook,
      readSession: id => slow && id === 'a' ? network.promise : Promise.resolve(snapshot(id)),
    }) });
    await host.select('a'); await host.select('b'); slow = true;
    const returning = host.select('a'); assert.equal(host.getSnapshot().session, null);
    network.resolve(snapshot('a')); await returning; host.dispose();
  }
});

test('idle rereads during a pending operation cannot make its old body reusable', async () => {
  const execution = deferred(); const network = deferred(); let slow = false;
  const host = createSessionHostController({ selectedSnapshotCache: true, adapter: adapter({
    readSession: id => slow && id === 'a' ? network.promise : Promise.resolve(snapshot(id)),
    execute: () => execution.promise,
  }) });
  await host.select('a'); const operation = host.execute('settings', { model: 'model' });
  await host.refreshSession(); await host.select('b'); slow = true;
  const returning = host.select('a'); assert.equal(host.getSnapshot().session, null);
  network.resolve(snapshot('a', 2)); await returning;
  execution.resolve({ accepted: true }); await operation; host.dispose();
});

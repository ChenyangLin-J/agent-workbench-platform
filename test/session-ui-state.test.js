import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionUiStateStore, restoreSessionScrollPosition, sessionScrollTopForPersistence } from '../src/ui/session-ui-state.js';

test('reading and draft state survive remount while unresolved uploads do not become ready', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const store = createSessionUiStateStore(storage);
  store.set('session-a', { draft: 'keep me', scrollTop: 340, processOpenByTurn: { turn: true }, attachments: [{ id: 'pending', status: 'uploading' }, { id: 'ready', path: '/a.txt', status: 'ready' }] });
  const restored = createSessionUiStateStore(storage).get('session-a');
  assert.equal(restored.draft, 'keep me');
  assert.equal(restored.scrollTop, 340);
  assert.equal(restored.processOpenByTurn.turn, true);
  assert.deepEqual(restored.attachments.map(value => value.id), ['ready']);
});

test('unavailable storage leaves Session switching recovery usable', () => {
  const store = createSessionUiStateStore({ getItem() { throw new Error('disabled'); }, setItem() { throw new Error('disabled'); } });
  store.set('session-a', { draft: 'safe' });
  assert.equal(store.get('session-a').draft, 'safe');
});

test('a persisted reading position retries after a short lazy transcript grows', () => {
  const transcript = { scrollTop: 0, scrollHeight: 300, clientHeight: 300 };
  const first = restoreSessionScrollPosition(transcript, 480);
  assert.deepEqual(first, { restored: false, scrollTop: 0 });

  transcript.scrollHeight = 1_200;
  const second = restoreSessionScrollPosition(transcript, 480);
  assert.deepEqual(second, { restored: true, scrollTop: 480 });
});

test('a deliberate top reading position is already restored, rather than treated as a missing position', () => {
  const transcript = { scrollTop: 240, scrollHeight: 1_200, clientHeight: 300 };
  assert.deepEqual(restoreSessionScrollPosition(transcript, 0), { restored: true, scrollTop: 0 });
});

test('an interrupted lazy restore persists its original target rather than the clamp position', () => {
  const detachedOrShortTranscript = { isConnected: false, scrollTop: 0 };
  assert.equal(sessionScrollTopForPersistence(detachedOrShortTranscript, 0, 1_200), 1_200);
  assert.equal(sessionScrollTopForPersistence(detachedOrShortTranscript, 0, 0), 0);
});

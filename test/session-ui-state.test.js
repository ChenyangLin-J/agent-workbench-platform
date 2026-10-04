import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionUiStateStore } from '../src/ui/session-ui-state.js';

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

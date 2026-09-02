import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SessionTurnQueue,
  createQueuedTurnDispatcher,
  queuedTurnWasAccepted,
} from '../src/features/turn-queue.js';

test('Session Turn Queue persists private runtime input while exposing a safe presentation', async () => {
  let persisted = null;
  const queue = new SessionTurnQueue({
    now: () => new Date('2026-09-02T00:00:00.000Z'),
    uuid: () => 'queued-1',
    persist: async (snapshot) => { persisted = snapshot; },
  });
  const queued = await queue.enqueue('session-a', {
    input: [{ type: 'text', text: 'next' }],
    prompt: 'next',
    attachments: [{ id: 'file-1', name: 'file.txt', storedPath: '/private/path' }],
    context: { ownerId: 'owner-a' },
  });
  assert.deepEqual(queued.attachments, [{ id: 'file-1', name: 'file.txt', kind: 'file' }]);
  assert.equal(JSON.stringify(queued).includes('/private/path'), false);
  assert.equal(persisted['session-a'][0].attachments[0].storedPath, '/private/path');
  assert.equal(queue.peek('session-a').context.ownerId, 'owner-a');
});

test('Queued Turn dispatcher starts the next Turn and removes it after Runtime acceptance', async () => {
  const queue = new SessionTurnQueue({ uuid: () => 'queued-1' });
  await queue.enqueue('session-a', { input: 'next input', prompt: 'next' });
  const started = [];
  const dispatcher = createQueuedTurnDispatcher({
    queue,
    activeTurnForSession: () => false,
    runtime: {
      readSession: async () => ({ turns: [{ id: 'turn-1' }] }),
      startTurn: async (sessionId, input, entry) => {
        started.push({ sessionId, input, queuedTurnId: entry.id });
        return { runtimeTurnId: 'turn-2' };
      },
    },
  });
  await dispatcher.startNext('session-a');
  assert.deepEqual(started, [{ sessionId: 'session-a', input: 'next input', queuedTurnId: 'queued-1' }]);
  assert.deepEqual(queue.list('session-a'), []);
  dispatcher.close();
});

test('Queued Turn recovery recognizes a previously accepted Turn', () => {
  assert.equal(queuedTurnWasAccepted({
    prompt: 'next',
    afterTurnId: 'turn-1',
    startedTurnId: null,
  }, {
    turns: [
      { id: 'turn-1', items: [] },
      { id: 'turn-2', items: [{ type: 'userMessage', text: 'next' }] },
    ],
  }), true);
});

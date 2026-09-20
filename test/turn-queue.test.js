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

test('Queued Turn dispatcher reports normal and recovered Runtime acceptance before removal', async () => {
  const queue = new SessionTurnQueue({ uuid: () => 'queued-1' });
  await queue.enqueue('session-a', { input: 'next', prompt: 'next', afterTurnId: 'turn-1' });
  const accepted = [];
  const dispatcher = createQueuedTurnDispatcher({
    queue,
    activeTurnForSession: () => false,
    runtime: {
      readSession: async () => ({ turns: [{ id: 'turn-1' }] }),
      startTurn: async () => ({ id: 'turn-2' }),
    },
    events: { onAccepted: (...args) => accepted.push(args) },
  });
  await dispatcher.startNext('session-a');
  assert.equal(accepted[0][2].id, 'turn-2');
  assert.equal(accepted[0][3].recovered, false);
  dispatcher.close();

  const recoveredQueue = new SessionTurnQueue({
    entries: {
      'session-a': [{
        id: 'queued-1', input: 'next', prompt: 'next', attachments: [], context: null,
        afterTurnId: 'turn-1', status: 'starting', attempts: 1, startedTurnId: null,
        createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
      }],
    },
  });
  const recovered = [];
  const recoveredDispatcher = createQueuedTurnDispatcher({
    queue: recoveredQueue,
    activeTurnForSession: () => false,
    runtime: {
      readSession: async () => ({ turns: [
        { id: 'turn-1', items: [] },
        { id: 'turn-2', items: [{ type: 'userMessage', text: 'next' }] },
      ] }),
      startTurn: async () => { throw new Error('must not restart'); },
    },
    events: { onAccepted: (...args) => recovered.push(args) },
  });
  await recoveredDispatcher.startNext('session-a');
  assert.equal(recovered[0][2].id, 'turn-2');
  assert.equal(recovered[0][3].recovered, true);
  recoveredDispatcher.close();
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

test('Queued Turn recovery ignores Session reference envelopes', () => {
  assert.equal(queuedTurnWasAccepted({
    prompt: 'inspect',
    afterTurnId: 'turn-1',
    startedTurnId: null,
  }, {
    turns: [
      { id: 'turn-1', items: [] },
      { id: 'turn-2', items: [{
        type: 'userMessage',
        text: 'inspect\n<agent-workbench-session-references>\n[{"kind":"session","version":1,"hostId":"personal-local","threadId":"thread-2"}]\n</agent-workbench-session-references>',
      }] },
    ],
  }), true);
});

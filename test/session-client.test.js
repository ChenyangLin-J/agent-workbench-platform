import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SessionClientOperationController,
  sessionOperationFingerprint,
} from '../src/session-client.js';

test('Session client operations reuse a key until the request is accepted', () => {
  let sequence = 0;
  const controller = new SessionClientOperationController({ createId: () => `request-${++sequence}` });
  const payload = { prompt: 'hello', mode: 'turn', attachments: [] };
  const first = controller.begin({ scope: 'turn', targetId: 'session-1', payload });
  const retry = controller.begin({
    scope: 'turn',
    targetId: 'session-1',
    payload: { attachments: [], mode: 'turn', prompt: 'hello' },
  });

  assert.equal(first, retry);
  assert.equal(first.idempotencyKey, 'turn:request-1');
  assert.equal(controller.complete(first), true);
  assert.equal(controller.begin({ scope: 'turn', targetId: 'session-1', payload }).idempotencyKey, 'turn:request-2');
});

test('Session client operations separate targets and changed payloads', () => {
  let sequence = 0;
  const controller = new SessionClientOperationController({ createId: () => `request-${++sequence}` });
  const first = controller.begin({ scope: 'turn', targetId: 'session-1', payload: { prompt: 'one' } });
  const changed = controller.begin({ scope: 'turn', targetId: 'session-1', payload: { prompt: 'two' } });
  const otherSession = controller.begin({ scope: 'turn', targetId: 'session-2', payload: { prompt: 'one' } });

  assert.notEqual(first.idempotencyKey, changed.idempotencyKey);
  assert.notEqual(first.idempotencyKey, otherSession.idempotencyKey);
  controller.clearTarget('session-1');
  assert.equal(controller.complete(first), false);
  assert.equal(controller.complete(otherSession), true);
});

test('Session operation fingerprints are stable across object key order', () => {
  assert.equal(
    sessionOperationFingerprint({ prompt: 'hello', nested: { second: 2, first: 1 } }),
    sessionOperationFingerprint({ nested: { first: 1, second: 2 }, prompt: 'hello' }),
  );
});

test('Session client operations are available through the public package entry', async () => {
  const entry = await import('@agent-workbench/platform/session-client');
  assert.equal(entry.SessionClientOperationController, SessionClientOperationController);
  assert.equal(entry.sessionOperationFingerprint, sessionOperationFingerprint);
  assert.equal(typeof entry.createSessionEventController, 'function');
  assert.equal(typeof entry.reconcileSessionSnapshot, 'function');
  assert.equal(typeof entry.mergeSessionTurns, 'function');
  assert.equal(typeof entry.sessionEventTurnId, 'function');
  assert.equal(typeof entry.sessionEventActivityKind, 'function');
});

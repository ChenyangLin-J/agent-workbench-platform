import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CoreEventReplayBuffer,
  createCoreEvent,
  normalizeRuntimeCapabilities,
} from '../src/runtime/core/index.js';

test('event envelope is stable and immutable', () => {
  const event = createCoreEvent({
    eventId: 1,
    type: 'turn_started',
    sessionId: 'session-a',
    runtimeProvider: 'codex',
    runtimeSessionId: 'thread-a',
    providerEvent: 'turn/started',
    payload: { turn: { id: 'turn-a' } },
    createdAt: 10,
  });
  assert.deepEqual(event, {
    eventId: 1,
    type: 'turn_started',
    sessionId: 'session-a',
    runtimeProvider: 'codex',
    runtimeSessionId: 'thread-a',
    runtimeTurnId: null,
    providerEvent: 'turn/started',
    payload: { turn: { id: 'turn-a' } },
    createdAt: 10,
  });
  assert.equal(Object.isFrozen(event), true);
});

test('bounded replay reports a gap instead of silently losing events', () => {
  const buffer = new CoreEventReplayBuffer({ limit: 2 });
  buffer.publish('session-a', { type: 'provider_event', runtimeProvider: 'codex', payload: { index: 1 } });
  buffer.publish('session-a', { type: 'provider_event', runtimeProvider: 'codex', payload: { index: 2 } });
  buffer.publish('session-a', { type: 'provider_event', runtimeProvider: 'codex', payload: { index: 3 } });
  assert.deepEqual(buffer.replay('session-a', 0), {
    earliestEventId: 2,
    latestEventId: 3,
    replayGap: true,
    events: [
      buffer.replay('session-a', 1).events[0],
      buffer.replay('session-a', 2).events[0],
    ],
  });
});

test('runtime capabilities are explicit and default to unsupported', () => {
  const capabilities = normalizeRuntimeCapabilities('pi', { resume: true, interrupt: true });
  assert.equal(capabilities.provider, 'pi');
  assert.equal(capabilities.resume, true);
  assert.equal(capabilities.interrupt, true);
  assert.equal(capabilities.steer, false);
  assert.equal(capabilities.approvals, false);
});

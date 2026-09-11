import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyMinimalHostSessionEvent,
  parseMinimalHostSessionEvent,
  patchMinimalHostSessionSummary,
} from '../src/environment/host-session-events.js';

function session() {
  return {
    id: 'session-a',
    sessionId: 'session-a',
    title: 'Stream',
    status: 'idle',
    statusLabel: '空闲',
    updatedAt: '2026-09-10T00:00:00.000Z',
    messages: [{ id: 'user-1', role: 'user', phase: 'answer', content: '开始', turnId: null }],
    technicalItems: [],
    pendingRequests: [],
    plan: [],
    runtimeBinding: null,
  };
}

test('Minimal Host applies streamed deltas directly to one selected Session and its summary', () => {
  let detail = session();
  const started = parseMinimalHostSessionEvent({
    eventId: 1,
    data: JSON.stringify({
      type: 'turn_started',
      sessionId: 'session-a',
      runtimeTurnId: 'turn-a',
      createdAt: 1_800_000_000_000,
      payload: {},
    }),
  });
  detail = applyMinimalHostSessionEvent(detail, started).session;
  detail = applyMinimalHostSessionEvent(detail, {
    eventId: 2,
    type: 'item_delta',
    sessionId: 'session-a',
    runtimeTurnId: 'turn-a',
    providerEvent: 'item/agentMessage/delta',
    createdAt: 1_800_000_000_001,
    payload: { itemId: 'answer-a', delta: '流' },
  }).session;
  detail = applyMinimalHostSessionEvent(detail, {
    eventId: 3,
    type: 'item_delta',
    sessionId: 'session-a',
    runtimeTurnId: 'turn-a',
    providerEvent: 'item/agentMessage/delta',
    createdAt: 1_800_000_000_002,
    payload: { itemId: 'answer-a', delta: '畅' },
  }).session;

  assert.equal(detail.status, 'running');
  assert.equal(detail.messages[0].turnId, 'turn-a');
  assert.equal(detail.messages[1].content, '流畅');
  const summaries = patchMinimalHostSessionSummary([
    { id: 'session-a', title: 'Stream', status: 'idle' },
    { id: 'session-b', title: 'Untouched', status: 'idle' },
  ], detail);
  assert.equal(summaries[0].status, 'running');
  assert.equal(summaries[1].status, 'idle');
});

test('Minimal Host publishes projected result media and handles requests without a snapshot refetch', () => {
  let detail = session();
  detail.messages.push({
    id: 'answer-a', role: 'assistant', phase: 'answer', content: '完成', turnId: 'turn-a', turnStatus: 'inProgress',
  });
  detail = applyMinimalHostSessionEvent(detail, {
    eventId: 4,
    type: 'item_completed',
    sessionId: 'session-a',
    runtimeTurnId: 'turn-a',
    createdAt: 1_800_000_000_003,
    payload: { item: {
      id: 'image-a',
      type: 'imageGeneration',
      status: 'completed',
      publishedMedia: {
        type: 'resourceImage', resourceId: 'res-a', name: 'a.png', mimeType: 'image/png', size: 12,
      },
    } },
  }).session;
  assert.equal(detail.messages.at(-1).media[0].resourceId, 'res-a');

  detail = applyMinimalHostSessionEvent(detail, {
    eventId: 5,
    type: 'request_opened',
    sessionId: 'session-a',
    runtimeTurnId: 'turn-a',
    createdAt: 1_800_000_000_004,
    payload: { requestToken: 'request-a', requestType: 'command_approval', request: { command: 'ls' } },
  }).session;
  assert.equal(detail.status, 'waiting');
  assert.equal(detail.pendingRequests[0].token, 'request-a');
  detail = applyMinimalHostSessionEvent(detail, {
    eventId: 6,
    type: 'request_resolved',
    sessionId: 'session-a',
    createdAt: 1_800_000_000_005,
    payload: { requestToken: 'request-a' },
  }).session;
  assert.equal(detail.pendingRequests.length, 0);
});

test('Minimal Host requests only a target snapshot when replay has a gap', () => {
  const current = session();
  const result = applyMinimalHostSessionEvent(current, {
    eventId: 99,
    type: 'replay_gap',
    sessionId: 'session-a',
    payload: { snapshotRequired: true },
  });
  assert.equal(result.snapshotRequired, true);
  assert.equal(result.session, current);
  assert.equal(parseMinimalHostSessionEvent({ data: '{bad json' }), null);
});

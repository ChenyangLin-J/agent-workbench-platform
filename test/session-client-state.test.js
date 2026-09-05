import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyAgentMessageDelta,
  classifySessionEvent,
  createSessionEventController,
  mergeSessionItems,
  mergeSessionTurns,
  reconcileSessionSnapshot,
  sessionEventActivityKind,
  sessionEventThreadId,
  sessionEventTurnId,
  upsertSessionItem,
} from '../src/session-client.js';

test('Session reconciliation collapses optimistic and authoritative copies of one message', () => {
  const currentSession = {
    activeTurnId: 'turn-1',
    thread: {
      id: 'session-1',
      turns: [{
        id: 'turn-1',
        status: 'inProgress',
        items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Continue' }] }],
      }],
    },
    items: [{
      id: 'local-1',
      turnId: 'turn-1',
      type: 'userMessage',
      content: [{ type: 'text', text: 'Continue' }],
    }],
  };
  const snapshot = reconcileSessionSnapshot({
    currentSession,
    thread: {
      id: 'session-1',
      turns: [{
        id: 'turn-1',
        status: 'inProgress',
        items: [{
          id: 'item-1',
          type: 'userMessage',
          content: [{ type: 'text', text: 'Continue' }],
        }],
      }],
    },
  });

  assert.equal(snapshot.activeTurnId, 'turn-1');
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].id, 'item-1');
});

test('Session reconciliation retains a known active Turn until an authoritative terminal status arrives', () => {
  const running = reconcileSessionSnapshot({
    currentSession: {
      activeTurnId: 'turn-1',
      thread: { id: 'session-1', turns: [{ id: 'turn-1', status: 'inProgress', items: [] }] },
      items: [],
    },
    thread: { id: 'session-1', turns: [{ id: 'turn-1', status: 'unknown', items: [] }] },
  });
  const completed = reconcileSessionSnapshot({
    currentSession: {
      activeTurnId: 'turn-1',
      thread: { id: 'session-1', turns: [{ id: 'turn-1', status: 'inProgress', items: [] }] },
      items: [],
    },
    thread: { id: 'session-1', turns: [{ id: 'turn-1', status: 'completed', items: [] }] },
  });

  assert.equal(running.activeTurnId, 'turn-1');
  assert.equal(completed.activeTurnId, null);
});

test('Session Turn merging refreshes recent Turns without moving them ahead of loaded history', () => {
  const turns = mergeSessionTurns(
    [
      { id: 'turn-1', status: 'completed', items: [{ id: 'user-1', type: 'userMessage', text: 'Earlier' }] },
      { id: 'turn-2', status: 'inProgress', items: [{ id: 'answer-2', type: 'agentMessage', text: 'Old' }] },
    ],
    [{
      id: 'turn-2',
      status: 'completed',
      items: [
        { id: 'commentary-2', type: 'agentMessage', phase: 'commentary', text: 'Working' },
        { id: 'answer-2', type: 'agentMessage', text: 'New' },
      ],
    }],
  );

  assert.deepEqual(turns.map((turn) => turn.id), ['turn-1', 'turn-2']);
  assert.deepEqual(turns[1].items.map((item) => item.id), ['commentary-2', 'answer-2']);
  assert.equal(turns[1].items[1].text, 'New');
});

test('Session item upsert replaces an id-less live copy with its canonical item', () => {
  const session = {
    items: [{ turnId: 'turn-1', type: 'userMessage', content: [{ type: 'text', text: 'Continue' }] }],
  };
  upsertSessionItem(session, {
    id: 'item-1',
    type: 'userMessage',
    content: [{ type: 'text', text: 'Continue' }],
  }, 'turn-1');
  assert.equal(session.items.length, 1);
  assert.equal(session.items[0].id, 'item-1');
});

test('Agent message deltas create commentary and preserve one live item', () => {
  const session = { items: [] };
  applyAgentMessageDelta(session, { itemId: 'agent-1', turnId: 'turn-1', delta: 'Working ' });
  applyAgentMessageDelta(session, { itemId: 'agent-1', turnId: 'turn-1', delta: 'now' });
  assert.deepEqual(session.items, [{
    id: 'agent-1',
    type: 'agentMessage',
    phase: 'commentary',
    text: 'Working now',
    turnId: 'turn-1',
  }]);
});

test('Session item merging keeps an authoritative id for a semantic live duplicate', () => {
  const canonical = {
    id: 'item-1',
    turnId: 'turn-1',
    type: 'userMessage',
    content: [{ type: 'text', text: 'Continue' }],
  };
  const live = {
    turnId: 'turn-1',
    type: 'userMessage',
    content: [{ type: 'text', text: 'Continue' }],
  };
  assert.deepEqual(mergeSessionItems([canonical], [live]), [canonical]);
});

test('Session event classification is product-neutral', () => {
  assert.equal(sessionEventThreadId({ params: { turn: { threadId: 'session-1' } } }), 'session-1');
  assert.equal(sessionEventTurnId({ params: { turn: { id: 'turn-1' } } }), 'turn-1');
  assert.equal(sessionEventActivityKind({ params: { item: { type: 'contextCompaction' } } }), 'contextCompaction');
  assert.deepEqual(classifySessionEvent({ threadId: 'session-1' }, {
    sessionThreadId: 'session-1',
    sideChatIds: ['side-1'],
  }), { kind: 'session', threadId: 'session-1' });
  assert.deepEqual(classifySessionEvent({ threadId: 'side-1' }, {
    sessionThreadId: 'session-1',
    sideChatIds: ['side-1'],
  }), { kind: 'side-chat', threadId: 'side-1' });
  assert.deepEqual(classifySessionEvent({ threadId: 'session-2' }, {
    sessionThreadId: 'session-1',
    sideChatIds: ['side-1'],
  }), { kind: 'activity', threadId: 'session-2' });
});

test('Context compaction is running activity but does not create a user result', () => {
  const context = eventHarness();
  context.controller.handleSessionEvent(context.session, {
    type: 'notification', method: 'turn/started', resultBearing: false,
    activityKind: 'contextCompaction', params: { threadId: 'session-1', turn: { id: 'turn-context' } },
  });
  assert.equal(context.session.activeTurnId, 'turn-context');
  assert.equal(context.session.activeActivityKind, 'contextCompaction');
  assert.equal(context.state.sessionRuntimeStatuses['session-1'], 'running');
  assert.equal(context.calls.some(([name]) => name === 'read'), false);

  context.controller.handleSessionEvent(context.session, {
    type: 'notification', method: 'item/started', resultBearing: false,
    activityKind: 'contextCompaction',
    params: { threadId: 'session-1', turnId: 'turn-context', item: { id: 'compact-1', type: 'contextCompaction' } },
  });
  assert.equal(context.session.items[0].status, 'inProgress');

  context.controller.handleSessionEvent(context.session, {
    type: 'notification', method: 'item/completed', resultBearing: false,
    activityKind: 'contextCompaction',
    params: { threadId: 'session-1', turnId: 'turn-context', item: { id: 'compact-1', type: 'contextCompaction' } },
  });
  context.controller.handleSessionEvent(context.session, {
    type: 'notification', method: 'turn/completed', resultBearing: false,
    activityKind: 'contextCompaction', params: { threadId: 'session-1', turn: { id: 'turn-context' } },
  });
  assert.equal(context.session.activeTurnId, null);
  assert.equal(context.session.items[0].status, 'completed');
  assert.equal(context.state.sessionRuntimeStatuses['session-1'], 'idle');
  assert.equal(context.calls.some(([name]) => name === 'unread'), false);
  assert.equal(context.state.sessionList[0].updatedAt, 1);
});

test('A late completion cannot clear a newer active Turn', () => {
  const context = eventHarness();
  context.controller.handleSessionEvent(context.session, {
    type: 'notification', method: 'turn/started', params: { threadId: 'session-1', turn: { id: 'turn-new' } },
  });
  context.controller.handleSessionEvent(context.session, {
    type: 'notification', method: 'turn/completed', params: { threadId: 'session-1', turn: { id: 'turn-old' } },
  });
  assert.equal(context.session.activeTurnId, 'turn-new');
  assert.equal(context.state.sessionRuntimeStatuses['session-1'], 'running');
  assert.equal(context.calls.some(([name]) => name === 'unread'), false);
  context.controller.stopActiveSessionSnapshotReconciliation(context.session);
});

test('Inline context compaction returns to ordinary running without completing the Turn', () => {
  const context = eventHarness();
  context.controller.handleSessionEvent(context.session, {
    type: 'notification', method: 'turn/started', params: { threadId: 'session-1', turn: { id: 'turn-user' } },
  });
  context.controller.handleSessionEvent(context.session, {
    type: 'notification', method: 'item/started', activityKind: 'contextCompaction',
    params: { threadId: 'session-1', turnId: 'turn-user', item: { id: 'compact-inline', type: 'contextCompaction' } },
  });
  assert.equal(context.session.activeActivityKind, 'contextCompaction');
  context.controller.handleSessionEvent(context.session, {
    type: 'notification', method: 'item/completed', activityKind: 'contextCompaction',
    params: { threadId: 'session-1', turnId: 'turn-user', item: { id: 'compact-inline', type: 'contextCompaction' } },
  });
  assert.equal(context.session.activeTurnId, 'turn-user');
  assert.equal(context.session.activeActivityKind, null);
  assert.equal(context.state.sessionRuntimeStatuses['session-1'], 'running');
  context.controller.stopActiveSessionSnapshotReconciliation(context.session);
});

test('Item activity restores a missed Turn start and keeps reconciliation alive', () => {
  const context = eventHarness();
  context.controller.handleSessionEvent(context.session, {
    type: 'notification', method: 'item/started',
    params: { threadId: 'session-1', turnId: 'turn-live', item: { id: 'tool-1', type: 'commandExecution' } },
  });
  assert.equal(context.session.activeTurnId, 'turn-live');
  assert.equal(context.state.sessionRuntimeTurnIds['session-1'], 'turn-live');
  assert.equal(context.state.sessionRuntimeStatuses['session-1'], 'running');
  assert.ok(context.session.snapshotReconcileTimer);
  context.controller.stopActiveSessionSnapshotReconciliation(context.session);
});

for (const fixture of [
  { label: 'project-free', context: {} },
  { label: 'project-scoped', context: { contextId: 'project-1', contextLabel: 'Project One' } },
]) {
  test(`Session events preserve ${fixture.label} host context while applying shared transitions`, async () => {
    const context = eventHarness(fixture.context);
    context.controller.handleSessionEvent(context.session, {
      type: 'server_request',
      request: { token: 'approval-1' },
    });
    context.controller.handleSessionEvent(context.session, {
      type: 'notification',
      method: 'turn/started',
      params: { turnId: 'turn-1' },
    });
    context.controller.handleSessionEvent(context.session, {
      type: 'notification',
      method: 'item/agentMessage/delta',
      params: { itemId: 'agent-1', turnId: 'turn-1', delta: 'Working' },
    });

    assert.equal(context.session.contextId, fixture.context.contextId);
    assert.equal(context.session.activeTurnId, 'turn-1');
    assert.equal(context.state.sessionRuntimeStatuses['session-1'], 'running');
    assert.equal(context.session.pendingRequests.length, 1);
    assert.equal(context.session.items[0].text, 'Working');
    context.controller.stopActiveSessionSnapshotReconciliation(context.session);
  });
}

test('Session event controller owns queue transitions and consumer-owned failure presentation', () => {
  const context = eventHarness();
  context.controller.handleSessionEvent(context.session, {
    type: 'turn_queued',
    queuedTurn: { id: 'queued-1', prompt: 'Next' },
  });
  context.controller.handleSessionEvent(context.session, {
    type: 'turn_queue_updated',
    queuedTurn: { id: 'queued-1', prompt: 'Updated' },
  });
  context.controller.handleSessionEvent(context.session, {
    type: 'queue_failed',
    queuedTurn: { id: 'queued-1', retrying: true },
  });
  context.controller.handleSessionEvent(context.session, {
    type: 'turn_queue_removed',
    queuedTurnId: 'queued-1',
  });

  assert.deepEqual(context.session.queuedTurns, []);
  assert.equal(context.calls.filter(([name]) => name === 'queue-failure').length, 1);
});

test('Session event controller keeps one replaceable connection and recovers after reconnect', async () => {
  const context = eventHarness();
  const first = context.controller.connectSessionActivityEvents();
  first.onopen();
  first.onerror();
  const second = context.controller.connectSessionActivityEvents();
  second.onopen();
  await context.state.sessionActivityRecovery;

  assert.equal(first.closed, true);
  assert.equal(context.state.sessionActivityConnected, true);
  assert.equal(context.session.connectionError, false);
  assert.ok(context.calls.some(([name]) => name === 'recover-external'));
  assert.ok(context.calls.some(([name]) => name === 'refresh-session'));
  assert.ok(context.calls.some(([name]) => name === 'recover-extensions'));
  context.controller.disconnectSessionActivityEvents();
  assert.equal(second.closed, true);
});

test('Session event controller delegates product events without requiring product vocabulary', () => {
  const context = eventHarness();
  context.controller.routeSessionEvent({ type: 'consumer', method: 'project/updated' });
  assert.deepEqual(context.calls.filter(([name]) => name === 'external'), [
    ['external', 'project/updated'],
  ]);
});

function eventHarness(sessionContext = {}) {
  const calls = [];
  const session = {
    threadId: 'session-1',
    isDraft: false,
    isArchived: false,
    connectionError: false,
    pendingRequests: [],
    queuedTurns: [],
    activeTurnId: null,
    snapshotController: null,
    snapshotReconcileTimer: null,
    sideChats: [],
    items: [],
    ...sessionContext,
  };
  const state = {
    session,
    sessionList: [{ id: 'session-1', updatedAt: 1 }],
    sessionRuntimeStatuses: {},
    sessionCompletedAt: {},
    sessionActivityEventSource: null,
    sessionActivityConnected: false,
    sessionActivityOpened: false,
    sessionActivityRecovery: null,
  };
  const eventSources = [];
  const controller = createSessionEventController({
    state,
    reconcileMs: 10_000,
    renderSessionWorkspace: () => calls.push(['render-workspace']),
    renderSessionsPage: () => calls.push(['render-sessions']),
    markSessionResultRead: (sessionId) => calls.push(['read', sessionId]),
    markSessionResultUnread: (sessionId) => calls.push(['unread', sessionId]),
    refreshSessionSnapshot: async () => calls.push(['refresh-session']),
    refreshSessions: async () => calls.push(['refresh-sessions']),
    recoverExternalState: async () => calls.push(['recover-external']),
    recoverSessionExtensions: async () => calls.push(['recover-extensions']),
    handleSessionItem: ({ item }) => calls.push(['session-item', item?.id]),
    handleQueueFailure: () => calls.push(['queue-failure']),
    handleExternalEvent: (event) => {
      if (event.type !== 'consumer') return false;
      calls.push(['external', event.method]);
      return true;
    },
    createEventSource: (url) => {
      const source = {
        url,
        closed: false,
        onmessage: null,
        onopen: null,
        onerror: null,
        close() { this.closed = true; },
      };
      eventSources.push(source);
      return source;
    },
  });
  return { calls, controller, eventSources, session, state };
}

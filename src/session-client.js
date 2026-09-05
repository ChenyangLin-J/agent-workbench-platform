import { sessionItemAttachmentPresentation } from './attachments.js';

const DEFAULT_MAX_PENDING_OPERATIONS = 32;
export const TERMINAL_SESSION_TURN_STATUSES = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'canceled',
  'interrupted',
]);

const TERMINAL_SESSION_TURN_STATUS_SET = new Set(TERMINAL_SESSION_TURN_STATUSES);
let fallbackOperationSequence = 0;

export class SessionClientOperationController {
  constructor({
    createId = defaultOperationId,
    maximumPending = DEFAULT_MAX_PENDING_OPERATIONS,
  } = {}) {
    if (typeof createId !== 'function') throw new TypeError('createId must be a function.');
    if (!Number.isSafeInteger(maximumPending) || maximumPending < 1) {
      throw new TypeError('maximumPending must be a positive integer.');
    }
    this.createId = createId;
    this.maximumPending = maximumPending;
    this.operations = new Map();
  }

  begin({ scope, targetId = '', payload = {} } = {}) {
    const normalizedScope = operationKeyPart(scope, 'Operation scope');
    const normalizedTargetId = String(targetId || 'new');
    const normalizedPayload = canonicalOperationValue(payload);
    const fingerprint = JSON.stringify(normalizedPayload);
    if (typeof fingerprint !== 'string') throw new TypeError('Operation payload must be JSON-safe.');
    const lookupKey = JSON.stringify([normalizedScope, normalizedTargetId, fingerprint]);
    const existing = this.operations.get(lookupKey);
    if (existing) return existing;

    const idempotencyKey = `${normalizedScope}:${operationKeyPart(this.createId(), 'Operation id')}`;
    if (idempotencyKey.length > 200) throw new TypeError('The generated idempotency key is too long.');
    const operation = Object.freeze({
      scope: normalizedScope,
      targetId: normalizedTargetId,
      fingerprint,
      idempotencyKey,
      payload: normalizedPayload,
      lookupKey,
    });
    this.operations.set(lookupKey, operation);
    this.#prune();
    return operation;
  }

  complete(operation) {
    return this.#remove(operation);
  }

  discard(operation) {
    return this.#remove(operation);
  }

  clearTarget(targetId) {
    const normalizedTargetId = String(targetId || 'new');
    for (const [lookupKey, operation] of this.operations) {
      if (operation.targetId === normalizedTargetId) this.operations.delete(lookupKey);
    }
  }

  #remove(operation) {
    if (!operation?.lookupKey || this.operations.get(operation.lookupKey) !== operation) return false;
    this.operations.delete(operation.lookupKey);
    return true;
  }

  #prune() {
    while (this.operations.size > this.maximumPending) {
      this.operations.delete(this.operations.keys().next().value);
    }
  }
}

export function sessionOperationFingerprint(payload) {
  const fingerprint = JSON.stringify(canonicalOperationValue(payload));
  if (typeof fingerprint !== 'string') throw new TypeError('Operation payload must be JSON-safe.');
  return fingerprint;
}

export function isTerminalSessionTurnStatus(status) {
  return TERMINAL_SESSION_TURN_STATUS_SET.has(status);
}

export function sessionItemText(item) {
  return sessionItemAttachmentPresentation(item).text;
}

export function sessionItemAttachmentMarkers(item) {
  return sessionItemAttachmentPresentation(item).attachments.map((attachment) => ({
    ...attachment,
    ...(attachment.mimeType === 'inode/directory'
      ? { kind: 'directory', sourceKind: 'directory' }
      : {}),
  }));
}

export function mergeSessionItems(baseItems = [], overlayItems = []) {
  const merged = [];
  const idIndexes = new Map();
  const semanticIndexes = new Map();
  for (const item of [...baseItems, ...overlayItems]) {
    const semanticKey = ['userMessage', 'agentMessage'].includes(item.type) && item.turnId
      ? `${item.turnId}:${item.type}:${sessionItemText(item)}`
      : null;
    const idIndex = item.id ? idIndexes.get(item.id) : undefined;
    const semanticIndex = semanticKey ? semanticIndexes.get(semanticKey) : undefined;
    const index = idIndex ?? semanticIndex;
    if (index !== undefined) {
      const existing = merged[index];
      merged[index] = { ...existing, ...item, id: existing.id || item.id };
      if (merged[index].id) idIndexes.set(merged[index].id, index);
      if (semanticKey) semanticIndexes.set(semanticKey, index);
      continue;
    }
    const nextIndex = merged.length;
    merged.push(item);
    if (item.id) idIndexes.set(item.id, nextIndex);
    if (semanticKey) semanticIndexes.set(semanticKey, nextIndex);
  }
  return merged;
}

export function mergeSessionTurns(baseTurns = [], overlayTurns = []) {
  const merged = baseTurns.map((turn) => ({ ...turn, items: [...(turn.items || [])] }));
  const indexes = new Map(merged.map((turn, index) => [turn.id, index]));
  for (const turn of overlayTurns) {
    const index = indexes.get(turn.id);
    if (index === undefined) {
      indexes.set(turn.id, merged.length);
      merged.push({ ...turn, items: [...(turn.items || [])] });
      continue;
    }
    const existing = merged[index];
    const incomingItems = (turn.items || []).map((item) => ({ ...item, turnId: turn.id }));
    const existingItems = (existing.items || []).map((item) => ({ ...item, turnId: turn.id }));
    const incomingById = new Map(incomingItems.filter((item) => item.id).map((item) => [item.id, item]));
    const items = mergeSessionItems(incomingItems, existingItems).map((item) => {
      const incoming = item.id ? incomingById.get(item.id) : null;
      const { turnId: _turnId, ...cleanItem } = incoming ? { ...item, ...incoming } : item;
      return cleanItem;
    });
    merged[index] = { ...existing, ...turn, items };
  }
  return merged;
}

export function normalizeSessionSnapshot(thread, pendingRequests = [], queuedTurns = []) {
  const items = [];
  let activeTurnId = null;
  for (const turn of thread?.turns || []) {
    if (turn.status === 'inProgress') activeTurnId = turn.id;
    for (const item of turn.items || []) items.push({ ...item, turnId: turn.id });
  }
  return { thread, items, activeTurnId, pendingRequests, queuedTurns, plan: null };
}

export function reconcileSessionSnapshot({
  currentSession,
  thread,
  pendingRequests = [],
  queuedTurns = [],
} = {}) {
  if (!currentSession || !thread) throw new TypeError('Current Session and authoritative thread are required.');
  const knownActiveTurnId = currentSession.activeTurnId;
  const mergedThread = {
    ...(currentSession.thread || {}),
    ...thread,
    turns: mergeSessionTurns(currentSession.thread?.turns || [], thread.turns || []),
  };
  const snapshot = normalizeSessionSnapshot(mergedThread, pendingRequests, queuedTurns);
  const knownActiveTurn = mergedThread.turns?.find((turn) => turn.id === knownActiveTurnId);
  if (!snapshot.activeTurnId
    && knownActiveTurnId
    && !isTerminalSessionTurnStatus(knownActiveTurn?.status)) {
    snapshot.activeTurnId = knownActiveTurnId;
  }
  snapshot.items = mergeSessionItems(snapshot.items, currentSession.items || []);
  return snapshot;
}

export function upsertSessionItem(session, item, turnId) {
  if (!session || !item) return;
  if (!Array.isArray(session.items)) session.items = [];
  const next = { ...item, turnId: turnId || item.turnId };
  const nextText = ['userMessage', 'agentMessage'].includes(next.type) ? sessionItemText(next) : null;
  const idIndex = next.id ? session.items.findIndex((current) => current.id === next.id) : -1;
  const semanticIndex = nextText ? session.items.findIndex((current) => current.turnId === next.turnId
    && current.type === next.type
    && sessionItemText(current) === nextText) : -1;
  if (idIndex >= 0 && semanticIndex >= 0 && idIndex !== semanticIndex) {
    session.items[semanticIndex] = {
      ...session.items[semanticIndex],
      ...session.items[idIndex],
      ...next,
      id: next.id || session.items[idIndex].id || session.items[semanticIndex].id,
    };
    session.items.splice(idIndex, 1);
    return;
  }
  const index = idIndex >= 0 ? idIndex : semanticIndex;
  if (index >= 0) {
    session.items[index] = { ...session.items[index], ...next, id: next.id || session.items[index].id };
  } else {
    session.items.push(next);
  }
}

export function applyAgentMessageDelta(session, params = {}) {
  if (!session || !params.itemId) return null;
  if (!Array.isArray(session.items)) session.items = [];
  let item = session.items.find((current) => current.id === params.itemId);
  if (!item) {
    item = {
      id: params.itemId,
      type: 'agentMessage',
      phase: ['answer', 'final_answer'].includes(params.phase) ? 'final_answer' : 'commentary',
      text: '',
      turnId: params.turnId,
    };
    session.items.push(item);
  } else if (!item.turnId && params.turnId) {
    item.turnId = params.turnId;
  }
  item.text = `${item.text || ''}${params.delta || ''}`;
  return item;
}

export function sessionEventThreadId(event) {
  return event?.threadId
    ?? event?.params?.threadId
    ?? event?.params?.thread?.id
    ?? event?.params?.turn?.threadId
    ?? null;
}

export function classifySessionEvent(event, { sessionThreadId = null, sideChatIds = [] } = {}) {
  const threadId = sessionEventThreadId(event);
  if (!threadId) return { kind: 'ignore', threadId: null };
  if (threadId === sessionThreadId) return { kind: 'session', threadId };
  if (sideChatIds.includes(threadId)) return { kind: 'side-chat', threadId };
  return { kind: 'activity', threadId };
}

export function createSessionEventController({
  state,
  eventUrl = '/api/session-events',
  reconcileMs = 2_500,
  completionRefreshDelayMs = 80,
  renderSessionWorkspace = () => {},
  renderSessionsPage = () => {},
  markSessionResultRead = () => {},
  markSessionResultUnread = () => {},
  refreshSessionSnapshot = async () => {},
  refreshSessions = async () => {},
  recoverExternalState = async () => {},
  recoverSessionExtensions = async () => {},
  handleSideChatEvent = () => {},
  handleExternalEvent = () => false,
  handleSessionItem = () => {},
  handleQueueFailure = () => {},
  createEventSource = defaultEventSource,
  scheduleTask = globalThis.setTimeout?.bind(globalThis),
  cancelTask = globalThis.clearTimeout?.bind(globalThis),
} = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('Session event state is required.');
  if (typeof createEventSource !== 'function') throw new TypeError('createEventSource must be a function.');
  if (typeof scheduleTask !== 'function' || typeof cancelTask !== 'function') {
    throw new TypeError('Session event timers are required.');
  }

  function selectedSession() {
    return state.session || null;
  }

  function syncSelectedSessionRuntimeStatus(session = selectedSession()) {
    if (!session?.threadId || selectedSession() !== session) return;
    state.sessionRuntimeStatuses ||= {};
    state.sessionRuntimeStatuses[session.threadId] = session.connectionError
      ? 'connecting'
      : session.pendingRequests?.length
        ? 'waiting'
        : session.activeTurnId
          ? 'running'
          : 'idle';
  }

  function touchSessionSummary(threadId, updatedAt = Date.now()) {
    const summary = (state.sessionList || []).find((session) => session.id === threadId);
    if (!summary) return false;
    summary.updatedAt = updatedAt;
    return true;
  }

  function stopActiveSessionSnapshotReconciliation(session = selectedSession()) {
    if (!session?.snapshotReconcileTimer) return;
    cancelTask(session.snapshotReconcileTimer);
    session.snapshotReconcileTimer = null;
  }

  function scheduleActiveSessionSnapshotReconciliation(session = selectedSession()) {
    stopActiveSessionSnapshotReconciliation(session);
    if (!session
      || selectedSession() !== session
      || session.isDraft
      || session.isArchived
      || !session.activeTurnId) return;
    session.snapshotReconcileTimer = scheduleTask(async () => {
      session.snapshotReconcileTimer = null;
      if (selectedSession() !== session
        || session.isDraft
        || session.isArchived
        || !session.activeTurnId) return;
      if (!session.snapshotController) await refreshSessionSnapshot(session).catch(() => {});
      scheduleActiveSessionSnapshotReconciliation(session);
    }, reconcileMs);
  }

  function handleSessionEvent(session, event) {
    if (!session || selectedSession() !== session) return;
    state.sessionRuntimeStatuses ||= {};
    state.sessionCompletedAt ||= {};
    if (event.type === 'server_request') {
      session.pendingRequests ||= [];
      const index = event.request?.token
        ? session.pendingRequests.findIndex((request) => request.token === event.request.token)
        : -1;
      if (index >= 0) session.pendingRequests[index] = event.request;
      else if (event.request) session.pendingRequests.push(event.request);
      state.sessionRuntimeStatuses[session.threadId] = 'waiting';
    } else if (event.type === 'server_request_resolved') {
      session.pendingRequests = (session.pendingRequests || [])
        .filter((request) => request.token !== event.token);
      syncSelectedSessionRuntimeStatus(session);
    } else if (['turn_queued', 'turn_queue_updated', 'queue_failed'].includes(event.type)) {
      session.queuedTurns ||= [];
      if (event.queuedTurn) {
        const index = session.queuedTurns.findIndex((item) => item.id === event.queuedTurn.id);
        if (index >= 0) session.queuedTurns[index] = { ...session.queuedTurns[index], ...event.queuedTurn };
        else session.queuedTurns.push(event.queuedTurn);
      }
      if (event.type === 'queue_failed') handleQueueFailure(event);
    } else if (['turn_dequeued', 'turn_queue_removed'].includes(event.type)) {
      session.queuedTurns = (session.queuedTurns || [])
        .filter((item) => item.id !== event.queuedTurnId);
    } else if (event.type === 'notification') {
      const { method, params = {} } = event;
      if (['turn/started', 'turn/completed'].includes(method)) touchSessionSummary(session.threadId);
      if (method === 'turn/started') {
        markSessionResultRead(session.threadId);
        session.activeTurnId = params.turn?.id || params.turnId || session.activeTurnId;
        state.sessionRuntimeStatuses[session.threadId] = 'running';
        scheduleActiveSessionSnapshotReconciliation(session);
      }
      if (method === 'turn/completed') {
        stopActiveSessionSnapshotReconciliation(session);
        session.activeTurnId = null;
        state.sessionRuntimeStatuses[session.threadId] = 'idle';
        state.sessionCompletedAt[session.threadId] = Date.now();
        markSessionResultUnread(session.threadId);
        scheduleTask(async () => {
          await refreshSessionSnapshot(session).catch(() => {});
          await refreshSessions({ force: true }).catch(() => {});
        }, completionRefreshDelayMs);
      }
      if (method === 'turn/plan/updated') session.plan = params;
      if (['item/started', 'item/completed'].includes(method)) {
        upsertSessionItem(session, params.item, params.turnId);
        handleSessionItem({ event, item: params.item, session });
      }
      if (method === 'item/agentMessage/delta') applyAgentMessageDelta(session, params);
    }
    renderSessionWorkspace();
  }

  function handleSessionActivityEvent(event) {
    if (event.type !== 'notification') return;
    const threadId = sessionEventThreadId(event);
    if (!threadId) return;
    state.sessionRuntimeStatuses ||= {};
    state.sessionCompletedAt ||= {};
    if (['turn/started', 'turn/completed'].includes(event.method)) touchSessionSummary(threadId);
    if (event.method === 'turn/started') state.sessionRuntimeStatuses[threadId] = 'running';
    if (event.method === 'turn/completed') {
      state.sessionRuntimeStatuses[threadId] = 'idle';
      state.sessionCompletedAt[threadId] = Date.now();
      markSessionResultUnread(threadId);
      scheduleTask(() => refreshSessions({ force: true }).catch(() => {}), completionRefreshDelayMs);
    }
    renderSessionsPage();
  }

  function routeSessionEvent(event) {
    if (handleExternalEvent(event) === true) return;
    const session = selectedSession();
    const target = classifySessionEvent(event, {
      sessionThreadId: session?.isDraft ? null : session?.threadId,
      sideChatIds: session?.sideChats?.map((item) => item.id) ?? [],
    });
    if (target.kind === 'session') {
      handleSessionEvent(session, event);
      return;
    }
    if (target.kind === 'side-chat') {
      handleSideChatEvent(session, session.sideChats.find((item) => item.id === target.threadId), event);
      return;
    }
    if (target.kind === 'activity') handleSessionActivityEvent(event);
  }

  async function recoverSessionEventState() {
    if (state.sessionActivityRecovery) return state.sessionActivityRecovery;
    const session = selectedSession();
    state.sessionActivityRecovery = (async () => {
      await Promise.all([
        () => recoverExternalState(),
        () => refreshSessions({ force: true }),
      ].map((operation) => Promise.resolve().then(operation).catch(() => {})));
      if (!session
        || selectedSession() !== session
        || session.isDraft
        || session.isArchived) return;
      await refreshSessionSnapshot(session).catch(() => {});
      if (selectedSession() !== session) return;
      await recoverSessionExtensions(session).catch(() => {});
    })().finally(() => {
      state.sessionActivityRecovery = null;
    });
    return state.sessionActivityRecovery;
  }

  function connectSessionActivityEvents() {
    state.sessionActivityEventSource?.close();
    const source = createEventSource(eventUrl);
    state.sessionActivityEventSource = source;
    source.onmessage = ({ data }) => {
      try {
        routeSessionEvent(JSON.parse(data));
      } catch {
        // Ignore malformed events. The authoritative recovery path will reconcile state.
      }
    };
    source.onopen = () => {
      const session = selectedSession();
      const shouldRecover = state.sessionActivityOpened || session?.connectionError;
      state.sessionActivityConnected = true;
      state.sessionActivityOpened = true;
      if (session && !session.isDraft && !session.isArchived) {
        session.connectionError = false;
        syncSelectedSessionRuntimeStatus(session);
        renderSessionWorkspace();
      }
      if (shouldRecover) recoverSessionEventState().catch(() => {});
    };
    source.onerror = () => {
      const session = selectedSession();
      state.sessionActivityConnected = false;
      if (session && !session.isDraft && !session.isArchived) {
        session.connectionError = true;
        syncSelectedSessionRuntimeStatus(session);
        renderSessionWorkspace();
      }
    };
    return source;
  }

  function disconnectSessionActivityEvents() {
    state.sessionActivityEventSource?.close();
    state.sessionActivityEventSource = null;
    state.sessionActivityConnected = false;
    stopActiveSessionSnapshotReconciliation();
  }

  return Object.freeze({
    connectSessionActivityEvents,
    disconnectSessionActivityEvents,
    handleSessionActivityEvent,
    handleSessionEvent,
    recoverSessionEventState,
    routeSessionEvent,
    scheduleActiveSessionSnapshotReconciliation,
    stopActiveSessionSnapshotReconciliation,
    syncSelectedSessionRuntimeStatus,
    touchSessionSummary,
  });
}

function canonicalOperationValue(value) {
  if (Array.isArray(value)) return value.map(canonicalOperationValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalOperationValue(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function operationKeyPart(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new TypeError(`${label} must use only letters, numbers, dot, underscore, colon, or hyphen.`);
  }
  return normalized;
}

function defaultOperationId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${(++fallbackOperationSequence).toString(36)}`;
}

function defaultEventSource(url) {
  if (typeof globalThis.EventSource !== 'function') {
    throw new TypeError('EventSource is unavailable; provide createEventSource.');
  }
  return new globalThis.EventSource(url);
}

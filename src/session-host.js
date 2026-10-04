import { SessionClientOperationController, mergeSessionItems, mergeSessionTurns } from './session-client.js';

/** Product-neutral Session orchestration. Transport, authorization and storage stay in the Host. */
export function createSessionHostController({ adapter, initialSessionId = null, capabilities = {}, operations = new SessionClientOperationController() } = {}) {
  if (!adapter || typeof adapter.listSessions !== 'function' || typeof adapter.readSession !== 'function') {
    throw new TypeError('A Session Host adapter must provide listSessions and readSession.');
  }
  let state = { sessions: [], session: null, selectedId: initialSessionId, connection: 'idle', error: '', nextCursor: null, capabilities, loaded: false };
  const listeners = new Set();
  const pendingOperations = new Map();
  let selectionGeneration = 0;
  let listGeneration = 0;
  let readGeneration = 0;
  let subscription = null;
  let selectionAbort = null;
  let readAbort = null;
  let disposed = false;
  let recovery = null;
  let eventBuffer = [];

  const publish = (patch) => {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const current = (id, generation) => !disposed && state.selectedId === id && selectionGeneration === generation;
  const fail = (error) => { if (error?.name !== 'AbortError') publish({ error: error?.message || String(error) }); };

  async function refreshSessions(options = {}) {
    const generation = ++listGeneration;
    const page = await adapter.listSessions(options);
    if (disposed || generation !== listGeneration) return null;
    const sessions = Array.isArray(page) ? page : page?.sessions || [];
    publish({ sessions: options.cursor ? mergeSessionSummaries(state.sessions, sessions) : sessions, nextCursor: page?.nextCursor ?? null, listPage: page, loaded: true });
    return sessions;
  }

  async function refreshSession(id = state.selectedId) {
    if (!id || id !== state.selectedId || disposed) return null;
    readAbort?.abort();
    const abort = new AbortController();
    readAbort = abort;
    const generation = ++readGeneration;
    const selectedGeneration = selectionGeneration;
    const snapshot = await adapter.readSession(id, { signal: abort.signal });
    if (!current(id, selectedGeneration) || generation !== readGeneration || abort.signal.aborted) return null;
    if (sessionId(snapshot) && sessionId(snapshot) !== id) throw new Error('Session adapter returned a snapshot for a different Session.');
    const previous = state.session;
    // A slow snapshot must not overwrite events that arrived after the request began.
    if (revisionOf(snapshot) != null && revisionOf(previous) != null && revisionOf(snapshot) < revisionOf(previous)) return previous;
    const next = previous && sessionId(previous) === id
      ? (adapter.mergeSnapshot || mergeSessionHostSnapshot)(previous, snapshot)
      : snapshot;
    publish({ session: next, error: '' });
    return next;
  }

  function receive(event, id, generation) {
    if (!current(id, generation) || (event?.sessionId && String(event.sessionId) !== id)) return false;
    if (event?.snapshotRequired || event?.type === 'replay_gap' || event?.payload?.snapshotRequired) {
      void recover(id, generation).catch(fail);
      return false;
    }
    if (recovery) { eventBuffer.push(event); return true; }
    const revision = revisionOf(event);
    const knownRevision = revisionOf(state.session);
    if (revision != null && knownRevision != null && revision <= knownRevision) return false;
    if (typeof adapter.applyEvent !== 'function') { void recover(id, generation).catch(fail); return false; }
    const applied = adapter.applyEvent(state.session, event);
    if (applied?.snapshotRequired) { void recover(id, generation).catch(fail); return false; }
    const next = applied;
    if (!next || (sessionId(next) && sessionId(next) !== id)) return false;
    publish({ session: revision == null ? next : { ...next, revision }, error: '' });
    if (adapter.patchSummary) publish({ sessions: adapter.patchSummary(state.sessions, state.session) });
    return true;
  }

  async function recover(id, generation) {
    if (!current(id, generation)) return null;
    if (recovery) return recovery;
    publish({ connection: 'recovering' });
    const task = refreshSession(id);
    recovery = task;
    try {
      const snapshot = await task;
      if (!current(id, generation)) return null;
      recovery = null;
      const buffered = eventBuffer;
      eventBuffer = [];
      for (const event of buffered) receive(event, id, generation);
      publish({ connection: 'connected' });
      return snapshot;
    } finally {
      if (recovery === task) recovery = null;
    }
  }

  function releaseSelection() {
    selectionGeneration++;
    selectionAbort?.abort();
    readAbort?.abort();
    subscription?.();
    subscription = null;
    recovery = null;
    eventBuffer = [];
  }

  async function select(value) {
    const id = value == null ? null : String(typeof value === 'object' ? sessionId(value) : value);
    if (id === state.selectedId && state.session && subscription) return state.session;
    releaseSelection();
    publish({ selectedId: id, session: null, connection: id ? 'connecting' : 'idle', error: '' });
    if (!id || disposed) return null;
    const generation = selectionGeneration;
    const abort = new AbortController();
    selectionAbort = abort;
    try {
      const snapshot = await refreshSession(id);
      if (!current(id, generation)) return null;
      if (adapter.subscribeSession) {
        const cleanup = await adapter.subscribeSession(id, {
          signal: abort.signal,
          afterRevision: revisionOf(snapshot) ?? snapshot?.lastEventId ?? null,
          onEvent: (event) => receive(event, id, generation),
          onConnection: (connection) => {
            if (!current(id, generation)) return;
            const status = typeof connection === 'string' ? connection : connection?.status;
            if (status === 'connected') void recover(id, generation).catch(fail);
            else publish({ connection: status || 'connecting' });
          },
        });
        if (!current(id, generation)) { if (typeof cleanup === 'function') cleanup(); return null; }
        subscription = typeof cleanup === 'function' ? cleanup : null;
      }
      publish({ connection: 'connected' });
      return snapshot;
    } catch (error) { if (current(id, generation)) fail(error); if (error?.name !== 'AbortError') throw error; return null; }
  }

  async function execute(action, payload = {}, { sessionId: target = state.selectedId } = {}) {
    if (disposed) throw new Error('Session Host is disposed.');
    const creating = action === 'create' || action === 'session-create';
    if (!creating && !target) throw new Error('Select a Session before performing this operation.');
    const operation = operations.begin({ scope: action, targetId: creating ? 'new' : target, payload });
    if (pendingOperations.has(operation.lookupKey)) return pendingOperations.get(operation.lookupKey);
    const task = (async () => {
      try {
        const result = creating
          ? await adapter.createSession(operation.payload, { idempotencyKey: operation.idempotencyKey })
          : await adapter.execute(target, action, operation.payload, { idempotencyKey: operation.idempotencyKey });
        if (result?.pending && result?.idempotent !== false) throw new Error('这条操作仍在确认中，请稍后重试。');
        operations.complete(operation);
        publish({ error: '' });
        if (creating) {
          const created = sessionId(result) ? result : result?.session;
          await refreshSessions().catch(fail);
          if (sessionId(created)) await select(sessionId(created)).catch(fail);
        } else if (target === state.selectedId) await refreshSession(target).catch(fail);
        return result;
      } catch (error) { if (error?.knownResult === true) operations.discard(operation); fail(error); throw error; }
      finally { pendingOperations.delete(operation.lookupKey); }
    })();
    pendingOperations.set(operation.lookupKey, task);
    return task;
  }

  return {
    operations,
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    async start() { disposed = false; await refreshSessions(); if (state.selectedId) await select(state.selectedId); return state; },
    select,
    refreshSession,
    refreshSessions,
    searchSessions: (options = {}) => adapter.listSessions(options),
    execute,
    receiveEvent: (event) => receive(event, state.selectedId, selectionGeneration),
    updateSession: (updater) => publish({ session: typeof updater === 'function' ? updater(state.session) : updater }),
    updateSessions: (updater) => publish({ sessions: typeof updater === 'function' ? updater(state.sessions) : updater }),
    async loadHistory(options = {}) {
      const id = state.selectedId;
      const generation = selectionGeneration;
      if (!id || !adapter.loadHistory) return null;
      const page = await adapter.loadHistory(id, options);
      if (current(id, generation)) publish({ session: (adapter.mergeHistory || mergeSessionHostSnapshot)(state.session, page) });
      return page;
    },
    markResultRead: (turnId) => state.selectedId && adapter.markResultRead?.(state.selectedId, turnId),
    dispose() { releaseSelection(); disposed = true; listeners.clear(); },
  };
}

export function mergeSessionHostSnapshot(current = {}, latest = {}) {
  if (current.threadId && latest.threadId && current.threadId !== latest.threadId) return latest;
  const previousThread = current.thread;
  const thread = latest.thread && previousThread ? { ...previousThread, ...latest.thread, turns: mergeSessionTurns(previousThread.turns, latest.thread.turns) } : latest.thread || previousThread;
  const earlierPaging = Boolean(current.turnsCursor) && Number(current.loadedTurnCount) > Number(latest.loadedTurnCount);
  return {
    ...current, ...latest, ...(thread ? { thread } : {}),
    items: mergeSessionItems(current.items || [], latest.items || []),
    messages: mergeById(current.messages, latest.messages),
    technicalItems: mergeById(current.technicalItems, latest.technicalItems),
    turnMetadata: mergeById(current.turnMetadata, latest.turnMetadata, (turn) => turn.turnKey || turn.turnId || turn.id),
    technicalDetailsAvailable: [...new Set([...(current.technicalDetailsAvailable || []), ...(latest.technicalDetailsAvailable || [])])],
    ...(earlierPaging ? { hasEarlierTurns: current.hasEarlierTurns, turnsCursor: current.turnsCursor, loadedTurnCount: current.loadedTurnCount } : {}),
  };
}

export function mergeSessionSummaries(current = [], incoming = []) {
  return mergeById(current, incoming, sessionId).sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
}

function mergeById(current = [], incoming = [], identify = (item) => item.id) {
  const values = new Map();
  for (const item of [...(current || []), ...(incoming || [])]) values.set(identify(item), item);
  return [...values.values()];
}
function sessionId(session) { return session?.sessionId || session?.id || null; }
function revisionOf(value) {
  const candidate = value?.revision ?? value?.outputRevision ?? value?.lastEventId ?? value?.eventId;
  const revision = candidate == null || candidate === '' ? NaN : Number(candidate);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}
function timestamp(value) { return typeof value === 'number' ? value : Date.parse(value) || 0; }

import { SessionClientOperationController, mergeSessionItems, mergeSessionTurns } from './session-client.js';

/** Product-neutral Session orchestration. Transport, authorization and storage stay in the Host. */
export function createSessionHostController({ adapter, initialSessionId = null, capabilities = {}, independentStartup = false, submissionFeedback = false, operationTimeoutMs = 30000, selectedSnapshotCache = false, operations = new SessionClientOperationController() } = {}) {
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
  const submissions = new Map();
  let selectionRepair = null;
  let repairAgain = false;
  const cacheLimits = snapshotCacheLimits(selectedSnapshotCache);
  const snapshotCache = new Map();
  const pendingTargets = new Map();
  let cacheBytes = 0;

  function forgetSnapshot(id) {
    const entry = snapshotCache.get(id);
    if (entry) cacheBytes -= entry.bytes;
    snapshotCache.delete(id);
  }
  function cacheIdentity(snapshot) {
    if (!cacheLimits || !snapshot || !sessionId(snapshot) || pendingTargets.has(sessionId(snapshot))
      || [...submissions.values()].some(submission => submission.target === sessionId(snapshot))
      || snapshot.activeTurnId || snapshot.isRunning || snapshot.running
      || snapshot.pendingRequests?.length || snapshot.queuedTurns?.length
      || snapshot.messages?.some(message => message.submissionId)) return null;
    // Only the adapter can attest current native activity and binding identity.
    // This pure hook must return null whenever that authority is unknown.
    try {
      const key = adapter.getSnapshotCacheKey?.(snapshot, state.sessions);
      return typeof key === 'string' && key ? key : null;
    } catch { return null; }
  }
  function catalogueIdentity(id) {
    const summary = state.sessions.find(row => sessionId(row) === id);
    return summary ? JSON.stringify([summary.revision, summary.outputRevision, summary.lastEventId,
      summary.updatedAt, summary.activityStatus, summary.status, summary.threadId, summary.webSessionId]) : null;
  }
  function pruneSnapshots() {
    for (const [id, entry] of snapshotCache) {
      if (Date.now() - entry.createdAt >= cacheLimits.ttlMs
        || entry.key !== cacheIdentity(entry.snapshot) || entry.catalogue !== catalogueIdentity(id)) forgetSnapshot(id);
    }
  }
  function rememberSnapshot(snapshot) {
    if (!cacheLimits) return;
    const id = sessionId(snapshot);
    const key = cacheIdentity(snapshot);
    forgetSnapshot(id);
    pruneSnapshots();
    if (!key) return;
    try {
      // Copy only this selected data snapshot; never a store, adapter, or Profile.
      const serialized = JSON.stringify(snapshot);
      const bytes = new TextEncoder().encode(serialized).byteLength;
      if (bytes > cacheLimits.maxBytes) return;
      snapshotCache.set(id, { snapshot: JSON.parse(serialized), key, bytes, catalogue: catalogueIdentity(id), createdAt: Date.now() });
      cacheBytes += bytes;
      while (snapshotCache.size > cacheLimits.maxEntries || cacheBytes > cacheLimits.maxBytes) forgetSnapshot(snapshotCache.keys().next().value);
    } catch { /* Non-data snapshots are ineligible for this optional cache. */ }
  }
  function cachedSnapshot(id) {
    if (!cacheLimits) return null;
    pruneSnapshots();
    const entry = snapshotCache.get(id);
    if (!entry) return null;
    snapshotCache.delete(id);
    snapshotCache.set(id, entry);
    // A new projection cannot mutate the retained entry during revalidation.
    return JSON.parse(JSON.stringify(entry.snapshot));
  }

  const publish = (patch) => {
    if (disposed) return;
    state = { ...state, ...patch };
    if (cacheLimits && Object.hasOwn(patch, 'sessions')) pruneSnapshots();
    if (submissionFeedback && state.session) {
      const base = { ...state.session, messages: (state.session.messages || []).filter(message => !message.submissionId) };
      const projected = [];
      for (const [key, submission] of submissions) {
        if (submission.target !== state.selectedId) continue;
        if (adapter.isSubmissionEcho?.(base, submission)) { submissions.delete(key); continue; }
        projected.push({ ...submission.message, id: `submission:${key}`, submissionId: key, deliveryState: submission.status, canEdit: false, canFork: false });
      }
      state.session = { ...base, messages: [...(base.messages || []), ...projected] };
    }
    for (const listener of [...listeners]) listener();
  };
  const current = (id, generation) => !disposed && state.selectedId === id && selectionGeneration === generation;
  const fail = (error) => { if (error?.name !== 'AbortError') publish({ error: error?.message || String(error) }); };

  async function refreshSessions(options = {}) {
    const generation = ++listGeneration;
    if (independentStartup) publish({ listLoading: !options.cursor, listLoadingMore: Boolean(options.cursor), listError: '' });
    try {
      const page = await adapter.listSessions(options);
      if (disposed || generation !== listGeneration) return null;
      const sessions = Array.isArray(page) ? page : page?.sessions || [];
      publish({ sessions: options.cursor ? mergeSessionSummaries(state.sessions, sessions) : sessions, nextCursor: page?.nextCursor ?? null, listPage: page, loaded: true });
      return sessions;
    } catch (error) {
      if (independentStartup && generation === listGeneration && error?.name !== 'AbortError') publish({ listError: error?.message || String(error) });
      throw error;
    } finally {
      if (independentStartup && generation === listGeneration) publish({ listLoading: false, listLoadingMore: false });
    }
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
    publish({ session: next, error: '', ...(cacheLimits ? { selectedSnapshotCached: false } : {}) });
    rememberSnapshot(state.session);
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
    publish({ session: revision == null ? next : { ...next, revision }, error: '', ...(cacheLimits ? { selectedSnapshotCached: false } : {}) });
    if (adapter.patchSummary) publish({ sessions: adapter.patchSummary(state.sessions, state.session) });
    rememberSnapshot(state.session);
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

  async function select(value, { force = false } = {}) {
    const id = value == null ? null : String(typeof value === 'object' ? sessionId(value) : value);
    if (!force && id === state.selectedId && state.session && subscription) return state.session;
    if (force) forgetSnapshot(id);
    const cached = !force && id ? cachedSnapshot(id) : null;
    releaseSelection();
    const retained = force && id === state.selectedId ? { ...state.session, revision: undefined } : null;
    publish({ selectedId: id, session: cached || retained, ...(cacheLimits ? { selectedSnapshotCached: Boolean(cached) } : {}), connection: id ? 'connecting' : 'idle', error: '' });
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

  // Only the selected logical Session is reconciled. The Host resolves its
  // replaceable transport binding; Platform owns cancellation and subscription.
  function reconcileSelectedSession({ refresh = false, resetRevision = false } = {}) {
    if (resetRevision) {
      // A restart changes the revision domain for every retained Session.
      snapshotCache.clear(); cacheBytes = 0;
      if (state.session) publish({ session: { ...state.session, revision: undefined }, ...(cacheLimits ? { selectedSnapshotCached: false } : {}) });
    }
    if (disposed || !state.selectedId || !state.session) return Promise.resolve(null);
    if (selectionRepair) { repairAgain = true; return selectionRepair; }
    const task = (async () => {
      do {
        repairAgain = false;
        const id = state.selectedId;
        const decision = adapter.reconcileSelection?.(state.session, state.sessions) || {};
        if (decision.bindingChanged) await select(id, { force: true });
        else if (refresh || decision.snapshotRequired) await recover(id, selectionGeneration);
        refresh = false;
      } while (repairAgain && !disposed);
    })().catch(fail).finally(() => { if (selectionRepair === task) selectionRepair = null; });
    selectionRepair = task;
    return task;
  }

  async function execute(action, payload = {}, { sessionId: target = state.selectedId } = {}) {
    if (disposed) throw new Error('Session Host is disposed.');
    const creating = action === 'create' || action === 'session-create';
    if (!creating && !target) throw new Error('Select a Session before performing this operation.');
    const operation = operations.begin({ scope: action, targetId: creating ? 'new' : target, payload });
    if (pendingOperations.has(operation.lookupKey)) return pendingOperations.get(operation.lookupKey);
    if (!creating && cacheLimits) {
      forgetSnapshot(target);
      pendingTargets.set(target, (pendingTargets.get(target) || 0) + 1);
    }
    const operationSelection = selectionGeneration;
    const message = submissionFeedback && adapter.submissionMessage?.(action, operation.payload);
    if (message) {
      const previous = submissions.get(operation.idempotencyKey);
      submissions.set(operation.idempotencyKey, previous ? { ...previous, status: 'sending' } : {
        target, message, payload: operation.payload, idempotencyKey: operation.idempotencyKey, status: 'sending',
        baseline: (state.session?.messages || []).filter(item => !item.submissionId).map(item => item.id),
      });
      publish({});
    }
    const task = (async () => {
      try {
        const abort = new AbortController();
        const run = () => creating
          ? adapter.createSession(operation.payload, { idempotencyKey: operation.idempotencyKey, signal: abort.signal })
          : adapter.execute(target, action, operation.payload, { idempotencyKey: operation.idempotencyKey, signal: abort.signal });
        const result = await boundedOperation(run, message ? operationTimeoutMs : 0, abort);
        const submission = submissions.get(operation.idempotencyKey);
        if (submission) submissions.set(operation.idempotencyKey, { ...submission, status: 'accepted', result });
        if (result?.pending && result?.idempotent !== false) throw new Error('这条操作仍在确认中，请稍后重试。');
        operations.complete(operation);
        if (selectionGeneration === operationSelection) publish({ error: '' });
        if (creating) {
          const created = sessionId(result) ? result : result?.session;
          if (sessionId(created) && !disposed) {
            // Creation already supplies the new row. An older history request must
            // not remove it, and listing unrelated Sessions must not delay selection.
            const pendingInitialList = independentStartup && state.listLoading;
            listGeneration++;
            publish({ sessions: mergeSessionSummaries(state.sessions, [created]), ...(independentStartup ? { listLoading: false, listLoadingMore: false } : {}) });
            if (pendingInitialList) void refreshSessions().catch(() => {});
            if (selectionGeneration === operationSelection) {
              const selected = await select(sessionId(created)).catch(() => null);
              if (selected && !disposed && adapter.patchSummary) publish({ sessions: adapter.patchSummary(state.sessions, selected) });
            }
          }
        } else if (target === state.selectedId && selectionGeneration === operationSelection) {
          const refresh = refreshSession(target).catch((error) => { if (current(target, operationSelection)) fail(error); });
          if (!message) await refresh;
        }
        return result;
      } catch (error) {
        const submission = submissions.get(operation.idempotencyKey);
        if (error?.knownResult === true) { operations.discard(operation); submissions.delete(operation.idempotencyKey); }
        else if (submission) submissions.set(operation.idempotencyKey, { ...submission, status: 'unknown' });
        if (selectionGeneration === operationSelection) fail(error); else publish({});
        if (message && error?.knownResult !== true && target === state.selectedId) void reconcileSelectedSession({ refresh: true });
        throw error;
      }
      finally {
        pendingOperations.delete(operation.lookupKey);
        if (!creating && cacheLimits) {
          const count = (pendingTargets.get(target) || 1) - 1;
          if (count) pendingTargets.set(target, count); else pendingTargets.delete(target);
        }
      }
    })();
    pendingOperations.set(operation.lookupKey, task);
    return task;
  }

  return {
    operations,
    getSnapshot: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    async start() {
      disposed = false;
      if (!independentStartup) { await refreshSessions(); if (state.selectedId) await select(state.selectedId); return state; }
      const initial = state.selectedId;
      // Catalogue failures belong to navigation, never to the selected conversation.
      const list = refreshSessions().catch(() => {});
      const selection = initial ? select(initial) : Promise.resolve();
      await Promise.all([list, selection]);
      return state;
    },
    select,
    refreshSession,
    refreshSessions,
    reconcileSelectedSession,
    searchSessions: (options = {}) => adapter.listSessions(options),
    execute,
    receiveEvent: (event) => receive(event, state.selectedId, selectionGeneration),
    updateSession: (updater) => { forgetSnapshot(state.selectedId); publish({ session: typeof updater === 'function' ? updater(state.session) : updater }); },
    updateSessions: (updater) => { publish({ sessions: typeof updater === 'function' ? updater(state.sessions) : updater }); void reconcileSelectedSession(); },
    async loadHistory(options = {}) {
      const id = state.selectedId;
      const generation = selectionGeneration;
      if (!id || !adapter.loadHistory) return null;
      const page = await adapter.loadHistory(id, options);
      if (current(id, generation)) {
        publish({ session: (adapter.mergeHistory || mergeSessionHostSnapshot)(state.session, page) });
        if (!state.selectedSnapshotCached) rememberSnapshot(state.session);
      }
      return page;
    },
    markResultRead: (turnId) => state.selectedId && adapter.markResultRead?.(state.selectedId, turnId),
    dispose() { releaseSelection(); disposed = true; listeners.clear(); snapshotCache.clear(); cacheBytes = 0; },
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

function boundedOperation(run, timeoutMs, abort) {
  if (!(timeoutMs > 0)) return Promise.resolve().then(run);
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    abort.abort();
    reject(new Error('发送结果暂未确认，请稍后重试；重试会保留同一个操作 ID。'));
  }, timeoutMs); });
  return Promise.race([Promise.resolve().then(run), timeout]).finally(() => clearTimeout(timer));
}

function snapshotCacheLimits(options) {
  if (!options) return null;
  const bounded = (value, fallback, maximum) => Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), maximum) || 1 : fallback;
  return {
    maxEntries: bounded(options.maxEntries, 5, 32),
    maxBytes: bounded(options.maxBytes, 16 * 1024 * 1024, 64 * 1024 * 1024),
    ttlMs: bounded(options.ttlMs, 60000, 300000),
  };
}

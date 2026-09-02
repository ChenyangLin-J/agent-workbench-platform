import { randomUUID } from 'node:crypto';

import { parseAttachmentEnvelopes } from '../attachments.js';

const QUEUED_TURN_STATUSES = new Set(['queued', 'starting', 'started', 'failed']);

export class SessionTurnQueue {
  constructor({ entries = {}, persist = null, now = () => new Date(), uuid = randomUUID } = {}) {
    this.queues = new Map();
    this.persist = typeof persist === 'function' ? persist : async () => {};
    this.now = now;
    this.uuid = uuid;
    this.mutationQueue = Promise.resolve();
    this.hydrate(entries);
  }

  async enqueue(sessionId, { input, prompt = '', attachments = [], afterTurnId = null, context = null } = {}) {
    requiredId(sessionId, 'Session');
    return this.#mutate(() => {
      const timestamp = this.#time();
      const entry = {
        id: String(this.uuid()),
        input: clone(input),
        prompt: String(prompt || '').trim(),
        attachments: normalizeAttachments(attachments),
        context: clone(context),
        afterTurnId: optionalId(afterTurnId),
        status: 'queued',
        attempts: 0,
        lastError: '',
        startedTurnId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const queue = this.queues.get(sessionId) ?? [];
      queue.push(entry);
      this.queues.set(sessionId, queue);
      return present(entry);
    });
  }

  list(sessionId) {
    return (this.queues.get(String(sessionId)) ?? []).map(present);
  }

  peek(sessionId) {
    const entry = this.queues.get(String(sessionId))?.[0];
    return entry ? clone(entry) : null;
  }

  sessionIds() {
    return [...this.queues.keys()];
  }

  threadIds() {
    return this.sessionIds();
  }

  snapshot() {
    return Object.fromEntries([...this.queues.entries()].map(([sessionId, entries]) => [
      sessionId,
      entries.map((entry) => clone(entry)),
    ]));
  }

  hydrate(entries = {}) {
    this.queues.clear();
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return this;
    for (const [sessionId, values] of Object.entries(entries)) {
      if (!sessionId || !Array.isArray(values)) continue;
      const queue = values.map((value) => normalizeEntry(value, this.#time())).filter(Boolean);
      if (queue.length) this.queues.set(sessionId, queue);
    }
    return this;
  }

  async markStarting(sessionId, queuedTurnId, { afterTurnId } = {}) {
    return this.#update(sessionId, queuedTurnId, (entry) => {
      if (afterTurnId !== undefined) entry.afterTurnId = optionalId(afterTurnId);
      entry.status = 'starting';
      entry.attempts = Number(entry.attempts || 0) + 1;
      entry.lastError = '';
      entry.updatedAt = this.#time();
    });
  }

  async markStarted(sessionId, queuedTurnId, startedTurnId) {
    return this.#update(sessionId, queuedTurnId, (entry) => {
      entry.status = 'started';
      entry.startedTurnId = optionalId(startedTurnId);
      entry.lastError = '';
      entry.updatedAt = this.#time();
    });
  }

  async markFailed(sessionId, queuedTurnId, error) {
    return this.#update(sessionId, queuedTurnId, (entry) => {
      entry.status = 'failed';
      entry.lastError = String(error?.message || error || 'Queued Turn failed').slice(0, 1000);
      entry.updatedAt = this.#time();
    });
  }

  async resetForRetry(sessionId, queuedTurnId) {
    return this.#update(sessionId, queuedTurnId, (entry) => {
      entry.status = 'queued';
      entry.updatedAt = this.#time();
    });
  }

  async shift(sessionId) {
    return this.#mutate(() => {
      const queue = this.queues.get(sessionId) ?? [];
      const entry = queue.shift() ?? null;
      if (!queue.length) this.queues.delete(sessionId);
      return entry ? clone(entry) : null;
    });
  }

  async remove(sessionId, queuedTurnId) {
    return this.#mutate(() => {
      const queue = this.queues.get(sessionId) ?? [];
      const index = queue.findIndex((entry) => entry.id === queuedTurnId);
      if (index < 0) return null;
      const [entry] = queue.splice(index, 1);
      if (!queue.length) this.queues.delete(sessionId);
      return present(entry);
    });
  }

  async #update(sessionId, queuedTurnId, update) {
    return this.#mutate(() => {
      const entry = (this.queues.get(sessionId) ?? []).find((item) => item.id === queuedTurnId);
      if (!entry) return null;
      update(entry);
      return present(entry);
    });
  }

  async #mutate(mutator) {
    const operation = this.mutationQueue.then(async () => {
      const before = this.snapshot();
      const result = mutator();
      try {
        await this.persist(this.snapshot());
        return result;
      } catch (error) {
        this.hydrate(before);
        throw error;
      }
    });
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  #time() {
    const value = this.now();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }
}

export function createQueuedTurnDispatcher({
  runtime,
  queue,
  events = {},
  activeTurnForSession,
  maxStartAttempts = 3,
  retryDelay = (attempts) => Math.min(5000, Math.max(750, Number(attempts || 1) * 1000)),
} = {}) {
  if (!runtime?.readSession || !runtime?.startTurn) throw new TypeError('Queued Turn runtime.readSession/startTurn are required.');
  if (!queue?.peek || !queue?.markStarting || !queue?.remove) throw new TypeError('Session Turn queue is required.');
  if (typeof activeTurnForSession !== 'function') throw new TypeError('activeTurnForSession is required.');
  const dispatches = new Map();
  const retryTimers = new Map();

  function clearRetry(sessionId) {
    const timer = retryTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(sessionId);
  }

  function scheduleRetry(sessionId, attempts) {
    clearRetry(sessionId);
    const timer = setTimeout(() => {
      retryTimers.delete(sessionId);
      startNext(sessionId).catch((error) => events.onError?.(error, sessionId));
    }, retryDelay(attempts));
    timer.unref?.();
    retryTimers.set(sessionId, timer);
  }

  async function startNext(sessionId) {
    if (!sessionId) return null;
    if (dispatches.has(sessionId)) return dispatches.get(sessionId);
    const dispatch = (async () => {
      let nextTurn = queue.peek(sessionId);
      if (!nextTurn) {
        events.onIdle?.(sessionId);
        return null;
      }
      const session = await runtime.readSession(sessionId);
      if (['starting', 'started', 'failed'].includes(nextTurn.status) && queuedTurnWasAccepted(nextTurn, session)) {
        await queue.remove(sessionId, nextTurn.id);
        clearRetry(sessionId);
        const queueLength = queue.list(sessionId).length;
        events.publish?.(sessionId, { type: 'turn_dequeued', queuedTurnId: nextTurn.id, startedTurnId: nextTurn.startedTurnId, queueLength });
        if (queueLength) queueMicrotask(() => startNext(sessionId).catch((error) => events.onError?.(error, sessionId)));
        return null;
      }
      if (activeTurnForSession(session)) {
        scheduleRetry(sessionId, 2);
        return null;
      }
      if (nextTurn.status === 'failed' && nextTurn.attempts >= maxStartAttempts) return null;
      if (nextTurn.status !== 'queued') nextTurn = await queue.resetForRetry(sessionId, nextTurn.id);
      nextTurn = await queue.markStarting(sessionId, nextTurn.id, {
        afterTurnId: session.turns?.at(-1)?.id ?? nextTurn.afterTurnId ?? null,
      });
      events.publish?.(sessionId, { type: 'turn_queue_updated', queuedTurn: nextTurn, queueLength: queue.list(sessionId).length });
      let turn;
      try {
        const acceptedEntry = queue.peek(sessionId);
        turn = await runtime.startTurn(sessionId, acceptedEntry.input, acceptedEntry, session);
      } catch (error) {
        const failedTurn = await queue.markFailed(sessionId, nextTurn.id, error);
        events.publish?.(sessionId, {
          type: 'queue_failed', queuedTurnId: nextTurn.id, queuedTurn: failedTurn,
          queueLength: queue.list(sessionId).length,
          retrying: Boolean(failedTurn && failedTurn.attempts < maxStartAttempts),
          error: error.message,
        });
        if (failedTurn?.attempts < maxStartAttempts) scheduleRetry(sessionId, failedTurn.attempts);
        return null;
      }
      await queue.markStarted(sessionId, nextTurn.id, turn?.id ?? turn?.runtimeTurnId);
      await queue.remove(sessionId, nextTurn.id);
      clearRetry(sessionId);
      events.publish?.(sessionId, {
        type: 'turn_dequeued', queuedTurnId: nextTurn.id,
        startedTurnId: turn?.id ?? turn?.runtimeTurnId ?? null,
        queueLength: queue.list(sessionId).length,
      });
      return turn;
    })().catch((error) => {
      if (queue.peek(sessionId)) scheduleRetry(sessionId, 2);
      throw error;
    }).finally(() => dispatches.delete(sessionId));
    dispatches.set(sessionId, dispatch);
    return dispatch;
  }

  async function recover() {
    await Promise.all(queue.sessionIds().map((sessionId) => startNext(sessionId).catch((error) => events.onError?.(error, sessionId))));
  }

  function close() {
    for (const timer of retryTimers.values()) clearTimeout(timer);
    retryTimers.clear();
  }

  return { clearRetry, close, recover, startNext };
}

export function queuedTurnWasAccepted(entry, session) {
  const turns = session?.turns ?? [];
  if (entry.startedTurnId && turns.some((turn) => turn.id === entry.startedTurnId)) return true;
  const baselineIndex = entry.afterTurnId ? turns.findIndex((turn) => turn.id === entry.afterTurnId) : -1;
  const candidates = baselineIndex >= 0 ? turns.slice(baselineIndex + 1) : [];
  if (!candidates.length) return false;
  if (!entry.prompt) return true;
  return candidates.some((turn) => (turn.items ?? []).some((item) => userMessageText(item) === entry.prompt));
}

function normalizeEntry(value, fallbackTimestamp) {
  if (!value || typeof value !== 'object' || !value.id) return null;
  const createdAt = String(value.createdAt || fallbackTimestamp);
  return {
    id: String(value.id),
    input: clone(value.input),
    prompt: String(value.prompt || '').trim(),
    attachments: normalizeAttachments(value.attachments),
    context: clone(value.context),
    afterTurnId: optionalId(value.afterTurnId),
    status: QUEUED_TURN_STATUSES.has(value.status) ? value.status : 'queued',
    attempts: Number.isFinite(Number(value.attempts)) ? Math.max(0, Math.floor(Number(value.attempts))) : 0,
    lastError: String(value.lastError || '').slice(0, 1000),
    startedTurnId: optionalId(value.startedTurnId),
    createdAt,
    updatedAt: String(value.updatedAt || createdAt),
  };
}

function present(entry) {
  return {
    id: entry.id,
    prompt: entry.prompt,
    attachments: entry.attachments.map(publicAttachment),
    afterTurnId: entry.afterTurnId,
    status: entry.status,
    attempts: entry.attempts,
    lastError: entry.lastError,
    startedTurnId: entry.startedTurnId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function normalizeAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map((attachment, index) => ({
    ...clone(attachment || {}),
    id: String(attachment?.id || `attachment-${index}`),
    name: String(attachment?.name || 'Attachment').slice(0, 120),
    kind: attachment?.inputType === 'localImage'
      ? 'image'
      : attachment?.inputType === 'localAudio'
        ? 'audio'
        : String(attachment?.kind || 'file'),
  }));
}

function publicAttachment(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    kind: attachment.kind,
  };
}

function userMessageText(item) {
  if (item?.type !== 'userMessage') return '';
  const text = typeof item.text === 'string' ? item.text : (Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === 'text')
    .map((part) => String(part.text || ''))
    .join('\n');
  return parseAttachmentEnvelopes(text).text.trim();
}

function optionalId(value) {
  const normalized = value == null ? '' : String(value).trim();
  return normalized || null;
}

function requiredId(value, label) {
  if (!optionalId(value)) throw new TypeError(`${label} id is required.`);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

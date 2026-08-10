export const CORE_EVENT_TYPES = Object.freeze([
  'snapshot',
  'turn_started',
  'turn_completed',
  'item_started',
  'item_delta',
  'item_completed',
  'plan_updated',
  'request_opened',
  'request_resolved',
  'request_rejected',
  'request_expired',
  'turn_accepted',
  'turn_queued',
  'turn_interrupt_requested',
  'session_attached',
  'session_detached',
  'connection_exited',
  'replay_gap',
  'provider_event',
  'provider_warning',
  'core_error',
]);

export const RUNTIME_CAPABILITIES = Object.freeze([
  'resume',
  'steer',
  'interrupt',
  'fork',
  'approvals',
  'user_input',
  'item_stream',
  'plan_stream',
  'attachments',
]);

export const REQUEST_TYPES = Object.freeze([
  'command_approval',
  'file_approval',
  'permission_approval',
  'user_input',
  'elicitation',
]);

const CORE_EVENT_TYPE_SET = new Set(CORE_EVENT_TYPES);

export function createCoreEvent({
  eventId,
  type,
  sessionId,
  runtimeProvider,
  runtimeSessionId = null,
  runtimeTurnId = null,
  providerEvent = null,
  payload = {},
  createdAt = Date.now(),
}) {
  if (!Number.isSafeInteger(eventId) || eventId < 0) {
    throw new TypeError('Core eventId must be a non-negative safe integer.');
  }
  if (!CORE_EVENT_TYPE_SET.has(type)) throw new TypeError(`Unsupported Core event type: ${type}`);
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('Core sessionId is required.');
  if (typeof runtimeProvider !== 'string' || !runtimeProvider) {
    throw new TypeError('Core runtimeProvider is required.');
  }
  if (!Number.isFinite(createdAt) || createdAt < 0) throw new TypeError('Core createdAt must be a timestamp.');
  return Object.freeze({
    eventId,
    type,
    sessionId,
    runtimeProvider,
    runtimeSessionId: nullableString(runtimeSessionId),
    runtimeTurnId: nullableString(runtimeTurnId),
    providerEvent: nullableString(providerEvent),
    payload: cloneProtocolValue(payload),
    createdAt,
  });
}

export class CoreEventReplayBuffer {
  constructor({ limit = 200 } = {}) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('Replay buffer limit must be positive.');
    this.limit = limit;
    this.events = new Map();
    this.counters = new Map();
  }

  publish(sessionId, event) {
    const eventId = (this.counters.get(sessionId) || 0) + 1;
    this.counters.set(sessionId, eventId);
    const normalized = createCoreEvent({ ...event, eventId, sessionId });
    const next = [...(this.events.get(sessionId) || []), normalized].slice(-this.limit);
    this.events.set(sessionId, next);
    return normalized;
  }

  latestEventId(sessionId) {
    return this.counters.get(sessionId) || 0;
  }

  replay(sessionId, afterEventId = 0) {
    const numericAfterId = Number.isSafeInteger(Number(afterEventId)) ? Number(afterEventId) : 0;
    const events = this.events.get(sessionId) || [];
    const latestEventId = this.latestEventId(sessionId);
    const earliestEventId = events[0]?.eventId ?? latestEventId + 1;
    return {
      earliestEventId,
      latestEventId,
      replayGap: numericAfterId < earliestEventId - 1,
      events: events.filter((event) => event.eventId > numericAfterId),
    };
  }

  clear(sessionId) {
    this.events.delete(sessionId);
    this.counters.delete(sessionId);
  }
}

export function normalizeRuntimeCapabilities(provider, capabilities = {}) {
  if (typeof provider !== 'string' || !provider.trim()) throw new TypeError('provider is required.');
  const normalized = Object.fromEntries(
    RUNTIME_CAPABILITIES.map((name) => [name, Boolean(capabilities[name])]),
  );
  return Object.freeze({ provider: provider.trim(), ...normalized });
}

export function assertRuntimeProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new TypeError('Runtime provider is required.');
  for (const method of ['capabilities', 'createSession']) {
    if (typeof provider[method] !== 'function') throw new TypeError(`Runtime provider.${method} is required.`);
  }
  const capabilities = provider.capabilities();
  if (!capabilities || capabilities.provider !== provider.id) {
    throw new TypeError('Runtime provider capabilities must identify provider.id.');
  }
  return provider;
}

export function cloneProtocolValue(value) {
  if (value === undefined) return null;
  return structuredClone(value);
}

function nullableString(value) {
  const normalized = value == null ? '' : String(value).trim();
  return normalized || null;
}

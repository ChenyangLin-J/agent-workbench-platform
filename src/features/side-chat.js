const SIDE_CHAT_STATUSES = new Set([
  'creating',
  'idle',
  'running',
  'interrupted',
  'expired',
  'error',
]);

const EXPIRED_RUNTIME_CODES = new Set([
  'RUNTIME_SESSION_NOT_FOUND',
  'THREAD_NOT_FOUND',
  'SESSION_NOT_FOUND',
]);

export class SideChatController {
  constructor({ store, runtime, now = () => Date.now() } = {}) {
    assertMethod(store, 'list', 'SideChat store');
    assertMethod(store, 'load', 'SideChat store');
    assertMethod(store, 'save', 'SideChat store');
    assertMethod(store, 'remove', 'SideChat store');
    assertMethod(runtime, 'fork', 'SideChat runtime');
    assertMethod(runtime, 'submit', 'SideChat runtime');
    assertMethod(runtime, 'interrupt', 'SideChat runtime');
    assertMethod(runtime, 'readSnapshot', 'SideChat runtime');
    this.store = store;
    this.runtime = runtime;
    this.now = now;
  }

  async list(parentSessionId) {
    requiredId(parentSessionId, 'Parent Session');
    const records = await this.store.list(parentSessionId);
    return (Array.isArray(records) ? records : [])
      .map(normalizeSideChatRecord)
      .filter((record) => record.parentSessionId === parentSessionId)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async create({
    parentSessionId,
    parentRuntimeSessionId,
    title = 'Side Chat',
    selectedText = '',
    model = '',
    reasoningEffort = '',
  } = {}) {
    requiredId(parentSessionId, 'Parent Session');
    requiredId(parentRuntimeSessionId, 'Parent Runtime Session');
    const createdAt = this.now();
    const result = await this.runtime.fork(parentRuntimeSessionId, {
      ephemeral: true,
      model: optionalString(model),
      reasoningEffort: optionalString(reasoningEffort),
    });
    const runtimeSessionId = runtimeId(result);
    const record = normalizeSideChatRecord({
      id: runtimeSessionId,
      parentSessionId,
      parentRuntimeSessionId,
      runtimeSessionId,
      title,
      selectedText,
      model,
      reasoningEffort,
      status: 'idle',
      resumable: true,
      transcript: [],
      createdAt,
      updatedAt: createdAt,
    });
    return this.store.save(record);
  }

  async submit(sideChatId, input, options = {}) {
    const record = await this.#loadMutable(sideChatId);
    if (record.status === 'running') throw sideChatError('SIDE_CHAT_TURN_ACTIVE', 'Side Chat is already running.', 409);
    const normalizedInput = normalizeInput(input);
    if (!normalizedInput.length) throw sideChatError('SIDE_CHAT_INPUT_REQUIRED', 'Side Chat input is required.', 400);
    const startedAt = this.now();
    const running = await this.store.save(normalizeSideChatRecord({
      ...record,
      status: 'running',
      activeTurnId: null,
      error: null,
      transcript: [...record.transcript, ...inputMessages(normalizedInput, startedAt)],
      updatedAt: startedAt,
    }));
    try {
      const result = await this.runtime.submit(record.runtimeSessionId, normalizedInput, {
        model: optionalString(options.model ?? record.model),
        reasoningEffort: optionalString(options.reasoningEffort ?? record.reasoningEffort),
      });
      return this.store.save(normalizeSideChatRecord({
        ...running,
        activeTurnId: result?.runtimeTurnId || result?.turnId || null,
        updatedAt: this.now(),
      }));
    } catch (error) {
      await this.store.save(normalizeSideChatRecord({
        ...running,
        status: 'error',
        activeTurnId: null,
        error: error?.message || 'Side Chat turn failed.',
        updatedAt: this.now(),
      }));
      throw error;
    }
  }

  async refresh(sideChatId) {
    const record = await this.#load(sideChatId);
    if (!record.resumable) return record;
    try {
      const snapshot = await this.runtime.readSnapshot(record.runtimeSessionId);
      return this.applySnapshot(sideChatId, snapshot);
    } catch (error) {
      if (!EXPIRED_RUNTIME_CODES.has(error?.code)) throw error;
      return this.store.save(normalizeSideChatRecord({
        ...record,
        status: 'expired',
        resumable: false,
        activeTurnId: null,
        error: null,
        updatedAt: this.now(),
      }));
    }
  }

  async applySnapshot(sideChatId, snapshot = {}) {
    const record = await this.#load(sideChatId);
    const normalized = normalizeSideChatSnapshot(snapshot);
    return this.store.save(normalizeSideChatRecord({
      ...record,
      status: normalized.status,
      resumable: normalized.status !== 'expired',
      activeTurnId: normalized.activeTurnId,
      transcript: normalized.transcript.length ? normalized.transcript : record.transcript,
      error: normalized.error,
      updatedAt: this.now(),
    }));
  }

  async interrupt(sideChatId) {
    const record = await this.#loadMutable(sideChatId);
    if (record.status !== 'running' || !record.activeTurnId) {
      throw sideChatError('SIDE_CHAT_TURN_NOT_ACTIVE', 'Side Chat does not have an active Turn.', 409);
    }
    await this.runtime.interrupt(record.runtimeSessionId, record.activeTurnId);
    return this.store.save(normalizeSideChatRecord({
      ...record,
      status: 'interrupted',
      activeTurnId: null,
      updatedAt: this.now(),
    }));
  }

  async update(sideChatId, { title, model, reasoningEffort } = {}) {
    const record = await this.#loadMutable(sideChatId);
    if (record.status === 'running') throw sideChatError('SIDE_CHAT_TURN_ACTIVE', 'Side Chat is already running.', 409);
    return this.store.save(normalizeSideChatRecord({
      ...record,
      title: title === undefined ? record.title : title,
      model: model === undefined ? record.model : model,
      reasoningEffort: reasoningEffort === undefined ? record.reasoningEffort : reasoningEffort,
      updatedAt: this.now(),
    }));
  }

  async remove(sideChatId) {
    const record = await this.#load(sideChatId);
    if (record.status === 'running') throw sideChatError('SIDE_CHAT_TURN_ACTIVE', 'Interrupt Side Chat before deleting it.', 409);
    await this.store.remove(record.id);
    return { id: record.id, removed: true };
  }

  async #load(sideChatId) {
    requiredId(sideChatId, 'Side Chat');
    const value = await this.store.load(sideChatId);
    if (!value) throw sideChatError('SIDE_CHAT_NOT_FOUND', 'Side Chat was not found.', 404);
    return normalizeSideChatRecord(value);
  }

  async #loadMutable(sideChatId) {
    const record = await this.#load(sideChatId);
    if (!record.resumable || record.status === 'expired') {
      throw sideChatError('SIDE_CHAT_EXPIRED', 'Side Chat is read-only because its Runtime Session expired.', 409);
    }
    return record;
  }
}

export function normalizeSideChatRecord(value = {}) {
  const status = SIDE_CHAT_STATUSES.has(value.status) ? value.status : 'idle';
  return {
    id: requiredString(value.id, 'Side Chat id'),
    parentSessionId: requiredString(value.parentSessionId, 'Parent Session id'),
    parentRuntimeSessionId: requiredString(value.parentRuntimeSessionId, 'Parent Runtime Session id'),
    runtimeSessionId: requiredString(value.runtimeSessionId, 'Runtime Session id'),
    title: String(value.title || 'Side Chat'),
    selectedText: String(value.selectedText || ''),
    model: String(value.model || ''),
    reasoningEffort: String(value.reasoningEffort || ''),
    status,
    resumable: value.resumable !== false && status !== 'expired',
    activeTurnId: optionalString(value.activeTurnId),
    transcript: normalizeTranscript(value.transcript),
    error: optionalString(value.error),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt ?? value.createdAt),
  };
}

export function normalizeSideChatSnapshot(value = {}) {
  const rawStatus = String(value.status || '').trim().toLowerCase();
  const activeTurnId = optionalString(value.activeTurnId ?? value.runtimeTurnId);
  const status = rawStatus === 'expired'
    ? 'expired'
    : rawStatus === 'interrupted' || rawStatus === 'cancelled'
      ? 'interrupted'
      : value.error || rawStatus === 'error' || rawStatus === 'failed'
        ? 'error'
        : activeTurnId || rawStatus === 'running' || rawStatus === 'inprogress'
          ? 'running'
          : 'idle';
  return {
    status,
    activeTurnId: status === 'running' ? activeTurnId : null,
    transcript: normalizeTranscript(value.transcript ?? value.messages),
    error: status === 'error' ? optionalString(value.error?.message ?? value.error) : null,
  };
}

function normalizeTranscript(value) {
  return (Array.isArray(value) ? value : []).map((message, index) => ({
    id: String(message?.id || `side-chat-message-${index}`),
    role: ['user', 'assistant', 'notice'].includes(message?.role) ? message.role : 'notice',
    content: String(message?.content ?? message?.text ?? ''),
    turnId: optionalString(message?.turnId),
    createdAt: timestamp(message?.createdAt),
  })).filter((message) => message.content);
}

function normalizeInput(value) {
  if (typeof value === 'string') return value.trim() ? [{ type: 'text', text: value.trim() }] : [];
  if (!Array.isArray(value)) return [];
  return structuredClone(value.filter((item) => item && typeof item === 'object'));
}

function inputMessages(input, createdAt) {
  const content = input
    .filter((item) => item.type === 'text')
    .map((item) => String(item.text || '').trim())
    .filter(Boolean)
    .join('\n\n');
  return content ? [{
    id: `side-chat-user-${createdAt}`,
    role: 'user',
    content,
    turnId: null,
    createdAt,
  }] : [];
}

function runtimeId(value) {
  const id = value?.runtimeSessionId || value?.threadId || value?.id;
  return requiredString(id, 'Forked Runtime Session id');
}

function timestamp(value) {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : 0;
}

function optionalString(value) {
  const normalized = value == null ? '' : String(value).trim();
  return normalized || null;
}

function requiredString(value, label) {
  const normalized = optionalString(value);
  if (!normalized) throw new TypeError(`${label} is required.`);
  return normalized;
}

function requiredId(value, label) {
  requiredString(value, `${label} id`);
}

function assertMethod(value, method, label) {
  if (typeof value?.[method] !== 'function') throw new TypeError(`${label}.${method} is required.`);
}

function sideChatError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

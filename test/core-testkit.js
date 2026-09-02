import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';

import { normalizeRuntimeCapabilities } from '../src/runtime/core/contracts.js';

export function createFakeAppServer({ onRequest } = {}) {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = '';
  const messages = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      input += chunk.toString();
      const lines = input.split(/\r?\n/);
      input = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        messages.push(message);
        queueMicrotask(() => onRequest?.(message, api));
      }
      callback();
    },
  });
  child.stdin = stdin;
  child.stdout = stdout;
  child.stderr = stderr;
  child.exitCode = null;
  child.kill = (signal = 'SIGTERM') => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0, signal));
    return true;
  };
  const api = {
    child,
    messages,
    send(message) {
      stdout.write(`${JSON.stringify(message)}\n`);
    },
    respond(request, result) {
      api.send({ id: request.id, result });
    },
    reject(request, error) {
      api.send({ id: request.id, error });
    },
    notify(method, params = {}) {
      api.send({ method, params });
    },
    request(id, method, params = {}) {
      api.send({ id, method, params });
    },
    exit(code = 1, signal = null) {
      child.exitCode = code;
      child.emit('exit', code, signal);
    },
  };
  return api;
}

export class InMemoryBindingStore {
  constructor(initial = {}) {
    this.bindings = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  }

  async load(sessionId) {
    const value = this.bindings.get(sessionId);
    return value ? structuredClone(value) : null;
  }

  async save(sessionId, binding, { expectedThreadId, expectedTurnId } = {}) {
    const current = this.bindings.get(sessionId) || null;
    if (expectedThreadId !== undefined && (current?.threadId ?? null) !== expectedThreadId) {
      throw Object.assign(new Error('thread binding conflict'), { code: 'BINDING_CONFLICT' });
    }
    if (expectedTurnId !== undefined && (current?.activeTurnId ?? null) !== expectedTurnId) {
      throw Object.assign(new Error('turn binding conflict'), { code: 'BINDING_CONFLICT' });
    }
    const next = { ...(current || {}), ...structuredClone(binding) };
    this.bindings.set(sessionId, next);
    return structuredClone(next);
  }
}

export class FakeRuntimeProvider {
  constructor({ id = 'fake', capabilities = {} } = {}) {
    this.id = id;
    this.declaredCapabilities = normalizeRuntimeCapabilities(id, {
      resume: true,
      interrupt: true,
      approvals: true,
      user_input: true,
      item_stream: true,
      ...capabilities,
    });
    this.createdSessions = [];
  }

  capabilities() {
    return this.declaredCapabilities;
  }

  createSession(options = {}) {
    const session = new FakeRuntimeSession({ providerId: this.id, ...options });
    this.createdSessions.push(session);
    return session;
  }
}

export class FakeRuntimeSession extends EventEmitter {
  constructor({ providerId = 'fake', cwd = null, settings = {} } = {}) {
    super();
    this.providerId = providerId;
    this.cwd = cwd;
    this.settings = settings;
    this.runtimeSessionId = null;
    this.activeTurnId = null;
    this.started = false;
    this.closed = false;
    this.turnSequence = 0;
    this.startedTurns = [];
    this.steeredTurns = [];
  }

  async start() {
    this.started = true;
  }

  async create({ cwd = this.cwd } = {}) {
    this.cwd = cwd;
    this.runtimeSessionId = `${this.providerId}-session-${FakeRuntimeSession.nextSessionId++}`;
    return this.describe();
  }

  async resume(runtimeSessionId, { cwd = this.cwd } = {}) {
    this.cwd = cwd;
    this.runtimeSessionId = runtimeSessionId;
    return this.describe();
  }

  async startTurn(input) {
    if (this.activeTurnId) throw Object.assign(new Error('turn active'), { code: 'RUNTIME_TURN_ACTIVE' });
    const runtimeTurnId = `${this.runtimeSessionId}-turn-${++this.turnSequence}`;
    this.activeTurnId = runtimeTurnId;
    this.startedTurns.push({ runtimeTurnId, input: structuredClone(input) });
    this.emit('event', {
      type: 'turn_started',
      runtimeSessionId: this.runtimeSessionId,
      runtimeTurnId,
      payload: { status: 'running' },
    });
    return { runtimeTurnId, status: 'running' };
  }

  async steerTurn(input, { expectedTurnId } = {}) {
    if (!this.activeTurnId || expectedTurnId !== this.activeTurnId) throw new Error('turn not active');
    this.steeredTurns.push({ runtimeTurnId: expectedTurnId, input: structuredClone(input) });
    return { runtimeTurnId: expectedTurnId, status: 'running' };
  }

  async interruptTurn(expectedTurnId) {
    if (expectedTurnId !== this.activeTurnId) throw new Error('turn not active');
    return { runtimeTurnId: expectedTurnId, status: 'interrupt_requested' };
  }

  async fork(lastTurnId, { cwd = this.cwd } = {}) {
    if (this.activeTurnId) throw Object.assign(new Error('turn active'), { code: 'RUNTIME_TURN_ACTIVE' });
    if (!lastTurnId) throw new TypeError('lastTurnId is required');
    return {
      runtimeProvider: this.providerId,
      runtimeSessionId: `${this.providerId}-fork-${FakeRuntimeSession.nextSessionId++}`,
      activeTurnId: null,
      cwd,
    };
  }

  complete(runtimeTurnId = this.activeTurnId, status = 'completed') {
    if (runtimeTurnId === this.activeTurnId) this.activeTurnId = null;
    this.emit('event', {
      type: 'turn_completed',
      runtimeSessionId: this.runtimeSessionId,
      runtimeTurnId,
      payload: { status, error: null },
    });
  }

  openRequest({ type = 'command_approval', payload = {}, runtimeTurnId = this.activeTurnId } = {}) {
    let resolveResponse;
    let rejectResponse;
    const response = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    this.emit('request', {
      type,
      providerRequestId: `provider-request-${Date.now()}`,
      runtimeSessionId: this.runtimeSessionId,
      runtimeTurnId,
      payload: structuredClone(payload),
      respond: async (value) => resolveResponse(value),
      reject: async (error) => rejectResponse(error),
    });
    return response;
  }

  async readSnapshot() {
    return {
      runtimeProvider: this.providerId,
      runtimeSessionId: this.runtimeSessionId,
      activeTurnId: this.activeTurnId,
      history: { id: this.runtimeSessionId, turns: structuredClone(this.startedTurns) },
    };
  }

  async unsubscribe() {
    if (this.activeTurnId) throw new Error('turn active');
    return { runtimeSessionId: this.runtimeSessionId };
  }

  describe() {
    return {
      runtimeProvider: this.providerId,
      runtimeSessionId: this.runtimeSessionId,
      activeTurnId: this.activeTurnId,
      cwd: this.cwd,
    };
  }

  close() {
    this.closed = true;
  }
}

FakeRuntimeSession.nextSessionId = 1;

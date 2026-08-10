import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  assertRuntimeProvider,
  CoreEventReplayBuffer,
} from './contracts.js';

export class AgentSessionKernel extends EventEmitter {
  constructor({
    provider,
    bindingStore,
    eventBuffer = new CoreEventReplayBuffer(),
    validateRequest = null,
    requestTimeoutMs = 15 * 60_000,
  } = {}) {
    super();
    this.setMaxListeners(0);
    this.provider = assertRuntimeProvider(provider);
    if (!bindingStore?.load || !bindingStore?.save) throw new TypeError('bindingStore.load/save are required.');
    this.bindingStore = bindingStore;
    this.eventBuffer = eventBuffer;
    this.validateRequest = validateRequest;
    this.requestTimeoutMs = positiveNumber(requestTimeoutMs, 'requestTimeoutMs');
    this.sessions = new Map();
    this.attachPromises = new Map();
    this.startingTurns = new Set();
    this.turnQueues = new Map();
    this.pendingRequests = new Map();
    this.bindingQueues = new Map();
  }

  capabilities() {
    return this.provider.capabilities();
  }

  async attach(sessionId, options = {}) {
    assertSessionId(sessionId);
    const current = this.sessions.get(sessionId);
    if (current && !current.closed) return this.#describe(sessionId, current);
    const inFlight = this.attachPromises.get(sessionId);
    if (inFlight) return inFlight;
    const promise = this.#attach(sessionId, options);
    this.attachPromises.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.attachPromises.delete(sessionId);
    }
  }

  async #attach(sessionId, { host = null, cwd = null, settings = {} } = {}) {
    const binding = await this.bindingStore.load(sessionId);
    if (binding?.runtimeProvider && binding.runtimeProvider !== this.provider.id) {
      throw kernelError('RUNTIME_PROVIDER_CONFLICT', `Session is bound to ${binding.runtimeProvider}.`, 409);
    }
    const runtimeSession = this.provider.createSession({ host, cwd: cwd || binding?.cwd || null, settings });
    this.#bindRuntimeSession(sessionId, runtimeSession);
    try {
      await runtimeSession.start();
      if (binding?.runtimeSessionId) {
        if (!this.capabilities().resume) throw kernelError('RUNTIME_RESUME_UNSUPPORTED', 'Provider cannot resume Sessions.', 409);
        await runtimeSession.resume(binding.runtimeSessionId, { cwd: cwd || binding.cwd || null, settings });
      } else {
        await runtimeSession.create({ cwd, settings });
      }
      this.sessions.set(sessionId, runtimeSession);
      await this.#saveBinding(sessionId, {
        runtimeProvider: this.provider.id,
        runtimeSessionId: runtimeSession.runtimeSessionId,
        activeTurnId: runtimeSession.activeTurnId,
        cwd: runtimeSession.cwd,
        status: runtimeSession.activeTurnId ? 'running' : 'idle',
        lastError: null,
      });
      this.#publish(sessionId, {
        type: 'session_attached',
        runtimeSessionId: runtimeSession.runtimeSessionId,
        runtimeTurnId: runtimeSession.activeTurnId,
        payload: { capabilities: this.capabilities() },
      });
      return this.#describe(sessionId, runtimeSession);
    } catch (error) {
      runtimeSession.close();
      throw error;
    }
  }

  async adopt(sessionId, runtimeSession) {
    assertSessionId(sessionId);
    if (!runtimeSession?.runtimeSessionId || typeof runtimeSession.describe !== 'function') {
      throw new TypeError('A created runtimeSession is required.');
    }
    if (runtimeSession.providerId !== this.provider.id) {
      throw kernelError('RUNTIME_PROVIDER_CONFLICT', `Session is owned by ${runtimeSession.providerId}.`, 409);
    }
    const current = this.sessions.get(sessionId);
    if (current && current !== runtimeSession && !current.closed) {
      throw kernelError('SESSION_ALREADY_ATTACHED', 'Product Session is already attached.', 409);
    }
    const binding = await this.bindingStore.load(sessionId);
    if (binding?.runtimeSessionId && binding.runtimeSessionId !== runtimeSession.runtimeSessionId) {
      throw kernelError('RUNTIME_SESSION_CONFLICT', 'Product Session is already bound to another Runtime Session.', 409);
    }
    this.#bindRuntimeSession(sessionId, runtimeSession);
    this.sessions.set(sessionId, runtimeSession);
    await this.#saveBinding(sessionId, {
      runtimeProvider: this.provider.id,
      runtimeSessionId: runtimeSession.runtimeSessionId,
      activeTurnId: runtimeSession.activeTurnId,
      cwd: runtimeSession.cwd,
      status: runtimeSession.activeTurnId ? 'running' : 'idle',
      lastError: null,
    });
    this.#publish(sessionId, {
      type: 'session_attached',
      runtimeSessionId: runtimeSession.runtimeSessionId,
      runtimeTurnId: runtimeSession.activeTurnId,
      payload: { capabilities: this.capabilities(), adopted: true },
    });
    return this.#describe(sessionId, runtimeSession);
  }

  async submit(sessionId, input, { mode = 'auto', ...params } = {}) {
    await this.attach(sessionId, params);
    const runtimeSession = this.sessions.get(sessionId);
    if (runtimeSession.activeTurnId) {
      if (mode === 'queue' || (mode === 'auto' && !this.capabilities().steer)) {
        return this.#queueTurn(sessionId, input, params);
      }
      if (!this.capabilities().steer) throw kernelError('RUNTIME_STEER_UNSUPPORTED', 'Provider cannot steer an active Turn.', 409);
      const result = await runtimeSession.steerTurn(input, {
        ...params,
        expectedTurnId: runtimeSession.activeTurnId,
      });
      return { ...result, deliveryMode: 'steer' };
    }
    return this.#startTurn(sessionId, runtimeSession, input, params);
  }

  #queueTurn(sessionId, input, params) {
    return new Promise((resolve, reject) => {
      const queue = this.turnQueues.get(sessionId) || [];
      queue.push({ input: structuredClone(input), params: structuredClone(params), resolve, reject });
      this.turnQueues.set(sessionId, queue);
      const runtimeSession = this.sessions.get(sessionId);
      this.#publish(sessionId, {
        type: 'turn_queued',
        runtimeSessionId: runtimeSession?.runtimeSessionId,
        runtimeTurnId: runtimeSession?.activeTurnId,
        payload: { queueLength: queue.length },
      });
      if (!runtimeSession?.activeTurnId) queueMicrotask(() => void this.#drainQueue(sessionId));
    });
  }

  async #startTurn(sessionId, runtimeSession, input, params) {
    if (this.startingTurns.has(sessionId)) throw kernelError('TURN_START_IN_PROGRESS', 'A Turn is already starting.', 409);
    this.startingTurns.add(sessionId);
    try {
      const result = await runtimeSession.startTurn(input, providerTurnParams(params));
      const completedBeforeResponse = runtimeSession.activeTurnId !== result.runtimeTurnId;
      await this.#saveBinding(sessionId, {
        activeTurnId: runtimeSession.activeTurnId,
        lastTurnId: completedBeforeResponse ? result.runtimeTurnId : null,
        status: completedBeforeResponse ? 'completed' : 'running',
        lastError: null,
      });
      this.#publish(sessionId, {
        type: 'turn_accepted',
        runtimeSessionId: runtimeSession.runtimeSessionId,
        runtimeTurnId: result.runtimeTurnId,
        payload: { status: completedBeforeResponse ? 'completed' : 'running' },
      });
      return { ...result, deliveryMode: 'new' };
    } finally {
      this.startingTurns.delete(sessionId);
    }
  }

  async interrupt(sessionId, expectedTurnId) {
    await this.attach(sessionId);
    const runtimeSession = this.sessions.get(sessionId);
    if (!this.capabilities().interrupt) throw kernelError('RUNTIME_INTERRUPT_UNSUPPORTED', 'Provider cannot interrupt Turns.', 409);
    if (!expectedTurnId || runtimeSession.activeTurnId !== expectedTurnId) {
      throw kernelError('TURN_NOT_ACTIVE', 'The expected Turn is not active.', 409);
    }
    const result = await runtimeSession.interruptTurn(expectedTurnId);
    this.#publish(sessionId, {
      type: 'turn_interrupt_requested',
      runtimeSessionId: runtimeSession.runtimeSessionId,
      runtimeTurnId: expectedTurnId,
      payload: {},
    });
    return result;
  }

  async respondToRequest(sessionId, requestToken, response) {
    const pending = this.pendingRequests.get(requestToken);
    if (!pending || pending.sessionId !== sessionId) throw kernelError('REQUEST_NOT_FOUND', 'Pending request not found.', 404);
    if (pending.resolving) throw kernelError('REQUEST_RESOLVING', 'Pending request is already resolving.', 409);
    pending.resolving = true;
    clearTimeout(pending.timer);
    try {
      await pending.request.respond(response);
      this.pendingRequests.delete(requestToken);
      await this.#saveBinding(sessionId, {
        status: pending.runtimeSession.activeTurnId ? 'running' : 'idle',
        lastError: null,
      });
      this.#publish(sessionId, {
        type: 'request_resolved',
        runtimeSessionId: pending.runtimeSession.runtimeSessionId,
        runtimeTurnId: pending.request.runtimeTurnId,
        payload: { requestToken, source: 'client' },
      });
      return { requestToken, resolved: true };
    } catch (error) {
      pending.resolving = false;
      const remainingMs = Math.max(1, pending.expiresAt - Date.now());
      pending.timer = this.#requestTimer(requestToken, remainingMs);
      throw error;
    }
  }

  async readSnapshot(sessionId) {
    await this.attach(sessionId);
    const runtimeSession = this.sessions.get(sessionId);
    const [binding, runtime] = await Promise.all([
      this.bindingStore.load(sessionId),
      runtimeSession.readSnapshot(),
    ]);
    return {
      sessionId,
      capabilities: this.capabilities(),
      binding,
      runtime,
      queuedTurnCount: (this.turnQueues.get(sessionId) || []).length,
      pendingRequests: this.getPendingRequests(sessionId),
    };
  }

  getPendingRequests(sessionId) {
    return [...this.pendingRequests.values()]
      .filter((pending) => pending.sessionId === sessionId)
      .map((pending) => ({
        requestToken: pending.requestToken,
        type: pending.request.type,
        runtimeSessionId: pending.request.runtimeSessionId,
        runtimeTurnId: pending.request.runtimeTurnId,
        payload: structuredClone(pending.request.payload),
        createdAt: pending.createdAt,
      }));
  }

  subscribe(sessionId, listener, { afterEventId = 0 } = {}) {
    if (typeof listener !== 'function') throw new TypeError('listener is required.');
    for (const event of this.eventBuffer.replay(sessionId, afterEventId).events) listener(event);
    const eventName = `session:${sessionId}`;
    this.on(eventName, listener);
    return () => this.off(eventName, listener);
  }

  replay(sessionId, afterEventId = 0) {
    return this.eventBuffer.replay(sessionId, afterEventId);
  }

  async detach(sessionId) {
    const runtimeSession = this.sessions.get(sessionId);
    if (!runtimeSession) return null;
    if (runtimeSession.activeTurnId) throw kernelError('TURN_ACTIVE', 'Interrupt the active Turn before detaching.', 409);
    await runtimeSession.unsubscribe();
    runtimeSession.close();
    this.sessions.delete(sessionId);
    this.#expireRequests(sessionId, 'session_detached');
    const binding = await this.#saveBinding(sessionId, { activeTurnId: null, status: 'detached' });
    this.#publish(sessionId, {
      type: 'session_detached',
      runtimeSessionId: binding.runtimeSessionId,
      payload: {},
    });
    return binding;
  }

  close() {
    for (const sessionId of this.sessions.keys()) this.#expireRequests(sessionId, 'kernel_closed');
    for (const runtimeSession of this.sessions.values()) runtimeSession.close();
    for (const queue of this.turnQueues.values()) {
      for (const entry of queue) entry.reject(kernelError('KERNEL_CLOSED', 'Session Kernel closed.'));
    }
    this.sessions.clear();
    this.turnQueues.clear();
  }

  #bindRuntimeSession(sessionId, runtimeSession) {
    runtimeSession.on('event', (event) => void this.#handleRuntimeEvent(sessionId, runtimeSession, event));
    runtimeSession.on('request', (request) => void this.#handleRuntimeRequest(sessionId, runtimeSession, request));
    runtimeSession.on('exit', (details) => void this.#handleRuntimeExit(sessionId, runtimeSession, details));
  }

  async #handleRuntimeEvent(sessionId, runtimeSession, event) {
    if (event.type === 'turn_started') {
      await this.#saveBinding(sessionId, { activeTurnId: event.runtimeTurnId, status: 'running', lastError: null });
    } else if (event.type === 'turn_completed') {
      await this.#saveBinding(sessionId, {
        activeTurnId: null,
        lastTurnId: event.runtimeTurnId,
        status: terminalStatus(event.payload?.status),
        lastError: event.payload?.error?.message || null,
      });
      this.#expireRequests(sessionId, 'turn_completed', event.runtimeTurnId);
    }
    this.#publish(sessionId, event);
    if (event.type === 'turn_completed') queueMicrotask(() => void this.#drainQueue(sessionId));
  }

  async #handleRuntimeRequest(sessionId, runtimeSession, request) {
    try {
      if (!this.validateRequest) {
        throw kernelError(
          'REQUEST_POLICY_REQUIRED',
          'Product adapter must configure an explicit agent-request policy.',
          503,
        );
      }
      await this.validateRequest({ sessionId, request, runtimeSession, capabilities: this.capabilities() });
    } catch (error) {
      await request.reject({ code: -32_602, message: error.message });
      this.#publish(sessionId, {
        type: 'request_rejected',
        runtimeSessionId: runtimeSession.runtimeSessionId,
        runtimeTurnId: request.runtimeTurnId,
        payload: { requestType: request.type, reason: 'policy' },
      });
      return;
    }
    const requestToken = `request_${randomUUID()}`;
    const createdAt = Date.now();
    const pending = {
      requestToken,
      sessionId,
      request,
      runtimeSession,
      createdAt,
      expiresAt: createdAt + this.requestTimeoutMs,
      resolving: false,
      timer: null,
    };
    pending.timer = this.#requestTimer(requestToken, this.requestTimeoutMs);
    this.pendingRequests.set(requestToken, pending);
    await this.#saveBinding(sessionId, { status: 'waiting_for_input', lastError: null });
    this.#publish(sessionId, {
      type: 'request_opened',
      runtimeSessionId: runtimeSession.runtimeSessionId,
      runtimeTurnId: request.runtimeTurnId,
      payload: { requestToken, requestType: request.type, request: structuredClone(request.payload) },
    });
  }

  async #handleRuntimeExit(sessionId, runtimeSession, details) {
    if (this.sessions.get(sessionId) === runtimeSession) this.sessions.delete(sessionId);
    this.#expireRequests(sessionId, 'connection_exited');
    await this.#saveBinding(sessionId, {
      activeTurnId: null,
      lastTurnId: details.runtimeTurnId || null,
      status: details.runtimeTurnId ? 'interrupted' : 'disconnected',
      lastError: details.reason || 'connection_exited',
    }).catch(() => {});
    this.#publish(sessionId, {
      type: 'connection_exited',
      runtimeSessionId: details.runtimeSessionId,
      runtimeTurnId: details.runtimeTurnId,
      payload: { reason: details.reason || 'connection_exited' },
    });
  }

  async #drainQueue(sessionId) {
    const runtimeSession = this.sessions.get(sessionId);
    const queue = this.turnQueues.get(sessionId) || [];
    if (!runtimeSession || runtimeSession.activeTurnId || this.startingTurns.has(sessionId) || !queue.length) return;
    const next = queue.shift();
    if (!queue.length) this.turnQueues.delete(sessionId);
    try {
      const result = await this.#startTurn(sessionId, runtimeSession, next.input, next.params);
      next.resolve({ ...result, deliveryMode: 'queue' });
    } catch (error) {
      next.reject(error);
    } finally {
      if (!runtimeSession.activeTurnId && (this.turnQueues.get(sessionId) || []).length) {
        queueMicrotask(() => void this.#drainQueue(sessionId));
      }
    }
  }

  #requestTimer(requestToken, timeoutMs) {
    const timer = setTimeout(() => void this.#timeoutRequest(requestToken), timeoutMs);
    timer.unref?.();
    return timer;
  }

  async #timeoutRequest(requestToken) {
    const pending = this.pendingRequests.get(requestToken);
    if (!pending || pending.resolving) return;
    this.pendingRequests.delete(requestToken);
    await pending.request.reject({ code: -32_000, message: 'Agent request timed out.' }).catch(() => {});
    await this.#saveBinding(pending.sessionId, {
      status: pending.runtimeSession.activeTurnId ? 'running' : 'idle',
      lastError: 'request_timeout',
    }).catch(() => {});
    this.#publish(pending.sessionId, {
      type: 'request_expired',
      runtimeSessionId: pending.runtimeSession.runtimeSessionId,
      runtimeTurnId: pending.request.runtimeTurnId,
      payload: { requestToken, reason: 'timeout' },
    });
  }

  #expireRequests(sessionId, reason, runtimeTurnId = null) {
    for (const [token, pending] of this.pendingRequests) {
      if (pending.sessionId !== sessionId) continue;
      if (runtimeTurnId && pending.request.runtimeTurnId && pending.request.runtimeTurnId !== runtimeTurnId) continue;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(token);
      this.#publish(sessionId, {
        type: 'request_expired',
        runtimeSessionId: pending.runtimeSession.runtimeSessionId,
        runtimeTurnId: pending.request.runtimeTurnId,
        payload: { requestToken: token, reason },
      });
    }
  }

  #publish(sessionId, event) {
    const normalized = this.eventBuffer.publish(sessionId, {
      ...event,
      runtimeProvider: this.provider.id,
    });
    this.emit(`session:${sessionId}`, normalized);
    this.emit('event', normalized);
    return normalized;
  }

  #saveBinding(sessionId, binding, options = {}) {
    const previous = this.bindingQueues.get(sessionId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.bindingStore.save(sessionId, binding, options));
    this.bindingQueues.set(sessionId, next);
    return next.finally(() => {
      if (this.bindingQueues.get(sessionId) === next) this.bindingQueues.delete(sessionId);
    });
  }

  #describe(sessionId, runtimeSession) {
    return {
      sessionId,
      capabilities: this.capabilities(),
      ...runtimeSession.describe(),
      status: runtimeSession.activeTurnId ? 'running' : 'idle',
    };
  }
}

function providerTurnParams(params) {
  const { host: _host, settings: _settings, mode: _mode, ...providerParams } = params;
  return providerParams;
}

function terminalStatus(status) {
  return ['completed', 'failed', 'interrupted', 'cancelled', 'canceled'].includes(status)
    ? status
    : 'completed';
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required.');
}

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive.`);
  return value;
}

function kernelError(code, message, status = 500) {
  return Object.assign(new Error(message), { name: 'AgentSessionKernelError', code, status });
}

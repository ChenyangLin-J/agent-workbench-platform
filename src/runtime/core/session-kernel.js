import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  assertRuntimeProvider,
  CoreEventReplayBuffer,
  createCoreEvent,
} from './contracts.js';

export class AgentSessionKernel extends EventEmitter {
  constructor({
    provider,
    bindingStore,
    eventBuffer = new CoreEventReplayBuffer(),
    validateRequest = null,
    requestTimeoutMs = 15 * 60_000,
    runtimeLeaseMs = 30 * 60_000,
    detachedLeaseMs = null,
    now = () => Date.now(),
  } = {}) {
    super();
    this.setMaxListeners(0);
    this.provider = assertRuntimeProvider(provider);
    if (!bindingStore?.load || !bindingStore?.save) throw new TypeError('bindingStore.load/save are required.');
    this.bindingStore = bindingStore;
    this.eventBuffer = eventBuffer;
    this.validateRequest = validateRequest;
    this.requestTimeoutMs = positiveNumber(requestTimeoutMs, 'requestTimeoutMs');
    this.runtimeLeaseMs = positiveNumber(runtimeLeaseMs, 'runtimeLeaseMs');
    this.detachedLeaseMs = detachedLeaseMs == null
      ? this.runtimeLeaseMs
      : positiveNumber(detachedLeaseMs, 'detachedLeaseMs');
    this.now = typeof now === 'function' ? now : () => Date.now();
    this.sessions = new Map();
    this.detachedSessions = new Map();
    this.deferredSessions = new Map();
    this.leases = new Map();
    this.attachPromises = new Map();
    this.resumePromises = new Map();
    this.startingTurns = new Set();
    this.turnQueues = new Map();
    this.pendingRequests = new Map();
    this.bindingQueues = new Map();
  }

  capabilities() {
    return this.provider.capabilities();
  }

  async listModels(options = {}) {
    if (typeof this.provider.listModels !== 'function') return [];
    return structuredClone(await this.provider.listModels(options));
  }

  async extensionRequest(sessionId, method, params = {}, options = {}) {
    assertSessionId(sessionId);
    const scope = typeof this.provider.extensionScope === 'function'
      ? this.provider.extensionScope(method)
      : 'thread';
    if (scope === 'global') {
      if (typeof this.provider.requestExtension !== 'function') {
        throw kernelError('RUNTIME_EXTENSION_UNSUPPORTED', 'Provider does not expose extension requests.', 501);
      }
      return this.provider.requestExtension(method, params, options);
    }
    const runtimeSession = await this.#ensureRuntime(sessionId, options);
    if (typeof runtimeSession.requestExtension !== 'function') {
      throw kernelError('RUNTIME_EXTENSION_UNSUPPORTED', 'Provider does not expose extension requests.', 501);
    }
    return runtimeSession.requestExtension(method, params);
  }

  async attach(sessionId, options = {}) {
    assertSessionId(sessionId);
    const current = this.sessions.get(sessionId);
    if (current && !current.closed) {
      this.#scheduleLease(sessionId, { renew: true });
      return this.#describe(sessionId, current);
    }
    const reclaimed = this.#reclaimDetached(sessionId);
    if (reclaimed) {
      this.#scheduleLease(sessionId, { renew: true });
      this.#publish(sessionId, {
        type: 'session_attached',
        runtimeSessionId: reclaimed.runtimeSessionId,
        runtimeTurnId: reclaimed.activeTurnId,
        payload: { capabilities: this.capabilities(), reattached: true },
      });
      return this.#describe(sessionId, reclaimed);
    }
    const resuming = this.resumePromises.get(sessionId);
    if (resuming) {
      const runtimeSession = await resuming;
      return this.#describe(sessionId, runtimeSession);
    }
    const deferred = this.deferredSessions.get(sessionId);
    if (deferred) return this.#describeDeferred(sessionId, deferred);
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
    if (binding?.released) {
      this.deferredSessions.set(sessionId, binding);
      this.#publish(sessionId, {
        type: 'session_attached',
        runtimeSessionId: binding.runtimeSessionId,
        payload: { capabilities: this.capabilities(), deferred: true, released: true },
      });
      return this.#describeDeferred(sessionId, binding);
    }
    const runtimeSession = await this.#startRuntime(sessionId, binding, { host, cwd, settings });
    this.#scheduleLease(sessionId, { renew: true });
    this.#publish(sessionId, {
      type: 'session_attached',
      runtimeSessionId: runtimeSession.runtimeSessionId,
      runtimeTurnId: runtimeSession.activeTurnId,
      payload: { capabilities: this.capabilities() },
    });
    return this.#describe(sessionId, runtimeSession);
  }

  async #startRuntime(sessionId, binding, { host = null, cwd = null, settings = {} } = {}) {
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
        released: false,
        releaseReason: null,
        releasedAt: null,
        detachedAt: null,
      });
      queueMicrotask(() => void this.#drainQueue(sessionId));
      return runtimeSession;
    } catch (error) {
      runtimeSession.close();
      throw error;
    }
  }

  async #ensureRuntime(sessionId, options = {}) {
    const current = this.sessions.get(sessionId);
    if (current && !current.closed) return current;
    const reclaimed = this.#reclaimDetached(sessionId);
    if (reclaimed) {
      this.#scheduleLease(sessionId, { renew: true });
      this.#publish(sessionId, {
        type: 'session_attached',
        runtimeSessionId: reclaimed.runtimeSessionId,
        runtimeTurnId: reclaimed.activeTurnId,
        payload: { capabilities: this.capabilities(), reattached: true },
      });
      return reclaimed;
    }
    const deferred = this.deferredSessions.get(sessionId);
    if (!deferred) {
      await this.attach(sessionId, options);
      const attached = this.sessions.get(sessionId);
      if (attached) return attached;
      const stillDeferred = this.deferredSessions.get(sessionId);
      if (!stillDeferred) throw kernelError('SESSION_NOT_ATTACHED', 'Session has no Runtime binding.', 409);
      return this.#resumeDeferred(sessionId, stillDeferred, options);
    }
    return this.#resumeDeferred(sessionId, deferred, options);
  }

  async #resumeDeferred(sessionId, binding, { host = null, cwd = null, settings = {} } = {}) {
    const inFlight = this.resumePromises.get(sessionId);
    if (inFlight) return inFlight;
    const promise = (async () => {
      const runtimeSession = await this.#startRuntime(sessionId, binding, { host, cwd, settings });
      this.#scheduleLease(sessionId, { renew: true });
      this.#publish(sessionId, {
        type: 'session_attached',
        runtimeSessionId: runtimeSession.runtimeSessionId,
        runtimeTurnId: runtimeSession.activeTurnId,
        payload: { capabilities: this.capabilities(), resumed: true },
      });
      return runtimeSession;
    })();
    this.resumePromises.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      this.resumePromises.delete(sessionId);
      if (this.sessions.get(sessionId)) this.deferredSessions.delete(sessionId);
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
    this.#scheduleLease(sessionId, { renew: true });
    this.#publish(sessionId, {
      type: 'session_attached',
      runtimeSessionId: runtimeSession.runtimeSessionId,
      runtimeTurnId: runtimeSession.activeTurnId,
      payload: { capabilities: this.capabilities(), adopted: true },
    });
    return this.#describe(sessionId, runtimeSession);
  }

  async submit(sessionId, input, { mode = 'auto', ...params } = {}) {
    const runtimeSession = await this.#ensureRuntime(sessionId, params);
    this.#renewLease(sessionId);
    if (this.startingTurns.has(sessionId) && mode !== 'new') {
      return this.#queueTurn(sessionId, input, params);
    }
    if (mode === 'steer') {
      if (!runtimeSession.activeTurnId) {
        throw kernelError('TURN_NOT_ACTIVE', 'There is no active turn.', 409);
      }
      if (!this.capabilities().steer) throw kernelError('RUNTIME_STEER_UNSUPPORTED', 'Provider cannot steer an active Turn.', 409);
      const result = await runtimeSession.steerTurn(input, {
        ...params,
        expectedTurnId: runtimeSession.activeTurnId,
      });
      return { ...result, deliveryMode: 'steer' };
    }
    if (runtimeSession.activeTurnId) {
      if (mode === 'queue' || (mode === 'auto' && !this.capabilities().steer)) {
        return this.#queueTurn(sessionId, input, params);
      }
      if (mode === 'new') {
        throw kernelError('TURN_ACTIVE', `Turn ${runtimeSession.activeTurnId} is already active.`, 409);
      }
      if (!this.capabilities().steer) throw kernelError('RUNTIME_STEER_UNSUPPORTED', 'Provider cannot steer an active Turn.', 409);
      try {
        const result = await runtimeSession.steerTurn(input, {
          ...params,
          expectedTurnId: runtimeSession.activeTurnId,
        });
        return { ...result, deliveryMode: 'steer' };
      } catch (error) {
        if (!isLateSteerError(error) || runtimeSession.activeTurnId) throw error;
        return this.#startTurn(sessionId, runtimeSession, input, params, { steerFallback: true });
      }
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

  async #startTurn(sessionId, runtimeSession, input, params, { steerFallback = false } = {}) {
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
        payload: { status: completedBeforeResponse ? 'completed' : 'running', steerFallback },
      });
      return { ...result, deliveryMode: steerFallback ? 'steer-fallback' : 'new' };
    } finally {
      this.startingTurns.delete(sessionId);
    }
  }

  cancelQueuedTurn(sessionId, clientUserMessageId) {
    const queue = this.turnQueues.get(sessionId) || [];
    const index = queue.findIndex((entry) => entry.params?.clientUserMessageId === clientUserMessageId);
    if (index < 0) throw kernelError('QUEUED_TURN_NOT_FOUND', 'The queued Turn is no longer pending.', 409);
    const [removed] = queue.splice(index, 1);
    removed.reject(kernelError('QUEUED_TURN_CANCELLED', 'The queued Turn was cancelled.', 409));
    return { clientUserMessageId, remaining: queue.length };
  }

  async interrupt(sessionId, expectedTurnId) {
    const runtimeSession = await this.#ensureRuntime(sessionId);
    this.#renewLease(sessionId);
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

  async fork(sourceSessionId, targetSessionId, { lastTurnId, host = null, cwd = null, settings = {} } = {}) {
    assertSessionId(sourceSessionId);
    assertSessionId(targetSessionId);
    if (sourceSessionId === targetSessionId) throw kernelError('SESSION_FORK_TARGET_CONFLICT', 'Fork target must be a new Session.', 409);
    if (!this.capabilities().fork) throw kernelError('RUNTIME_FORK_UNSUPPORTED', 'Provider cannot fork Sessions.', 409);
    const normalizedLastTurnId = String(lastTurnId || '').trim();
    if (!normalizedLastTurnId) throw new TypeError('lastTurnId is required.');
    const sourceRuntimeSession = await this.#ensureRuntime(sourceSessionId, { host, cwd, settings });
    this.#renewLease(sourceSessionId);
    if (sourceRuntimeSession.activeTurnId) throw kernelError('RUNTIME_TURN_ACTIVE', 'Cannot fork an active Turn.', 409);
    if (this.sessions.has(targetSessionId) || await this.bindingStore.load(targetSessionId)) {
      throw kernelError('SESSION_ALREADY_ATTACHED', 'Fork target Session already has a Runtime binding.', 409);
    }
    const forked = await sourceRuntimeSession.fork(normalizedLastTurnId, { cwd: cwd ?? sourceRuntimeSession.cwd, ...settings });
    const runtimeSession = this.provider.createSession({ host, cwd: forked.cwd, settings });
    try {
      await runtimeSession.start();
      await runtimeSession.resume(forked.runtimeSessionId, { cwd: forked.cwd, settings });
      return await this.adopt(targetSessionId, runtimeSession);
    } catch (error) {
      runtimeSession.close();
      throw error;
    }
  }

  async respondToRequest(sessionId, requestToken, response) {
    const pending = this.pendingRequests.get(requestToken);
    if (!pending || pending.sessionId !== sessionId) throw kernelError('REQUEST_NOT_FOUND', 'Pending request not found.', 404);
    if (pending.resolving) throw kernelError('REQUEST_RESOLVING', 'Pending request is already resolving.', 409);
    this.#renewLease(sessionId);
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

  async rejectRequest(sessionId, requestToken, error) {
    const pending = this.pendingRequests.get(requestToken);
    if (!pending || pending.sessionId !== sessionId) throw kernelError('REQUEST_NOT_FOUND', 'Pending request not found.', 404);
    if (pending.resolving) throw kernelError('REQUEST_RESOLVING', 'Pending request is already resolving.', 409);
    this.#renewLease(sessionId);
    pending.resolving = true;
    clearTimeout(pending.timer);
    const reason = error && typeof error === 'object' && error.code != null
      ? error
      : { code: -32_000, message: error?.message || String(error || 'Request rejected.') };
    try {
      await pending.request.reject(reason);
      this.pendingRequests.delete(requestToken);
      await this.#saveBinding(sessionId, {
        status: pending.runtimeSession.activeTurnId ? 'running' : 'idle',
        lastError: null,
      });
      this.#publish(sessionId, {
        type: 'request_resolved',
        runtimeSessionId: pending.runtimeSession.runtimeSessionId,
        runtimeTurnId: pending.request.runtimeTurnId,
        payload: { requestToken, source: 'client', rejected: true },
      });
      return { requestToken, resolved: true };
    } catch (rejectError) {
      pending.resolving = false;
      const remainingMs = Math.max(1, pending.expiresAt - Date.now());
      pending.timer = this.#requestTimer(requestToken, remainingMs);
      throw rejectError;
    }
  }

  clearQueue(sessionId, error = kernelError('SESSION_DETACHED', 'The Session was detached.')) {
    this.#rejectQueue(sessionId, error);
  }

  async readSnapshot(sessionId) {
    const runtimeSession = await this.#ensureRuntime(sessionId);
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

  async updateSettings(sessionId, settings, options = {}) {
    assertSessionId(sessionId);
    const runtimeSession = await this.#ensureRuntime(sessionId, options);
    this.#renewLease(sessionId);
    if (runtimeSession.activeTurnId || this.startingTurns.has(sessionId)) {
      throw kernelError('RUNTIME_TURN_ACTIVE', 'Cannot update settings while a Turn is active.', 409);
    }
    if (typeof runtimeSession.updateSettings !== 'function') {
      throw kernelError('RUNTIME_SETTINGS_UPDATE_UNSUPPORTED', 'Provider cannot update Session settings.', 501);
    }
    const result = await runtimeSession.updateSettings(settings);
    await this.#saveBinding(sessionId, { status: 'idle', lastError: null });
    return { sessionId, ...result };
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
    const replay = this.eventBuffer.replay(sessionId, afterEventId);
    if (replay.replayGap) {
      listener(createCoreEvent({
        eventId: replay.latestEventId,
        type: 'replay_gap',
        sessionId,
        runtimeProvider: this.provider.id,
        payload: {
          afterEventId: Number(afterEventId) || 0,
          earliestEventId: replay.earliestEventId,
          latestEventId: replay.latestEventId,
          snapshotRequired: true,
        },
      }));
    } else {
      for (const event of replay.events) listener(event);
    }
    const eventName = `session:${sessionId}`;
    this.on(eventName, listener);
    return () => this.off(eventName, listener);
  }

  replay(sessionId, afterEventId = 0) {
    return this.eventBuffer.replay(sessionId, afterEventId);
  }

  async detach(sessionId) {
    const deferred = this.deferredSessions.get(sessionId);
    if (deferred) {
      this.deferredSessions.delete(sessionId);
      return this.#saveBinding(sessionId, { status: 'released', detachedAt: new Date(this.now()).toISOString() });
    }
    const runtimeSession = this.sessions.get(sessionId);
    if (!runtimeSession) return null;
    this.#clearLease(sessionId);
    const detachedAt = new Date(this.now()).toISOString();
    const detached = { runtimeSession, detachedAt, timer: null };
    detached.timer = setTimeout(() => void this.#expireDetached(sessionId), this.detachedLeaseMs);
    detached.timer.unref?.();
    this.detachedSessions.set(sessionId, detached);
    this.sessions.delete(sessionId);
    const binding = await this.#saveBinding(sessionId, {
      status: runtimeSession.activeTurnId ? 'running' : 'detached',
      detachedAt,
    });
    this.#publish(sessionId, {
      type: 'session_detached',
      runtimeSessionId: runtimeSession.runtimeSessionId,
      runtimeTurnId: runtimeSession.activeTurnId,
      payload: { detachedAt, leaseMs: this.detachedLeaseMs },
    });
    return binding;
  }

  renewRuntimeLease(sessionId) {
    this.#renewLease(sessionId);
  }

  async releaseRuntime(sessionId, { reason = 'explicit' } = {}) {
    assertSessionId(sessionId);
    const runtimeSession = this.sessions.get(sessionId) ?? this.detachedSessions.get(sessionId)?.runtimeSession ?? null;
    if (!runtimeSession) return this.deferredSessions.has(sessionId) ? this.bindingStore.load(sessionId) : null;
    if (runtimeSession.activeTurnId || this.startingTurns.has(sessionId)) {
      throw kernelError('TURN_ACTIVE', 'Interrupt the active Turn before releasing the Runtime.', 409);
    }
    return this.#releaseRuntime(sessionId, runtimeSession, reason);
  }

  close() {
    for (const sessionId of this.sessions.keys()) this.#expireRequests(sessionId, 'kernel_closed');
    for (const sessionId of this.detachedSessions.keys()) this.#expireRequests(sessionId, 'kernel_closed');
    for (const lease of this.leases.values()) if (lease.timer) clearTimeout(lease.timer);
    for (const detached of this.detachedSessions.values()) {
      if (detached.timer) clearTimeout(detached.timer);
      detached.runtimeSession.close();
    }
    for (const runtimeSession of this.sessions.values()) runtimeSession.close();
    for (const queue of this.turnQueues.values()) {
      for (const entry of queue) entry.reject(kernelError('KERNEL_CLOSED', 'Session Kernel closed.'));
    }
    this.sessions.clear();
    this.detachedSessions.clear();
    this.deferredSessions.clear();
    this.leases.clear();
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

  #runtimeFor(sessionId) {
    return this.sessions.get(sessionId) ?? this.detachedSessions.get(sessionId)?.runtimeSession ?? null;
  }

  #reclaimDetached(sessionId) {
    const detached = this.detachedSessions.get(sessionId);
    if (!detached || detached.runtimeSession.closed) {
      this.detachedSessions.delete(sessionId);
      return null;
    }
    if (detached.timer) clearTimeout(detached.timer);
    this.detachedSessions.delete(sessionId);
    this.sessions.set(sessionId, detached.runtimeSession);
    void this.#saveBinding(sessionId, { detachedAt: null }).catch(() => {});
    return detached.runtimeSession;
  }

  #renewLease(sessionId) {
    if (!this.sessions.has(sessionId)) return;
    this.#scheduleLease(sessionId, { renew: true });
  }

  #scheduleLease(sessionId, { renew = false } = {}) {
    const runtimeSession = this.sessions.get(sessionId);
    if (!runtimeSession || runtimeSession.closed) return;
    const lease = this.leases.get(sessionId) || { lastMeaningfulActivityAt: null, timer: null };
    if (lease.timer) clearTimeout(lease.timer);
    if (renew || !lease.lastMeaningfulActivityAt) {
      lease.lastMeaningfulActivityAt = new Date(this.now()).toISOString();
    }
    const expiresAtMs = Date.parse(lease.lastMeaningfulActivityAt) + this.runtimeLeaseMs;
    lease.timer = setTimeout(() => void this.#expireLease(sessionId), Math.max(0, expiresAtMs - this.now()));
    lease.timer.unref?.();
    this.leases.set(sessionId, lease);
    void this.#saveBinding(sessionId, {
      lastMeaningfulActivityAt: lease.lastMeaningfulActivityAt,
      runtimeLeaseExpiresAt: new Date(expiresAtMs).toISOString(),
    }).catch(() => {});
  }

  #clearLease(sessionId) {
    const lease = this.leases.get(sessionId);
    if (lease?.timer) clearTimeout(lease.timer);
    this.leases.delete(sessionId);
  }

  async #expireLease(sessionId) {
    const lease = this.leases.get(sessionId);
    if (lease) lease.timer = null;
    const runtimeSession = this.sessions.get(sessionId);
    if (!runtimeSession || runtimeSession.closed) return;
    const remainingMs = Date.parse(lease?.lastMeaningfulActivityAt || 0) + this.runtimeLeaseMs - this.now();
    if (remainingMs > 0) {
      this.#scheduleLease(sessionId);
      return;
    }
    if (this.#hasActiveWork(sessionId)) {
      const recheckMs = Math.min(60_000, Math.max(100, Math.floor(this.runtimeLeaseMs / 4)));
      if (lease) {
        lease.timer = setTimeout(() => void this.#expireLease(sessionId), recheckMs);
        lease.timer.unref?.();
      }
      return;
    }
    await this.#releaseRuntime(sessionId, runtimeSession, 'idle-ttl');
  }

  async #expireDetached(sessionId) {
    const detached = this.detachedSessions.get(sessionId);
    if (!detached) return;
    detached.timer = null;
    if (this.#hasActiveWork(sessionId)) {
      const recheckMs = Math.min(60_000, Math.max(100, Math.floor(this.detachedLeaseMs / 4)));
      detached.timer = setTimeout(() => void this.#expireDetached(sessionId), recheckMs);
      detached.timer.unref?.();
      return;
    }
    await this.#releaseRuntime(sessionId, detached.runtimeSession, 'detached-ttl');
  }

  #hasActiveWork(sessionId) {
    const runtimeSession = this.#runtimeFor(sessionId);
    if (runtimeSession?.activeTurnId || this.startingTurns.has(sessionId)) return true;
    if ((this.turnQueues.get(sessionId) || []).length) return true;
    for (const pending of this.pendingRequests.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  async #releaseRuntime(sessionId, runtimeSession, reason) {
    this.#clearLease(sessionId);
    const detached = this.detachedSessions.get(sessionId);
    if (detached?.timer) clearTimeout(detached.timer);
    this.detachedSessions.delete(sessionId);
    if (this.sessions.get(sessionId) === runtimeSession) this.sessions.delete(sessionId);
    this.#expireRequests(sessionId, 'runtime_released');
    await runtimeSession.unsubscribe?.().catch(() => {});
    runtimeSession.close();
    const releasedAt = new Date(this.now()).toISOString();
    const binding = await this.#saveBinding(sessionId, {
      activeTurnId: null,
      status: 'released',
      released: true,
      releaseReason: reason,
      releasedAt,
      runtimeLeaseExpiresAt: null,
    }).catch(() => this.bindingStore.load(sessionId));
    this.#publish(sessionId, {
      type: 'runtime_released',
      runtimeSessionId: runtimeSession.runtimeSessionId,
      payload: { reason, releasedAt },
    });
    return binding;
  }

  #describeDeferred(sessionId, binding) {
    return {
      sessionId,
      capabilities: this.capabilities(),
      runtimeProvider: this.provider.id,
      runtimeSessionId: binding.runtimeSessionId || null,
      activeTurnId: null,
      cwd: binding.cwd || null,
      runtimeProfile: null,
      status: 'released',
      released: true,
      releaseReason: binding.releaseReason || null,
    };
  }

  async #handleRuntimeExit(sessionId, runtimeSession, details) {
    if (this.sessions.get(sessionId) === runtimeSession) this.sessions.delete(sessionId);
    const detached = this.detachedSessions.get(sessionId);
    if (detached?.runtimeSession === runtimeSession) {
      if (detached.timer) clearTimeout(detached.timer);
      this.detachedSessions.delete(sessionId);
    }
    this.#clearLease(sessionId);
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
    if ((this.turnQueues.get(sessionId) || []).length) {
      queueMicrotask(() => void this.#ensureRuntime(sessionId).catch(
        (error) => this.#rejectQueue(sessionId, error),
      ));
    }
  }

  #rejectQueue(sessionId, error) {
    const queue = this.turnQueues.get(sessionId) || [];
    this.turnQueues.delete(sessionId);
    for (const entry of queue) entry.reject(error);
  }

  async #drainQueue(sessionId) {
    const runtimeSession = this.#runtimeFor(sessionId);
    const queue = this.turnQueues.get(sessionId) || [];
    if (!runtimeSession || runtimeSession.closed || runtimeSession.activeTurnId || this.startingTurns.has(sessionId) || !queue.length) return;
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

function isLateSteerError(error) {
  return error?.code === 'RUNTIME_TURN_NOT_ACTIVE' || /no active turn|turn.*not active/i.test(error?.message || '');
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

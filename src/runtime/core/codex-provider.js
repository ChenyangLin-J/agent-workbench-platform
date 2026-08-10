import { EventEmitter } from 'node:events';

import { normalizeRuntimeCapabilities } from './contracts.js';

const MAX_COMPLETED_TURNS = 100;

export class CodexAppServerProvider {
  constructor({ connection = null, connectionFor = null } = {}) {
    if (!connection && typeof connectionFor !== 'function') {
      throw new TypeError('Codex provider requires connection or connectionFor.');
    }
    this.id = 'codex';
    this.connection = connection;
    this.connectionFor = connectionFor;
  }

  capabilities() {
    return normalizeRuntimeCapabilities(this.id, {
      resume: true,
      steer: true,
      interrupt: true,
      fork: true,
      approvals: true,
      user_input: true,
      item_stream: true,
      plan_stream: true,
      attachments: true,
    });
  }

  createSession({ host = null, cwd = null, settings = {} } = {}) {
    const connection = this.connectionFor ? this.connectionFor(host) : this.connection;
    return new CodexRuntimeSession({ connection, cwd, settings });
  }
}

export class CodexRuntimeSession extends EventEmitter {
  constructor({ connection, cwd = null, settings = {} } = {}) {
    super();
    if (!connection?.request || !connection?.on) throw new TypeError('Codex connection is required.');
    this.providerId = 'codex';
    this.connection = connection;
    this.cwd = cwd;
    this.settings = structuredClone(settings);
    this.runtimeSessionId = null;
    this.activeTurnId = null;
    this.completedTurnIds = new Set();
    this.runtimeProfile = null;
    this.started = false;
    this.closed = false;
    this.bound = false;
    this.onNotification = (notification) => this.#handleNotification(notification);
    this.onServerRequest = (request) => this.#handleServerRequest(request);
    this.onExit = (details) => this.#handleExit(details);
  }

  async start() {
    if (this.closed) throw providerError('RUNTIME_SESSION_CLOSED', 'Runtime Session is closed.');
    if (this.started) return;
    this.#bind();
    try {
      await this.connection.start();
      this.started = true;
    } catch (error) {
      this.#unbind();
      throw error;
    }
  }

  async create({ cwd = this.cwd, settings = this.settings } = {}) {
    this.#assertStarted();
    const result = await this.connection.request('thread/start', codexSessionParams(cwd, settings));
    const threadId = String(result?.thread?.id || '');
    if (!threadId) throw providerError('RUNTIME_SESSION_ID_MISSING', 'Codex did not return a thread id.');
    this.cwd = cwd;
    this.settings = structuredClone(settings);
    this.runtimeSessionId = threadId;
    this.activeTurnId = null;
    this.completedTurnIds.clear();
    this.runtimeProfile = profileFromResult(result);
    return this.describe();
  }

  async resume(runtimeSessionId, { cwd = this.cwd, settings = this.settings } = {}) {
    this.#assertStarted();
    if (typeof runtimeSessionId !== 'string' || !runtimeSessionId) {
      throw new TypeError('runtimeSessionId is required.');
    }
    const previous = this.#state();
    this.runtimeSessionId = runtimeSessionId;
    this.activeTurnId = null;
    this.completedTurnIds.clear();
    try {
      const result = await this.connection.request('thread/resume', {
        ...codexSessionParams(cwd, settings),
        threadId: runtimeSessionId,
      });
      this.cwd = cwd;
      this.settings = structuredClone(settings);
      this.runtimeSessionId = String(result?.thread?.id || runtimeSessionId);
      this.runtimeProfile = profileFromResult(result);
      const activeTurnId = findActiveTurnId(result);
      this.activeTurnId = this.completedTurnIds.has(activeTurnId) ? null : activeTurnId;
      return this.describe();
    } catch (error) {
      this.#restore(previous);
      throw error;
    }
  }

  async readSnapshot() {
    this.#assertSession();
    const result = await this.connection.request('thread/read', {
      threadId: this.runtimeSessionId,
      includeTurns: true,
    });
    return {
      runtimeProvider: this.providerId,
      runtimeSessionId: this.runtimeSessionId,
      activeTurnId: this.activeTurnId,
      history: result?.thread || null,
    };
  }

  async startTurn(input, params = {}) {
    this.#assertSession();
    if (this.activeTurnId) throw providerError('RUNTIME_TURN_ACTIVE', `Turn ${this.activeTurnId} is active.`);
    const result = await this.connection.request('turn/start', {
      ...params,
      threadId: this.runtimeSessionId,
      input: normalizeInput(input),
    });
    const turnId = String(result?.turn?.id || '');
    if (!turnId) throw providerError('RUNTIME_TURN_ID_MISSING', 'Codex did not return a turn id.');
    this.activeTurnId = this.completedTurnIds.has(turnId) ? null : turnId;
    return { runtimeTurnId: turnId, status: this.activeTurnId ? 'running' : 'completed', raw: result.turn };
  }

  async steerTurn(input, { expectedTurnId = this.activeTurnId, ...params } = {}) {
    this.#assertSession();
    if (!this.activeTurnId || expectedTurnId !== this.activeTurnId) {
      throw providerError('RUNTIME_TURN_NOT_ACTIVE', 'The expected turn is not active.');
    }
    try {
      const result = await this.connection.request('turn/steer', {
        ...params,
        threadId: this.runtimeSessionId,
        expectedTurnId,
        input: normalizeInput(input),
      });
      if (String(result?.turnId || '') !== expectedTurnId) {
        throw providerError('RUNTIME_STEER_MISMATCH', 'Codex steered an unexpected turn.');
      }
      return { runtimeTurnId: expectedTurnId, status: 'running' };
    } catch (error) {
      if (/no active turn/i.test(error.message)) this.activeTurnId = null;
      throw error;
    }
  }

  async interruptTurn(expectedTurnId = this.activeTurnId) {
    this.#assertSession();
    if (!this.activeTurnId || expectedTurnId !== this.activeTurnId) {
      throw providerError('RUNTIME_TURN_NOT_ACTIVE', 'The expected turn is not active.');
    }
    await this.connection.request('turn/interrupt', {
      threadId: this.runtimeSessionId,
      turnId: expectedTurnId,
    });
    return { runtimeTurnId: expectedTurnId, status: 'interrupt_requested' };
  }

  async fork(lastTurnId, params = {}) {
    this.#assertSession();
    if (this.activeTurnId) throw providerError('RUNTIME_TURN_ACTIVE', 'Cannot fork an active turn.');
    const result = await this.connection.request('thread/fork', {
      ...codexSessionParams(params.cwd ?? this.cwd, { ...this.settings, ...params }),
      threadId: this.runtimeSessionId,
      lastTurnId,
    });
    const threadId = String(result?.thread?.id || '');
    if (!threadId) throw providerError('RUNTIME_SESSION_ID_MISSING', 'Codex did not return a forked thread id.');
    this.runtimeSessionId = threadId;
    this.activeTurnId = null;
    this.completedTurnIds.clear();
    return this.describe();
  }

  async unsubscribe() {
    this.#assertSession();
    if (this.activeTurnId) throw providerError('RUNTIME_TURN_ACTIVE', 'Cannot unsubscribe an active turn.');
    await this.connection.request('thread/unsubscribe', { threadId: this.runtimeSessionId });
    const previousRuntimeSessionId = this.runtimeSessionId;
    this.runtimeSessionId = null;
    return { runtimeSessionId: previousRuntimeSessionId };
  }

  describe() {
    return {
      runtimeProvider: this.providerId,
      runtimeSessionId: this.runtimeSessionId,
      activeTurnId: this.activeTurnId,
      cwd: this.cwd,
      runtimeProfile: this.runtimeProfile ? structuredClone(this.runtimeProfile) : null,
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.started = false;
    this.#unbind();
  }

  #bind() {
    if (this.bound) return;
    this.bound = true;
    this.connection.on('notification', this.onNotification);
    this.connection.on('server-request', this.onServerRequest);
    this.connection.on('exit', this.onExit);
  }

  #unbind() {
    if (!this.bound) return;
    this.bound = false;
    this.connection.off('notification', this.onNotification);
    this.connection.off('server-request', this.onServerRequest);
    this.connection.off('exit', this.onExit);
  }

  #handleNotification(notification) {
    if (!this.#tracks(notification)) return;
    const { method, params = {} } = notification;
    const event = mapCodexEvent(method, params, this.activeTurnId);
    if (event.type === 'turn_started' && event.runtimeTurnId && !this.completedTurnIds.has(event.runtimeTurnId)) {
      this.activeTurnId = event.runtimeTurnId;
    }
    if (event.type === 'turn_completed') {
      if (event.runtimeTurnId) this.#rememberCompleted(event.runtimeTurnId);
      if (!event.runtimeTurnId || event.runtimeTurnId === this.activeTurnId) this.activeTurnId = null;
    }
    this.emit('event', event);
  }

  #handleServerRequest(request) {
    if (!this.#tracks(request)) return;
    const mapped = mapCodexRequest(request, this.activeTurnId);
    if (!mapped) {
      void request.reject({ code: -32_601, message: `Unsupported Codex request ${request.method}.` });
      return;
    }
    if (this.listenerCount('request') === 0) {
      void request.reject({ code: -32_601, message: `No handler for Codex request ${request.method}.` });
      return;
    }
    this.emit('request', mapped);
  }

  #handleExit(details) {
    if (this.closed) return;
    const interrupted = this.activeTurnId;
    this.activeTurnId = null;
    this.started = false;
    this.#unbind();
    this.emit('exit', {
      runtimeSessionId: this.runtimeSessionId,
      runtimeTurnId: interrupted,
      reason: 'connection_exited',
      details,
    });
  }

  #tracks(message) {
    const threadId = extractThreadId(message);
    return Boolean(threadId && this.runtimeSessionId && threadId === this.runtimeSessionId);
  }

  #rememberCompleted(turnId) {
    this.completedTurnIds.add(turnId);
    while (this.completedTurnIds.size > MAX_COMPLETED_TURNS) {
      this.completedTurnIds.delete(this.completedTurnIds.values().next().value);
    }
  }

  #assertStarted() {
    if (!this.started || this.closed) throw providerError('RUNTIME_SESSION_NOT_STARTED', 'Runtime Session is not started.');
  }

  #assertSession() {
    this.#assertStarted();
    if (!this.runtimeSessionId) throw providerError('RUNTIME_SESSION_MISSING', 'Runtime Session has not been created.');
  }

  #state() {
    return {
      cwd: this.cwd,
      settings: structuredClone(this.settings),
      runtimeSessionId: this.runtimeSessionId,
      activeTurnId: this.activeTurnId,
      runtimeProfile: this.runtimeProfile ? structuredClone(this.runtimeProfile) : null,
      completedTurnIds: new Set(this.completedTurnIds),
    };
  }

  #restore(state) {
    Object.assign(this, state);
  }
}

function codexSessionParams(cwd, settings) {
  return {
    ...(settings || {}),
    ...(cwd ? { cwd } : {}),
  };
}

function normalizeInput(input) {
  if (Array.isArray(input)) return structuredClone(input);
  const text = String(input || '').trim();
  if (!text) throw new TypeError('Turn input cannot be empty.');
  return [{ type: 'text', text }];
}

function findActiveTurnId(result) {
  const turns = [
    ...(Array.isArray(result?.initialTurnsPage?.data) ? result.initialTurnsPage.data : []),
    ...(Array.isArray(result?.thread?.turns) ? result.thread.turns : []),
  ];
  return String(turns.find((turn) => turn?.status === 'inProgress')?.id || '') || null;
}

function profileFromResult(result) {
  const profile = {
    model: result?.model ?? null,
    sandbox: result?.sandbox ?? null,
    approvalPolicy: result?.approvalPolicy ?? null,
  };
  return Object.values(profile).some((value) => value != null) ? profile : null;
}

function mapCodexEvent(method, params, activeTurnId) {
  const common = {
    runtimeSessionId: String(params?.threadId || '') || null,
    runtimeTurnId: String(params?.turnId || params?.turn?.id || activeTurnId || '') || null,
    providerEvent: method,
  };
  if (method === 'turn/started') return { ...common, type: 'turn_started', payload: { status: 'running' } };
  if (method === 'turn/completed') {
    return {
      ...common,
      type: 'turn_completed',
      payload: { status: params?.turn?.status || 'completed', error: params?.turn?.error || null },
    };
  }
  if (method === 'item/started') return { ...common, type: 'item_started', payload: { item: params.item } };
  if (method === 'item/completed') return { ...common, type: 'item_completed', payload: { item: params.item } };
  if (method === 'turn/plan/updated') return { ...common, type: 'plan_updated', payload: { plan: params.plan || [], explanation: params.explanation || '' } };
  if (/\/delta$/i.test(method) || /\/progress$/i.test(method)) {
    return { ...common, type: 'item_delta', payload: { itemId: params.itemId || null, delta: params.delta ?? params.message ?? '' } };
  }
  if (['warning', 'guardianWarning', 'configWarning', 'model/rerouted'].includes(method)) {
    return { ...common, type: 'provider_warning', payload: structuredClone(params) };
  }
  return { ...common, type: 'provider_event', payload: structuredClone(params) };
}

function mapCodexRequest(request, activeTurnId) {
  const type = {
    'item/commandExecution/requestApproval': 'command_approval',
    'item/fileChange/requestApproval': 'file_approval',
    'item/permissions/requestApproval': 'permission_approval',
    'item/tool/requestUserInput': 'user_input',
    'mcpServer/elicitation/request': 'elicitation',
  }[request.method];
  if (!type) return null;
  return {
    type,
    providerRequestId: String(request.id),
    runtimeSessionId: extractThreadId(request),
    runtimeTurnId: String(request.params?.turnId || activeTurnId || '') || null,
    payload: structuredClone(request.params || {}),
    respond: (response) => request.respond(codexRequestResponse(type, response)),
    reject: (error) => request.reject(error),
  };
}

function extractThreadId(message) {
  const value =
    message?.params?.threadId ??
    message?.message?.params?.threadId ??
    (message?.method === 'thread/started' ? message?.params?.thread?.id : null);
  const normalized = value == null ? '' : String(value).trim();
  return normalized || null;
}

function codexRequestResponse(type, response = {}) {
  if (['command_approval', 'file_approval'].includes(type)) {
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(response.decision)) {
      throw new TypeError('Invalid approval decision.');
    }
    return { decision: response.decision };
  }
  if (type === 'permission_approval') {
    if (response.scope != null && !['turn', 'session'].includes(response.scope)) throw new TypeError('Invalid permission scope.');
    return { permissions: structuredClone(response.permissions || {}), ...(response.scope ? { scope: response.scope } : {}) };
  }
  if (type === 'user_input') {
    if (!response.answers || typeof response.answers !== 'object') throw new TypeError('answers are required.');
    return { answers: structuredClone(response.answers) };
  }
  if (type === 'elicitation') {
    if (!['accept', 'decline', 'cancel'].includes(response.action)) throw new TypeError('Invalid elicitation action.');
    return { action: response.action, ...(response.content === undefined ? {} : { content: response.content }) };
  }
  throw new TypeError(`Unsupported request type: ${type}`);
}

function providerError(code, message) {
  return Object.assign(new Error(message), { name: 'AgentRuntimeProviderError', code });
}

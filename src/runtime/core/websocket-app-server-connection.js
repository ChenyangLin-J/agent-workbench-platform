import { EventEmitter } from 'node:events';

import { coreError } from './app-server-connection.js';

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: 'codex_workbench_core',
  title: 'Codex Workbench Core',
  version: '0.1.0',
});

export class WebSocketAppServerConnection extends EventEmitter {
  constructor({
    url,
    WebSocketImpl = globalThis.WebSocket,
    ensureServer = null,
    initializeParams = {},
    requestTimeoutMs = 30_000,
  } = {}) {
    super();
    this.setMaxListeners(0);
    if (typeof url !== 'string' || !/^wss?:\/\//.test(url)) throw new TypeError('A ws:// or wss:// url is required.');
    if (typeof WebSocketImpl !== 'function') throw new TypeError('WebSocketImpl is required.');
    if (ensureServer != null && typeof ensureServer !== 'function') throw new TypeError('ensureServer must be a function.');
    this.url = url;
    this.WebSocketImpl = WebSocketImpl;
    this.ensureServer = ensureServer;
    this.initializeParams = {
      ...initializeParams,
      clientInfo: { ...DEFAULT_CLIENT_INFO, ...(initializeParams.clientInfo || {}) },
    };
    this.requestTimeoutMs = positiveNumber(requestTimeoutMs, 'requestTimeoutMs');
    this.socket = null;
    this.state = 'idle';
    this.startPromise = null;
    this.initializeResult = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.closing = false;
  }

  async start() {
    if (this.state === 'ready') return this.initializeResult;
    if (this.startPromise) return this.startPromise;
    if (!['idle', 'stopped'].includes(this.state)) {
      throw coreError('APP_SERVER_NOT_STARTABLE', `Cannot start from ${this.state}.`);
    }
    this.state = 'starting';
    this.startPromise = this.#start();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
    try {
      await this.ensureServer?.();
      await this.#connect();
      const result = await this.request('initialize', this.initializeParams);
      await this.notify('initialized', {});
      this.initializeResult = result;
      this.state = 'ready';
      this.emit('ready', result);
      return result;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  #connect() {
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.url);
      this.socket = socket;
      this.closing = false;
      const onOpen = () => {
        socket.removeEventListener('error', onInitialError);
        resolve();
      };
      const onInitialError = () => reject(coreError('APP_SERVER_CONNECTION_FAILED', `Could not connect to ${this.url}.`));
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onInitialError, { once: true });
      socket.addEventListener('message', (event) => this.#handleMessage(event.data));
      socket.addEventListener('close', (event) => this.#handleClose(event));
      socket.addEventListener('error', () => {
        if (this.state === 'ready') this.emit('protocol-error', coreError('APP_SERVER_CONNECTION_ERROR', 'WebSocket connection error.'), '');
      });
    });
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (typeof method !== 'string' || !method) return Promise.reject(new TypeError('method is required.'));
    this.#assertWritable();
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(coreError('APP_SERVER_REQUEST_TIMEOUT', `${method} timed out.`, { id, method }));
      }, positiveNumber(timeoutMs, 'timeoutMs'));
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.#takePending(id)?.reject(coreError('APP_SERVER_WRITE_FAILED', error.message, { id, method }));
      }
    });
  }

  notify(method, params = {}) {
    this.#assertWritable();
    this.socket.send(JSON.stringify({ method, params }));
    return Promise.resolve();
  }

  respond(id, result = null) {
    this.#assertWritable();
    this.socket.send(JSON.stringify({ id, result }));
    return Promise.resolve();
  }

  respondError(id, error) {
    this.#assertWritable();
    this.socket.send(JSON.stringify({
      id,
      error: {
        code: Number.isInteger(error?.code) ? error.code : -32_000,
        message: String(error?.message || 'App Server request rejected.'),
        ...(error?.data === undefined ? {} : { data: error.data }),
      },
    }));
    return Promise.resolve();
  }

  close() {
    if (this.state === 'closed') return;
    this.closing = true;
    this.state = 'closed';
    this.#rejectPending(coreError('APP_SERVER_CLOSED', 'App Server connection closed.'));
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close?.();
    } catch {
      // A failed connection may still be in CONNECTING state and cannot be closed cleanly.
    }
    this.emit('close');
  }

  #handleMessage(data) {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch (error) {
      this.emit('protocol-error', error, '');
      return;
    }
    const hasId = Object.hasOwn(message, 'id') && message.id !== null;
    const hasMethod = typeof message.method === 'string' && message.method;
    if (hasId && !hasMethod) {
      const pending = this.#takePending(message.id);
      if (!pending) return void this.emit('orphan-response', message);
      if (message.error) pending.reject(coreError('APP_SERVER_RESPONSE_ERROR', message.error.message || pending.method, message.error));
      else pending.resolve(message.result);
      return;
    }
    if (hasId && hasMethod) {
      let handled = false;
      const request = {
        id: message.id,
        method: message.method,
        params: message.params,
        get handled() { return handled; },
        respond: (result) => {
          if (handled) return Promise.reject(coreError('APP_SERVER_REQUEST_HANDLED', 'Request already handled.'));
          handled = true;
          return this.respond(message.id, result);
        },
        reject: (error) => {
          if (handled) return Promise.reject(coreError('APP_SERVER_REQUEST_HANDLED', 'Request already handled.'));
          handled = true;
          return this.respondError(message.id, error);
        },
      };
      this.emit('server-request', request);
      return;
    }
    if (hasMethod) return void this.emit('notification', { method: message.method, params: message.params, message });
    this.emit('protocol-error', coreError('APP_SERVER_PROTOCOL_ERROR', 'Unrecognized JSON-RPC message.'), '');
  }

  #handleClose(event) {
    this.socket = null;
    if (this.closing) return;
    this.state = 'stopped';
    const error = coreError('APP_SERVER_CONNECTION_CLOSED', 'App Server WebSocket connection closed.');
    this.#rejectPending(error);
    this.emit('exit', { code: event?.code, reason: event?.reason, error });
  }

  #assertWritable() {
    if (!this.socket || this.socket.readyState !== 1 || ['closed', 'stopped'].includes(this.state)) {
      throw coreError('APP_SERVER_NOT_RUNNING', 'App Server is not connected.');
    }
  }

  #takePending(id) {
    const key = typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id;
    const pending = this.pending.get(key);
    if (!pending) return null;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    return pending;
  }

  #rejectPending(error) {
    for (const id of [...this.pending.keys()]) this.#takePending(id)?.reject(error);
  }
}

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive.`);
  return value;
}

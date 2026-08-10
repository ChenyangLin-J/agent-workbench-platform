import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: 'codex_workbench_core',
  title: 'Codex Workbench Core',
  version: '0.1.0',
});

export class AppServerConnection extends EventEmitter {
  constructor({
    command,
    args = ['app-server'],
    cwd,
    env,
    childProcess = null,
    spawnProcess = spawn,
    initializeParams = {},
    requestTimeoutMs = 30_000,
    writeTimeoutMs = 30_000,
    maxBufferBytes = 1_048_576,
    maxLineBytes = 1_048_576,
    maxStderrBytes = 16_384,
    forceKillAfterMs = 2_000,
    redactedValues = [],
  } = {}) {
    super();
    this.setMaxListeners(0);
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.providedChild = childProcess;
    this.spawnProcess = spawnProcess;
    this.initializeParams = {
      ...initializeParams,
      clientInfo: { ...DEFAULT_CLIENT_INFO, ...(initializeParams.clientInfo || {}) },
    };
    this.requestTimeoutMs = positiveNumber(requestTimeoutMs, 'requestTimeoutMs');
    this.writeTimeoutMs = positiveNumber(writeTimeoutMs, 'writeTimeoutMs');
    this.maxBufferBytes = positiveNumber(maxBufferBytes, 'maxBufferBytes');
    this.maxLineBytes = positiveNumber(maxLineBytes, 'maxLineBytes');
    this.maxStderrBytes = positiveNumber(maxStderrBytes, 'maxStderrBytes');
    this.forceKillAfterMs = positiveNumber(forceKillAfterMs, 'forceKillAfterMs');
    this.redactedValues = redactedValues.map(String).filter(Boolean);
    this.child = null;
    this.state = 'idle';
    this.startPromise = null;
    this.initializeResult = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.decoder = new StringDecoder('utf8');
    this.handlers = null;
    this.exitHandled = false;
  }

  async start() {
    if (this.state === 'ready') return this.initializeResult;
    if (this.startPromise) return this.startPromise;
    if (this.state !== 'idle') throw coreError('APP_SERVER_NOT_STARTABLE', `Cannot start from ${this.state}.`);
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
      const child = this.providedChild || this.#spawn();
      this.#attach(child);
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
      this.pending.set(id, { id, method, resolve, reject, timer });
      this.#write({ id, method, params }).catch((error) => {
        const pending = this.#takePending(id);
        pending?.reject(coreError('APP_SERVER_WRITE_FAILED', error.message, { id, method }));
      });
    });
  }

  notify(method, params = {}) {
    this.#assertWritable();
    return this.#write({ method, params });
  }

  respond(id, result = null) {
    this.#assertWritable();
    return this.#write({ id, result });
  }

  respondError(id, error) {
    this.#assertWritable();
    return this.#write({ id, error: normalizeRpcError(error) });
  }

  close({ signal = 'SIGTERM' } = {}) {
    if (this.state === 'closed') return;
    const child = this.child;
    this.state = 'closed';
    this.exitHandled = true;
    this.#rejectPending(coreError('APP_SERVER_CLOSED', 'App Server connection closed.'));
    this.#detach();
    if (child?.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    if (child && child.exitCode == null && typeof child.kill === 'function') {
      child.kill(signal);
      const timer = setTimeout(() => {
        if (child.exitCode == null) child.kill('SIGKILL');
      }, this.forceKillAfterMs);
      timer.unref?.();
    }
    this.child = null;
    this.emit('close');
  }

  #spawn() {
    if (typeof this.command !== 'string' || !path.isAbsolute(this.command)) {
      throw coreError('APP_SERVER_CONFIG_REQUIRED', 'command must be an explicit absolute path.');
    }
    if (typeof this.cwd !== 'string' || !path.isAbsolute(this.cwd)) {
      throw coreError('APP_SERVER_CONFIG_REQUIRED', 'cwd must be an explicit absolute path.');
    }
    if (!this.env || typeof this.env !== 'object' || Array.isArray(this.env)) {
      throw coreError('APP_SERVER_CONFIG_REQUIRED', 'env must be explicit.');
    }
    return this.spawnProcess(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
  }

  #attach(child) {
    if (!child?.stdin?.write || !child?.stdout?.on || !child?.on) throw new TypeError('Invalid App Server child.');
    this.child = child;
    this.exitHandled = false;
    this.stdoutBuffer = '';
    this.decoder = new StringDecoder('utf8');
    this.handlers = {
      stdout: (chunk) => this.#handleStdout(chunk),
      stderr: (chunk) => this.emit('stderr', sanitizeText(chunk, this.maxStderrBytes, this.redactedValues)),
      error: (error) => this.#handleExit(error),
      exit: (code, signal) => this.#handleExit(coreError('APP_SERVER_EXITED', `Exited (${code ?? signal ?? 'unknown'}).`), { code, signal }),
    };
    child.stdout.on('data', this.handlers.stdout);
    child.stderr?.on?.('data', this.handlers.stderr);
    child.on('error', this.handlers.error);
    child.on('exit', this.handlers.exit);
  }

  #detach() {
    if (!this.child || !this.handlers) return;
    this.child.stdout?.off?.('data', this.handlers.stdout);
    this.child.stderr?.off?.('data', this.handlers.stderr);
    this.child.off?.('error', this.handlers.error);
    this.child.off?.('exit', this.handlers.exit);
    this.handlers = null;
  }

  #handleStdout(chunk) {
    this.stdoutBuffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    if (Buffer.byteLength(this.stdoutBuffer) > this.maxBufferBytes) {
      const error = coreError('APP_SERVER_OUTPUT_LIMIT', 'App Server output buffer limit exceeded.');
      this.emit('protocol-error', error, '');
      this.#handleExit(error);
      return;
    }
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) this.#handleLine(line);
  }

  #handleLine(line) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line) > this.maxLineBytes) {
      this.emit('protocol-error', coreError('APP_SERVER_LINE_LIMIT', 'Protocol line limit exceeded.'), '');
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.emit('protocol-error', error, sanitizeText(line, this.maxStderrBytes, this.redactedValues));
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

  #write(message) {
    const line = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(coreError('APP_SERVER_WRITE_TIMEOUT', 'App Server write timed out.'));
      }, this.writeTimeoutMs);
      timer.unref?.();
      try {
        this.child.stdin.write(line, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  #assertWritable() {
    if (!this.child?.stdin || this.state === 'closed' || this.state === 'stopped') {
      throw coreError('APP_SERVER_NOT_RUNNING', 'App Server is not running.');
    }
  }

  #takePending(id) {
    const pending = this.pending.get(id);
    if (!pending) return null;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    return pending;
  }

  #rejectPending(error) {
    for (const id of [...this.pending.keys()]) this.#takePending(id)?.reject(error);
  }

  #handleExit(error, details = {}) {
    if (this.exitHandled) return;
    this.exitHandled = true;
    const trailing = `${this.stdoutBuffer}${this.decoder.end()}`;
    this.stdoutBuffer = '';
    if (trailing.trim()) this.#handleLine(trailing);
    this.state = 'stopped';
    this.#rejectPending(error);
    this.#detach();
    this.child = null;
    this.emit('exit', { ...details, error });
  }
}

export function coreError(code, message, details = {}) {
  const error = new Error(message);
  error.name = 'CodexWorkbenchCoreError';
  error.code = code;
  Object.assign(error, details);
  return error;
}

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be positive.`);
  return value;
}

function normalizeRpcError(error) {
  return {
    code: Number.isInteger(error?.code) ? error.code : -32_000,
    message: String(error?.message || 'App Server request rejected.'),
    ...(error?.data === undefined ? {} : { data: error.data }),
  };
}

function sanitizeText(value, limit, redactedValues) {
  let text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  for (const secret of redactedValues) text = text.split(secret).join('[REDACTED]');
  if (text.length > limit) text = `${text.slice(0, limit)}…`;
  return text;
}

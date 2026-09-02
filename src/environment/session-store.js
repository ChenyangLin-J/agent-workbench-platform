import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { normalizeSessionAttachment } from '../attachments.js';

const STORE_VERSION = 1;
const MAX_MESSAGES_PER_SESSION = 2_000;
const MAX_TECHNICAL_ITEMS_PER_SESSION = 2_000;

export class EnvironmentSessionStore {
  constructor({ stateRoot, now = () => new Date(), uuid = randomUUID } = {}) {
    if (typeof stateRoot !== 'string' || !stateRoot.trim()) throw new TypeError('stateRoot is required');
    this.stateRoot = stateRoot;
    this.path = join(stateRoot, 'sessions.json');
    this.now = now;
    this.uuid = uuid;
    this.queue = Promise.resolve();
    this.ready = this.#initialize();
  }

  async list({ ownerId = null } = {}) {
    const document = await this.#readQueued();
    return Object.values(document.sessions)
      .filter((session) => ownerId == null || session.ownerId === ownerId)
      .map(publicSession)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  async create({ title = '新对话', ownerId = null } = {}) {
    const sessionId = `session-${this.uuid()}`;
    const timestamp = this.#time();
    const normalizedOwnerId = ownerId == null ? null : nonEmptyString(ownerId, 'Session owner');
    await this.#mutate((document) => {
      document.sessions[sessionId] = {
        id: sessionId,
        ownerId: normalizedOwnerId,
        title: nonEmptyString(title, 'Session title'),
        status: 'idle',
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        messages: [],
        technicalItems: [],
        plan: [],
      };
    });
    return this.get(sessionId);
  }

  async createBranch(sourceSessionId, { beforeTurnId, ownerId = null, title = null } = {}) {
    const targetTurnId = nonEmptyString(beforeTurnId, 'Branch Turn id');
    const sessionId = `session-${this.uuid()}`;
    const timestamp = this.#time();
    await this.#mutate((document) => {
      const source = requireSession(document, sourceSessionId);
      requireOwnedSession(source, sourceSessionId, ownerId);
      const messageIndex = source.messages.findIndex((message) => message.turnId === targetTurnId);
      if (messageIndex < 0) throw storeError('SESSION_BRANCH_TURN_NOT_FOUND', `Turn not found: ${targetTurnId}`, 404);
      const messages = structuredClone(source.messages.slice(0, messageIndex));
      const retainedTurnIds = new Set(messages.map((message) => message.turnId).filter(Boolean));
      document.sessions[sessionId] = {
        id: sessionId,
        ownerId: source.ownerId,
        title: title == null ? source.title : nonEmptyString(title, 'Session title'),
        status: 'idle',
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        messages,
        technicalItems: structuredClone(source.technicalItems.filter((item) => retainedTurnIds.has(item.turnId))),
        plan: [],
      };
    });
    return this.get(sessionId, { ownerId });
  }

  async remove(sessionId, { ownerId = null, requireUnbound = false } = {}) {
    let removed = null;
    await this.#mutate((document) => {
      const session = document.sessions[sessionId];
      requireOwnedSession(session, sessionId, ownerId);
      if (requireUnbound && document.bindings[sessionId]) {
        throw storeError('SESSION_BOUND', `Session is already bound: ${sessionId}`, 409);
      }
      removed = sessionView(session, document.bindings[sessionId]);
      delete document.sessions[sessionId];
      delete document.bindings[sessionId];
      if (document.queuedTurns) delete document.queuedTurns[sessionId];
    });
    return removed;
  }

  async get(sessionId, { ownerId = null } = {}) {
    const document = await this.#readQueued();
    const session = document.sessions[sessionId];
    requireOwnedSession(session, sessionId, ownerId);
    return sessionView(session, document.bindings[sessionId]);
  }

  async load(sessionId) {
    const document = await this.#readQueued();
    return document.bindings[sessionId] ? structuredClone(document.bindings[sessionId]) : null;
  }

  async save(sessionId, patch = {}) {
    let binding;
    await this.#mutate((document) => {
      const session = document.sessions[sessionId];
      if (!session) throw storeError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
      binding = {
        ...(document.bindings[sessionId] || {}),
        ...structuredClone(patch),
        sessionId,
        updatedAt: this.#time(),
      };
      document.bindings[sessionId] = binding;
      session.status = sessionStatus(binding.status, session.status);
      session.updatedAt = binding.updatedAt;
      if (['completed', 'failed', 'interrupted', 'cancelled', 'canceled'].includes(binding.status)) {
        session.completedAt = binding.updatedAt;
      }
    });
    return structuredClone(binding);
  }

  async loadQueuedTurns() {
    const document = await this.#readQueued();
    return structuredClone(document.queuedTurns || {});
  }

  async saveQueuedTurns(entries = {}) {
    let saved;
    await this.#mutate((document) => {
      saved = entries && typeof entries === 'object' && !Array.isArray(entries)
        ? structuredClone(entries)
        : {};
      document.queuedTurns = saved;
    });
    return structuredClone(saved);
  }

  async recordUserInput(sessionId, input, { attachments = [], ownerId = null, turnId = null } = {}) {
    const content = inputText(input);
    if (!content) throw new TypeError('Session input cannot be empty');
    const normalizedAttachments = Array.isArray(attachments)
      ? attachments.map((attachment, index) => normalizeSessionAttachment(attachment, `attachment-${index}`))
      : [];
    await this.#mutate((document) => {
      const session = requireSession(document, sessionId);
      requireOwnedSession(session, sessionId, ownerId);
      if (!session.messages.length && defaultSessionTitle(session.title)) {
        session.title = titleFromUserInput(content, normalizedAttachments);
      }
      const message = {
        id: `message-${this.uuid()}`,
        role: 'user',
        phase: 'answer',
        content,
        attachments: normalizedAttachments,
        turnId: turnId == null ? null : nonEmptyString(turnId, 'Runtime Turn id'),
        turnStatus: null,
        createdAt: this.#time(),
      };
      const existingTurnIndex = message.turnId == null
        ? -1
        : session.messages.findIndex((candidate) => candidate.turnId === message.turnId);
      if (existingTurnIndex === -1) session.messages.push(message);
      else session.messages.splice(existingTurnIndex, 0, message);
      session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
      session.updatedAt = this.#time();
    });
  }

  async applyEvent(event) {
    if (!event?.sessionId) return;
    await this.#mutate((document) => {
      const session = document.sessions[event.sessionId];
      if (!session) return;
      const timestamp = new Date(event.createdAt || Date.now()).toISOString();
      if (event.type === 'turn_started') {
        session.status = 'running';
        bindLatestUserMessage(session, event.runtimeTurnId);
      } else if (event.type === 'turn_completed') {
        session.status = event.payload?.status === 'completed' ? 'idle' : 'error';
        session.completedAt = timestamp;
        for (const message of session.messages) {
          if (message.turnId === event.runtimeTurnId) message.turnStatus = event.payload?.status || 'completed';
        }
      } else if (event.type === 'request_opened') {
        session.status = 'waiting';
      } else if (['request_resolved', 'request_rejected', 'request_expired'].includes(event.type)) {
        session.status = document.bindings[event.sessionId]?.activeTurnId ? 'running' : 'idle';
      } else if (event.type === 'connection_exited') {
        session.status = 'error';
      } else if (event.type === 'plan_updated') {
        session.plan = normalizePlan(event.payload?.plan);
      } else if (event.type === 'item_delta') {
        applyAgentDelta(session, event);
      } else if (['item_started', 'item_completed'].includes(event.type)) {
        applyRuntimeItem(session, event);
      }
      session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
      session.technicalItems = session.technicalItems.slice(-MAX_TECHNICAL_ITEMS_PER_SESSION);
      session.updatedAt = timestamp;
    });
  }

  async #initialize() {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    try {
      await open(this.path, 'wx', 0o600).then(async (handle) => {
        try {
          await handle.writeFile(`${JSON.stringify(emptyStore(), null, 2)}\n`, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
      });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }

  async #read() {
    await this.ready;
    const document = JSON.parse(await readFile(this.path, 'utf8'));
    if (document?.version !== STORE_VERSION || !document.sessions || !document.bindings) {
      throw storeError('SESSION_STORE_INVALID', `Invalid Session store: ${this.path}`, 500);
    }
    return document;
  }

  #readQueued() {
    const operation = this.queue.catch(() => {}).then(() => this.#read());
    this.queue = operation.then(() => undefined);
    return operation;
  }

  #mutate(updater) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const document = await this.#read();
      await updater(document);
      await writeJsonAtomic(this.path, document);
    });
    this.queue = operation;
    return operation;
  }

  #time() {
    const date = this.now();
    return (date instanceof Date ? date : new Date(date)).toISOString();
  }
}

function emptyStore() {
  return { version: STORE_VERSION, sessions: {}, bindings: {}, queuedTurns: {} };
}

function publicSession(session) {
  return {
    id: session.id,
    title: session.title,
    contextId: 'environment',
    contextLabel: '',
    status: session.status,
    statusLabel: statusLabel(session.status),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    canArchive: false,
    canEnd: false,
    canFavorite: false,
  };
}

function sessionView(session, binding = null) {
  return {
    ...publicSession(session),
    sessionId: session.id,
    messages: structuredClone(session.messages),
    technicalItems: structuredClone(session.technicalItems),
    plan: structuredClone(session.plan),
    pendingRequests: [],
    runtimeBinding: binding ? structuredClone(binding) : null,
    executionProfile: {
      model: '',
      reasoningEffort: 'medium',
      accessMode: 'restricted',
    },
  };
}

function applyAgentDelta(session, event) {
  const itemId = String(event.payload?.itemId || `agent-${event.runtimeTurnId || 'unknown'}`);
  let message = session.messages.find((candidate) => candidate.id === itemId);
  if (!message) {
    message = {
      id: itemId,
      role: 'assistant',
      phase: /agentMessage/i.test(event.providerEvent || '') ? 'answer' : 'commentary',
      content: '',
      turnId: event.runtimeTurnId,
      turnStatus: 'inProgress',
      createdAt: new Date(event.createdAt || Date.now()).toISOString(),
    };
    session.messages.push(message);
  }
  message.content = `${message.content}${String(event.payload?.delta ?? '')}`;
}

function applyRuntimeItem(session, event) {
  const item = event.payload?.item;
  if (!item || typeof item !== 'object') return;
  if (['userMessage', 'agentMessage'].includes(item.type)) {
    const role = item.type === 'userMessage' ? 'user' : 'assistant';
    const content = runtimeItemText(item);
    const id = String(item.id || `${role}-${event.runtimeTurnId || 'unknown'}`);
    const existing = session.messages.find((candidate) => candidate.id === id);
    const message = {
      id,
      role,
      phase: item.phase === 'commentary' ? 'commentary' : 'answer',
      content,
      turnId: event.runtimeTurnId,
      turnStatus: item.status || 'inProgress',
      createdAt: new Date(event.createdAt || Date.now()).toISOString(),
    };
    if (existing) Object.assign(existing, message);
    else if (!session.messages.some((candidate) => candidate.role === role && candidate.turnId === message.turnId && candidate.content === content)) {
      session.messages.push(message);
    }
    return;
  }
  const id = String(item.id || `technical-${event.runtimeTurnId || 'unknown'}-${session.technicalItems.length}`);
  const existing = session.technicalItems.find((candidate) => candidate.id === id);
  const technical = {
    id,
    turnId: event.runtimeTurnId,
    title: runtimeItemTitle(item),
    status: String(item.status || (event.type === 'item_completed' ? 'completed' : 'running')),
    detail: runtimeItemText(item),
  };
  if (existing) Object.assign(existing, technical);
  else session.technicalItems.push(technical);
}

function bindLatestUserMessage(session, turnId) {
  const message = [...session.messages].reverse().find((candidate) => candidate.role === 'user' && !candidate.turnId);
  if (message) {
    message.turnId = turnId;
    message.turnStatus = 'inProgress';
  }
}

function normalizePlan(value) {
  return Array.isArray(value) ? value.map((step, index) => ({
    id: String(step?.id || `plan-${index}`),
    text: String(step?.step || step?.text || ''),
    status: String(step?.status || 'pending'),
  })).filter((step) => step.text) : [];
}

function runtimeItemText(item) {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) {
    return item.content.map((part) => part?.text || part?.content || '').filter(Boolean).join('\n');
  }
  if (typeof item.output === 'string') return item.output;
  if (typeof item.command === 'string') return item.command;
  return '';
}

function runtimeItemTitle(item) {
  return ({
    commandExecution: 'Command',
    fileChange: 'File change',
    mcpToolCall: 'Tool call',
    webSearch: 'Web search',
    reasoning: 'Reasoning',
  })[item.type] || String(item.type || 'Runtime item');
}

function inputText(input) {
  if (typeof input === 'string') return input.trim();
  if (!Array.isArray(input)) return '';
  return input.map((part) => part?.text || part?.content || '').filter(Boolean).join('\n').trim();
}

function defaultSessionTitle(value) {
  return ['新对话', 'New Session', '新 Session'].includes(String(value || '').trim());
}

function titleFromUserInput(content, attachments) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  const fallback = attachments.length
    ? `附件：${attachments.map((attachment) => attachment.name).join('、')}`
    : '新对话';
  return [...(text || fallback)].slice(0, 60).join('');
}

function requireSession(document, sessionId) {
  const session = document.sessions[sessionId];
  if (!session) throw storeError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
  return session;
}

function requireOwnedSession(session, sessionId, ownerId) {
  if (!session || (ownerId != null && session.ownerId !== ownerId)) {
    throw storeError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
  }
  return session;
}

function sessionStatus(value, fallback) {
  if (value === 'waiting_for_input') return 'waiting';
  if (['running', 'connecting'].includes(value)) return value;
  if (['failed', 'disconnected'].includes(value)) return 'error';
  if (value === 'interrupted') return 'interrupted';
  return ['idle', 'detached', 'completed'].includes(value) ? 'idle' : fallback;
}

function statusLabel(status) {
  return ({
    connecting: '正在连接',
    error: '发生错误',
    idle: '空闲',
    interrupted: '已停止',
    running: '正在处理',
    waiting: '等待输入',
  })[status] || status;
}

async function writeJsonAtomic(path, document) {
  const temporary = join(dirname(path), `.${basename(path)}.writing-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim().slice(0, 200);
}

function storeError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { normalizeSessionAttachment } from '../attachments.js';

const LEGACY_STORE_VERSION = 1;
const SESSION_STORE_VERSION = 2;
const RUNTIME_STORE_VERSION = 1;
const MAX_MESSAGES_PER_SESSION = 2_000;
const MAX_TECHNICAL_ITEMS_PER_SESSION = 2_000;
const MUTATION_LOCK_STALE_MS = 30_000;
const MUTATION_LOCK_RETRIES = 250;
const MAX_TECHNICAL_DETAIL_CHARS = 16_000;
const MAX_SESSION_DRAFT_CHARS = 12_000;
const SESSION_EVENT_FLUSH_MS = 150;
const SESSION_EVENT_FLUSH_BYTES = 64 * 1024;
const SESSION_EVENT_SEGMENT_BYTES = 1024 * 1024;
const SESSION_LIST_PAGE_SIZE = 50;
const SESSION_LIST_MAX_PAGE_SIZE = 200;
let DatabaseSync = null;
let databaseSyncPromise = null;

function emptyStore() {
  return { version: LEGACY_STORE_VERSION, sessions: {}, bindings: {}, queuedTurns: {} };
}

export class EnvironmentSessionStore {
  constructor({ stateRoot, runId = null, crossProcess = false, now = () => new Date(), uuid = randomUUID } = {}) {
    if (typeof stateRoot !== 'string' || !stateRoot.trim()) throw new TypeError('stateRoot is required');
    this.stateRoot = stateRoot;
    this.path = join(stateRoot, 'sessions.json');
    this.manifestPath = join(stateRoot, 'manifest.json');
    this.indexPath = join(stateRoot, 'index.sqlite');
    this.sessionsRoot = join(stateRoot, 'sessions');
    this.sessionsCanonicalRoot = null;
    this.migrationRoot = join(stateRoot, 'migration');
    this.lockPath = join(stateRoot, '.session-store-v2.lock');
    this.runId = runId == null ? null : nonEmptyString(runId, 'Run id');
    this.crossProcess = crossProcess === true;
    this.now = now;
    this.uuid = uuid;
    this.queue = Promise.resolve();
    this.sessionQueues = new Map();
    this.pendingEventBatches = new Map();
    this.db = null;
    this.runtimeStore = null;
    this.ready = this.#initialize();
  }

  async list(options = {}) {
    const sessions = [];
    let cursor = null;
    do {
      const page = await this.listPage({ ...options, cursor, limit: SESSION_LIST_MAX_PAGE_SIZE });
      sessions.push(...page.sessions);
      cursor = page.nextCursor;
    } while (cursor);
    return sessions;
  }

  async listPage({
    ownerId = null,
    includeOwnerId = false,
    includeArchived = false,
    cursor = null,
    limit = SESSION_LIST_PAGE_SIZE,
  } = {}) {
    await this.ready;
    const pageSize = Math.max(1, Math.min(SESSION_LIST_MAX_PAGE_SIZE, Number(limit) || SESSION_LIST_PAGE_SIZE));
    const after = decodeSessionListCursor(cursor);
    const conditions = [];
    const values = [];
    if (ownerId != null) {
      conditions.push('owner_id = ?');
      values.push(nonEmptyString(ownerId, 'Session owner'));
    }
    if (!includeArchived) conditions.push('archived_at IS NULL');
    if (after) {
      conditions.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      values.push(after.updatedAt, after.updatedAt, after.id);
    }
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(...values, pageSize + 1);
    const selected = rows.slice(0, pageSize);
    const sessions = selected.map((row) => publicSession(indexRowSession(row), { includeOwnerId }));
    const last = selected.at(-1);
    return {
      sessions,
      nextCursor: rows.length > pageSize && last
        ? encodeSessionListCursor({ updatedAt: last.updated_at, id: last.id })
        : null,
    };
  }

  async create(options = {}) {
    return (await this.createIdempotent(options)).session;
  }

  async createIdempotent({
    title = '新对话',
    ownerId = null,
    runId = this.runId,
    draft = '',
    idempotencyKey = null,
  } = {}) {
    const normalizedOwnerId = ownerId == null ? null : nonEmptyString(ownerId, 'Session owner');
    const normalizedTitle = nonEmptyString(title, 'Session title');
    const normalizedDraft = sessionDraft(draft);
    const normalizedIdempotencyKey = idempotencyKey == null ? null : sessionCreateIdempotencyKey(idempotencyKey);
    const fingerprint = sessionCreateFingerprint({ title: normalizedTitle, draft: normalizedDraft });
    let result;
    await this.#withGlobalMutation(async () => {
      const existing = normalizedIdempotencyKey
        ? this.db.prepare(`
            SELECT id, creation_fingerprint FROM sessions
            WHERE owner_id IS ? AND creation_key = ?
            LIMIT 1
          `).get(normalizedOwnerId, normalizedIdempotencyKey)
        : null;
      if (existing) {
        if (existing.creation_fingerprint !== fingerprint) {
          throw storeError(
            'SESSION_CREATE_IDEMPOTENCY_CONFLICT',
            'The Session idempotency key was already used with different input.',
            409,
          );
        }
        result = { created: false, sessionId: existing.id };
        return;
      }
      const sessionId = `session-${this.uuid()}`;
      const timestamp = this.#time();
      await this.#writeNewSession({
        id: sessionId,
        ownerId: normalizedOwnerId,
        ...(runId == null ? {} : { createdRunId: nonEmptyString(runId, 'Run id') }),
        title: normalizedTitle,
        draft: normalizedDraft,
        status: 'idle',
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        messages: [],
        technicalItems: [],
        plan: [],
        ...(normalizedIdempotencyKey ? {
          creationIdempotency: { key: normalizedIdempotencyKey, fingerprint, createdAt: timestamp },
        } : {}),
      });
      result = { created: true, sessionId };
    });
    return { ...result, session: await this.get(result.sessionId, { ownerId: normalizedOwnerId }) };
  }

  async createBranch(sourceSessionId, {
    beforeTurnId,
    includeTargetTurn = false,
    ownerId = null,
    title = null,
    projectMessages = null,
  } = {}) {
    const targetTurnId = nonEmptyString(beforeTurnId, 'Branch Turn id');
    const sessionId = `session-${this.uuid()}`;
    await this.#flushPending(sourceSessionId);
    await this.#enqueueSessionOperation(sourceSessionId, async () => {
      const release = await this.#acquireSessionLock(sourceSessionId);
      try {
        const { session: source } = await this.#readSessionRecord(sourceSessionId, { ownerId });
        const messageIndex = source.messages.findIndex((message) => message.turnId === targetTurnId);
        if (messageIndex < 0) throw storeError('SESSION_BRANCH_TURN_NOT_FOUND', `Turn not found: ${targetTurnId}`, 404);
        let endIndex = messageIndex;
        if (includeTargetTurn) {
          endIndex += 1;
          while (endIndex < source.messages.length && source.messages[endIndex].turnId === targetTurnId) endIndex += 1;
        }
        const sourceMessages = structuredClone(source.messages.slice(0, endIndex));
        const messages = typeof projectMessages === 'function'
          ? await projectMessages(sourceMessages, { sourceSessionId, sessionId })
          : sourceMessages;
        if (!Array.isArray(messages)) throw new TypeError('Projected branch messages must be an array');
        const retainedTurnIds = new Set(messages.map((message) => message.turnId).filter(Boolean));
        const timestamp = this.#time();
        await this.#writeNewSession({
          id: sessionId,
          ownerId: source.ownerId,
          ...(this.runId == null ? {} : { createdRunId: this.runId }),
          title: title == null ? source.title : nonEmptyString(title, 'Session title'),
          status: 'idle',
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: null,
          messages,
          technicalItems: structuredClone(source.technicalItems.filter((item) => retainedTurnIds.has(item.turnId))),
          plan: [],
        });
      } finally {
        await release();
      }
    });
    return this.get(sessionId, { ownerId });
  }

  async createSharedContinuation(sourceSessionId, {
    ownerId,
    shareId,
    idempotencyKey,
    title = null,
    projectMessages = null,
  } = {}) {
    const normalizedOwnerId = nonEmptyString(ownerId, 'Session owner');
    const normalizedShareId = nonEmptyString(shareId, 'Share id');
    const normalizedIdempotencyKey = nonEmptyString(idempotencyKey, 'Idempotency key');
    let result;
    await this.#flushPending(sourceSessionId);
    await this.#withGlobalMutation(async () => {
      const existing = this.db.prepare(`
        SELECT id FROM sessions
        WHERE owner_id = ? AND shared_share_id = ? AND shared_key = ?
        LIMIT 1
      `).get(normalizedOwnerId, normalizedShareId, normalizedIdempotencyKey);
      if (existing) {
        result = { created: false, sessionId: existing.id };
        return;
      }
      const { session: source } = await this.#readSessionRecord(sourceSessionId);
      if (source.ownerId === normalizedOwnerId) {
        throw storeError('SESSION_CONTINUATION_OWNER_INVALID', 'A shared continuation requires a different owner.', 409);
      }
      const sessionId = `session-${this.uuid()}`;
      const timestamp = this.#time();
      const projected = typeof projectMessages === 'function'
        ? await projectMessages(structuredClone(source.messages), { sourceSessionId, sessionId })
        : structuredClone(source.messages);
      const messages = sharedContinuationMessages(projected, this.uuid, this.#time.bind(this));
      await this.#writeNewSession({
        id: sessionId,
        ownerId: normalizedOwnerId,
        ...(this.runId == null ? {} : { createdRunId: this.runId }),
        title: title == null ? `${source.title}（副本）` : nonEmptyString(title, 'Session title'),
        status: 'idle',
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        messages,
        technicalItems: [],
        plan: [],
        sharedContinuation: {
          sourceSessionId,
          shareId: normalizedShareId,
          idempotencyKey: normalizedIdempotencyKey,
          watermark: source.messages.at(-1)?.id || source.updatedAt,
          createdAt: timestamp,
        },
      });
      result = { created: true, sessionId };
    });
    return { ...result, session: await this.get(result.sessionId, { ownerId: normalizedOwnerId }) };
  }

  async remove(sessionId, { ownerId = null, requireUnbound = false } = {}) {
    await this.#flushPending(sessionId);
    return this.#enqueueSessionOperation(sessionId, async () => {
      const release = await this.#acquireSessionLock(sessionId);
      try {
        const { session, directory } = await this.#readSessionRecord(sessionId, { ownerId });
        const binding = await this.runtimeStore.load(sessionId);
        if (requireUnbound && binding) throw storeError('SESSION_BOUND', `Session is already bound: ${sessionId}`, 409);
        const removed = sessionView(session, binding);
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        await this.runtimeStore.remove(sessionId);
        await rm(directory, { recursive: true, force: true });
        return removed;
      } finally {
        await release();
      }
    });
  }

  async archive(sessionId, { ownerId = null } = {}) {
    await this.#mutateSession(sessionId, { ownerId }, (session) => {
      session.archivedAt ||= this.#time();
    });
    return this.get(sessionId, { ownerId });
  }

  async get(sessionId, { ownerId = null, includeOwnerId = false } = {}) {
    await this.ready;
    await this.#flushPending(sessionId);
    const { session } = await this.#readSessionRecord(sessionId, { ownerId });
    return sessionView(session, await this.runtimeStore.load(sessionId), { includeOwnerId });
  }

  async getShared(sessionId) {
    await this.ready;
    await this.#flushPending(sessionId);
    const { session } = await this.#readSessionRecord(sessionId);
    return sessionView(session, null);
  }

  async load(sessionId) {
    await this.ready;
    return this.runtimeStore.load(sessionId);
  }

  async loadMany(sessionIds = []) {
    await this.ready;
    return this.runtimeStore.loadMany(sessionIds);
  }

  async save(sessionId, patch = {}) {
    await this.ready;
    if (!this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId)) {
      throw storeError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    }
    const binding = await this.runtimeStore.save(sessionId, patch);
    await this.#mutateSession(sessionId, {}, (session) => {
      session.status = sessionStatus(binding.status, session.status);
      session.updatedAt = binding.updatedAt;
      if (['completed', 'failed', 'interrupted', 'cancelled', 'canceled'].includes(binding.status)) {
        session.completedAt = binding.updatedAt;
      }
    });
    return binding;
  }

  async loadQueuedTurns() {
    await this.ready;
    return this.runtimeStore.loadQueuedTurns();
  }

  async saveQueuedTurns(entries = {}) {
    await this.ready;
    return this.runtimeStore.saveQueuedTurns(entries);
  }

  async recordUserInput(sessionId, input, { attachments = [], ownerId = null, turnId = null } = {}) {
    const content = inputText(input);
    if (!content) throw new TypeError('Session input cannot be empty');
    const normalizedAttachments = Array.isArray(attachments)
      ? attachments.map((attachment, index) => normalizeSessionAttachment(attachment, `attachment-${index}`))
      : [];
    await this.#mutateSession(sessionId, { ownerId }, (session) => {
      session.draft = '';
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
      const existingUserIndex = message.turnId == null ? -1 : session.messages.findIndex((candidate) => (
        candidate.role === 'user' && candidate.turnId === message.turnId
      ));
      const existingTurnIndex = message.turnId == null
        ? -1
        : session.messages.findIndex((candidate) => candidate.turnId === message.turnId);
      if (existingUserIndex !== -1) session.messages.splice(existingUserIndex, 1, message);
      else if (existingTurnIndex === -1) session.messages.push(message);
      else session.messages.splice(existingTurnIndex, 0, message);
      session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
      session.updatedAt = this.#time();
    });
  }

  async reserveTurnSubmission(sessionId, { ownerId = null, idempotencyKey, fingerprint } = {}) {
    const key = turnIdempotencyKey(idempotencyKey);
    const normalizedFingerprint = nonEmptyString(fingerprint, 'Turn fingerprint');
    let result;
    await this.#mutateSession(sessionId, { ownerId }, (session) => {
      session.turnSubmissions ||= {};
      const existing = session.turnSubmissions[key];
      if (existing) {
        if (existing.fingerprint !== normalizedFingerprint) {
          throw storeError(
            'SESSION_TURN_IDEMPOTENCY_CONFLICT',
            'The Turn idempotency key was already used with different input.',
            409,
          );
        }
        result = { created: false, submission: structuredClone(existing) };
        return;
      }
      const submission = {
        key,
        fingerprint: normalizedFingerprint,
        status: 'reserved',
        responseStatus: null,
        response: null,
        createdAt: this.#time(),
        updatedAt: this.#time(),
      };
      session.turnSubmissions[key] = submission;
      result = { created: true, submission: structuredClone(submission) };
    });
    return result;
  }

  async completeTurnSubmission(
    sessionId,
    { ownerId = null, idempotencyKey, responseStatus = 202, response = {} } = {},
  ) {
    const key = turnIdempotencyKey(idempotencyKey);
    await this.#mutateSession(sessionId, { ownerId }, (session) => {
      const submission = session.turnSubmissions?.[key];
      if (!submission) throw storeError('SESSION_TURN_IDEMPOTENCY_MISSING', 'Turn reservation was not found.', 409);
      submission.status = 'accepted';
      submission.responseStatus = Number(responseStatus) || 202;
      submission.response = structuredClone(response);
      submission.updatedAt = this.#time();
    });
  }

  async releaseTurnSubmission(sessionId, { ownerId = null, idempotencyKey } = {}) {
    const key = turnIdempotencyKey(idempotencyKey);
    await this.#mutateSession(sessionId, { ownerId }, (session) => {
      if (session.turnSubmissions?.[key]?.status === 'reserved') delete session.turnSubmissions[key];
    });
  }

  async applyEvent(event) {
    if (!event?.sessionId) return;
    await this.ready;
    const sessionId = String(event.sessionId);
    let batch = this.pendingEventBatches.get(sessionId);
    if (!batch) {
      batch = { bytes: 0, events: [], timer: null, waiters: [] };
      this.pendingEventBatches.set(sessionId, batch);
    }
    batch.events.push(structuredClone(event));
    batch.bytes += Buffer.byteLength(JSON.stringify(event));
    const promise = new Promise((resolve, reject) => batch.waiters.push({ resolve, reject }));
    const strong = event.type !== 'item_delta';
    if (strong || batch.bytes >= SESSION_EVENT_FLUSH_BYTES) {
      void this.#flushEventBatch(sessionId, batch, { strong });
    } else if (!batch.timer) {
      batch.timer = setTimeout(() => void this.#flushEventBatch(sessionId, batch), SESSION_EVENT_FLUSH_MS);
    }
    return promise;
  }

  async exportDurableSessions() {
    await this.ready;
    await Promise.all([...this.pendingEventBatches.keys()].map((sessionId) => this.#flushPending(sessionId)));
    const sessions = {};
    for (const { id } of this.db.prepare('SELECT id FROM sessions ORDER BY id').all()) {
      sessions[id] = structuredClone((await this.#readSessionRecord(id)).session);
    }
    return sessions;
  }

  async close() {
    await this.ready;
    await Promise.all([...this.pendingEventBatches.keys()].map((sessionId) => this.#flushPending(sessionId)));
    await Promise.all(this.sessionQueues.values());
    this.db?.close();
    this.db = null;
  }

  async #initialize() {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    await loadDatabaseSync();
    const release = await acquireFilesystemLock(this.lockPath);
    try {
      if (!(await pathExists(this.manifestPath))) await this.#initializeV2();
      const manifest = JSON.parse(await readFile(this.manifestPath, 'utf8'));
      if (manifest?.schema !== 'agent-workbench.session-store/v2' || manifest.version !== SESSION_STORE_VERSION) {
        throw storeError('SESSION_STORE_INVALID', `Invalid Session store manifest: ${this.manifestPath}`, 500);
      }
      this.db = openSessionIndex(this.indexPath);
      this.sessionsCanonicalRoot = await realpath(this.sessionsRoot);
    } finally {
      await release();
    }
    this.runtimeStore = new EnvironmentSessionRuntimeStore({ stateRoot: this.stateRoot, now: this.now });
    await this.runtimeStore.ready;
  }

  async #initializeV2() {
    if (await pathExists(this.indexPath) || await pathExists(this.sessionsRoot)) {
      throw storeError('SESSION_STORE_PARTIAL_MIGRATION', 'Inactive Session Store v2 files require operator review.', 500);
    }
    const legacy = await readLegacySessionStore(this.path);
    const temporaryId = this.uuid();
    const temporaryIndex = join(this.stateRoot, `.index.migrating-${temporaryId}.sqlite`);
    const temporarySessions = join(this.stateRoot, `.sessions.migrating-${temporaryId}`);
    await mkdir(temporarySessions, { recursive: true, mode: 0o700 });
    let temporaryDatabase = null;
    let sessionsActivated = false;
    let indexActivated = false;
    try {
      temporaryDatabase = createSessionIndex(temporaryIndex);
      for (const session of Object.values(legacy.document.sessions)) {
        validateStoredSession(session);
        const snapshotPath = sessionSnapshotPath(temporarySessions, session.id);
        await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
        await writeJsonAtomic(snapshotPath, { version: SESSION_STORE_VERSION, sequence: 0, session });
        upsertSessionIndex(temporaryDatabase, session, relative(temporarySessions, snapshotPath));
      }
      temporaryDatabase.close();
      temporaryDatabase = null;
      await chmod(temporaryIndex, 0o600);
      await rename(temporarySessions, this.sessionsRoot);
      sessionsActivated = true;
      await rename(temporaryIndex, this.indexPath);
      indexActivated = true;
      await mkdir(this.migrationRoot, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(join(this.migrationRoot, 'report.json'), {
        schema: 'agent-workbench.session-store-migration/v1',
        source: legacy.exists ? 'sessions.json' : 'empty',
        sourceRetained: legacy.exists,
        sessions: Object.keys(legacy.document.sessions).length,
        bindings: Object.keys(legacy.document.bindings).length,
        queuedSessions: Object.keys(legacy.document.queuedTurns || {}).length,
        completedAt: this.#time(),
      });
      await writeTextAtomic(join(this.migrationRoot, 'source.digest'), `${legacy.digest}\n`);
      const runtimePath = join(this.stateRoot, 'session-runtime.json');
      if (!(await pathExists(runtimePath))) {
        await writeJsonAtomic(runtimePath, {
          version: RUNTIME_STORE_VERSION,
          bindings: legacy.document.bindings,
          queuedTurns: legacy.document.queuedTurns || {},
        });
      }
      await writeJsonAtomic(this.manifestPath, {
        schema: 'agent-workbench.session-store/v2',
        version: SESSION_STORE_VERSION,
        generation: `generation-${this.#time()}`,
        index: 'index.sqlite',
        sessions: 'sessions',
        sourceDigest: legacy.digest,
        createdAt: this.#time(),
      });
      await syncDirectory(this.stateRoot);
    } catch (error) {
      temporaryDatabase?.close();
      await rm(temporaryIndex, { force: true });
      await rm(temporarySessions, { recursive: true, force: true });
      if (indexActivated) await rm(this.indexPath, { force: true });
      if (sessionsActivated) await rm(this.sessionsRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async #mutateSession(sessionId, { ownerId = null } = {}, updater) {
    await this.ready;
    await this.#flushPending(sessionId);
    return this.#enqueueSessionOperation(sessionId, async () => {
      const release = await this.#acquireSessionLock(sessionId);
      try {
        const record = await this.#readSessionRecord(sessionId, { ownerId });
        const result = await updater(record.session);
        await this.#writeSessionRecord(record, { strong: true });
        return result;
      } finally {
        await release();
      }
    });
  }

  async #writeNewSession(session) {
    validateStoredSession(session);
    if (this.db.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id)) {
      throw storeError('SESSION_ALREADY_EXISTS', `Session already exists: ${session.id}`, 409);
    }
    const snapshotPath = sessionSnapshotPath(this.sessionsRoot, session.id);
    await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(snapshotPath, { version: SESSION_STORE_VERSION, sequence: 0, session });
    upsertSessionIndex(this.db, session, relative(this.sessionsRoot, snapshotPath));
  }

  async #writeSessionRecord(record, { events = [], strong = true } = {}) {
    let sequence = record.sequence;
    const storedEvents = [];
    for (const event of events) {
      sequence += 1;
      const storedEvent = persistentSessionEvent(event);
      if (storedEvent) storedEvents.push({ sequence, event: storedEvent });
    }
    if (!events.length) sequence += 1;
    if (storedEvents.length) await appendSessionEvents(record.directory, storedEvents, { sync: strong });
    if (strong) {
      await writeJsonAtomic(record.snapshotPath, {
        version: SESSION_STORE_VERSION,
        sequence,
        session: record.session,
      });
      upsertSessionIndex(this.db, record.session, relative(this.sessionsRoot, record.snapshotPath), sequence);
      await rotateSessionEventSegment(record.directory, sequence);
    }
    record.sequence = sequence;
  }

  async #readSessionRecord(sessionId, { ownerId = null } = {}) {
    const row = ownerId == null
      ? this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)
      : this.db.prepare('SELECT * FROM sessions WHERE id = ? AND owner_id = ?').get(sessionId, ownerId);
    if (!row) throw storeError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`, 404);
    const snapshotPath = join(this.sessionsRoot, row.snapshot_path);
    const snapshotRelativePath = relative(this.sessionsRoot, snapshotPath);
    if (!snapshotRelativePath || snapshotRelativePath.startsWith('..') || snapshotRelativePath.startsWith('/')) {
      throw storeError('SESSION_STORE_INVALID', `Session snapshot path is invalid: ${sessionId}`, 500);
    }
    const snapshotInfo = await lstat(snapshotPath).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!snapshotInfo?.isFile() || snapshotInfo.isSymbolicLink()) {
      throw storeError('SESSION_STORE_INVALID', `Session snapshot is not a regular file: ${sessionId}`, 500);
    }
    const canonicalSnapshotPath = await realpath(snapshotPath);
    const canonicalRelativePath = relative(this.sessionsCanonicalRoot, canonicalSnapshotPath);
    if (!canonicalRelativePath || canonicalRelativePath.startsWith('..') || canonicalRelativePath.startsWith('/')) {
      throw storeError('SESSION_STORE_INVALID', `Session snapshot escapes the Session root: ${sessionId}`, 500);
    }
    const directory = dirname(snapshotPath);
    const snapshot = await readSessionSnapshot(snapshotPath, sessionId);
    const events = await readSessionEvents(directory, snapshot.sequence);
    for (const entry of events) applySessionEvent(snapshot.session, entry.event, null);
    return {
      session: snapshot.session,
      sequence: events.at(-1)?.sequence || snapshot.sequence,
      snapshotPath,
      directory,
    };
  }

  async #flushEventBatch(sessionId, expectedBatch, { strong = false } = {}) {
    const batch = this.pendingEventBatches.get(sessionId);
    if (!batch || batch !== expectedBatch) return;
    this.pendingEventBatches.delete(sessionId);
    clearTimeout(batch.timer);
    try {
      await this.#enqueueSessionOperation(sessionId, async () => {
        const release = await this.#acquireSessionLock(sessionId);
        try {
          const record = await this.#readSessionRecord(sessionId);
          const binding = await this.runtimeStore.load(sessionId);
          for (const event of batch.events) applySessionEvent(record.session, event, binding);
          await this.#writeSessionRecord(record, { events: batch.events, strong });
        } catch (error) {
          if (error?.code !== 'SESSION_NOT_FOUND') throw error;
        } finally {
          await release();
        }
      });
      for (const waiter of batch.waiters) waiter.resolve();
    } catch (error) {
      for (const waiter of batch.waiters) waiter.reject(error);
    }
  }

  async #flushPending(sessionId) {
    const batch = this.pendingEventBatches.get(sessionId);
    if (batch) await this.#flushEventBatch(sessionId, batch, { strong: true });
  }

  #enqueueSessionOperation(sessionId, task) {
    const previous = this.sessionQueues.get(sessionId) || Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    const tail = operation.then(() => undefined, () => undefined);
    this.sessionQueues.set(sessionId, tail);
    void tail.finally(() => {
      if (this.sessionQueues.get(sessionId) === tail) this.sessionQueues.delete(sessionId);
    });
    return operation;
  }

  #withGlobalMutation(task) {
    const operation = this.queue.catch(() => {}).then(async () => {
      await this.ready;
      const release = this.crossProcess ? await acquireFilesystemLock(this.lockPath) : async () => {};
      try {
        return await task();
      } finally {
        await release();
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #acquireSessionLock(sessionId) {
    if (!this.crossProcess) return async () => {};
    return acquireFilesystemLock(join(this.stateRoot, `.session-${sessionLockName(sessionId)}.lock`));
  }

  #time() {
    const date = this.now();
    return (date instanceof Date ? date : new Date(date)).toISOString();
  }
}

async function loadDatabaseSync() {
  databaseSyncPromise ||= import('node:sqlite').then((module) => {
    DatabaseSync = module.DatabaseSync;
  });
  await databaseSyncPromise;
}

function createSessionIndex(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      owner_id TEXT,
      created_run_id TEXT,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      archived_at TEXT,
      creation_key TEXT,
      creation_fingerprint TEXT,
      shared_share_id TEXT,
      shared_key TEXT,
      snapshot_path TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_owner_updated
      ON sessions(owner_id, archived_at, updated_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_creation_idempotency
      ON sessions(COALESCE(owner_id, ''), creation_key)
      WHERE creation_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_shared_continuation
      ON sessions(owner_id, shared_share_id, shared_key)
      WHERE shared_share_id IS NOT NULL AND shared_key IS NOT NULL;
  `);
  return database;
}

function openSessionIndex(path) {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  return database;
}

function upsertSessionIndex(database, session, snapshotPath, sequence = 0) {
  database.prepare(`
    INSERT INTO sessions (
      id, owner_id, created_run_id, title, status, created_at, updated_at,
      completed_at, archived_at, creation_key, creation_fingerprint,
      shared_share_id, shared_key, snapshot_path, last_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      owner_id = excluded.owner_id,
      created_run_id = excluded.created_run_id,
      title = excluded.title,
      status = excluded.status,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at,
      archived_at = excluded.archived_at,
      creation_key = excluded.creation_key,
      creation_fingerprint = excluded.creation_fingerprint,
      shared_share_id = excluded.shared_share_id,
      shared_key = excluded.shared_key,
      snapshot_path = excluded.snapshot_path,
      last_sequence = excluded.last_sequence
  `).run(
    session.id,
    session.ownerId ?? null,
    session.createdRunId ?? null,
    session.title,
    session.status,
    session.createdAt,
    session.updatedAt,
    session.completedAt ?? null,
    session.archivedAt ?? null,
    session.creationIdempotency?.key ?? null,
    session.creationIdempotency?.fingerprint ?? null,
    session.sharedContinuation?.shareId ?? null,
    session.sharedContinuation?.idempotencyKey ?? null,
    snapshotPath,
    sequence,
  );
}

function indexRowSession(row) {
  return {
    id: row.id,
    ownerId: row.owner_id ?? null,
    ...(row.created_run_id ? { createdRunId: row.created_run_id } : {}),
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? null,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
}

function encodeSessionListCursor({ updatedAt, id }) {
  return Buffer.from(JSON.stringify({ updatedAt, id }), 'utf8').toString('base64url');
}

function decodeSessionListCursor(value) {
  if (value == null || value === '') return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (typeof cursor.updatedAt !== 'string' || !Number.isFinite(Date.parse(cursor.updatedAt))) throw new Error();
    if (typeof cursor.id !== 'string' || !cursor.id) throw new Error();
    return cursor;
  } catch {
    throw storeError('SESSION_LIST_CURSOR_INVALID', 'Session list cursor is invalid.', 400);
  }
}

function sessionLockName(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 24);
}

function sessionSnapshotPath(sessionsRoot, sessionId) {
  const digest = createHash('sha256').update(sessionId).digest('hex');
  const directoryName = Buffer.from(sessionId, 'utf8').toString('base64url');
  return join(sessionsRoot, digest.slice(0, 2), directoryName, 'snapshot.json');
}

function validateStoredSession(session) {
  if (!plainObject(session) || typeof session.id !== 'string' || !/^[A-Za-z0-9._:-]{1,240}$/.test(session.id)) {
    throw storeError('SESSION_STORE_INVALID', 'Stored Session id is invalid.', 500);
  }
  if (session.ownerId != null && (typeof session.ownerId !== 'string' || !session.ownerId)) {
    throw storeError('SESSION_STORE_INVALID', `Stored Session owner is invalid: ${session.id}`, 500);
  }
  if (typeof session.title !== 'string' || typeof session.status !== 'string'
    || !Number.isFinite(Date.parse(session.createdAt)) || !Number.isFinite(Date.parse(session.updatedAt))
    || !Array.isArray(session.messages) || !Array.isArray(session.technicalItems) || !Array.isArray(session.plan)) {
    throw storeError('SESSION_STORE_INVALID', `Stored Session is invalid: ${session.id}`, 500);
  }
}

async function readSessionSnapshot(path, sessionId) {
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw storeError('SESSION_STORE_INVALID', `Session snapshot is missing: ${sessionId}`, 500);
    if (error instanceof SyntaxError) throw storeError('SESSION_STORE_INVALID', `Session snapshot is invalid: ${sessionId}`, 500);
    throw error;
  }
  if (snapshot?.version !== SESSION_STORE_VERSION || !Number.isSafeInteger(snapshot.sequence)
    || snapshot.sequence < 0 || snapshot.session?.id !== sessionId) {
    throw storeError('SESSION_STORE_INVALID', `Session snapshot is invalid: ${sessionId}`, 500);
  }
  validateStoredSession(snapshot.session);
  return { sequence: snapshot.sequence, session: snapshot.session };
}

async function readSessionEvents(directory, afterSequence) {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const files = entries
    .filter((entry) => entry.isFile() && /^events-\d{6,}\.ndjson$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const events = [];
  for (const name of files) {
    const content = await readFile(join(directory, name), 'utf8');
    const lines = content.split('\n');
    if (!content.endsWith('\n')) lines.pop();
    for (const line of lines) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw storeError('SESSION_STORE_EVENT_INVALID', `Session event segment is invalid: ${name}`, 500);
      }
      if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= afterSequence || !plainObject(entry.event)) continue;
      events.push(entry);
    }
  }
  return events.sort((left, right) => left.sequence - right.sequence);
}

function persistentSessionEvent(event) {
  const common = {
    eventId: Number.isSafeInteger(Number(event.eventId)) ? Number(event.eventId) : null,
    type: String(event.type || ''),
    sessionId: String(event.sessionId || ''),
    runtimeTurnId: event.runtimeTurnId == null ? null : String(event.runtimeTurnId),
    providerEvent: event.providerEvent == null ? null : String(event.providerEvent),
    createdAt: Number(event.createdAt) || Date.now(),
  };
  if (event.type === 'item_delta') {
    return { ...common, payload: {
      itemId: event.payload?.itemId == null ? null : String(event.payload.itemId),
      delta: String(event.payload?.delta ?? ''),
    } };
  }
  if (['turn_started', 'turn_completed', 'request_opened', 'request_resolved', 'request_rejected', 'request_expired', 'connection_exited'].includes(event.type)) {
    return { ...common, payload: structuredClone(event.payload || {}) };
  }
  if (event.type === 'plan_updated') {
    return { ...common, payload: { plan: normalizePlan(event.payload?.plan) } };
  }
  if (['item_started', 'item_completed'].includes(event.type)) {
    const item = event.payload?.item;
    if (item?.type === 'agentMessage') {
      return { ...common, payload: { item: {
        id: item.id == null ? null : String(item.id),
        type: 'agentMessage',
        phase: item.phase == null ? null : String(item.phase),
        status: item.status == null ? null : String(item.status),
        text: runtimeItemText(item),
        ...(Array.isArray(item.publishedArtifacts) ? {
          publishedArtifacts: structuredClone(item.publishedArtifacts),
        } : {}),
        ...(Array.isArray(item.artifactPublicationErrors) ? {
          artifactPublicationErrors: item.artifactPublicationErrors.slice(0, 20).map((failure) => ({
            name: String(failure?.name || 'artifact').slice(0, 255),
            code: String(failure?.code || 'RESULT_FILE_CAPTURE_FAILED').slice(0, 120),
          })),
        } : {}),
      } } };
    }
    if (item?.type === 'imageGeneration') {
      return { ...common, payload: { item: {
        id: item.id == null ? null : String(item.id),
        type: 'imageGeneration',
        status: item.status == null ? null : String(item.status),
        ...(item.publishedMedia ? { publishedMedia: structuredClone(item.publishedMedia) } : {}),
        ...(item.publicationError?.code ? { publicationError: { code: String(item.publicationError.code) } } : {}),
      } } };
    }
  }
  return null;
}

function applySessionEvent(session, event, binding) {
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
    publishTurnMedia(session, event.runtimeTurnId);
  } else if (event.type === 'request_opened') {
    session.status = 'waiting';
  } else if (['request_resolved', 'request_rejected', 'request_expired'].includes(event.type)) {
    session.status = binding && !binding.activeTurnId ? 'idle' : 'running';
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
}

async function appendSessionEvents(directory, events, { sync = false } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(join(directory, 'events-000001.ndjson'), 'a', 0o600);
  try {
    await handle.writeFile(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    if (sync) await handle.sync();
  } finally {
    await handle.close();
  }
}

async function rotateSessionEventSegment(directory, sequence) {
  const current = join(directory, 'events-000001.ndjson');
  const info = await stat(current).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info || info.size < SESSION_EVENT_SEGMENT_BYTES) return;
  const archived = join(directory, `events-${String(sequence).padStart(12, '0')}.ndjson`);
  await rename(current, archived);
  await syncDirectory(directory);
}

async function readLegacySessionStore(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw storeError('SESSION_STORE_LEGACY_INVALID', 'Legacy Session store must be a regular file.', 500);
    }
    const raw = await readFile(path, 'utf8');
    const document = JSON.parse(raw);
    if (document?.version !== LEGACY_STORE_VERSION || !plainObject(document.sessions)
      || !plainObject(document.bindings) || !plainObject(document.queuedTurns || {})) {
      throw storeError('SESSION_STORE_LEGACY_INVALID', 'Legacy Session store is invalid.', 500);
    }
    return { exists: true, raw, digest: createHash('sha256').update(raw).digest('hex'), document };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) throw storeError('SESSION_STORE_LEGACY_INVALID', 'Legacy Session store is invalid JSON.', 500);
      throw error;
    }
    const document = emptyStore();
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    return { exists: false, raw, digest: createHash('sha256').update(raw).digest('hex'), document };
  }
}

async function acquireFilesystemLock(path) {
  for (let attempt = 0; attempt < MUTATION_LOCK_RETRIES; attempt += 1) {
    try {
      await mkdir(path, { mode: 0o700 });
      return () => rm(path, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const info = await stat(path).catch((error) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) continue;
    if (Date.now() - info.mtimeMs > MUTATION_LOCK_STALE_MS) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    await delay(20);
  }
  throw storeError('SESSION_STORE_BUSY', 'Session persistence is busy in another process.', 503);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
}

function publicSession(session, { includeOwnerId = false } = {}) {
  return {
    id: session.id,
    ...(includeOwnerId ? { ownerId: session.ownerId } : {}),
    ...(session.createdRunId ? { createdRunId: session.createdRunId } : {}),
    title: session.title,
    contextId: 'environment',
    contextLabel: '',
    status: session.status,
    statusLabel: statusLabel(session.status),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    archived: Boolean(session.archivedAt),
    canArchive: false,
    canEnd: false,
    canFavorite: false,
  };
}

export class EnvironmentSessionRuntimeStore {
  constructor({ stateRoot, now = () => new Date() } = {}) {
    if (typeof stateRoot !== 'string' || !stateRoot.trim()) throw new TypeError('stateRoot is required');
    this.stateRoot = stateRoot;
    this.path = join(stateRoot, 'session-runtime.json');
    this.now = now;
    this.queue = Promise.resolve();
    this.ready = this.#initialize();
  }

  async load(sessionId) {
    const document = await this.#readQueued();
    return document.bindings[sessionId] ? structuredClone(document.bindings[sessionId]) : null;
  }

  async loadMany(sessionIds = []) {
    const document = await this.#readQueued();
    return Object.fromEntries([...new Set(sessionIds.map(String))]
      .filter((sessionId) => document.bindings[sessionId])
      .map((sessionId) => [sessionId, structuredClone(document.bindings[sessionId])]));
  }

  async save(sessionId, patch = {}) {
    let binding;
    await this.#mutate((document) => {
      binding = {
        ...(document.bindings[sessionId] || {}),
        ...structuredClone(patch),
        sessionId,
        updatedAt: this.#time(),
      };
      document.bindings[sessionId] = binding;
    });
    return structuredClone(binding);
  }

  async remove(sessionId) {
    let removed = null;
    await this.#mutate((document) => {
      removed = document.bindings[sessionId] ? structuredClone(document.bindings[sessionId]) : null;
      delete document.bindings[sessionId];
      delete document.queuedTurns[sessionId];
    });
    return removed;
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

  async #initialize() {
    await mkdir(this.stateRoot, { recursive: true, mode: 0o700 });
    try {
      await open(this.path, 'wx', 0o600).then(async (handle) => {
        try {
          await handle.writeFile(`${JSON.stringify(emptyRuntimeStore(), null, 2)}\n`, 'utf8');
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
    if (document?.version !== RUNTIME_STORE_VERSION || !document.bindings || !document.queuedTurns) {
      throw storeError('SESSION_RUNTIME_STORE_INVALID', `Invalid Session Runtime store: ${this.path}`, 500);
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

function emptyRuntimeStore() {
  return { version: RUNTIME_STORE_VERSION, bindings: {}, queuedTurns: {} };
}

async function waitForInitializedDocument(path, validate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const document = JSON.parse(await readFile(path, 'utf8'));
      if (validate(document)) return;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(5);
  }
  throw storeError('SESSION_STORE_INVALID', `Session store did not finish initializing: ${path}`, 500);
}

function sessionView(session, binding = null, { includeOwnerId = false } = {}) {
  return {
    ...publicSession(session, { includeOwnerId }),
    sessionId: session.id,
    draft: typeof session.draft === 'string' ? session.draft : '',
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

function sharedContinuationMessages(messages, uuid, now) {
  if (!Array.isArray(messages)) throw new TypeError('Projected Session messages must be an array');
  return messages.slice(-MAX_MESSAGES_PER_SESSION).map((message) => ({
    id: `message-${uuid()}`,
    role: message?.role === 'user' ? 'user' : 'assistant',
    phase: message?.phase === 'commentary' ? 'commentary' : 'answer',
    content: String(message?.content || '').slice(0, 200_000),
    attachments: Array.isArray(message?.attachments) ? structuredClone(message.attachments) : [],
    media: Array.isArray(message?.media) ? structuredClone(message.media) : [],
    turnId: null,
    turnStatus: 'completed',
    copiedFromShared: true,
    createdAt: validTimestamp(message?.createdAt) || now(),
  })).filter((message) => message.content || message.attachments.length || message.media.length);
}

function validTimestamp(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
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
  const timestamp = new Date(event.createdAt || Date.now()).toISOString();
  if (['userMessage', 'agentMessage'].includes(item.type)) {
    const role = item.type === 'userMessage' ? 'user' : 'assistant';
    const content = runtimeItemText(item);
    const id = String(item.id || `${role}-${event.runtimeTurnId || 'unknown'}`);
    const existing = session.messages.find((candidate) => candidate.id === id);
    const existingUserTurn = role === 'user'
      ? session.messages.find((candidate) => (
          candidate.role === 'user' && candidate.turnId === event.runtimeTurnId
        ))
      : null;
    const message = {
      id,
      role,
      phase: item.phase === 'commentary' ? 'commentary' : 'answer',
      content,
      turnId: event.runtimeTurnId,
      turnStatus: item.status || 'inProgress',
      createdAt: timestamp,
      ...(Array.isArray(item.publishedArtifacts) ? { attachments: structuredClone(item.publishedArtifacts) } : {}),
      ...(Array.isArray(item.artifactPublicationErrors) ? {
        artifactErrors: structuredClone(item.artifactPublicationErrors),
      } : {}),
    };
    if (existing) Object.assign(existing, message);
    else if (existingUserTurn) return;
    else if (!session.messages.some((candidate) => candidate.role === role && candidate.turnId === message.turnId && candidate.content === content)) {
      session.messages.push(message);
    }
    if (role === 'assistant' && message.phase !== 'commentary') publishTurnMedia(session, event.runtimeTurnId);
    return;
  }
  if (item.type === 'imageGeneration' && item.publishedMedia) {
    const turnId = String(event.runtimeTurnId || '');
    if (turnId) {
      session.publishedMediaByTurn ||= {};
      const media = session.publishedMediaByTurn[turnId] ||= [];
      if (!media.some((candidate) => candidate.resourceId === item.publishedMedia.resourceId)) {
        media.push(structuredClone(item.publishedMedia));
      }
      publishTurnMedia(session, turnId);
    }
  }
  const id = String(item.id || `technical-${event.runtimeTurnId || 'unknown'}-${session.technicalItems.length}`);
  const existing = session.technicalItems.find((candidate) => candidate.id === id);
  const status = String(item.status || (event.type === 'item_completed' ? 'completed' : 'running'));
  const technical = {
    id,
    turnId: event.runtimeTurnId,
    kind: String(item.type || 'runtimeItem'),
    title: runtimeItemTitle(item),
    status,
    detail: runtimeItemDetail(item),
    durationMs: runtimeDuration(item, existing),
    startedAt: existing?.startedAt || timestamp,
    updatedAt: timestamp,
    completedAt: ['completed', 'failed', 'cancelled', 'canceled'].includes(status) ? timestamp : null,
  };
  if (existing) Object.assign(existing, technical);
  else session.technicalItems.push(technical);
}

function bindLatestUserMessage(session, turnId) {
  const message = [...session.messages].reverse().find((candidate) => (
    candidate.role === 'user' && !candidate.turnId && candidate.copiedFromShared !== true
  ));
  if (message) {
    message.turnId = turnId;
    message.turnStatus = 'inProgress';
  }
}

function publishTurnMedia(session, turnId) {
  const published = session.publishedMediaByTurn?.[turnId];
  if (!Array.isArray(published) || !published.length) return;
  const targets = session.messages.filter((message) => (
    message.role === 'assistant' && message.phase !== 'commentary' && message.turnId === turnId
  ));
  const target = targets.at(-1);
  if (!target) return;
  const publishedIds = new Set(published.map((media) => media.resourceId));
  for (const message of targets) {
    const retained = (message.media || []).filter((media) => !publishedIds.has(media?.resourceId));
    if (message === target) {
      const seen = new Set(retained.map((media) => media?.resourceId).filter(Boolean));
      message.media = [...retained, ...published.filter((media) => {
        if (!media?.resourceId || seen.has(media.resourceId)) return false;
        seen.add(media.resourceId);
        return true;
      })];
    } else if (retained.length) {
      message.media = retained;
    } else {
      delete message.media;
    }
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
  const title = ({
    commandExecution: 'Command',
    fileChange: 'File change',
    mcpToolCall: 'Tool call',
    webSearch: 'Web search',
    reasoning: 'Reasoning',
  })[item.type] || String(item.type || 'Runtime item');
  let subject = '';
  if (item.type === 'mcpToolCall') {
    subject = [item.server, item.tool || item.name || item.toolName].filter(Boolean).join('.');
  } else if (item.type === 'commandExecution') {
    subject = String(item.command || '').split(/\r?\n/, 1)[0];
  } else if (item.type === 'webSearch') {
    subject = item.query;
  }
  subject = String(subject || '').replace(/\s+/g, ' ').trim();
  return subject ? `${title} · ${subject.slice(0, 160)}` : title;
}

function runtimeItemDetail(item) {
  const sections = [];
  if (item.type === 'imageGeneration') {
    addRuntimeSection(
      sections,
      'Publication',
      item.publishedMedia
        ? 'Generated image published as a Session resource.'
        : item.publicationError?.code || 'Generated image was not published.',
    );
  } else if (item.type === 'reasoning') {
    addRuntimeSection(sections, 'Summary', Array.isArray(item.summary) ? item.summary.join('\n') : item.summary);
  } else if (item.type === 'mcpToolCall') {
    addRuntimeSection(sections, 'Input', runtimeValueText(item.arguments));
    addRuntimeSection(sections, 'Output', runtimeValueText(item.result));
    addRuntimeSection(sections, 'Error', runtimeValueText(item.error));
  } else if (item.type === 'commandExecution') {
    addRuntimeSection(sections, 'Command', item.command);
    addRuntimeSection(sections, 'Working directory', item.cwd);
    addRuntimeSection(sections, 'Output', item.aggregatedOutput);
    if (Number.isInteger(item.exitCode)) addRuntimeSection(sections, 'Exit code', String(item.exitCode));
  } else if (item.type === 'fileChange') {
    addRuntimeSection(sections, 'Changes', runtimeValueText(item.changes));
  } else if (item.type === 'webSearch') {
    addRuntimeSection(sections, 'Query', item.query);
    addRuntimeSection(sections, 'Results', runtimeValueText(item.results));
  }
  if (!sections.length) addRuntimeSection(sections, 'Detail', runtimeItemText(item));
  return sections.join('\n\n').slice(0, MAX_TECHNICAL_DETAIL_CHARS);
}

function addRuntimeSection(sections, label, value) {
  const text = String(value ?? '').trim();
  if (text) sections.push(`${label}\n${text}`);
}

function runtimeValueText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function runtimeDuration(item, existing) {
  const value = Number(item.durationMs);
  return Number.isFinite(value) && value >= 0 ? value : existing?.durationMs ?? null;
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

async function writeJsonAtomic(path, document, { sync = true } = {}) {
  await writeTextAtomic(path, `${JSON.stringify(document, null, 2)}\n`, { sync });
}

async function writeTextAtomic(path, content, { sync = true } = {}) {
  const temporary = join(dirname(path), `.${basename(path)}.writing-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    if (sync) await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    if (sync) await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim().slice(0, 200);
}

function sessionDraft(value) {
  if (typeof value !== 'string') throw new TypeError('Session draft must be a string');
  if (value.length > MAX_SESSION_DRAFT_CHARS) {
    throw storeError(
      'SESSION_DRAFT_TOO_LARGE',
      `Session draft exceeds ${MAX_SESSION_DRAFT_CHARS} characters.`,
      400,
    );
  }
  return value;
}

function sessionCreateIdempotencyKey(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw storeError('SESSION_CREATE_IDEMPOTENCY_KEY_INVALID', 'Session idempotency key is invalid.', 400);
  }
  const normalized = value.trim();
  if (normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw storeError('SESSION_CREATE_IDEMPOTENCY_KEY_INVALID', 'Session idempotency key is invalid.', 400);
  }
  return normalized;
}

function turnIdempotencyKey(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw storeError('SESSION_TURN_IDEMPOTENCY_KEY_INVALID', 'Turn idempotency key is invalid.', 400);
  }
  const normalized = value.trim();
  if (normalized.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw storeError('SESSION_TURN_IDEMPOTENCY_KEY_INVALID', 'Turn idempotency key is invalid.', 400);
  }
  return normalized;
}

function sessionCreateFingerprint({ title, draft }) {
  return createHash('sha256').update(JSON.stringify({ title, draft })).digest('hex');
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function storeError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

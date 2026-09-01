import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  link,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  RESOURCE_SCHEMA,
  normalizeResourceDescriptor,
} from './resources.js';

const RESOURCE_RECORD_SCHEMA = 'agent-workbench.resource-record/v1';
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TRANSIENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const TRANSIENT_CAPABILITIES = Object.freeze({
  preview: false,
  download: false,
  openInWorkspace: false,
});
const PROMOTED_CAPABILITIES = Object.freeze({
  preview: true,
  download: true,
  openInWorkspace: false,
});

export class FilesystemResourceStore {
  constructor({
    root,
    maxBytes = DEFAULT_MAX_BYTES,
    now = () => new Date(),
    uuid = randomUUID,
  } = {}) {
    if (typeof root !== 'string' || !root.trim()) throw new TypeError('ResourceStore root is required');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('ResourceStore maxBytes must be positive');
    this.root = resolve(root);
    this.recordsRoot = join(this.root, 'records');
    this.blobsRoot = join(this.root, 'blobs');
    this.maxBytes = maxBytes;
    this.now = now;
    this.uuid = uuid;
    this.queue = Promise.resolve();
    this.ready = this.#initialize();
  }

  async stage({
    kind = 'session-input',
    owner,
    display,
    bytes,
    originType = 'upload',
    capabilities = { preview: true, download: true, openInWorkspace: false },
  } = {}) {
    return this.#stageManaged({
      kind,
      owner,
      display,
      bytes,
      originType,
      lifecycleClass: 'draft',
      lifecycleState: 'staged',
      capabilities,
    });
  }

  async stageTransient({
    owner,
    display,
    bytes,
    originType = 'tool',
    capabilities = TRANSIENT_CAPABILITIES,
  } = {}) {
    if (!owner?.sessionId && !owner?.runId) {
      throw new TypeError('Transient resource owner requires sessionId or runId');
    }
    return this.#stageManaged({
      kind: 'transient-output',
      owner,
      display,
      bytes,
      originType,
      lifecycleClass: 'transient',
      lifecycleState: 'ready',
      capabilities,
    });
  }

  async #stageManaged({
    kind,
    owner,
    display,
    bytes,
    originType,
    lifecycleClass,
    lifecycleState,
    capabilities,
  }) {
    await this.ready;
    const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
    if (!content.length) throw resourceError('RESOURCE_EMPTY', 'Resource cannot be empty.', 400);
    if (content.length > this.maxBytes) throw resourceError('RESOURCE_TOO_LARGE', 'Resource exceeds the configured size limit.', 413);
    if (Number(display?.size) !== content.length) {
      throw resourceError('RESOURCE_SIZE_MISMATCH', 'Resource size changed during upload.', 400);
    }
    const timestamp = this.#time();
    const id = generatedResourceId(this.uuid());
    const extension = safeExtension(display?.name);
    const storageKey = `blobs/${id}${extension}`;
    const contentPath = this.#containedPath(storageKey);
    const descriptor = normalizeResourceDescriptor({
      schema: RESOURCE_SCHEMA,
      id,
      kind,
      mode: 'managed',
      owner,
      display: { ...display, size: content.length },
      integrity: {
        algorithm: 'sha256',
        digest: createHash('sha256').update(content).digest('hex'),
      },
      origin: { type: originType, createdAt: timestamp },
      lifecycle: { class: lifecycleClass, state: lifecycleState, updatedAt: timestamp },
      capabilities,
    });
    const record = { schema: RESOURCE_RECORD_SCHEMA, descriptor, storage: { key: storageKey } };
    let contentCreated = false;
    try {
      await writeExclusive(contentPath, content);
      contentCreated = true;
      await writeJsonAtomic(this.#recordPath(id), record, { exclusive: true });
    } catch (error) {
      if (contentCreated) await rm(contentPath, { force: true }).catch(() => {});
      throw error;
    }
    return structuredClone(descriptor);
  }

  async registerExternal({
    kind,
    owner,
    display,
    handle,
    originType = 'workspace',
    capabilities = { preview: false, download: false, openInWorkspace: true },
  } = {}) {
    if (!handle || typeof handle !== 'object' || Array.isArray(handle)) {
      throw new TypeError('External resource handle must be an object');
    }
    return this.#writeQueued(async () => {
      await this.ready;
      const timestamp = this.#time();
      const id = generatedResourceId(this.uuid());
      const descriptor = normalizeResourceDescriptor({
        schema: RESOURCE_SCHEMA,
        id,
        kind,
        mode: 'external',
        owner,
        display,
        origin: { type: originType, createdAt: timestamp },
        lifecycle: { class: 'workspace', state: 'ready', updatedAt: timestamp },
        capabilities,
      });
      await writeJsonAtomic(this.#recordPath(id), {
        schema: RESOURCE_RECORD_SCHEMA,
        descriptor,
        external: { handle: structuredClone(handle) },
      }, { exclusive: true });
      return structuredClone(descriptor);
    });
  }

  async commit(id, { sessionId, turnId = null } = {}) {
    return this.#writeQueued(async () => {
      await this.ready;
      const record = await this.#readOwnedRecord(id, { sessionId });
      if (record.descriptor.kind === 'transient-output'
        || record.descriptor.lifecycle.class === 'transient') {
        throw resourceError(
          'RESOURCE_PROMOTION_REQUIRED',
          'Transient output must be promoted before it can be bound to a Turn.',
          409,
        );
      }
      const currentTurnId = record.descriptor.owner.turnId || null;
      if (record.descriptor.lifecycle.state === 'ready') {
        if (turnId && currentTurnId && currentTurnId !== turnId) {
          throw resourceError('RESOURCE_ALREADY_COMMITTED', 'Resource is already committed to another Turn.', 409);
        }
        if (turnId && !currentTurnId) {
          record.descriptor = normalizeResourceDescriptor({
            ...record.descriptor,
            owner: { ...record.descriptor.owner, turnId },
            lifecycle: { ...record.descriptor.lifecycle, updatedAt: this.#time() },
          });
          await writeJsonAtomic(this.#recordPath(record.descriptor.id), record);
        }
        return structuredClone(record.descriptor);
      }
      if (record.descriptor.mode !== 'managed') {
        throw resourceError('RESOURCE_MODE_INVALID', 'External resources must be ready before binding.', 409);
      }
      if (record.descriptor.lifecycle.state !== 'staged') {
        throw resourceError('RESOURCE_STATE_INVALID', 'Resource is not available for commit.', 409);
      }
      const timestamp = this.#time();
      record.descriptor = normalizeResourceDescriptor({
        ...record.descriptor,
        owner: {
          ...record.descriptor.owner,
          ...(turnId ? { turnId } : {}),
        },
        lifecycle: { class: 'session-durable', state: 'ready', updatedAt: timestamp },
      });
      await writeJsonAtomic(this.#recordPath(record.descriptor.id), record);
      return structuredClone(record.descriptor);
    });
  }

  async promote(id, {
    runId = null,
    sessionId,
    turnId = null,
    kind = 'session-artifact',
    capabilities = PROMOTED_CAPABILITIES,
  } = {}) {
    if (!['session-artifact', 'visualization'].includes(kind)) {
      throw new TypeError('Promotion kind must be session-artifact or visualization');
    }
    const targetSessionId = resourceIdentity(sessionId, 'Promotion sessionId');
    const targetTurnId = turnId == null || turnId === ''
      ? null
      : resourceIdentity(turnId, 'Promotion turnId');
    const sourceRunId = runId == null || runId === ''
      ? null
      : resourceIdentity(runId, 'Promotion runId');
    return this.#writeQueued(async () => {
      await this.ready;
      const record = await this.#readRecord(id);
      this.#authorizePromotion(record.descriptor, {
        runId: sourceRunId,
        sessionId: targetSessionId,
      });
      if (record.descriptor.lifecycle.state === 'promoted') {
        const currentTurnId = record.descriptor.owner.turnId || null;
        if (record.descriptor.kind !== kind
          || record.descriptor.owner.sessionId !== targetSessionId
          || currentTurnId !== targetTurnId) {
          throw resourceError(
            'RESOURCE_PROMOTION_CONFLICT',
            'Resource was already promoted with a different durable target.',
            409,
          );
        }
        return structuredClone(record.descriptor);
      }
      if (record.descriptor.mode !== 'managed'
        || record.descriptor.kind !== 'transient-output'
        || record.descriptor.lifecycle.class !== 'transient'
        || !['ready', 'promotable'].includes(record.descriptor.lifecycle.state)) {
        throw resourceError('RESOURCE_STATE_INVALID', 'Resource is not available for promotion.', 409);
      }
      await this.#verifyManagedContent(record);
      record.descriptor = normalizeResourceDescriptor({
        ...record.descriptor,
        kind,
        owner: {
          ...record.descriptor.owner,
          sessionId: targetSessionId,
          ...(targetTurnId ? { turnId: targetTurnId } : {}),
        },
        lifecycle: { class: 'session-durable', state: 'promoted', updatedAt: this.#time() },
        capabilities,
      });
      await writeJsonAtomic(this.#recordPath(record.descriptor.id), record);
      return structuredClone(record.descriptor);
    });
  }

  async get(id, { sessionId } = {}) {
    await this.ready;
    await this.queue;
    const record = await this.#readOwnedRecord(id, { sessionId });
    return structuredClone(record.descriptor);
  }

  async list({ sessionId } = {}) {
    await this.ready;
    await this.queue;
    const records = await this.#readAllRecords();
    return records
      .filter((record) => sessionId == null || record.descriptor.owner.sessionId === sessionId)
      .map((record) => structuredClone(record.descriptor))
      .sort((left, right) => right.origin.createdAt.localeCompare(left.origin.createdAt));
  }

  async open(id, { sessionId } = {}) {
    await this.ready;
    await this.queue;
    const record = await this.#readOwnedRecord(id, { sessionId });
    if (record.descriptor.mode !== 'managed' || !record.storage?.key) {
      throw resourceError('RESOURCE_CONTENT_EXTERNAL', 'External resource content is not managed by this store.', 409);
    }
    const path = await this.#resolveStoredContent(record.storage.key);
    const info = await stat(path);
    if (!info.isFile() || info.size !== record.descriptor.display.size) {
      throw resourceError('RESOURCE_CONTENT_INVALID', 'Resource content does not match its record.', 409);
    }
    return { descriptor: structuredClone(record.descriptor), path, size: info.size };
  }

  async read(id, authorization = {}) {
    const opened = await this.open(id, authorization);
    return { descriptor: opened.descriptor, bytes: await readFile(opened.path) };
  }

  async resolveExternal(id, { sessionId } = {}) {
    await this.ready;
    await this.queue;
    const record = await this.#readOwnedRecord(id, { sessionId });
    if (record.descriptor.mode !== 'external' || !record.external?.handle) {
      throw resourceError('RESOURCE_NOT_EXTERNAL', 'Resource is not an external reference.', 409);
    }
    return { descriptor: structuredClone(record.descriptor), handle: structuredClone(record.external.handle) };
  }

  async inspectUsage() {
    await this.ready;
    await this.queue;
    const records = await this.#readAllRecords();
    const byClass = {};
    const byState = {};
    let bytes = 0;
    for (const { descriptor } of records) {
      bytes += descriptor.mode === 'managed' ? descriptor.display.size : 0;
      byClass[descriptor.lifecycle.class] = (byClass[descriptor.lifecycle.class] || 0) + 1;
      byState[descriptor.lifecycle.state] = (byState[descriptor.lifecycle.state] || 0) + 1;
    }
    return { resources: records.length, bytes, byClass, byState };
  }

  async planCollection({
    draftMaxAgeMs = DEFAULT_DRAFT_MAX_AGE_MS,
    transientMaxAgeMs = DEFAULT_TRANSIENT_MAX_AGE_MS,
    now = this.now(),
  } = {}) {
    if (!Number.isFinite(draftMaxAgeMs) || draftMaxAgeMs < 0) throw new TypeError('draftMaxAgeMs must be non-negative');
    if (!Number.isFinite(transientMaxAgeMs) || transientMaxAgeMs < 0) throw new TypeError('transientMaxAgeMs must be non-negative');
    const collectionTime = new Date(now).getTime();
    if (!Number.isFinite(collectionTime)) throw new TypeError('collection time must be valid');
    const draftCutoff = collectionTime - draftMaxAgeMs;
    const transientCutoff = collectionTime - transientMaxAgeMs;
    const records = await this.#readAllRecordsAfterQueue();
    return {
      generatedAt: new Date(now).toISOString(),
      resources: records
        .map(({ descriptor }) => {
          const updatedAt = Date.parse(descriptor.lifecycle.updatedAt || descriptor.origin.createdAt);
          const isDraft = descriptor.lifecycle.class === 'draft'
            && descriptor.lifecycle.state === 'staged'
            && updatedAt <= draftCutoff;
          const isTransient = descriptor.lifecycle.class === 'transient'
            && ['ready', 'promotable'].includes(descriptor.lifecycle.state)
            && updatedAt <= transientCutoff;
          if (!isDraft && !isTransient) return null;
          return {
            id: descriptor.id,
            sessionId: descriptor.owner.sessionId || null,
            bytes: descriptor.mode === 'managed' ? descriptor.display.size : 0,
            class: descriptor.lifecycle.class,
            state: descriptor.lifecycle.state,
            ageMs: Math.max(0, collectionTime - updatedAt),
            reason: isDraft ? 'draft-expired' : 'transient-expired',
          };
        })
        .filter(Boolean),
    };
  }

  #authorizePromotion(descriptor, { runId, sessionId }) {
    const targetSessionId = String(sessionId);
    if (descriptor.owner.sessionId && descriptor.owner.sessionId !== targetSessionId) {
      throw resourceError('RESOURCE_SESSION_MISMATCH', 'Resource does not belong to this Session.', 403);
    }
    if (descriptor.owner.runId && descriptor.owner.runId !== String(runId || '')) {
      throw resourceError('RESOURCE_RUN_MISMATCH', 'Resource does not belong to this Run.', 403);
    }
  }

  async #verifyManagedContent(record) {
    if (record.descriptor.mode !== 'managed' || !record.storage?.key) {
      throw resourceError('RESOURCE_CONTENT_INVALID', 'Resource content is not managed by this store.', 409);
    }
    const path = await this.#resolveStoredContent(record.storage.key);
    const content = await readFile(path);
    const digest = createHash('sha256').update(content).digest('hex');
    if (content.length !== record.descriptor.display.size
      || digest !== record.descriptor.integrity?.digest) {
      throw resourceError('RESOURCE_CONTENT_INVALID', 'Resource content does not match its record.', 409);
    }
  }

  async #initialize() {
    await mkdir(this.recordsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.blobsRoot, { recursive: true, mode: 0o700 });
    const [canonicalRoot, canonicalRecords, canonicalBlobs] = await Promise.all([
      realpath(this.root),
      realpath(this.recordsRoot),
      realpath(this.blobsRoot),
    ]);
    if (!isContained(canonicalRoot, canonicalRecords) || !isContained(canonicalRoot, canonicalBlobs)) {
      throw resourceError('RESOURCE_ROOT_INVALID', 'ResourceStore directories escape the configured root.', 500);
    }
    this.root = canonicalRoot;
    this.recordsRoot = canonicalRecords;
    this.blobsRoot = canonicalBlobs;
  }

  async #readAllRecordsAfterQueue() {
    await this.ready;
    await this.queue;
    return this.#readAllRecords();
  }

  async #readAllRecords() {
    const entries = await readdir(this.recordsRoot);
    const records = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      records.push(await this.#readRecord(basename(entry, '.json')));
    }
    return records;
  }

  async #readOwnedRecord(id, { sessionId } = {}) {
    const record = await this.#readRecord(id);
    if (sessionId != null && record.descriptor.owner.sessionId !== String(sessionId)) {
      throw resourceError('RESOURCE_SESSION_MISMATCH', 'Resource does not belong to this Session.', 403);
    }
    return record;
  }

  async #readRecord(id) {
    const normalizedId = validResourceId(id);
    let document;
    try {
      document = JSON.parse(await readFile(this.#recordPath(normalizedId), 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') throw resourceError('RESOURCE_NOT_FOUND', `Resource not found: ${normalizedId}`, 404);
      if (error instanceof SyntaxError) throw resourceError('RESOURCE_RECORD_INVALID', `Resource record is invalid: ${normalizedId}`, 409);
      throw error;
    }
    if (document?.schema !== RESOURCE_RECORD_SCHEMA) {
      throw resourceError('RESOURCE_RECORD_INVALID', `Resource record is invalid: ${normalizedId}`, 409);
    }
    let descriptor;
    try {
      descriptor = normalizeResourceDescriptor(document.descriptor);
    } catch {
      throw resourceError('RESOURCE_RECORD_INVALID', `Resource descriptor is invalid: ${normalizedId}`, 409);
    }
    if (descriptor.id !== normalizedId) {
      throw resourceError('RESOURCE_RECORD_INVALID', `Resource record id does not match: ${normalizedId}`, 409);
    }
    return { ...document, descriptor };
  }

  async #resolveStoredContent(key) {
    if (typeof key !== 'string' || isAbsolute(key) || !key.startsWith('blobs/')) {
      throw resourceError('RESOURCE_STORAGE_KEY_INVALID', 'Resource storage key is invalid.', 409);
    }
    const candidate = this.#containedPath(key);
    let canonical;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') throw resourceError('RESOURCE_NOT_FOUND', 'Resource content does not exist.', 404);
      throw error;
    }
    if (!isContained(this.blobsRoot, canonical)) {
      throw resourceError('RESOURCE_PATH_INVALID', 'Resource content escapes its storage root.', 403);
    }
    return canonical;
  }

  #recordPath(id) {
    return this.#containedPath(`records/${validResourceId(id)}.json`);
  }

  #containedPath(key) {
    const candidate = resolve(this.root, key);
    if (!isContained(this.root, candidate)) throw resourceError('RESOURCE_PATH_INVALID', 'Resource path escapes its storage root.', 403);
    return candidate;
  }

  #time() {
    const value = this.now();
    const time = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(time.getTime())) throw new TypeError('ResourceStore clock returned an invalid time');
    return time.toISOString();
  }

  #writeQueued(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function writeExclusive(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(path, value, { exclusive = false } = {}) {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (exclusive) {
      await link(temporary, path);
      await rm(temporary, { force: true });
      return;
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function generatedResourceId(value) {
  const suffix = String(value || '').trim().replace(/[^A-Za-z0-9_-]/g, '-');
  return validResourceId(`res_${suffix}`);
}

function validResourceId(value) {
  const id = String(value || '').trim();
  if (!/^res_[A-Za-z0-9][A-Za-z0-9_-]{7,199}$/.test(id)) {
    throw resourceError('RESOURCE_ID_INVALID', 'Resource id is invalid.', 400);
  }
  return id;
}

function safeExtension(value) {
  const extension = extname(String(value || '')).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '';
}

function resourceIdentity(value, label) {
  const identity = String(value || '').trim();
  if (!identity || identity.length > 240 || /[\u0000-\u001f\u007f]/.test(identity)) {
    throw new TypeError(`${label} is invalid`);
  }
  return identity;
}

function isContained(root, candidate) {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
}

function resourceError(code, message, status = 500) {
  return Object.assign(new Error(message), { code, status });
}

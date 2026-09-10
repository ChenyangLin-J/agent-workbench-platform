import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';

import { resourceDescriptorAttachment } from '../resources.js';

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_CACHE_LIMIT = 256;

export class MinimalHostResultFileProjector {
  constructor({
    resourceStore,
    runId,
    workspaceRoot,
    enabled = true,
    maxBytes = DEFAULT_MAX_BYTES,
    cacheLimit = DEFAULT_CACHE_LIMIT,
    logger = () => {},
  } = {}) {
    if (!resourceStore?.stageTransient || !resourceStore?.promote) {
      throw new TypeError('Result file projection requires transient ResourceStore promotion');
    }
    if (typeof runId !== 'string' || !runId.trim()) throw new TypeError('Result file projection requires a Run id');
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
      throw new TypeError('Result file projection requires a workspace root');
    }
    this.resourceStore = resourceStore;
    this.runId = runId.trim();
    this.workspaceRoot = resolve(workspaceRoot);
    this.enabled = enabled === true;
    this.maxBytes = Math.max(1, Number(maxBytes) || DEFAULT_MAX_BYTES);
    this.cacheLimit = Math.max(1, Number(cacheLimit) || DEFAULT_CACHE_LIMIT);
    this.logger = logger;
    this.candidates = new Map();
    this.publications = new Map();
  }

  async projectEvent(event = {}) {
    if (!this.enabled) return event;
    const item = event?.payload?.item;
    const key = turnKey(event.sessionId, event.runtimeTurnId);
    if (event.type === 'item_completed' && item?.type === 'fileChange') {
      const candidates = this.candidates.get(key) || new Map();
      for (const candidate of fileChangeCandidates(item)) candidates.set(candidate.path, candidate);
      this.#remember(this.candidates, key, candidates);
      return event;
    }
    if (event.type !== 'item_completed' || item?.type !== 'agentMessage' || item.phase === 'commentary') return event;
    const text = runtimeItemText(item);
    const publicationKey = JSON.stringify([key, item.id || '', createHash('sha256').update(text).digest('hex')]);
    let publication = this.publications.get(publicationKey);
    if (!publication) {
      publication = this.#publish({
        candidates: [...(this.candidates.get(key)?.values() || [])],
        sessionId: event.sessionId,
        turnId: event.runtimeTurnId,
        text,
      });
      this.#remember(this.publications, publicationKey, publication);
    }
    const result = await publication;
    return {
      ...event,
      payload: {
        ...(event.payload || {}),
        item: {
          ...item,
          ...(result.artifacts.length ? { publishedArtifacts: result.artifacts } : {}),
          ...(result.errors.length ? { artifactPublicationErrors: result.errors } : {}),
        },
      },
    };
  }

  async #publish({ candidates, sessionId, turnId, text }) {
    const artifacts = [];
    const errors = [];
    for (const candidate of candidates) {
      if (!candidateReferenced(candidate.path, text)) continue;
      try {
        artifacts.push(resourceDescriptorAttachment(await this.#capture(candidate.path, { sessionId, turnId })));
      } catch (error) {
        const failure = {
          name: basename(candidate.path) || 'artifact',
          code: String(error?.code || 'RESULT_FILE_CAPTURE_FAILED'),
        };
        errors.push(failure);
        this.logger('minimal-host-result-file-capture-failed', {
          sessionId: boundedLogValue(sessionId),
          turnId: boundedLogValue(turnId),
          code: failure.code,
        });
      }
    }
    return { artifacts, errors };
  }

  async #capture(sourcePath, { sessionId, turnId }) {
    const workspace = await realpath(this.workspaceRoot);
    const requested = isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(workspace, sourcePath);
    const path = await realpath(requested).catch((error) => {
      if (error?.code === 'ENOENT') throw resultFileError('RESULT_FILE_NOT_FOUND', 'Referenced result file is missing.');
      throw error;
    });
    if (!isContained(workspace, path)) {
      throw resultFileError('RESULT_FILE_PATH_UNAUTHORIZED', 'Referenced result file is outside the workspace.');
    }
    const info = await stat(path);
    if (!info.isFile()) throw resultFileError('RESULT_FILE_TYPE_INVALID', 'Referenced result is not a regular file.');
    if (info.size > this.maxBytes) throw resultFileError('RESULT_FILE_TOO_LARGE', 'Referenced result file is too large.');
    const bytes = await readFile(path);
    if (bytes.length !== info.size) throw resultFileError('RESULT_FILE_CHANGED', 'Referenced result file changed while it was captured.');
    const transient = await this.resourceStore.stageTransient({
      owner: {
        runId: this.runId,
        sessionId,
        ...(turnId ? { turnId } : {}),
      },
      display: {
        name: basename(path),
        mimeType: resultFileMimeType(path),
        size: bytes.length,
      },
      bytes,
      allowEmpty: true,
      originType: 'generated',
    });
    return this.resourceStore.promote(transient.id, {
      runId: this.runId,
      sessionId,
      turnId: turnId || null,
      kind: 'session-artifact',
    });
  }

  #remember(map, key, value) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > this.cacheLimit) map.delete(map.keys().next().value);
  }
}

function fileChangeCandidates(item) {
  const values = [
    ...(Array.isArray(item?.changes) ? item.changes : []),
    ...(item?.path ? [{ path: item.path, kind: item.kind }] : []),
  ];
  return values.flatMap((change) => {
    if (['delete', 'deleted', 'remove', 'removed'].includes(String(change?.kind || '').toLowerCase())) return [];
    const path = normalizedCandidatePath(change?.path);
    return path ? [{ path }] : [];
  });
}

function normalizedCandidatePath(value) {
  let path = String(value || '').trim();
  if (!path || /[\u0000\r\n]/.test(path)) return null;
  if (path.startsWith('file://')) {
    try { path = decodeURIComponent(new URL(path).pathname); } catch { return null; }
  }
  return path.replace(/#L\d+(?:C\d+)?$/i, '');
}

function candidateReferenced(path, text) {
  const source = String(text || '');
  const variants = new Set([path, encodeURI(path), path.replace(/ /g, '%20')]);
  return [...variants].some((candidate) => candidate && exactReference(source, candidate));
}

function exactReference(source, candidate) {
  let offset = 0;
  while (offset <= source.length - candidate.length) {
    const index = source.indexOf(candidate, offset);
    if (index < 0) return false;
    const before = source[index - 1] || '';
    const after = source.slice(index + candidate.length);
    const beforeIsBoundary = !before || !referencePathCharacter(before);
    const afterIsBoundary = !after || /^(?:#L\d+(?:C\d+)?|:\d+(?::\d+)?)?(?:$|[^\p{Letter}\p{Number}_.\/\\%+-])/u.test(after);
    if (beforeIsBoundary && afterIsBoundary) return true;
    offset = index + candidate.length;
  }
  return false;
}

function referencePathCharacter(character) {
  return /[\p{Letter}\p{Number}_.\/\\%+-]/u.test(character);
}

function runtimeItemText(item) {
  if (typeof item?.text === 'string') return item.text;
  if (typeof item?.content === 'string') return item.content;
  if (Array.isArray(item?.content)) {
    return item.content.map((part) => part?.text || part?.content || '').filter(Boolean).join('\n');
  }
  return '';
}

function resultFileMimeType(path) {
  return ({
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.sql': 'application/sql',
    '.txt': 'text/plain',
  })[extname(path).toLowerCase()] || 'application/octet-stream';
}

function isContained(root, candidate) {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
}

function turnKey(sessionId, turnId) {
  return JSON.stringify([String(sessionId || ''), String(turnId || '')]);
}

function boundedLogValue(value) {
  return String(value || '').slice(0, 240);
}

function resultFileError(code, message) {
  return Object.assign(new Error(message), { code });
}

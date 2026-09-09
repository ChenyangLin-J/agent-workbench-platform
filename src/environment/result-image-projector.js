import { createHash } from 'node:crypto';
import { extname } from 'node:path';

import { MAX_SESSION_ATTACHMENT_BYTES } from '../attachments.js';

const DEFAULT_CAPTURE_CACHE_LIMIT = 256;
const IMAGE_MIME_TYPES = Object.freeze({
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
});
const IMAGE_EXTENSIONS = Object.freeze({
  'image/gif': '.gif',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
});

export class MinimalHostResultImageProjector {
  constructor({
    resourceStore,
    runId,
    captureCacheLimit = DEFAULT_CAPTURE_CACHE_LIMIT,
    maxBytes = MAX_SESSION_ATTACHMENT_BYTES,
    logger = () => {},
  } = {}) {
    if (!resourceStore?.stageTransient || !resourceStore?.promote) {
      throw new TypeError('Result image projection requires a ResourceStore with transient promotion');
    }
    if (typeof runId !== 'string' || !runId.trim()) throw new TypeError('Result image projection requires a Run id');
    this.resourceStore = resourceStore;
    this.runId = runId.trim();
    this.captureCacheLimit = Math.max(1, Number(captureCacheLimit) || DEFAULT_CAPTURE_CACHE_LIMIT);
    this.maxBytes = Math.max(1, Number(maxBytes) || MAX_SESSION_ATTACHMENT_BYTES);
    this.captures = new Map();
    this.logger = logger;
  }

  async projectEvent(event = {}) {
    const item = event?.payload?.item;
    if (item?.type !== 'imageGeneration') return event;
    const safeItem = sanitizeImageGeneration(item);
    if (event.type !== 'item_completed' || !publishableImageGeneration(item)) {
      return withProjectedItem(event, safeItem);
    }
    try {
      const descriptor = await this.#capture({
        item,
        sessionId: event.sessionId,
        turnId: event.runtimeTurnId,
      });
      return withProjectedItem(event, {
        ...safeItem,
        publishedMedia: {
          type: 'resourceImage',
          resourceId: descriptor.id,
          name: descriptor.display.name,
          mimeType: descriptor.display.mimeType,
          size: descriptor.display.size,
        },
      });
    } catch (error) {
      this.logger('minimal-host-result-image-capture-failed', {
        sessionId: boundedLogValue(event.sessionId),
        turnId: boundedLogValue(event.runtimeTurnId),
        itemId: boundedLogValue(item.id),
        code: error?.code || 'RESULT_IMAGE_CAPTURE_FAILED',
      });
      return withProjectedItem(event, {
        ...safeItem,
        publicationError: { code: error?.code || 'RESULT_IMAGE_CAPTURE_FAILED' },
      });
    }
  }

  #capture({ item, sessionId, turnId }) {
    const image = decodeImageGeneration(item, this.maxBytes);
    const digest = createHash('sha256').update(image.bytes).digest('hex');
    const key = JSON.stringify([sessionId, turnId || '', item.id, digest]);
    const existing = this.captures.get(key);
    if (existing) {
      this.captures.delete(key);
      this.captures.set(key, existing);
      return existing;
    }
    const capture = Promise.resolve().then(async () => {
      const transient = await this.resourceStore.stageTransient({
        owner: {
          runId: this.runId,
          sessionId,
          ...(turnId ? { turnId } : {}),
        },
        display: {
          name: generatedImageName(item.id, image.mimeType),
          mimeType: image.mimeType,
          size: image.bytes.length,
        },
        bytes: image.bytes,
        originType: 'generated',
      });
      return this.resourceStore.promote(transient.id, {
        runId: this.runId,
        sessionId,
        turnId: turnId || null,
        kind: 'session-artifact',
      });
    });
    this.captures.set(key, capture);
    while (this.captures.size > this.captureCacheLimit) this.captures.delete(this.captures.keys().next().value);
    capture.catch(() => {
      if (this.captures.get(key) === capture) this.captures.delete(key);
    });
    return capture;
  }
}

function publishableImageGeneration(item) {
  return Boolean(item?.id
    && typeof item.result === 'string'
    && item.result.trim()
    && (!item.status || item.status === 'completed')
    && !item.failure);
}

function decodeImageGeneration(item, maxBytes) {
  let encoded = String(item?.result || '').trim();
  const dataUrl = encoded.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/\s]*={0,2})$/i);
  const mimeType = dataUrl
    ? dataUrl[1].toLowerCase()
    : IMAGE_MIME_TYPES[extname(String(item?.savedPath || item?.saved_path || '')).toLowerCase()] || 'image/png';
  if (dataUrl) encoded = dataUrl[2];
  encoded = encoded.replace(/\s+/g, '');
  if (encoded.length > Math.ceil(maxBytes * 4 / 3) + 4) {
    throw resultImageError('RESULT_IMAGE_TOO_LARGE', 'Generated image exceeds the Resource size limit.');
  }
  if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw resultImageError('RESULT_IMAGE_DATA_INVALID', 'Generated image data is not valid base64.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length) throw resultImageError('RESULT_IMAGE_DATA_INVALID', 'Generated image data is empty.');
  if (bytes.length > maxBytes) {
    throw resultImageError('RESULT_IMAGE_TOO_LARGE', 'Generated image exceeds the Resource size limit.');
  }
  return { bytes, mimeType };
}

function sanitizeImageGeneration(item) {
  const {
    result: _result,
    savedPath: _savedPath,
    saved_path: _legacySavedPath,
    publishedMedia: _publishedMedia,
    publicationError: _publicationError,
    ...safe
  } = item;
  return safe;
}

function withProjectedItem(event, item) {
  return { ...event, payload: { ...(event.payload || {}), item } };
}

function generatedImageName(itemId, mimeType) {
  const suffix = String(itemId || 'result').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 120) || 'result';
  return `generated-${suffix}${IMAGE_EXTENSIONS[mimeType] || '.png'}`;
}

function boundedLogValue(value) {
  return String(value || '').slice(0, 240);
}

function resultImageError(code, message) {
  return Object.assign(new Error(message), { code });
}

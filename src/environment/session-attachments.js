import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

import {
  MAX_SESSION_ATTACHMENTS,
  MAX_SESSION_ATTACHMENT_BYTES,
  normalizeSessionAttachment,
} from '../attachments.js';
import { FilesystemResourceStore } from '../filesystem-resource-store.js';
import { resourceDescriptorAttachment } from '../resources.js';
import { appServerAttachmentInputs } from '../runtime.js';

export function createEnvironmentSessionResourceStore({ root, maxBytes = MAX_SESSION_ATTACHMENT_BYTES } = {}) {
  return new FilesystemResourceStore({ root, maxBytes });
}

export async function saveEnvironmentSessionAttachment({ attachment, sessionId, root, store = null }) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const name = normalizeAttachmentName(attachment?.name);
  const mimeType = normalizeMimeType(attachment?.type || attachment?.mimeType);
  const bytes = decodeAttachmentData(attachment?.data);
  if (!bytes.length) throw attachmentError('ATTACHMENT_EMPTY', 'Attachment cannot be empty.', 400);
  if (bytes.length > MAX_SESSION_ATTACHMENT_BYTES) {
    throw attachmentError('ATTACHMENT_TOO_LARGE', 'Attachment cannot exceed 20 MB.', 413);
  }
  if (Number.isFinite(attachment?.size) && Number(attachment.size) !== bytes.length) {
    throw attachmentError('ATTACHMENT_SIZE_MISMATCH', 'Attachment size changed during upload.', 400);
  }

  const resource = await attachmentStore({ root, store }).stage({
    kind: 'session-input',
    owner: { sessionId: normalizedSessionId },
    display: { name, mimeType, size: bytes.length },
    bytes,
    originType: attachment?.originType === 'paste' ? 'paste' : 'upload',
    capabilities: {
      preview: previewableMimeType(mimeType),
      download: true,
      openInWorkspace: false,
    },
  });
  return browserAttachment(resource);
}

export async function resolveEnvironmentSessionAttachmentInputs({
  attachments,
  sessionId,
  authorizedRoots = [],
  root,
  store = null,
}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const requested = normalizeRequestedAttachments(attachments);
  const resourceStore = attachmentStore({ root, store, external: true });
  let roots = null;
  const resolved = await Promise.all(requested.map(async (attachment) => {
    const resource = await requestedResource(resourceStore, attachment, normalizedSessionId);
    if (resource.mode === 'external') {
      const external = await resourceStore.resolveExternal(resource.id, { sessionId: normalizedSessionId });
      roots ||= await canonicalAuthorizedRoots(authorizedRoots);
      if (!roots.length) {
        throw attachmentError('DIRECTORY_ROOT_UNAVAILABLE', 'No authorized workspace root is available.', 403);
      }
      const path = await authorizedDirectoryPath(external.handle.path, roots);
      return [{
        type: 'text',
        text: `Authorized ${resource.kind} ${JSON.stringify(resource.display.name)}: ${JSON.stringify(path)}`,
      }];
    }
    const opened = await resourceStore.open(resource.id, { sessionId: normalizedSessionId });
    let textContent = null;
    if (['text/plain', 'text/markdown', 'text/x-markdown'].includes(opened.descriptor.display.mimeType)) {
      textContent = await readFile(opened.path, 'utf8');
    }
    try {
      return appServerAttachmentInputs({
        id: opened.descriptor.id,
        mimeType: opened.descriptor.display.mimeType,
        name: opened.descriptor.display.name,
        path: opened.path,
        size: opened.descriptor.display.size,
        textContent,
      });
    } catch (error) {
      if (error?.code === 'TEXT_ATTACHMENT_TOO_LARGE') {
        throw attachmentError(error.code, 'Text attachment cannot exceed 512 KB.', 413);
      }
      throw error;
    }
  }));
  return resolved.flat();
}

export async function commitEnvironmentSessionAttachments({
  attachments,
  sessionId,
  turnId = null,
  root,
  store = null,
}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const requested = normalizeRequestedAttachments(attachments);
  const resourceStore = attachmentStore({ root, store });
  return Promise.all(requested.map(async (attachment) => {
    const resource = await requestedResource(resourceStore, attachment, normalizedSessionId);
    return browserAttachment(await resourceStore.commit(resource.id, {
      sessionId: normalizedSessionId,
      turnId,
    }));
  }));
}

export async function registerEnvironmentSessionDirectories({
  directories,
  sessionId,
  runId = null,
  authorizedRoots = [],
  root,
  store = null,
}) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const requested = Array.isArray(directories) ? directories : [];
  if (!requested.length) throw attachmentError('DIRECTORY_INPUT_REQUIRED', 'At least one directory is required.', 400);
  if (requested.length > MAX_SESSION_ATTACHMENTS) {
    throw attachmentError('ATTACHMENT_LIMIT_EXCEEDED', `A turn can include at most ${MAX_SESSION_ATTACHMENTS} resources.`, 400);
  }
  const resourceStore = attachmentStore({ root, store, external: true });
  const roots = await canonicalAuthorizedRoots(authorizedRoots);
  if (!roots.length) throw attachmentError('DIRECTORY_ROOT_UNAVAILABLE', 'No authorized workspace root is available.', 403);
  return Promise.all(requested.map(async (directory) => {
    const path = await authorizedDirectoryPath(directory?.pathHint, roots);
    const resource = await resourceStore.registerExternal({
      kind: 'workspace-directory',
      owner: {
        sessionId: normalizedSessionId,
        ...(runId ? { runId: String(runId) } : {}),
      },
      display: {
        name: normalizeAttachmentName(directory?.name || path),
        mimeType: 'inode/directory',
        size: 0,
      },
      handle: { type: 'local-path', path },
      originType: 'workspace',
      capabilities: { preview: false, download: false, openInWorkspace: true },
    });
    return browserAttachment(resource);
  }));
}

export async function readEnvironmentSessionAttachment({ id = '', name = '', sessionId, root, store = null }) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const resourceStore = attachmentStore({ root, store });
  const opened = await openRequestedAttachment(resourceStore, { id, name }, normalizedSessionId);
  const { descriptor } = opened;
  return {
    id: descriptor.id,
    sessionId: descriptor.owner.sessionId,
    name: descriptor.display.name,
    mimeType: descriptor.display.mimeType,
    size: descriptor.display.size,
    inputType: normalizeSessionAttachment(resourceDescriptorAttachment(descriptor)).inputType,
    storedPath: opened.path,
    createdAt: descriptor.origin.createdAt,
    resource: descriptor,
  };
}

async function openRequestedAttachment(store, attachment, sessionId) {
  const resource = await requestedResource(store, attachment, sessionId);
  return store.open(resource.id, { sessionId });
}

async function requestedResource(store, attachment, sessionId) {
  const requestedId = String(attachment?.id || '').trim();
  if (requestedId) return store.get(requestedId, { sessionId });
  const requestedName = normalizeAttachmentName(attachment?.name);
  const resources = await store.list({ sessionId });
  const resource = resources.find((candidate) => candidate.display.name === requestedName);
  if (!resource) {
    throw attachmentError('ATTACHMENT_NOT_FOUND', `Attachment not found: ${requestedName}`, 404);
  }
  return resource;
}

function normalizeRequestedAttachments(attachments) {
  const requested = Array.isArray(attachments) ? attachments : [];
  if (requested.length > MAX_SESSION_ATTACHMENTS) {
    throw attachmentError(
      'ATTACHMENT_LIMIT_EXCEEDED',
      `A turn can include at most ${MAX_SESSION_ATTACHMENTS} attachments.`,
      400,
    );
  }
  return requested;
}

function attachmentStore({ root, store, external = false }) {
  if (store) {
    const methods = ['stage', 'commit', 'get', 'list', 'open', ...(external ? ['registerExternal', 'resolveExternal'] : [])];
    for (const method of methods) {
      if (typeof store[method] !== 'function') throw new TypeError(`ResourceStore.${method} is required`);
    }
    return store;
  }
  return createEnvironmentSessionResourceStore({ root });
}

async function canonicalAuthorizedRoots(values) {
  const roots = [];
  for (const value of values || []) {
    if (typeof value !== 'string' || !value.trim() || !isAbsolute(value)) continue;
    const root = await realpath(value).catch(() => null);
    if (root && !roots.includes(root)) roots.push(root);
  }
  return roots;
}

async function authorizedDirectoryPath(value, roots) {
  const requested = String(value || '').trim();
  if (!requested || !isAbsolute(requested)) {
    throw attachmentError('DIRECTORY_PATH_REQUIRED', 'The browser did not provide an absolute directory path.', 400);
  }
  const path = await realpath(requested).catch((error) => {
    if (error?.code === 'ENOENT') throw attachmentError('DIRECTORY_NOT_FOUND', 'The referenced directory does not exist.', 404);
    throw error;
  });
  if (!roots.some((root) => isContained(root, path))) {
    throw attachmentError('DIRECTORY_PATH_UNAUTHORIZED', 'The directory is outside authorized workspace roots.', 403);
  }
  const info = await stat(path);
  if (!info.isDirectory()) throw attachmentError('DIRECTORY_TYPE_INVALID', 'The referenced path is not a directory.', 400);
  return path;
}

function isContained(root, candidate) {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
}

function browserAttachment(resource) {
  return normalizeSessionAttachment(resourceDescriptorAttachment(resource));
}

function decodeAttachmentData(value) {
  const source = String(value || '');
  const match = source.match(/^data:[^;,]*(?:;[^;,=]+=[^;,]*)*;base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!match || match[1].length % 4 === 1) {
    throw attachmentError('ATTACHMENT_DATA_INVALID', 'Attachment data must be a base64 data URL.', 400);
  }
  return Buffer.from(match[1], 'base64');
}

function normalizeSessionId(value) {
  const sessionId = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(sessionId)) {
    throw attachmentError('ATTACHMENT_SESSION_INVALID', 'Session ID is invalid.', 400);
  }
  return sessionId;
}

function normalizeAttachmentName(value) {
  const name = String(value || 'attachment')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .split(/[\\/]/)
    .filter(Boolean)
    .at(-1);
  return (name || 'attachment').slice(0, 120);
}

function normalizeMimeType(value) {
  const mimeType = String(value || 'application/octet-stream').trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)
    ? mimeType
    : 'application/octet-stream';
}

function previewableMimeType(value) {
  return value.startsWith('image/')
    || value.startsWith('audio/')
    || value === 'application/pdf'
    || ['text/plain', 'text/markdown', 'text/x-markdown'].includes(value);
}

function attachmentError(code, message, status) {
  return Object.assign(new Error(message), { code, status });
}

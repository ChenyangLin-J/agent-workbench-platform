export const RESOURCE_SCHEMA = 'agent-workbench.resource/v1';

export const RESOURCE_KINDS = Object.freeze([
  'workspace-file',
  'workspace-directory',
  'session-input',
  'session-artifact',
  'visualization',
  'transient-output',
  'diagnostic-evidence',
]);

export const RESOURCE_MODES = Object.freeze(['managed', 'external']);

export const RESOURCE_LIFECYCLE_CLASSES = Object.freeze([
  'session-durable',
  'draft',
  'transient',
  'diagnostic',
  'workspace',
  'cache',
]);

export const RESOURCE_LIFECYCLE_STATES = Object.freeze([
  'staged',
  'ready',
  'promotable',
  'promoted',
  'orphaned',
  'quarantined',
  'purged',
]);

const SESSION_RESOURCE_KINDS = new Set(['session-input', 'session-artifact', 'visualization']);
const ORIGIN_TYPES = new Set(['upload', 'paste', 'tool', 'browser', 'workspace', 'generated', 'migration']);

export function normalizeResourceDescriptor(value = {}) {
  if (!plainObject(value)) throw new TypeError('resource descriptor must be an object');
  const schema = String(value.schema || RESOURCE_SCHEMA);
  if (schema !== RESOURCE_SCHEMA) throw new TypeError(`unsupported resource schema: ${schema}`);
  const id = resourceId(value.id);
  const kind = enumValue(value.kind, RESOURCE_KINDS, 'resource kind');
  const mode = enumValue(value.mode, RESOURCE_MODES, 'resource mode');
  const owner = normalizeResourceOwner(value.owner, { requireSession: SESSION_RESOURCE_KINDS.has(kind) });
  const display = normalizeResourceDisplay(value.display);
  const lifecycle = normalizeResourceLifecycle(value.lifecycle);
  const origin = normalizeResourceOrigin(value.origin);
  const integrity = normalizeResourceIntegrity(value.integrity);
  const capabilities = normalizeResourceCapabilities(value.capabilities);
  return {
    schema: RESOURCE_SCHEMA,
    id,
    kind,
    mode,
    owner,
    display,
    ...(integrity ? { integrity } : {}),
    origin,
    lifecycle,
    capabilities,
  };
}

export function resourceDescriptorAttachment(resource) {
  const descriptor = normalizeResourceDescriptor(resource);
  return {
    id: descriptor.id,
    name: descriptor.display.name,
    mimeType: descriptor.display.mimeType,
    size: descriptor.display.size,
    resource: descriptor,
  };
}

export function isResourceDescriptor(value) {
  try {
    normalizeResourceDescriptor(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeResourceOwner(value, { requireSession }) {
  if (!plainObject(value)) throw new TypeError('resource owner must be an object');
  const owner = {};
  for (const key of ['sessionId', 'turnId', 'runId', 'workspaceId']) {
    if (value[key] != null && value[key] !== '') owner[key] = boundedString(value[key], `resource owner ${key}`, 240);
  }
  if (requireSession && !owner.sessionId) throw new TypeError('Session resource owner requires sessionId');
  if (!Object.keys(owner).length) throw new TypeError('resource owner requires at least one identity');
  return owner;
}

function normalizeResourceDisplay(value) {
  if (!plainObject(value)) throw new TypeError('resource display must be an object');
  const rawName = String(value.name || 'resource').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const name = (rawName || 'resource').split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 255) || 'resource';
  const rawMimeType = String(value.mimeType || 'application/octet-stream').trim().toLowerCase();
  const mimeType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(rawMimeType)
    ? rawMimeType
    : 'application/octet-stream';
  const size = Number(value.size);
  if (!Number.isSafeInteger(size) || size < 0) throw new TypeError('resource display size must be a non-negative integer');
  return { name, mimeType, size };
}

function normalizeResourceLifecycle(value) {
  if (!plainObject(value)) throw new TypeError('resource lifecycle must be an object');
  return {
    class: enumValue(value.class, RESOURCE_LIFECYCLE_CLASSES, 'resource lifecycle class'),
    state: enumValue(value.state, RESOURCE_LIFECYCLE_STATES, 'resource lifecycle state'),
    ...(value.updatedAt == null ? {} : { updatedAt: isoTime(value.updatedAt, 'resource lifecycle updatedAt') }),
  };
}

function normalizeResourceOrigin(value) {
  if (!plainObject(value)) throw new TypeError('resource origin must be an object');
  const type = String(value.type || '').trim();
  if (!ORIGIN_TYPES.has(type)) throw new TypeError(`unsupported resource origin type: ${type}`);
  return {
    type,
    createdAt: isoTime(value.createdAt, 'resource origin createdAt'),
  };
}

function normalizeResourceIntegrity(value) {
  if (value == null) return null;
  if (!plainObject(value)) throw new TypeError('resource integrity must be an object');
  if (value.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(String(value.digest || ''))) {
    throw new TypeError('resource integrity must contain a lowercase sha256 digest');
  }
  return { algorithm: 'sha256', digest: value.digest };
}

function normalizeResourceCapabilities(value = {}) {
  if (!plainObject(value)) throw new TypeError('resource capabilities must be an object');
  return Object.fromEntries(['preview', 'download', 'openInWorkspace'].map((name) => [name, value[name] === true]));
}

function resourceId(value) {
  const id = String(value || '').trim();
  if (!/^res_[A-Za-z0-9][A-Za-z0-9_-]{7,199}$/.test(id)) throw new TypeError('resource id is invalid');
  return id;
}

function enumValue(value, allowed, label) {
  const normalized = String(value || '').trim();
  if (!allowed.includes(normalized)) throw new TypeError(`unsupported ${label}: ${normalized}`);
  return normalized;
}

function boundedString(value, label, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError(`${label} is invalid`);
  }
  return normalized;
}

function isoTime(value, label) {
  const time = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(time.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return time.toISOString();
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

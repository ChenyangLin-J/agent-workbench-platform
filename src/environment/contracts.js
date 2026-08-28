import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export const ENVIRONMENT_MANIFEST_SCHEMA = 'agent-workbench.environment/v1';
export const ENVIRONMENT_PROFILE_SCHEMA = 'agent-workbench.environment-profile/v1';
export const ISOLATION_LEVELS = Object.freeze([
  'development',
  'guarded-host',
  'ephemeral-machine',
]);

export const ENFORCEMENT_FACETS = Object.freeze([
  'filesystem',
  'process',
  'environment',
  'capabilities',
  'credentials',
  'network',
  'externalEffects',
  'crossRun',
  'ephemeralIdentity',
]);

const ISOLATION_RANK = new Map(ISOLATION_LEVELS.map((level, index) => [level, index]));
const GUARDED_FACETS = ENFORCEMENT_FACETS.filter((name) => name !== 'ephemeralIdentity');
const TOP_LEVEL_PROFILE_KEYS = new Set([
  '$schema',
  'schema',
  'id',
  'title',
  'runtime',
  'features',
  'capabilities',
  'isolation',
  'extensions',
]);
const SECRET_KEY = /(?:password|passwd|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|private[_-]?key|credential[_-]?value)$/i;
const PEM_VALUE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;

export function compareIsolationLevels(left, right) {
  return isolationRank(left) - isolationRank(right);
}

export function satisfiesIsolationLevel(effectiveLevel, requiredLevel) {
  return compareIsolationLevels(effectiveLevel, requiredLevel) >= 0;
}

export function normalizeEnforcement(enforcement = {}) {
  if (!plainObject(enforcement)) throw new TypeError('isolation enforcement must be an object');
  return deepFreeze(Object.fromEntries(ENFORCEMENT_FACETS.map((name) => {
    const candidate = enforcement[name];
    if (candidate == null) return [name, { enforced: false, mode: 'none' }];
    if (!plainObject(candidate)) throw new TypeError(`isolation enforcement.${name} must be an object`);
    return [name, {
      enforced: candidate.enforced === true,
      mode: nonEmptyString(candidate.mode || (candidate.enforced === true ? 'provider' : 'none'), `isolation enforcement.${name}.mode`),
      ...(candidate.detail == null ? {} : { detail: nonEmptyString(candidate.detail, `isolation enforcement.${name}.detail`) }),
    }];
  })));
}

export function deriveEffectiveIsolationLevel(enforcement = {}) {
  const normalized = normalizeEnforcement(enforcement);
  if (!GUARDED_FACETS.every((name) => normalized[name].enforced)) return 'development';
  return normalized.ephemeralIdentity.enforced ? 'ephemeral-machine' : 'guarded-host';
}

export function normalizeEnvironmentProfile(profile, { baseDirectory = process.cwd() } = {}) {
  if (!plainObject(profile)) throw new TypeError('environment profile must be an object');
  rejectUnknownKeys(profile, TOP_LEVEL_PROFILE_KEYS, 'environment profile');
  const schema = profile.schema || profile.$schema || ENVIRONMENT_PROFILE_SCHEMA;
  if (schema !== ENVIRONMENT_PROFILE_SCHEMA) throw new TypeError(`unsupported environment profile schema: ${schema}`);
  const id = profileId(profile.id);
  const runtime = normalizeRuntime(profile.runtime);
  const features = normalizeFeatures(profile.features);
  const capabilityLock = normalizeCapabilityLock(profile.capabilities?.lock ?? profile.capabilities);
  const isolation = normalizeIsolation(profile.isolation, { baseDirectory });
  const extensions = normalizeExtensions(profile.extensions);
  const normalized = {
    schema: ENVIRONMENT_PROFILE_SCHEMA,
    id,
    ...(profile.title == null ? {} : { title: nonEmptyString(profile.title, 'environment profile title') }),
    runtime,
    features,
    capabilities: { lock: capabilityLock },
    isolation,
    extensions,
  };
  assertNoSecretMaterial(normalized.extensions, 'environment profile extensions');
  return deepFreeze(normalized);
}

export function environmentProfileHash(profile) {
  const normalized = normalizeEnvironmentProfile(profile);
  return createHash('sha256').update(stableStringify(normalized)).digest('hex');
}

export function stableStringify(value) {
  return JSON.stringify(sortObject(value));
}

export function assertNoSecretMaterial(value, label = 'value') {
  visit(value, [], (candidate, path) => {
    const key = path.at(-1);
    if (typeof key === 'string' && SECRET_KEY.test(key)) {
      throw new TypeError(`${label} must not contain credential values (${path.join('.')})`);
    }
    if (typeof candidate === 'string' && PEM_VALUE.test(candidate)) {
      throw new TypeError(`${label} must not contain private key material`);
    }
  });
  return value;
}

function normalizeRuntime(runtime = {}) {
  if (!plainObject(runtime)) throw new TypeError('environment profile runtime must be an object');
  rejectUnknownKeys(runtime, new Set(['provider', 'model', 'reasoningEffort']), 'environment profile runtime');
  return {
    provider: nonEmptyString(runtime.provider || 'codex', 'runtime provider'),
    ...(runtime.model == null ? {} : { model: nonEmptyString(runtime.model, 'runtime model') }),
    ...(runtime.reasoningEffort == null ? {} : { reasoningEffort: nonEmptyString(runtime.reasoningEffort, 'runtime reasoningEffort') }),
  };
}

function normalizeFeatures(features = {}) {
  if (!plainObject(features)) throw new TypeError('environment profile features must be an object');
  const defaults = {
    sessionWorkspace: true,
    attachments: true,
    sideChat: false,
    subagents: false,
    browser: false,
    capabilityMutation: false,
    evidenceDashboard: false,
  };
  for (const [name, enabled] of Object.entries(features)) {
    if (!(name in defaults)) throw new TypeError(`unsupported minimal host feature: ${name}`);
    if (typeof enabled !== 'boolean') throw new TypeError(`feature ${name} must be boolean`);
    defaults[name] = enabled;
  }
  if (!defaults.sessionWorkspace) throw new TypeError('minimal host requires the sessionWorkspace feature');
  return defaults;
}

function normalizeCapabilityLock(lock = {}) {
  if (!plainObject(lock)) throw new TypeError('environment capability lock must be an object');
  const capabilities = lock.capabilities ?? [];
  if (!Array.isArray(capabilities)) throw new TypeError('environment capability lock capabilities must be an array');
  const seen = new Set();
  const normalizedCapabilities = capabilities.map((candidate) => {
    if (!plainObject(candidate)) throw new TypeError('capability lock entry must be an object');
    rejectUnknownKeys(candidate, new Set(['id', 'kind', 'scope', 'version']), 'capability lock entry');
    const id = nonEmptyString(candidate.id, 'capability lock id');
    if (seen.has(id)) throw new TypeError(`duplicate capability lock id: ${id}`);
    seen.add(id);
    return {
      id,
      kind: nonEmptyString(candidate.kind, `capability ${id} kind`),
      scope: nonEmptyString(candidate.scope, `capability ${id} scope`),
      version: nonEmptyString(candidate.version, `capability ${id} version`),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  return {
    version: positiveInteger(lock.version ?? 1, 'capability lock version'),
    profileId: nonEmptyString(lock.profileId || 'default', 'capability lock profileId'),
    catalogVersion: positiveInteger(lock.catalogVersion ?? 1, 'capability lock catalogVersion'),
    capabilities: normalizedCapabilities,
  };
}

function normalizeIsolation(isolation = {}, { baseDirectory }) {
  if (!plainObject(isolation)) throw new TypeError('environment profile isolation must be an object');
  rejectUnknownKeys(isolation, new Set([
    'provider',
    'minimumLevel',
    'filesystem',
    'environmentKeys',
    'networkTargets',
    'credentialReferences',
    'externalEffects',
  ]), 'environment profile isolation');
  const filesystem = isolation.filesystem ?? {};
  if (!plainObject(filesystem)) throw new TypeError('isolation filesystem must be an object');
  rejectUnknownKeys(filesystem, new Set(['readableRoots', 'writableRoots']), 'isolation filesystem');
  const externalEffects = isolation.externalEffects ?? {};
  if (!plainObject(externalEffects)) throw new TypeError('isolation externalEffects must be an object');
  rejectUnknownKeys(externalEffects, new Set(['read', 'write']), 'isolation externalEffects');
  return {
    provider: nonEmptyString(isolation.provider || 'development', 'isolation provider'),
    minimumLevel: isolationLevel(isolation.minimumLevel || 'development'),
    filesystem: {
      readableRoots: normalizePathList(filesystem.readableRoots, baseDirectory, 'readableRoots'),
      writableRoots: normalizePathList(filesystem.writableRoots, baseDirectory, 'writableRoots'),
    },
    environmentKeys: normalizeStringList(isolation.environmentKeys, 'isolation environmentKeys'),
    networkTargets: normalizeStringList(isolation.networkTargets, 'isolation networkTargets'),
    credentialReferences: normalizeStringList(isolation.credentialReferences, 'isolation credentialReferences'),
    externalEffects: {
      read: normalizeStringList(externalEffects.read, 'isolation externalEffects.read'),
      write: normalizeStringList(externalEffects.write, 'isolation externalEffects.write'),
    },
  };
}

function normalizeExtensions(extensions = {}) {
  if (!plainObject(extensions)) throw new TypeError('environment profile extensions must be an object');
  for (const key of Object.keys(extensions)) {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(key)) {
      throw new TypeError(`environment extension key must be namespaced: ${key}`);
    }
  }
  return structuredClone(extensions);
}

function normalizePathList(value, baseDirectory, label) {
  return [...new Set(normalizeStringList(value, `isolation filesystem.${label}`).map((item) => (
    isAbsolute(item) ? resolve(item) : resolve(baseDirectory, item)
  )))].sort();
}

function normalizeStringList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value.map((item) => item.trim()))].sort();
}

function isolationRank(value) {
  const level = isolationLevel(value);
  return ISOLATION_RANK.get(level);
}

function isolationLevel(value) {
  const level = nonEmptyString(value, 'isolation level');
  if (!ISOLATION_RANK.has(level)) throw new TypeError(`unsupported isolation level: ${level}`);
  return level;
}

function profileId(value) {
  const id = nonEmptyString(value, 'environment profile id');
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(id)) {
    throw new TypeError('environment profile id must use 2-63 lowercase letters, digits, or hyphens');
  }
  return id;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError(`${label} must be a positive integer`);
  return number;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field: ${key}`);
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
}

function visit(value, path, callback) {
  callback(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, [...path, index], callback));
  } else if (plainObject(value)) {
    Object.entries(value).forEach(([key, item]) => visit(item, [...path, key], callback));
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const ENVIRONMENT_BINDINGS_SCHEMA = 'agent-workbench.environment-bindings/v1';
export const OPENMETADATA_READ_ADAPTER_KIND = 'openmetadata-mcp-read';
export const BIGQUERY_READ_ADAPTER_KIND = 'bigquery-read';
export const BIGQUERY_API_TARGET = 'https://bigquery.googleapis.com/bigquery/v2';
export const GOOGLE_OAUTH_TARGET = 'https://oauth2.googleapis.com/token';
export const OPENMETADATA_READ_TOOLS = Object.freeze([
  'get_entity_details',
  'get_entity_lineage',
  'search_metadata',
]);

const ADAPTER_LOCK_KIND = 'read-only-adapter';
const OPENMETADATA_EFFECT = 'metadata.read';
const BIGQUERY_EFFECT = 'warehouse.read';
const DEFAULT_MAXIMUM_BYTES_BILLED = 100 * 1024 * 1024 * 1024;
const DEFAULT_MAXIMUM_ROWS = 10_000;

export function normalizeDataAdapters(value, lock) {
  if (value == null) value = [];
  if (!Array.isArray(value)) throw new TypeError('environment capability adapters must be an array');
  const lockEntries = lock?.capabilities || [];
  const adapterLock = new Map(lockEntries
    .filter((entry) => entry.kind === ADAPTER_LOCK_KIND)
    .map((entry) => [entry.id, entry]));
  const seenIds = new Set();
  const seenServers = new Set();
  const normalized = value.map((candidate) => {
    if (!plainObject(candidate)) throw new TypeError('environment capability adapter must be an object');
    const id = nonEmptyString(candidate.id, 'environment capability adapter id');
    if (!adapterLock.has(id)) throw new TypeError(`capability adapter is not present in the read-only adapter lock: ${id}`);
    if (seenIds.has(id)) throw new TypeError(`duplicate capability adapter id: ${id}`);
    seenIds.add(id);
    const kind = nonEmptyString(candidate.kind, `capability adapter ${id} kind`);
    const server = mcpServerName(candidate.server, `capability adapter ${id} server`);
    if (seenServers.has(server)) throw new TypeError(`duplicate capability adapter server: ${server}`);
    seenServers.add(server);
    if (kind === OPENMETADATA_READ_ADAPTER_KIND) return normalizeOpenMetadataAdapter(candidate, { id, kind, server });
    if (kind === BIGQUERY_READ_ADAPTER_KIND) return normalizeBigQueryAdapter(candidate, { id, kind, server });
    throw new TypeError(`unsupported read-only adapter kind: ${kind}`);
  }).sort((left, right) => left.id.localeCompare(right.id));
  for (const id of adapterLock.keys()) {
    if (!seenIds.has(id)) throw new TypeError(`read-only adapter lock entry has no adapter declaration: ${id}`);
  }
  return normalized;
}

export function dataAdapterRequest(profile = {}) {
  const adapters = profile.capabilities?.adapters || [];
  const credentialReferences = [];
  const networkTargets = [];
  const readEffects = [];
  for (const adapter of adapters) {
    credentialReferences.push(adapter.credentialReference);
    readEffects.push(adapter.effect);
    if (adapter.kind === OPENMETADATA_READ_ADAPTER_KIND) networkTargets.push(adapter.target);
    if (adapter.kind === BIGQUERY_READ_ADAPTER_KIND) networkTargets.push(BIGQUERY_API_TARGET, GOOGLE_OAUTH_TARGET);
  }
  return {
    requested: adapters.length > 0,
    supported: adapters.every((adapter) => [OPENMETADATA_READ_ADAPTER_KIND, BIGQUERY_READ_ADAPTER_KIND].includes(adapter.kind)),
    adapters: structuredClone(adapters),
    credentialReferences: uniqueSorted(credentialReferences),
    networkTargets: uniqueSorted(networkTargets),
    externalEffects: { read: uniqueSorted(readEffects), write: [] },
  };
}

export function normalizeEnvironmentBindings(document, { baseDirectory = process.cwd() } = {}) {
  if (!plainObject(document)) throw new TypeError('environment bindings must be an object');
  rejectUnknownKeys(document, new Set(['schema', '$schema', 'credentials']), 'environment bindings');
  const schema = document.schema || document.$schema || ENVIRONMENT_BINDINGS_SCHEMA;
  if (schema !== ENVIRONMENT_BINDINGS_SCHEMA) throw new TypeError(`unsupported environment bindings schema: ${schema}`);
  const credentials = document.credentials ?? {};
  if (!plainObject(credentials)) throw new TypeError('environment bindings credentials must be an object');
  const normalized = {};
  for (const [reference, binding] of Object.entries(credentials).sort(([left], [right]) => left.localeCompare(right))) {
    const id = nonEmptyString(reference, 'environment binding credential reference');
    if (!plainObject(binding)) throw new TypeError(`environment binding ${id} must be an object`);
    const source = nonEmptyString(binding.source, `environment binding ${id} source`);
    if (source === 'environment') {
      rejectUnknownKeys(binding, new Set(['source', 'key']), `environment binding ${id}`);
      const key = nonEmptyString(binding.key, `environment binding ${id} key`);
      if (!/^[A-Z][A-Z0-9_]{1,126}$/.test(key)) throw new TypeError(`environment binding ${id} key is invalid`);
      normalized[id] = { source, key };
      continue;
    }
    if (source === 'file') {
      rejectUnknownKeys(binding, new Set(['source', 'path']), `environment binding ${id}`);
      const path = nonEmptyString(binding.path, `environment binding ${id} path`);
      normalized[id] = { source, path: resolve(baseDirectory, path) };
      continue;
    }
    throw new TypeError(`environment binding ${id} has unsupported source: ${source}`);
  }
  return deepFreeze({ schema: ENVIRONMENT_BINDINGS_SCHEMA, credentials: normalized });
}

export async function readEnvironmentBindings(path) {
  const requestedPath = resolve(nonEmptyString(path, 'environment bindings path'));
  const [info, canonical] = await Promise.all([lstat(requestedPath), realpath(requestedPath)]);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw adapterError('ENVIRONMENT_BINDINGS_UNSAFE', 'Environment bindings must be a private regular file and not a symlink.');
  }
  return normalizeEnvironmentBindings(JSON.parse(await readFile(canonical, 'utf8')), { baseDirectory: dirname(canonical) });
}

export function createDataAdapterCredentialBroker({
  bindings = { schema: ENVIRONMENT_BINDINGS_SCHEMA, credentials: {} },
  environment = process.env,
} = {}) {
  const normalizedBindings = normalizeEnvironmentBindings(bindings);
  return Object.freeze({
    id: 'read-only-data-adapters',
    async inspect({ profile } = {}) {
      const request = dataAdapterRequest(profile);
      if (!request.requested) return { ready: true, requested: false, adapters: [] };
      const reasons = [];
      for (const adapter of request.adapters) {
        try {
          await resolveAdapterCredential(adapter, normalizedBindings, environment);
        } catch (error) {
          reasons.push(`${adapter.id}: ${safeAdapterError(error)}`);
        }
      }
      return {
        ready: reasons.length === 0,
        requested: true,
        adapters: request.adapters.map(safeAdapterDescriptor),
        ...(reasons.length ? { reason: `Data adapter credential broker is unavailable: ${reasons.join(' ')}` } : {}),
      };
    },
    async stage({ profile, directory } = {}) {
      const request = dataAdapterRequest(profile);
      if (!request.requested || !request.supported) {
        throw adapterError('DATA_ADAPTER_PROFILE_UNSUPPORTED', 'Supported read-only data adapters were not requested.');
      }
      const targetDirectory = resolve(nonEmptyString(directory, 'data adapter credential directory'));
      const temporaryDirectory = `${targetDirectory}.staging-${randomUUID()}`;
      await mkdir(dirname(targetDirectory), { recursive: true, mode: 0o700 });
      await mkdir(temporaryDirectory, { mode: 0o700 });
      try {
        for (const adapter of request.adapters) {
          const credential = await resolveAdapterCredential(adapter, normalizedBindings, environment);
          const adapterDirectory = join(temporaryDirectory, adapterDirectoryName(adapter.id));
          await mkdir(adapterDirectory, { mode: 0o700 });
          await writeFile(join(adapterDirectory, 'credential.json'), `${JSON.stringify(credential, null, 2)}\n`, {
            encoding: 'utf8', flag: 'wx', mode: 0o600,
          });
        }
        await rename(temporaryDirectory, targetDirectory);
      } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        throw error;
      }
      return {
        directory: targetDirectory,
        adapters: request.adapters.map((adapter) => ({
          ...safeAdapterDescriptor(adapter),
          directory: adapterDirectoryName(adapter.id),
        })),
      };
    },
  });
}

export async function readStagedDataAdapterCredential(path, adapter) {
  const requestedPath = resolve(nonEmptyString(path, 'staged data adapter credential path'));
  const [info, canonical] = await Promise.all([lstat(requestedPath), realpath(requestedPath)]);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw adapterError('DATA_ADAPTER_CREDENTIAL_UNSAFE', 'Staged data adapter credential must be a private regular file and not a symlink.');
  }
  const credential = JSON.parse(await readFile(canonical, 'utf8'));
  if (adapter.kind === OPENMETADATA_READ_ADAPTER_KIND) {
    if (credential?.schemaVersion !== 1 || credential.kind !== 'openmetadata-pat'
      || credential.credentialReference !== adapter.credentialReference
      || typeof credential.token !== 'string' || !credential.token.trim()) {
      throw adapterError('DATA_ADAPTER_CREDENTIAL_INVALID', 'Staged OpenMetadata credential is invalid.');
    }
  } else if (adapter.kind === BIGQUERY_READ_ADAPTER_KIND) {
    validateGoogleCredential(credential?.credential);
    if (credential?.schemaVersion !== 1 || credential.kind !== 'google-application-credential'
      || credential.credentialReference !== adapter.credentialReference) {
      throw adapterError('DATA_ADAPTER_CREDENTIAL_INVALID', 'Staged BigQuery credential is invalid.');
    }
  } else {
    throw adapterError('DATA_ADAPTER_KIND_UNSUPPORTED', `Unsupported staged data adapter kind: ${adapter.kind}.`);
  }
  return credential;
}

export function adapterDirectoryName(id) {
  return Buffer.from(nonEmptyString(id, 'data adapter id')).toString('hex').slice(0, 48);
}

function normalizeOpenMetadataAdapter(candidate, base) {
  rejectUnknownKeys(candidate, new Set([
    'id', 'kind', 'server', 'target', 'credentialReference', 'effect', 'allowedTools',
  ]), `capability adapter ${base.id}`);
  const target = httpsTarget(candidate.target, `capability adapter ${base.id} target`);
  const credentialReferenceValue = normalizeCredentialReference(candidate.credentialReference, base.id);
  const effect = nonEmptyString(candidate.effect, `capability adapter ${base.id} effect`);
  if (effect !== OPENMETADATA_EFFECT) throw new TypeError(`OpenMetadata adapter ${base.id} effect must be ${OPENMETADATA_EFFECT}`);
  const allowedTools = stringList(candidate.allowedTools, `capability adapter ${base.id} allowedTools`);
  if (!allowedTools.length || allowedTools.some((tool) => !OPENMETADATA_READ_TOOLS.includes(tool))) {
    throw new TypeError(`OpenMetadata adapter ${base.id} allowedTools must use only the built-in read allowlist`);
  }
  return { ...base, target, credentialReference: credentialReferenceValue, effect, allowedTools };
}

function normalizeBigQueryAdapter(candidate, base) {
  rejectUnknownKeys(candidate, new Set([
    'id', 'kind', 'server', 'credentialReference', 'effect', 'billingProject', 'allowedProjects',
    'maximumBytesBilled', 'maximumRows',
  ]), `capability adapter ${base.id}`);
  const credentialReferenceValue = normalizeCredentialReference(candidate.credentialReference, base.id);
  const effect = nonEmptyString(candidate.effect, `capability adapter ${base.id} effect`);
  if (effect !== BIGQUERY_EFFECT) throw new TypeError(`BigQuery adapter ${base.id} effect must be ${BIGQUERY_EFFECT}`);
  const billingProject = googleProject(candidate.billingProject, `capability adapter ${base.id} billingProject`);
  const allowedProjects = stringList(candidate.allowedProjects, `capability adapter ${base.id} allowedProjects`)
    .map((project) => googleProject(project, `capability adapter ${base.id} allowed project`));
  if (!allowedProjects.length) throw new TypeError(`BigQuery adapter ${base.id} requires allowedProjects`);
  return {
    ...base,
    credentialReference: credentialReferenceValue,
    effect,
    billingProject,
    allowedProjects: uniqueSorted(allowedProjects),
    maximumBytesBilled: positiveInteger(candidate.maximumBytesBilled ?? DEFAULT_MAXIMUM_BYTES_BILLED, `capability adapter ${base.id} maximumBytesBilled`),
    maximumRows: positiveInteger(candidate.maximumRows ?? DEFAULT_MAXIMUM_ROWS, `capability adapter ${base.id} maximumRows`),
  };
}

async function resolveAdapterCredential(adapter, bindings, environment) {
  const binding = bindings.credentials[adapter.credentialReference];
  if (!binding) throw adapterError('DATA_ADAPTER_BINDING_MISSING', `binding ${adapter.credentialReference} is missing.`);
  if (adapter.kind === OPENMETADATA_READ_ADAPTER_KIND) {
    if (binding.source !== 'environment') {
      throw adapterError('DATA_ADAPTER_BINDING_SOURCE_INVALID', 'OpenMetadata PAT must come from an environment binding.');
    }
    const token = environment[binding.key];
    if (typeof token !== 'string' || !token.trim()) {
      throw adapterError('DATA_ADAPTER_CREDENTIAL_MISSING', `environment key ${binding.key} is empty.`);
    }
    return {
      schemaVersion: 1,
      kind: 'openmetadata-pat',
      credentialReference: adapter.credentialReference,
      token: token.trim(),
    };
  }
  if (adapter.kind === BIGQUERY_READ_ADAPTER_KIND) {
    if (binding.source !== 'file') {
      throw adapterError('DATA_ADAPTER_BINDING_SOURCE_INVALID', 'BigQuery ADC must come from a private file binding.');
    }
    const [info, canonical] = await Promise.all([lstat(binding.path), realpath(binding.path)]);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
      throw adapterError('DATA_ADAPTER_CREDENTIAL_UNSAFE', 'Google application credential must be a private regular file and not a symlink.');
    }
    const credential = JSON.parse(await readFile(canonical, 'utf8'));
    validateGoogleCredential(credential);
    return {
      schemaVersion: 1,
      kind: 'google-application-credential',
      credentialReference: adapter.credentialReference,
      credential,
    };
  }
  throw adapterError('DATA_ADAPTER_KIND_UNSUPPORTED', `Unsupported data adapter kind: ${adapter.kind}.`);
}

function validateGoogleCredential(credential) {
  if (!plainObject(credential) || !['authorized_user', 'service_account'].includes(credential.type)) {
    throw adapterError('DATA_ADAPTER_CREDENTIAL_INVALID', 'Google application credential type is not supported.');
  }
  if (credential.type === 'authorized_user') {
    for (const key of ['client_id', 'client_secret', 'refresh_token']) nonEmptyString(credential[key], `Google credential ${key}`);
  } else {
    for (const key of ['client_email', 'private_key', 'token_uri']) nonEmptyString(credential[key], `Google credential ${key}`);
  }
}

function safeAdapterDescriptor(adapter) {
  return {
    id: adapter.id,
    kind: adapter.kind,
    server: adapter.server,
    credentialReference: adapter.credentialReference,
    effect: adapter.effect,
  };
}

function httpsTarget(value, label) {
  let url;
  try {
    url = new URL(nonEmptyString(value, label));
  } catch {
    throw new TypeError(`${label} must be a valid URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) {
    throw new TypeError(`${label} must be a credential-free https URL without query or fragment`);
  }
  return url.toString().replace(/\/$/, '');
}

function normalizeCredentialReference(value, id) {
  const reference = nonEmptyString(value, `capability adapter ${id} credentialReference`);
  if (!/^credentials\.[a-z0-9][a-z0-9.-]{0,126}$/.test(reference)) {
    throw new TypeError(`capability adapter ${id} credentialReference is invalid`);
  }
  return reference;
}

function mcpServerName(value, label) {
  const server = nonEmptyString(value, label);
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(server)) throw new TypeError(`${label} is invalid`);
  return server;
}

function googleProject(value, label) {
  const project = nonEmptyString(value, label);
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new TypeError(`${label} is invalid`);
  return project;
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new TypeError(`${label} must be an array of non-empty strings`);
  }
  return uniqueSorted(value.map((item) => item.trim()));
}

function uniqueSorted(value) {
  return [...new Set(value)].sort();
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

function safeAdapterError(error) {
  if (error?.code === 'ENOENT') return 'credential source was not found.';
  if (String(error?.code || '').startsWith('DATA_ADAPTER_')) return error.message;
  return 'credential validation failed.';
}

function adapterError(code, message) {
  return Object.assign(new Error(message), { code });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

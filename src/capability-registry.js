import { readFileSync } from 'node:fs';

import { normalizeCapabilityPluginManifest } from './plugins.js';

export const CAPABILITY_SCOPES = Object.freeze(['common', 'custom']);

const SCOPE_SET = new Set(CAPABILITY_SCOPES);
const COMMON_REGISTRY_URL = new URL('../capabilities/registry.json', import.meta.url);

export function loadCommonCapabilityCatalog() {
  const document = JSON.parse(readFileSync(COMMON_REGISTRY_URL, 'utf8'));
  return normalizeCapabilityCatalog(document, { requiredScope: 'common' });
}

export function normalizeCapabilityCatalog(document, { requiredScope = null } = {}) {
  const input = Array.isArray(document) ? { version: 1, capabilities: document } : document;
  if (!input || typeof input !== 'object' || !Array.isArray(input.capabilities)) {
    throw new TypeError('capability catalog must contain a capabilities array');
  }
  const version = Number(input.version);
  if (!Number.isInteger(version) || version < 1) throw new TypeError('capability catalog version must be a positive integer');
  const seen = new Set();
  const capabilities = input.capabilities.map((candidate) => {
    const manifest = normalizeCapabilityPluginManifest(candidate);
    const scope = String(candidate.scope || '');
    if (!SCOPE_SET.has(scope)) throw new TypeError(`unsupported capability scope: ${scope || '(empty)'}`);
    if (requiredScope && scope !== requiredScope) throw new TypeError(`capability ${manifest.id} must use ${requiredScope} scope`);
    if (seen.has(manifest.id)) throw duplicateCapability(manifest.id);
    seen.add(manifest.id);
    const dependencies = normalizeStringList(candidate.dependencies, `capability ${manifest.id} dependencies`);
    return deepFreeze({ ...manifest, scope, defaultEnabled: candidate.defaultEnabled === true, dependencies });
  });
  return deepFreeze({ version, capabilities });
}

export function mergeCapabilityCatalogs(commonCatalog, ...customCatalogs) {
  const common = normalizeCapabilityCatalog(commonCatalog, { requiredScope: 'common' });
  const capabilities = [...common.capabilities];
  const seen = new Set(capabilities.map((item) => item.id));
  let version = common.version;
  for (const source of customCatalogs) {
    const custom = normalizeCapabilityCatalog(source, { requiredScope: 'custom' });
    version = Math.max(version, custom.version);
    for (const capability of custom.capabilities) {
      if (seen.has(capability.id)) throw duplicateCapability(capability.id);
      seen.add(capability.id);
      capabilities.push(capability);
    }
  }
  for (const capability of capabilities) {
    for (const dependency of capability.dependencies) {
      if (!seen.has(dependency)) throw new TypeError(`capability ${capability.id} depends on unknown capability ${dependency}`);
    }
  }
  return deepFreeze({ version, capabilities });
}

export function resolveCapabilityInstallPlan(catalogDocument, profile = {}, lock = {}) {
  const catalog = normalizeCapabilityCatalog(catalogDocument);
  const profileEntries = profile?.plugins ?? profile;
  if (!profileEntries || typeof profileEntries !== 'object' || Array.isArray(profileEntries)) {
    throw new TypeError('capability profile must contain a plugins object');
  }
  const lockedEntries = new Map((lock.capabilities ?? []).map((entry) => [entry.id, entry]));
  const catalogIds = new Set(catalog.capabilities.map((item) => item.id));
  for (const id of Object.keys(profileEntries)) {
    if (!catalogIds.has(id)) throw Object.assign(new Error(`capability is not registered: ${id}`), { code: 'CAPABILITY_NOT_REGISTERED' });
  }
  const selected = new Set();
  const explicitlyDisabled = new Set();
  for (const capability of catalog.capabilities) {
    const setting = profileEntries[capability.id];
    const enabled = setting ? setting.enabled !== false : capability.defaultEnabled;
    if (enabled) selected.add(capability.id);
    else if (setting?.enabled === false) explicitlyDisabled.add(capability.id);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const capability of catalog.capabilities) {
      if (!selected.has(capability.id)) continue;
      for (const dependency of capability.dependencies) {
        if (explicitlyDisabled.has(dependency)) {
          throw Object.assign(new Error(`capability ${capability.id} requires disabled dependency ${dependency}`), { code: 'CAPABILITY_DEPENDENCY_DISABLED' });
        }
        if (!selected.has(dependency)) { selected.add(dependency); changed = true; }
      }
    }
  }
  const capabilities = catalog.capabilities.map((capability) => {
    const enabled = selected.has(capability.id);
    const locked = lockedEntries.get(capability.id);
    const action = !enabled ? 'disabled' : !locked ? 'install' : locked.version === capability.version ? 'ready' : 'update';
    return deepFreeze({ id: capability.id, kind: capability.kind, scope: capability.scope, version: capability.version, enabled, action });
  });
  return deepFreeze({ catalogVersion: catalog.version, capabilities });
}

export function createCapabilityLock(plan, { profileId = 'default' } = {}) {
  if (!plan || !Array.isArray(plan.capabilities)) throw new TypeError('capability plan is required');
  return deepFreeze({
    version: 1,
    profileId: String(profileId || 'default'),
    catalogVersion: plan.catalogVersion,
    capabilities: plan.capabilities.filter((item) => item.enabled).map(({ id, kind, scope, version }) => ({ id, kind, scope, version })),
  });
}

function normalizeStringList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) throw new TypeError(`${label} must be an array of non-empty strings`);
  return [...new Set(value.map((item) => item.trim()))];
}

function duplicateCapability(id) {
  return Object.assign(new Error(`capability already registered: ${id}`), { code: 'CAPABILITY_DUPLICATE_ID' });
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

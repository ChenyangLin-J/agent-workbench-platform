/** Product-neutral capability plugin contracts. */
export const CAPABILITY_PLUGIN_KINDS = Object.freeze(['skill-source', 'mcp-server', 'cli-tool', 'credential-provider']);

const PLUGIN_KINDS = new Set(CAPABILITY_PLUGIN_KINDS);
const HEALTH_STATUSES = new Set(['healthy', 'degraded']);
const RESERVED_CREDENTIAL_VALUE_KEYS = new Set(['credential', 'credentials', 'credentialvalue', 'credentialvalues', 'secret', 'secrets', 'token', 'tokens', 'password', 'passwords', 'apikey', 'apikeys', 'api_key', 'api_keys', 'access_token', 'refresh_token']);

export function normalizeCapabilityPluginManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new TypeError('plugin manifest must be an object');
  rejectCredentialValues(manifest, 'plugin manifest');
  const id = requiredString(manifest.id, 'plugin manifest id');
  const kind = requiredString(manifest.kind, 'plugin manifest kind');
  const version = requiredString(manifest.version, 'plugin manifest version');
  if (!PLUGIN_KINDS.has(kind)) throw new TypeError(`unsupported plugin kind: ${kind}`);
  return freezeCopy({ ...copyPublicFields(manifest), id, kind, version });
}

export class CapabilityPluginRegistry {
  #plugins = new Map();

  register(plugin) {
    const descriptor = normalizePluginDescriptor(plugin);
    if (this.#plugins.has(descriptor.manifest.id)) throw Object.assign(new Error(`plugin already registered: ${descriptor.manifest.id}`), { code: 'PLUGIN_DUPLICATE_ID' });
    this.#plugins.set(descriptor.manifest.id, descriptor);
    return descriptor.manifest;
  }

  unregister(id) {
    const pluginId = requiredString(id, 'plugin id');
    const descriptor = this.#plugins.get(pluginId);
    if (!descriptor) return null;
    this.#plugins.delete(pluginId);
    return descriptor.manifest;
  }

  get(id) { return this.#plugins.get(requiredString(id, 'plugin id'))?.manifest ?? null; }

  list({ kind } = {}) {
    if (kind != null && !PLUGIN_KINDS.has(kind)) throw new TypeError(`unsupported plugin kind: ${kind}`);
    return [...this.#plugins.values()].filter((item) => !kind || item.manifest.kind === kind).map((item) => item.manifest);
  }

  _descriptor(id) { return this.#plugins.get(id) ?? null; }
}

export function createCapabilityPluginRegistry() { return new CapabilityPluginRegistry(); }

export function resolveCapabilityPluginProfile(base = {}, overlay = {}) {
  const resolved = new Map();
  for (const [id, value] of Object.entries(profileEntries(base, 'base profile'))) resolved.set(id, normalizeProfileEntry(id, value));
  for (const [id, value] of Object.entries(profileEntries(overlay, 'product overlay'))) {
    const prior = resolved.get(id) ?? { id, enabled: true, config: {}, credentialRefs: [] };
    resolved.set(id, normalizeProfileEntry(id, { ...prior, ...value }));
  }
  return freezeCopy({ plugins: Object.fromEntries(resolved) });
}

export async function checkCapabilityPluginHealth(registry, profile = {}) {
  if (!registry || typeof registry._descriptor !== 'function') throw new TypeError('registry must be a CapabilityPluginRegistry');
  const { plugins } = resolveCapabilityPluginProfile(profile);
  const results = [];
  for (const manifest of registry.list()) {
    const settings = plugins[manifest.id] ?? { id: manifest.id, enabled: true, config: {}, credentialRefs: [] };
    if (!settings.enabled) { results.push(freezeCopy({ id: manifest.id, kind: manifest.kind, status: 'disabled' })); continue; }
    const descriptor = registry._descriptor(manifest.id);
    if (typeof descriptor.check !== 'function') { results.push(freezeCopy({ id: manifest.id, kind: manifest.kind, status: 'healthy' })); continue; }
    try {
      const result = normalizeHealthResult(await descriptor.check(freezeCopy({ manifest, config: settings.config, credentialRefs: settings.credentialRefs })));
      results.push(freezeCopy({ id: manifest.id, kind: manifest.kind, ...result }));
    } catch (error) {
      results.push(freezeCopy({ id: manifest.id, kind: manifest.kind, status: 'error', error: publicError(error) }));
    }
  }
  for (const id of Object.keys(plugins)) {
    if (registry._descriptor(id)) continue;
    results.push(freezeCopy({
      id,
      kind: null,
      status: 'error',
      error: { code: 'PLUGIN_NOT_REGISTERED', message: `plugin is not registered: ${id}` },
    }));
  }
  return Object.freeze(results);
}

function normalizePluginDescriptor(plugin) {
  if (!plugin || typeof plugin !== 'object') throw new TypeError('plugin must be an object');
  const manifest = normalizeCapabilityPluginManifest(plugin.manifest ?? plugin);
  if (plugin.check != null && typeof plugin.check !== 'function') throw new TypeError('plugin check must be a function');
  return Object.freeze({ manifest, check: plugin.check ?? null });
}

function profileEntries(profile, label) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new TypeError(`${label} must be an object`);
  const entries = profile.plugins ?? profile;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new TypeError(`${label} plugins must be an object`);
  return entries;
}

function normalizeProfileEntry(id, entry) {
  const pluginId = requiredString(id, 'plugin profile id');
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new TypeError(`plugin profile ${id} must be an object`);
  rejectCredentialValues(entry, `plugin profile ${id}`);
  const credentialRefs = entry.credentialRefs == null ? [] : entry.credentialRefs;
  if (!Array.isArray(credentialRefs) || credentialRefs.some((ref) => typeof ref !== 'string' || !ref.trim())) throw new TypeError(`plugin profile ${id} credentialRefs must be non-empty strings`);
  const config = entry.config == null ? {} : entry.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError(`plugin profile ${id} config must be an object`);
  rejectCredentialValues(config, `plugin profile ${id} config`);
  return freezeCopy({ id: pluginId, enabled: entry.enabled !== false, config, credentialRefs });
}

function normalizeHealthResult(result) {
  if (result == null || result === true) return { status: 'healthy' };
  if (result === false) return { status: 'degraded' };
  if (!result || typeof result !== 'object' || !HEALTH_STATUSES.has(result.status)) throw new TypeError('plugin health check must return true, false, or { status: healthy|degraded }');
  rejectCredentialValues(result, 'plugin health result');
  return copyPublicFields(result);
}

function rejectCredentialValues(value, label) {
  if (Array.isArray(value)) {
    for (const child of value) if (child && typeof child === 'object') rejectCredentialValues(child, label);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (RESERVED_CREDENTIAL_VALUE_KEYS.has(key.toLowerCase())) throw new TypeError(`${label} must use credentialRefs instead of ${key}`);
    if (child && typeof child === 'object') rejectCredentialValues(child, label);
  }
}

function requiredString(value, label) { if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function publicError(error) { return { message: error instanceof Error ? error.message : String(error) }; }
function copyPublicFields(value) { return structuredClone(value); }
function freezeCopy(value) { return deepFreeze(structuredClone(value)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }

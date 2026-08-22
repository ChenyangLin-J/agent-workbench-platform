import { createCapabilityLock, normalizeCapabilityCatalog, resolveCapabilityInstallPlan } from './capability-registry.js';

const DEFAULT_KIND_LABELS = Object.freeze({
  'skill-source': 'Skills',
  'mcp-server': 'MCP',
  'cli-tool': 'CLI',
  'credential-provider': 'Credentials',
});

export class CapabilityManager {
  constructor({ catalog, store, check, installer, kindLabels = {} } = {}) {
    this.catalog = normalizeCapabilityCatalog(catalog);
    if (!store?.load || !store?.save) throw new TypeError('Capability manager requires a store with load and save.');
    if (typeof check !== 'function') throw new TypeError('Capability manager requires a health check function.');
    if (!installer?.plan || !installer?.execute) throw new TypeError('Capability manager requires an installer.');
    this.store = store;
    this.check = check;
    this.installer = installer;
    this.kindLabels = Object.freeze({ ...DEFAULT_KIND_LABELS, ...kindLabels });
    this.mutationQueue = Promise.resolve();
  }

  async snapshot() {
    const { profile, lock = {} } = await this.#loadState();
    const plan = resolveCapabilityInstallPlan(this.catalog, profile, lock);
    const enabledIds = new Set(plan.capabilities.filter((item) => item.enabled).map((item) => item.id));
    const capabilities = await Promise.all(this.catalog.capabilities.map(async (manifest) => {
      const enabled = enabledIds.has(manifest.id);
      const health = normalizeHealth(await this.check(manifest, profile.plugins?.[manifest.id]?.config ?? {}));
      const operation = operationFor(manifest);
      const action = await this.installer.plan(manifest, { operation, context: { available: health.available, health } });
      return {
        id: manifest.id,
        title: manifest.title || manifest.id,
        kind: manifest.kind,
        kindLabel: this.kindLabels[manifest.kind] || manifest.kind,
        scope: manifest.scope,
        version: manifest.version,
        enabled,
        explicitEnabled: profile.plugins?.[manifest.id]?.enabled === true,
        explicitDisabled: profile.plugins?.[manifest.id]?.enabled === false,
        requiredBy: enabled ? selectedDependents(manifest.id, enabledIds, this.catalog.capabilities) : [],
        dependencies: manifest.dependencies,
        components: manifest.components ?? [],
        available: health.available,
        status: enabled ? health.status : 'disabled',
        detail: health.detail,
        action,
      };
    }));
    return {
      profileId: profile.id,
      catalogVersion: this.catalog.version,
      counts: {
        common: capabilities.filter((item) => item.scope === 'common').length,
        custom: capabilities.filter((item) => item.scope === 'custom').length,
        enabled: capabilities.filter((item) => item.enabled).length,
        healthy: capabilities.filter((item) => item.enabled && item.available).length,
      },
      capabilities,
    };
  }

  setEnabled(id, enabled) {
    const task = this.mutationQueue.then(() => this.#setEnabled(id, enabled));
    this.mutationQueue = task.catch(() => {});
    return task;
  }

  async planAction(id, operation = null) {
    const manifest = findManifest(this.catalog, id);
    const selectedOperation = validateOperation(manifest, operation || operationFor(manifest));
    const { profile } = await this.#loadState();
    const health = normalizeHealth(await this.check(manifest, profile.plugins?.[id]?.config ?? {}));
    return this.installer.plan(manifest, {
      operation: selectedOperation,
      context: { available: health.available, health },
    });
  }

  async executeAction(id, operation = null, confirmed = false) {
    const manifest = findManifest(this.catalog, id);
    const selectedOperation = validateOperation(manifest, operation || operationFor(manifest));
    const { profile } = await this.#loadState();
    const health = normalizeHealth(await this.check(manifest, profile.plugins?.[id]?.config ?? {}));
    const result = await this.installer.execute(manifest, {
      operation: selectedOperation,
      confirmed,
      context: { available: health.available, health },
    });
    return { result, snapshot: await this.snapshot() };
  }

  async #setEnabled(id, enabled) {
    const manifest = findManifest(this.catalog, id);
    const { profile, lock = {} } = await this.#loadState();
    const next = structuredClone(profile);
    next.plugins ??= {};
    next.plugins[id] = { ...(next.plugins[id] ?? {}), enabled: enabled === true };
    if (enabled) enableDependencies(manifest, this.catalog, next);
    const plan = resolveCapabilityInstallPlan(this.catalog, next, lock);
    const nextLock = createCapabilityLock(plan, { profileId: next.id });
    await this.store.save({ profile: next, lock: nextLock });
    return this.snapshot();
  }

  async #loadState() {
    const state = await this.store.load();
    if (!state?.profile || typeof state.profile !== 'object') throw new TypeError('Capability store must return a profile.');
    return { profile: structuredClone(state.profile), lock: structuredClone(state.lock ?? {}) };
  }
}

export function createCapabilityManager(options) { return new CapabilityManager(options); }

function normalizeHealth(value) {
  const status = value?.status === 'healthy' || value === true ? 'healthy' : value?.status || 'degraded';
  return {
    available: value?.available === true || status === 'healthy',
    status,
    detail: value?.detail == null ? null : String(value.detail),
  };
}

function operationFor(manifest) { return manifest.kind === 'credential-provider' ? 'authenticate' : 'install'; }

function validateOperation(manifest, operation) {
  const allowed = manifest.kind === 'credential-provider' ? ['authenticate'] : ['install', 'update'];
  if (!allowed.includes(operation)) throw Object.assign(new Error(`Capability ${manifest.id} does not support ${operation}.`), { code: 'CAPABILITY_OPERATION_UNSUPPORTED' });
  return operation;
}

function findManifest(catalog, id) {
  const manifest = catalog.capabilities.find((item) => item.id === id);
  if (!manifest) throw Object.assign(new Error(`Capability is not registered: ${id}`), { code: 'CAPABILITY_NOT_FOUND' });
  return manifest;
}

function enableDependencies(manifest, catalog, profile) {
  for (const dependencyId of manifest.dependencies ?? []) {
    const dependency = findManifest(catalog, dependencyId);
    profile.plugins[dependencyId] = { ...(profile.plugins[dependencyId] ?? {}), enabled: true };
    enableDependencies(dependency, catalog, profile);
  }
}

function selectedDependents(id, selectedIds, capabilities) {
  return capabilities
    .filter((candidate) => selectedIds.has(candidate.id) && candidate.dependencies?.includes(id))
    .map((item) => item.id);
}

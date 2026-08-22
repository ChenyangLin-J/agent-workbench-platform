import { normalizeCapabilityPluginManifest } from './plugins.js';

export const CAPABILITY_INSTALL_OPERATIONS = Object.freeze(['install', 'update', 'authenticate']);

const OPERATION_SET = new Set(CAPABILITY_INSTALL_OPERATIONS);
const PLAN_STATUSES = new Set(['ready', 'action-required', 'manual', 'unsupported']);
const RESULT_STATUSES = new Set(['completed', 'failed', 'manual', 'unsupported']);
const RESERVED_VALUE_KEYS = new Set([
  'credential', 'credentials', 'secret', 'secrets', 'token', 'tokens', 'password', 'passwords',
  'apikey', 'apikeys', 'api_key', 'api_keys', 'access_token', 'refresh_token',
]);

/** Product-neutral two-phase dispatcher. Consumers own every host side effect. */
export class CapabilityInstaller {
  #handlers = new Map();

  register(strategy, handler) {
    const name = requiredString(strategy, 'capability installation strategy');
    if (!handler || typeof handler !== 'object') throw new TypeError(`installer ${name} must be an object`);
    if (typeof handler.plan !== 'function') throw new TypeError(`installer ${name} must provide plan()`);
    if (handler.execute != null && typeof handler.execute !== 'function') throw new TypeError(`installer ${name} execute must be a function`);
    if (this.#handlers.has(name)) throw Object.assign(new Error(`installer already registered: ${name}`), { code: 'CAPABILITY_INSTALLER_DUPLICATE' });
    this.#handlers.set(name, Object.freeze({ plan: handler.plan, execute: handler.execute ?? null }));
    return this;
  }

  async plan(manifestInput, { operation = 'install', context = {} } = {}) {
    const manifest = normalizeCapabilityPluginManifest(manifestInput);
    const normalizedOperation = normalizeOperation(operation);
    const strategy = requiredString(manifest.installation?.strategy ?? 'manual', `capability ${manifest.id} installation strategy`);
    const handler = this.#handlers.get(strategy);
    if (!handler) return freezePublic({
      capabilityId: manifest.id,
      kind: manifest.kind,
      operation: normalizedOperation,
      strategy,
      status: 'unsupported',
      title: manifest.id,
      detail: `No consumer installer is registered for ${strategy}.`,
      confirmationRequired: false,
    }, 'capability action plan');
    const value = await handler.plan(freezePublic(manifest, 'capability manifest'), {
      operation: normalizedOperation,
      context: freezePublic(context, 'capability action context'),
    });
    return normalizePlan(value, { manifest, operation: normalizedOperation, strategy });
  }

  async execute(manifestInput, { operation = 'install', context = {}, confirmed = false } = {}) {
    const manifest = normalizeCapabilityPluginManifest(manifestInput);
    const plan = await this.plan(manifest, { operation, context });
    if (plan.status !== 'action-required') return freezePublic({
      capabilityId: plan.capabilityId,
      operation: plan.operation,
      status: plan.status === 'ready' ? 'completed' : plan.status,
      detail: plan.detail,
    }, 'capability action result');
    if (plan.confirmationRequired && confirmed !== true) {
      throw Object.assign(new Error('capability action requires explicit confirmation'), {
        code: 'CAPABILITY_ACTION_CONFIRMATION_REQUIRED',
        plan,
      });
    }
    const handler = this.#handlers.get(plan.strategy);
    if (!handler?.execute) return freezePublic({
      capabilityId: plan.capabilityId,
      operation: plan.operation,
      status: 'manual',
      detail: plan.detail,
    }, 'capability action result');
    const value = await handler.execute(freezePublic(manifest, 'capability manifest'), {
      operation: plan.operation,
      plan,
      context: freezePublic(context, 'capability action context'),
    });
    return normalizeResult(value, plan);
  }
}

export function createCapabilityInstaller() { return new CapabilityInstaller(); }

function normalizePlan(value, { manifest, operation, strategy }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`installer ${strategy} plan must be an object`);
  const status = requiredString(value.status, `installer ${strategy} plan status`);
  if (!PLAN_STATUSES.has(status)) throw new TypeError(`unsupported capability action plan status: ${status}`);
  return freezePublic({
    capabilityId: manifest.id,
    kind: manifest.kind,
    operation,
    strategy,
    status,
    title: String(value.title || manifest.id),
    detail: value.detail == null ? null : String(value.detail),
    confirmationRequired: status === 'action-required' && value.confirmationRequired !== false,
    command: value.command ?? null,
    metadata: value.metadata ?? null,
  }, 'capability action plan');
}

function normalizeResult(value, plan) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`installer ${plan.strategy} result must be an object`);
  const status = requiredString(value.status, `installer ${plan.strategy} result status`);
  if (!RESULT_STATUSES.has(status)) throw new TypeError(`unsupported capability action result status: ${status}`);
  return freezePublic({
    capabilityId: plan.capabilityId,
    operation: plan.operation,
    status,
    detail: value.detail == null ? null : String(value.detail),
    restartRequired: value.restartRequired === true,
  }, 'capability action result');
}

function normalizeOperation(value) {
  const operation = requiredString(value, 'capability install operation');
  if (!OPERATION_SET.has(operation)) throw new TypeError(`unsupported capability install operation: ${operation}`);
  return operation;
}

function freezePublic(value, label) {
  rejectReservedValues(value, label);
  return deepFreeze(structuredClone(value));
}

function rejectReservedValues(value, label) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const child of value) rejectReservedValues(child, label);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (RESERVED_VALUE_KEYS.has(key.toLowerCase())) throw new TypeError(`${label} must not contain credential values in ${key}`);
    rejectReservedValues(child, label);
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

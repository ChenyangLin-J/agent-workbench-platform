const DEFAULT_MAX_PENDING_OPERATIONS = 32;
let fallbackOperationSequence = 0;

export class SessionClientOperationController {
  constructor({
    createId = defaultOperationId,
    maximumPending = DEFAULT_MAX_PENDING_OPERATIONS,
  } = {}) {
    if (typeof createId !== 'function') throw new TypeError('createId must be a function.');
    if (!Number.isSafeInteger(maximumPending) || maximumPending < 1) {
      throw new TypeError('maximumPending must be a positive integer.');
    }
    this.createId = createId;
    this.maximumPending = maximumPending;
    this.operations = new Map();
  }

  begin({ scope, targetId = '', payload = {} } = {}) {
    const normalizedScope = operationKeyPart(scope, 'Operation scope');
    const normalizedTargetId = String(targetId || 'new');
    const normalizedPayload = canonicalOperationValue(payload);
    const fingerprint = JSON.stringify(normalizedPayload);
    if (typeof fingerprint !== 'string') throw new TypeError('Operation payload must be JSON-safe.');
    const lookupKey = JSON.stringify([normalizedScope, normalizedTargetId, fingerprint]);
    const existing = this.operations.get(lookupKey);
    if (existing) return existing;

    const idempotencyKey = `${normalizedScope}:${operationKeyPart(this.createId(), 'Operation id')}`;
    if (idempotencyKey.length > 200) throw new TypeError('The generated idempotency key is too long.');
    const operation = Object.freeze({
      scope: normalizedScope,
      targetId: normalizedTargetId,
      fingerprint,
      idempotencyKey,
      payload: normalizedPayload,
      lookupKey,
    });
    this.operations.set(lookupKey, operation);
    this.#prune();
    return operation;
  }

  complete(operation) {
    return this.#remove(operation);
  }

  discard(operation) {
    return this.#remove(operation);
  }

  clearTarget(targetId) {
    const normalizedTargetId = String(targetId || 'new');
    for (const [lookupKey, operation] of this.operations) {
      if (operation.targetId === normalizedTargetId) this.operations.delete(lookupKey);
    }
  }

  #remove(operation) {
    if (!operation?.lookupKey || this.operations.get(operation.lookupKey) !== operation) return false;
    this.operations.delete(operation.lookupKey);
    return true;
  }

  #prune() {
    while (this.operations.size > this.maximumPending) {
      this.operations.delete(this.operations.keys().next().value);
    }
  }
}

export function sessionOperationFingerprint(payload) {
  const fingerprint = JSON.stringify(canonicalOperationValue(payload));
  if (typeof fingerprint !== 'string') throw new TypeError('Operation payload must be JSON-safe.');
  return fingerprint;
}

function canonicalOperationValue(value) {
  if (Array.isArray(value)) return value.map(canonicalOperationValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalOperationValue(value[key])]));
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

function operationKeyPart(value, label) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new TypeError(`${label} must use only letters, numbers, dot, underscore, colon, or hyphen.`);
  }
  return normalized;
}

function defaultOperationId() {
  return globalThis.crypto?.randomUUID?.()
    || `${Date.now().toString(36)}-${(++fallbackOperationSequence).toString(36)}`;
}

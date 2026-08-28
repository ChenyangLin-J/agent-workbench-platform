import { deriveEffectiveIsolationLevel, normalizeEnforcement, satisfiesIsolationLevel } from './contracts.js';
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';

const REQUIRED_PROVIDER_METHODS = Object.freeze(['inspect', 'start', 'stop']);

export function defineIsolationProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new TypeError('isolation provider must be an object');
  const id = nonEmptyString(provider.id, 'isolation provider id');
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (typeof provider[method] !== 'function') throw new TypeError(`isolation provider ${id}.${method} is required`);
  }
  if (Object.isFrozen(provider) && provider.id === id) return provider;
  return Object.freeze({ ...provider, id });
}

export class IsolationProviderRegistry {
  constructor(providers = []) {
    this.providers = new Map();
    for (const provider of providers) this.register(provider);
  }

  register(candidate) {
    const provider = defineIsolationProvider(candidate);
    if (this.providers.has(provider.id)) throw new TypeError(`isolation provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
    return provider;
  }

  get(id) {
    const provider = this.providers.get(id);
    if (!provider) throw providerError('ISOLATION_PROVIDER_NOT_FOUND', `Isolation provider is not registered: ${id}`);
    return provider;
  }

  list() {
    return [...this.providers.values()];
  }
}

export async function inspectIsolationProvider(provider, context) {
  const normalizedProvider = defineIsolationProvider(provider);
  const report = await normalizedProvider.inspect(context);
  if (!report || typeof report !== 'object') {
    throw providerError('ISOLATION_INSPECTION_INVALID', `Isolation provider ${normalizedProvider.id} returned an invalid inspection.`);
  }
  const available = report.available === true;
  const enforcement = normalizeEnforcement(report.enforcement ?? {});
  const effectiveLevel = deriveEffectiveIsolationLevel(enforcement);
  return Object.freeze({
    provider: normalizedProvider.id,
    available,
    effectiveLevel,
    enforcement,
    ...(report.reason == null ? {} : { reason: String(report.reason) }),
  });
}

export function assertIsolationSatisfied(inspection, requiredLevel) {
  if (!inspection?.available) {
    throw providerError(
      'ISOLATION_PROVIDER_UNAVAILABLE',
      inspection?.reason || `Isolation provider ${inspection?.provider || '(unknown)'} is unavailable.`,
      { inspection, requiredLevel },
    );
  }
  if (!satisfiesIsolationLevel(inspection.effectiveLevel, requiredLevel)) {
    throw providerError(
      'ISOLATION_REQUIREMENT_UNSATISFIED',
      `Required isolation ${requiredLevel}, but ${inspection.provider} provides ${inspection.effectiveLevel}.`,
      { inspection, requiredLevel },
    );
  }
  return inspection;
}

export function createDevelopmentIsolationProvider({ spawnProcess = spawn } = {}) {
  return defineIsolationProvider({
    id: 'development',
    async inspect() {
      return {
        available: true,
        enforcement: {
          filesystem: { enforced: false, mode: 'path-convention' },
          process: { enforced: false, mode: 'host-process' },
          environment: { enforced: true, mode: 'constructed-allowlist' },
          capabilities: { enforced: false, mode: 'runtime-configuration' },
          credentials: { enforced: false, mode: 'host-reference' },
          network: { enforced: false, mode: 'host-network' },
          externalEffects: { enforced: false, mode: 'profile-declaration' },
          crossRun: { enforced: false, mode: 'path-convention' },
          ephemeralIdentity: { enforced: false, mode: 'host-identity' },
        },
      };
    },
    async start({ launch } = {}) {
      validateLaunch(launch);
      const stdout = openSync(launch.stdoutPath, 'a', 0o600);
      const stderr = openSync(launch.stderrPath, 'a', 0o600);
      let child;
      try {
        child = spawnProcess(launch.command, launch.args, {
          cwd: launch.cwd,
          env: { ...launch.environment },
          detached: true,
          shell: false,
          stdio: ['ignore', stdout, stderr],
        });
      } finally {
        // spawn duplicates these descriptors into the child process.
        const { closeSync } = await import('node:fs');
        closeSync(stdout);
        closeSync(stderr);
      }
      if (!Number.isSafeInteger(child.pid) || child.pid <= 1) {
        throw providerError('ISOLATION_LAUNCH_FAILED', 'Development Host did not return a valid process id.');
      }
      child.unref?.();
      return { pid: child.pid, processGroupId: child.pid, expectedArguments: launch.args };
    },
    async stop({ pid, processGroupId = pid, verifyOwnership } = {}) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(processGroupId) || processGroupId <= 1) {
        throw providerError('ISOLATION_PROCESS_INVALID', 'Refusing to stop an invalid Host process.');
      }
      if (typeof verifyOwnership !== 'function' || !await verifyOwnership({ pid, processGroupId })) {
        throw providerError('ISOLATION_PROCESS_UNOWNED', `Refusing to stop unverified Host process ${pid}.`);
      }
      try {
        process.kill(-processGroupId, 'SIGTERM');
      } catch (error) {
        if (error?.code === 'ESRCH') return { stopped: false, reason: 'not-running' };
        throw error;
      }
      return { stopped: true };
    },
  });
}

export function providerError(code, message, details = undefined) {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function validateLaunch(launch) {
  if (!launch || typeof launch !== 'object') throw new TypeError('isolation launch descriptor is required');
  for (const name of ['command', 'cwd', 'stdoutPath', 'stderrPath']) nonEmptyString(launch[name], `isolation launch ${name}`);
  if (!Array.isArray(launch.args) || launch.args.some((value) => typeof value !== 'string')) {
    throw new TypeError('isolation launch args must be an array of strings');
  }
  if (!launch.environment || typeof launch.environment !== 'object' || Array.isArray(launch.environment)) {
    throw new TypeError('isolation launch environment must be an object');
  }
  if (Object.values(launch.environment).some((value) => typeof value !== 'string')) {
    throw new TypeError('isolation launch environment values must be strings');
  }
}

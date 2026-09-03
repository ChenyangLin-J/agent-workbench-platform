import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { buildMinimalHostAssets } from './assets.js';
import { createMinimalCodexRuntime } from './codex-runtime.js';
import { environmentProfileHash, normalizeEnvironmentProfile, satisfiesIsolationLevel } from './contracts.js';
import { createMinimalHost } from './minimal-host.js';
import {
  removeHostIdentity,
  removeTransientCredentials,
  writeHostIdentity,
} from './process.js';
import { createDevelopmentIsolationProvider, inspectIsolationProvider } from './providers.js';
import { createEnvironmentSessionResourceStore } from './session-attachments.js';
import { EnvironmentSessionRuntimeStore, EnvironmentSessionStore } from './session-store.js';
import { prepareMinimalRuntimeConfiguration } from './runtime-config.js';
import {
  markRunStopped,
  readEnvironmentManifest,
  readStoredEnvironmentProfile,
} from './store.js';

export async function runInternalMinimalHost(runTarget, {
  port = 0,
  bindHost = '127.0.0.1',
  profilePath = null,
  parentManagesLifecycle = false,
  readyFile = null,
  socketPath = null,
} = {}) {
  const manifest = await readEnvironmentManifest(runTarget);
  if (manifest.kind !== 'run') throw new TypeError('Internal Host requires a Run target');
  const profile = profilePath
    ? normalizeEnvironmentProfile(JSON.parse(await readFile(profilePath, 'utf8')), { baseDirectory: manifest.paths.root })
    : await readStoredEnvironmentProfile(manifest.paths.root);
  if (manifest.profile.hash !== environmentProfileHash(profile)) {
    throw hostProcessError('ENVIRONMENT_PROFILE_CHANGED', 'Internal Host Profile does not match its manifest.');
  }
  const inspection = parentManagesLifecycle
    ? {
        provider: manifest.isolation.provider,
        available: manifest.isolation.available,
        effectiveLevel: manifest.isolation.effectiveLevel,
        enforcement: manifest.isolation.enforcement,
      }
    : await inspectIsolationProvider(createDevelopmentIsolationProvider(), {
        phase: 'internal-host',
        manifest,
        profile,
        paths: manifest.paths,
      });
  if (inspection.provider !== manifest.isolation.provider || !inspection.available
    || !satisfiesIsolationLevel(inspection.effectiveLevel, profile.isolation.minimumLevel)) {
    throw hostProcessError('ISOLATION_REQUIREMENT_UNSATISFIED', 'Internal Host isolation no longer satisfies the stored Profile.');
  }
  for (const path of [
    manifest.paths.runtime,
    manifest.paths.state,
    manifest.paths.resources || join(manifest.paths.root, 'resources'),
    manifest.paths.sessionState,
    manifest.paths.sessionResources,
    manifest.paths.workspace,
    manifest.paths.temporary,
    join(manifest.paths.runtime, 'home'),
    join(manifest.paths.runtime, 'codex-home'),
  ].filter(Boolean)) await mkdir(path, { recursive: true, mode: 0o700 });
  const assetsRoot = join(manifest.paths.state, 'minimal-host-assets');
  await buildMinimalHostAssets({ outputDirectory: assetsRoot });
  const externalSessionPersistence = Boolean(manifest.paths.sessionState && manifest.paths.sessionResources);
  const sessionStore = new EnvironmentSessionStore({
    stateRoot: manifest.paths.sessionState || manifest.paths.state,
    runId: manifest.id,
    crossProcess: externalSessionPersistence,
  });
  const runtimeStateStore = externalSessionPersistence
    ? new EnvironmentSessionRuntimeStore({ stateRoot: manifest.paths.state })
    : sessionStore;
  const resourceStore = externalSessionPersistence
    ? createEnvironmentSessionResourceStore({ root: manifest.paths.sessionResources })
    : null;
  const runtimeConfiguration = await prepareMinimalRuntimeConfiguration({ manifest });
  const runtime = createMinimalCodexRuntime({
    manifest,
    bindingStore: runtimeStateStore,
    runtimeEnvironmentOverrides: runtimeConfiguration.environment,
  });
  let stopping = false;
  let host;

  async function shutdown({ failure = null } = {}) {
    if (stopping) return;
    stopping = true;
    await host?.stop().catch(() => {});
    await runtime.stop().catch(() => {});
    if (!parentManagesLifecycle) {
      await removeTransientCredentials(manifest).catch(() => {});
      await removeHostIdentity(manifest).catch(() => {});
      await markRunStopped(manifest.paths.root, { failure }).catch(() => {});
    }
  }

  host = createMinimalHost({
    manifest,
    kernel: runtime.kernel,
    sessionStore,
    runtimeStateStore,
    assetsRoot,
    host: bindHost,
    port,
    socketPath,
    accessToken: await hostAccessToken(),
    sessionOwnerHeader: manifest.extensions?.['ai.ddit.agent-workbench.minimal-host']?.sessionOwnerHeader || null,
    sessionAccessHeader: manifest.extensions?.['ai.ddit.agent-workbench.minimal-host']?.sessionAccessHeader || null,
    sessionObserverHeader: manifest.extensions?.['ai.ddit.agent-workbench.minimal-host']?.sessionObserverHeader || null,
    resourceStore,
    onStopRequested: async () => {
      await shutdown();
      process.exit(0);
    },
  });
  const listening = await host.start();
  if (parentManagesLifecycle) {
    if (!readyFile) throw hostProcessError('ENVIRONMENT_READY_FILE_REQUIRED', 'Parent-managed Host requires a ready file.');
    await writeFile(readyFile, `${JSON.stringify({
      schemaVersion: 1,
      runId: manifest.id,
      pid: process.pid,
      port: listening.port,
      socketPath: listening.socketPath || null,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } else {
    await writeHostIdentity(manifest, { port: listening.port, inspection });
  }
  const stopOnSignal = (signal) => {
    void shutdown().finally(() => process.exit(signal === 'SIGTERM' ? 0 : 130));
  };
  process.once('SIGTERM', () => stopOnSignal('SIGTERM'));
  process.once('SIGINT', () => stopOnSignal('SIGINT'));
  process.once('uncaughtException', (error) => {
    void shutdown({ failure: error }).finally(() => process.exit(1));
  });
  process.once('unhandledRejection', (error) => {
    const failure = error instanceof Error ? error : new Error(String(error));
    void shutdown({ failure }).finally(() => process.exit(1));
  });
  return listening;
}

async function hostAccessToken() {
  if (process.env.AGENT_WORKBENCH_HOST_TOKEN_FILE) {
    return (await readFile(process.env.AGENT_WORKBENCH_HOST_TOKEN_FILE, 'utf8')).trim();
  }
  return process.env.AGENT_WORKBENCH_HOST_TOKEN || null;
}

function hostProcessError(code, message) {
  return Object.assign(new Error(message), { code });
}

import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { appServerLaunchArgs } from '../runtime.js';
import {
  AgentSessionKernel,
  CodexAppServerProvider,
  WebSocketAppServerConnection,
  bundledCodexLaunch,
} from '../runtime/core/index.js';

const SUPPORTED_REQUEST_TYPES = new Set([
  'command_approval',
  'file_approval',
  'permission_approval',
  'user_input',
  'elicitation',
]);

export function createMinimalCodexRuntime({
  manifest,
  bindingStore,
  spawnProcess = spawn,
  runtimeEnvironmentOverrides = {},
} = {}) {
  if (!manifest?.paths?.runtime || !manifest?.paths?.workspace) throw new TypeError('Run manifest is required');
  if (!bindingStore?.load || !bindingStore?.save) throw new TypeError('bindingStore is required');
  let appServer = null;
  let appServerStart = null;
  let connection = null;

  async function ensureAppServer() {
    if (appServer && appServer.exitCode == null) return;
    if (appServerStart) return appServerStart;
    appServerStart = startAppServer().finally(() => { appServerStart = null; });
    return appServerStart;
  }

  async function startAppServer() {
    const port = await availablePort();
    const serverUrl = `ws://127.0.0.1:${port}`;
    const launch = bundledCodexLaunch({ args: appServerLaunchArgs({ listenUrl: serverUrl }) });
    const stdoutHandle = await open(join(manifest.paths.runtime, 'app-server.stdout.log'), 'a', 0o600);
    const stderrHandle = await open(join(manifest.paths.runtime, 'app-server.stderr.log'), 'a', 0o600);
    try {
      appServer = spawnProcess(launch.command, launch.args, {
        cwd: manifest.paths.workspace,
        env: runtimeEnvironment(manifest, process.env, runtimeEnvironmentOverrides),
        detached: false,
        shell: false,
        stdio: ['ignore', stdoutHandle.fd, stderrHandle.fd],
      });
    } finally {
      await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
    }
    await waitForWebSocket(serverUrl, appServer);
    connection.url = serverUrl;
  }

  connection = new WebSocketAppServerConnection({
    url: 'ws://127.0.0.1:1',
    ensureServer: ensureAppServer,
    initializeParams: {
      clientInfo: {
        name: 'agent_workbench_minimal_host',
        title: 'Agent Workbench Minimal Host',
        version: String(manifest.versions?.platform || '0'),
      },
      capabilities: { experimentalApi: true },
    },
  });
  // The connection URL is chosen lazily immediately before its first socket is created.
  const originalConnectStart = connection.start.bind(connection);
  connection.start = async () => {
    await ensureAppServer();
    return originalConnectStart();
  };
  const provider = new CodexAppServerProvider({ connection });
  const kernel = new AgentSessionKernel({
    provider,
    bindingStore,
    validateRequest: ({ request }) => {
      if (!SUPPORTED_REQUEST_TYPES.has(request.type)) {
        throw runtimeError('MINIMAL_HOST_REQUEST_UNSUPPORTED', `Minimal Host does not support ${request.type}.`);
      }
    },
  });

  return {
    connection,
    provider,
    kernel,
    async stop() {
      kernel.close();
      connection.close();
      const child = appServer;
      appServer = null;
      if (!child || child.exitCode != null) return;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        delay(3_000).then(() => {
          if (child.exitCode == null) child.kill('SIGKILL');
        }),
      ]);
    },
  };
}

export function runtimeEnvironment(manifest, source = process.env, overrides = {}) {
  const environment = {};
  for (const key of unique([
    'LANG',
    'LC_ALL',
    'PATH',
    ...(manifest.isolation?.environmentKeys || []),
  ])) {
    if (typeof source[key] === 'string') environment[key] = source[key];
  }
  environment.HOME = join(manifest.paths.runtime, 'home');
  environment.CODEX_HOME = join(manifest.paths.runtime, 'codex-home');
  environment.TMPDIR = manifest.paths.temporary;
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^AGENT_WORKBENCH_[A-Z0-9_]+$/.test(key) || typeof value !== 'string') {
      throw new TypeError('Runtime environment overrides must use internal Agent Workbench string keys.');
    }
    environment[key] = value;
  }
  return environment;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw runtimeError('APP_SERVER_PORT_UNAVAILABLE', 'Could not allocate an App Server port.');
  return port;
}

async function waitForWebSocket(url, child) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode != null) throw runtimeError('APP_SERVER_EXITED', `Codex App Server exited with ${child.exitCode}.`);
    if (await webSocketReachable(url)) return;
    await delay(100);
  }
  child.kill('SIGTERM');
  throw runtimeError('APP_SERVER_START_TIMEOUT', `Codex App Server did not listen at ${url}.`);
}

function webSocketReachable(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => finish(false), 300);
    timeout.unref?.();
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket.close(); } catch {}
      resolve(reachable);
    };
    socket.addEventListener('open', () => finish(true), { once: true });
    socket.addEventListener('error', () => finish(false), { once: true });
    socket.addEventListener('close', () => finish(false), { once: true });
  });
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function runtimeError(code, message) {
  return Object.assign(new Error(message), { code });
}

import { createServer } from 'node:http';
import { chmod, readFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { resolveContainedPath } from './paths.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

export function createMinimalHost({
  manifest,
  kernel,
  sessionStore,
  assetsRoot = null,
  host = '127.0.0.1',
  port = 0,
  socketPath = null,
  accessToken = null,
  onStopRequested = null,
} = {}) {
  assertRunManifest(manifest);
  if (!kernel?.attach || !kernel?.submit || !kernel?.subscribe) throw new TypeError('Session Kernel is required');
  if (!sessionStore?.list || !sessionStore?.create || !sessionStore?.get) throw new TypeError('Session store is required');
  const clients = new Set();
  const server = createServer((request, response) => {
    void route(request, response).catch((error) => sendError(response, error));
  });
  let unsubscribeEvents = null;

  async function route(request, response) {
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (accessToken && request.headers['x-agent-workbench-token'] !== accessToken && url.pathname.startsWith('/api/')) {
      throw hostError('HOST_UNAUTHORIZED', 'Missing or invalid Host access token.', 401);
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, {
        status: 'ok',
        runId: manifest.id,
        runtime: kernel.capabilities(),
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/environment') {
      return sendJson(response, 200, hostEnvironmentView(manifest));
    }
    if (request.method === 'POST' && url.pathname === '/api/runtime/stop') {
      if (typeof onStopRequested !== 'function') throw hostError('HOST_STOP_UNAVAILABLE', 'Host stop is not configured.', 501);
      sendJson(response, 202, { stopping: true });
      queueMicrotask(() => void onStopRequested());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      return sendJson(response, 200, { sessions: await sessionStore.list() });
    }
    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readJsonBody(request);
      const session = await sessionStore.create({ title: body.title || 'New Session' });
      await kernel.attach(session.sessionId, runtimeAttachOptions(manifest));
      return sendJson(response, 201, { session: await sessionStore.get(session.sessionId) });
    }
    const sessionRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(turns|interrupt|events|requests\/([^/]+)))?$/);
    if (sessionRoute) {
      const sessionId = decodeURIComponent(sessionRoute[1]);
      const action = sessionRoute[2] || '';
      if (request.method === 'GET' && !action) {
        await kernel.attach(sessionId, runtimeAttachOptions(manifest));
        const session = await sessionStore.get(sessionId);
        session.pendingRequests = kernel.getPendingRequests(sessionId).map(pendingRequestView);
        return sendJson(response, 200, { session });
      }
      if (request.method === 'POST' && action === 'turns') {
        const body = await readJsonBody(request);
        const input = normalizeTurnInput(body);
        await sessionStore.recordUserInput(sessionId, input);
        const result = await kernel.submit(sessionId, input, {
          mode: body.mode || 'auto',
          ...runtimeAttachOptions(manifest),
        });
        return sendJson(response, 202, { result });
      }
      if (request.method === 'POST' && action === 'interrupt') {
        const body = await readJsonBody(request);
        return sendJson(response, 202, {
          result: await kernel.interrupt(sessionId, body.expectedTurnId),
        });
      }
      if (request.method === 'POST' && action.startsWith('requests/')) {
        const body = await readJsonBody(request);
        return sendJson(response, 200, {
          result: await kernel.respondToRequest(sessionId, decodeURIComponent(sessionRoute[3]), body.response),
        });
      }
      if (request.method === 'GET' && action === 'events') {
        return openEventStream(response, sessionId, Number(url.searchParams.get('after') || 0));
      }
    }
    if (request.method === 'GET' && url.pathname === '/bootstrap.js' && assetsRoot) {
      return sendJavascript(response, `globalThis.__AGENT_WORKBENCH_BOOTSTRAP__=${JSON.stringify({ accessToken })};\n`);
    }
    if (request.method === 'GET' && assetsRoot) return serveAsset(response, assetsRoot, url.pathname);
    if (request.method === 'GET' && url.pathname === '/') {
      return sendHtml(response, fallbackPage(manifest, accessToken));
    }
    throw hostError('HOST_ROUTE_NOT_FOUND', 'Route not found.', 404);
  }

  function openEventStream(response, sessionId, afterEventId) {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    const send = (event) => response.write(`id: ${event.eventId}\ndata: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = kernel.subscribe(sessionId, send, { afterEventId });
    const client = { response, unsubscribe };
    clients.add(client);
    response.write(': connected\n\n');
    response.on('close', () => {
      clients.delete(client);
      unsubscribe();
    });
  }

  return {
    server,
    async start() {
      if (!unsubscribeEvents) unsubscribeEvents = subscribeStore(kernel, sessionStore);
      if (socketPath) await rm(socketPath, { force: true });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath || { port, host }, () => {
          server.off('error', reject);
          resolve();
        });
      });
      if (socketPath) await chmodSocketPrivate(socketPath);
      const address = server.address();
      return {
        ...(socketPath ? { socketPath, host: null, port: null, url: null } : {
          host,
          port: typeof address === 'object' && address ? address.port : port,
          url: `http://${host}:${typeof address === 'object' && address ? address.port : port}`,
        }),
      };
    },
    async stop() {
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      for (const client of clients) {
        client.unsubscribe();
        client.response.end();
      }
      clients.clear();
      kernel.close?.();
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (socketPath) await rm(socketPath, { force: true });
    },
  };
}

async function chmodSocketPrivate(socketPath) {
  try {
    await chmod(socketPath, 0o600);
  } catch (error) {
    // Docker Desktop/Colima bind mounts can reject chmod on Unix sockets even when
    // the containing Run state directory is already private (0700).
    if (!['EINVAL', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  }
}

function subscribeStore(kernel, sessionStore) {
  const listener = (event) => void sessionStore.applyEvent(event).catch(() => {});
  kernel.on?.('event', listener);
  return () => kernel.off?.('event', listener);
}

function runtimeAttachOptions(manifest) {
  return {
    cwd: manifest.paths.workspace,
    settings: {
      ...(manifest.runtime?.model ? { model: manifest.runtime.model } : {}),
      ...(manifest.runtime?.reasoningEffort ? { reasoningEffort: manifest.runtime.reasoningEffort } : {}),
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
    },
  };
}

function normalizeTurnInput(body) {
  if (Array.isArray(body.input)) return body.input;
  const prompt = String(body.prompt || body.input || '').trim();
  if (!prompt) throw hostError('HOST_INPUT_REQUIRED', 'Turn input is required.', 400);
  return prompt;
}

function pendingRequestView(request) {
  return {
    token: request.requestToken,
    title: 'Approval required',
    detail: String(request.payload?.command || request.payload?.reason || request.type),
    kind: request.type,
    questions: request.payload?.questions || [],
  };
}

function hostEnvironmentView(manifest) {
  return {
    id: manifest.id,
    environmentId: manifest.environmentId,
    status: manifest.status,
    versions: manifest.versions,
    profile: manifest.profile,
    features: manifest.features,
    capabilities: manifest.capabilities,
    isolation: manifest.isolation,
    lifecycle: manifest.lifecycle,
  };
}

async function readJsonBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw hostError('HOST_BODY_TOO_LARGE', 'Request body is too large.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw hostError('HOST_BODY_INVALID', 'Request body must be valid JSON.', 400);
  }
}

async function serveAsset(response, assetsRoot, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  const path = await resolveContainedPath(assetsRoot, relativePath);
  const body = await readFile(path);
  response.writeHead(200, {
    'content-type': contentType(path),
    'cache-control': path.endsWith('.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'",
  });
  response.end(body);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function sendHtml(response, value) {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  response.end(value);
}

function sendJavascript(response, value) {
  response.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(value);
}

function sendError(response, error) {
  if (response.headersSent) return void response.end();
  sendJson(response, Number(error?.status) || 500, {
    error: {
      code: String(error?.code || 'HOST_INTERNAL_ERROR'),
      message: Number(error?.status) && error.status < 500 ? error.message : 'Minimal Host request failed.',
    },
  });
}

function contentType(path) {
  return ({
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  })[extname(path)] || 'application/octet-stream';
}

function fallbackPage(manifest) {
  const name = escapeHtml(manifest.profile?.id || manifest.environmentId || manifest.id);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Agent Workbench</title><style>body{font:16px system-ui;margin:3rem;max-width:52rem}code{background:#eee;padding:.2rem .4rem}</style></head><body><h1>Agent Workbench Minimal Host</h1><p>Run <code>${escapeHtml(manifest.id)}</code> is active for <strong>${name}</strong>.</p><p>The shared Session UI asset was not configured for this launcher.</p></body></html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function assertRunManifest(manifest) {
  if (!manifest || manifest.kind !== 'run' || !manifest.paths?.workspace) throw new TypeError('Run manifest is required');
}

function hostError(code, message, status = 500) {
  return Object.assign(new Error(message), { code, status });
}

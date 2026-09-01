import { createServer } from 'node:http';
import { chmod, readFile, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';

import { MAX_SESSION_ATTACHMENT_BYTES } from '../attachments.js';
import { resolveContainedPath } from './paths.js';
import {
  commitEnvironmentSessionAttachments,
  createEnvironmentSessionResourceStore,
  readEnvironmentSessionAttachment,
  registerEnvironmentSessionDirectories,
  resolveEnvironmentSessionAttachmentInputs,
  saveEnvironmentSessionAttachment,
} from './session-attachments.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ATTACHMENT_BODY_BYTES = Math.ceil(MAX_SESSION_ATTACHMENT_BYTES * 4 / 3) + 64 * 1024;

export function createMinimalHost({
  manifest,
  kernel,
  sessionStore,
  assetsRoot = null,
  host = '127.0.0.1',
  port = 0,
  socketPath = null,
  accessToken = null,
  sessionOwnerHeader = null,
  resourceStore = null,
  onStopRequested = null,
} = {}) {
  assertRunManifest(manifest);
  if (!kernel?.attach || !kernel?.submit || !kernel?.subscribe) throw new TypeError('Session Kernel is required');
  if (!sessionStore?.list || !sessionStore?.create || !sessionStore?.get) throw new TypeError('Session store is required');
  const ownerHeader = normalizeSessionOwnerHeader(sessionOwnerHeader);
  const attachmentsEnabled = manifest.features?.attachments === true;
  const resourcesRoot = manifest.paths.resources || join(manifest.paths.state || manifest.paths.workspace, 'resources');
  const sessionResourceStore = attachmentsEnabled
    ? resourceStore || createEnvironmentSessionResourceStore({ root: resourcesRoot })
    : null;
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
    const ownerId = url.pathname.startsWith('/api/sessions')
      ? requestSessionOwner(request, ownerHeader)
      : null;
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
      return sendJson(response, 200, { sessions: await sessionStore.list({ ownerId }) });
    }
    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readJsonBody(request);
      const session = await sessionStore.create({ title: body.title || '新对话', ownerId });
      await kernel.attach(session.sessionId, runtimeAttachOptions(manifest));
      return sendJson(response, 201, { session: await sessionStore.get(session.sessionId, { ownerId }) });
    }
    const directoryRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/directory-references$/);
    if (directoryRoute) {
      const sessionId = decodeURIComponent(directoryRoute[1]);
      await sessionStore.get(sessionId, { ownerId });
      requireAttachmentsEnabled(attachmentsEnabled);
      if (request.method === 'POST') {
        const body = await readJsonBody(request);
        const resources = await registerEnvironmentSessionDirectories({
          directories: body.directories,
          sessionId,
          runId: manifest.id,
          authorizedRoots: authorizedResourceRoots(manifest),
          store: sessionResourceStore,
        });
        return sendJson(response, 201, { resources });
      }
    }
    const attachmentRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/attachments(?:\/([^/]+)\/content)?$/);
    if (attachmentRoute) {
      const sessionId = decodeURIComponent(attachmentRoute[1]);
      const attachmentId = attachmentRoute[2] ? decodeURIComponent(attachmentRoute[2]) : null;
      await sessionStore.get(sessionId, { ownerId });
      requireAttachmentsEnabled(attachmentsEnabled);
      if (request.method === 'POST' && !attachmentId) {
        const body = await readJsonBody(request, { maxBytes: MAX_ATTACHMENT_BODY_BYTES });
        const attachment = await saveEnvironmentSessionAttachment({
          attachment: body.attachment,
          sessionId,
          store: sessionResourceStore,
        });
        return sendJson(response, 201, { attachment });
      }
      if (request.method === 'GET' && attachmentId) {
        const attachment = await readEnvironmentSessionAttachment({
          id: attachmentId,
          sessionId,
          store: sessionResourceStore,
        });
        const body = await readFile(attachment.storedPath);
        if (!body.length || body.length > MAX_SESSION_ATTACHMENT_BYTES) {
          throw hostError('HOST_ATTACHMENT_INVALID', 'Attachment content is unavailable.', 413);
        }
        return sendAttachment(response, attachment, body);
      }
    }
    const sessionRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(turns|interrupt|events|requests\/([^/]+)))?$/);
    if (sessionRoute) {
      const sessionId = decodeURIComponent(sessionRoute[1]);
      const action = sessionRoute[2] || '';
      await sessionStore.get(sessionId, { ownerId });
      if (request.method === 'GET' && !action) {
        await kernel.attach(sessionId, runtimeAttachOptions(manifest));
        const session = await sessionStore.get(sessionId, { ownerId });
        session.pendingRequests = kernel.getPendingRequests(sessionId).map(pendingRequestView);
        return sendJson(response, 200, { session });
      }
      if (request.method === 'POST' && action === 'turns') {
        const body = await readJsonBody(request);
        const turn = normalizeTurnRequest(body);
        if (turn.attachments.length) requireAttachmentsEnabled(attachmentsEnabled);
        const attachmentInputs = attachmentsEnabled
          ? await resolveEnvironmentSessionAttachmentInputs({
              attachments: turn.attachments,
              sessionId,
              authorizedRoots: authorizedResourceRoots(manifest),
              store: sessionResourceStore,
            })
          : [];
        const input = runtimeTurnInput(turn, attachmentInputs);
        const result = await kernel.submit(sessionId, input, {
          mode: body.mode || 'auto',
          ...runtimeAttachOptions(manifest),
        });
        const committedAttachments = turn.attachments.length
          ? await commitEnvironmentSessionAttachments({
              attachments: turn.attachments,
              sessionId,
              turnId: result.runtimeTurnId,
              store: sessionResourceStore,
            })
          : [];
        await sessionStore.recordUserInput(sessionId, turn.displayText, {
          attachments: committedAttachments,
          ownerId,
          turnId: result.runtimeTurnId,
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
      return sendJavascript(response, `globalThis.__AGENT_WORKBENCH_BOOTSTRAP__=${JSON.stringify({
        accessToken,
        features: manifest.features,
      })};\n`);
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

function normalizeSessionOwnerHeader(value) {
  if (value == null || value === '') return null;
  const header = String(value).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,126}$/.test(header)) {
    throw new TypeError('Session owner header must be a valid HTTP header name');
  }
  return header;
}

function requestSessionOwner(request, ownerHeader) {
  if (!ownerHeader) return null;
  const value = request.headers[ownerHeader];
  const ownerId = Array.isArray(value) ? value[0] : value;
  if (typeof ownerId !== 'string' || !ownerId.trim()) {
    throw hostError('HOST_SESSION_OWNER_REQUIRED', 'Verified Session owner is required.', 401);
  }
  return ownerId.trim().slice(0, 200);
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
  const selfContained = selfContainedEphemeralRun(manifest);
  return {
    cwd: manifest.paths.workspace,
    settings: {
      ...(manifest.runtime?.model ? { model: manifest.runtime.model } : {}),
      ...(manifest.runtime?.reasoningEffort ? { reasoningEffort: manifest.runtime.reasoningEffort } : {}),
      sandbox: selfContained ? 'danger-full-access' : 'workspace-write',
      approvalPolicy: selfContained ? 'never' : 'on-request',
    },
  };
}

function authorizedResourceRoots(manifest) {
  return [...new Set([
    manifest.paths.workspace,
    ...(manifest.isolation?.filesystem?.readableRoots || []),
  ].filter((value) => typeof value === 'string' && value.trim()))];
}

function selfContainedEphemeralRun(manifest) {
  return manifest.isolation?.effectiveLevel === 'ephemeral-machine'
    && ['no-external-effects', 'read-only-data-adapter-allowlist']
      .includes(manifest.isolation?.enforcement?.externalEffects?.mode);
}

function normalizeTurnRequest(body) {
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const directInput = Array.isArray(body.input) ? body.input : null;
  const prompt = directInput ? inputText(directInput) : String(body.prompt || body.input || '').trim();
  if (!prompt && !attachments.length) throw hostError('HOST_INPUT_REQUIRED', 'Turn input is required.', 400);
  return {
    attachments,
    directInput,
    displayText: prompt || '请查看附件并按其内容处理。',
    prompt,
  };
}

function runtimeTurnInput(turn, attachmentInputs) {
  if (!attachmentInputs.length) return turn.directInput || turn.prompt;
  const baseInput = turn.directInput || (turn.prompt ? [{ type: 'text', text: turn.prompt }] : []);
  return [...baseInput, ...attachmentInputs];
}

function inputText(input) {
  return input.map((part) => part?.text || part?.content || '').filter(Boolean).join('\n').trim();
}

function requireAttachmentsEnabled(enabled) {
  if (!enabled) throw hostError('HOST_ATTACHMENTS_DISABLED', 'Attachments are disabled for this Environment.', 403);
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

async function readJsonBody(request, { maxBytes = MAX_BODY_BYTES } = {}) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw hostError('HOST_BODY_TOO_LARGE', 'Request body is too large.', 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw hostError('HOST_BODY_INVALID', 'Request body must be valid JSON.', 400);
  }
}

function sendAttachment(response, attachment, body) {
  response.writeHead(200, {
    'content-type': inlineAttachmentContentType(attachment.mimeType),
    'content-length': String(body.length),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function inlineAttachmentContentType(value) {
  const mimeType = String(value || '').toLowerCase();
  if (mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType === 'application/pdf') {
    return mimeType;
  }
  if (['text/plain', 'text/markdown', 'text/x-markdown'].includes(mimeType)) {
    return 'text/plain; charset=utf-8';
  }
  return 'application/octet-stream';
}

async function serveAsset(response, assetsRoot, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  let path;
  let body;
  try {
    path = await resolveContainedPath(assetsRoot, relativePath);
    body = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENVIRONMENT_PATH_NOT_FOUND') {
      throw hostError('HOST_ASSET_NOT_FOUND', 'Asset not found.', 404);
    }
    throw error;
  }
  response.writeHead(200, {
    'content-type': contentType(path),
    // Minimal Host assets use stable URLs. They must be revalidated on every
    // page load so an upgraded Run cannot keep executing a previous UI bundle.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'",
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

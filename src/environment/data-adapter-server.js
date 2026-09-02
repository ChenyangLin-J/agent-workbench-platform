import { createSign, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BIGQUERY_API_TARGET,
  BIGQUERY_READ_ADAPTER_KIND,
  GOOGLE_OAUTH_TARGET,
  MODULE_MCP_READ_ADAPTER_KIND,
  OPENMETADATA_READ_ADAPTER_KIND,
  normalizeDataAdapters,
  readStagedDataAdapterCredential,
} from './data-adapters.js';

const MAX_REQUEST_BYTES = 1024 * 1024;
// BigQuery query and dry-run requests both use the Jobs API. Google rejects
// service-account tokens limited to bigquery.readonly before IAM or the
// adapter's SELECT-only policy can be evaluated.
const GOOGLE_BIGQUERY_JOB_SCOPE = 'https://www.googleapis.com/auth/bigquery';

export async function runDataAdapterServer({
  adapter,
  credentialPath,
  serviceTokenPath,
  readyFile,
  runId,
  host = '0.0.0.0',
  port = 4200,
  fetchImpl = proxyAwareFetch,
  capabilityRoot = null,
} = {}) {
  const lockKind = adapter?.kind === MODULE_MCP_READ_ADAPTER_KIND ? 'mcp-server' : 'read-only-adapter';
  adapter = normalizeDataAdapters([adapter], {
    capabilities: [{ id: adapter?.id, kind: lockKind }],
  })[0];
  const credential = await readStagedDataAdapterCredential(credentialPath, adapter);
  const serviceToken = (await readFile(serviceTokenPath, 'utf8')).trim();
  if (serviceToken.length < 32) throw serverError('DATA_ADAPTER_SERVICE_TOKEN_INVALID', 'Data adapter service token is invalid.');
  const rpc = adapter.kind === MODULE_MCP_READ_ADAPTER_KIND
    ? await createModuleMcpRpcHandler({ adapter, credential, capabilityRoot, fetchImpl })
    : createDataAdapterRpcHandler({ adapter, credential, fetchImpl });
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/mcp') return send(response, 404, errorResponse(null, -32601, 'Not found'));
      if (!safeBearer(request.headers.authorization, serviceToken)) {
        return send(response, 401, errorResponse(null, -32001, 'Unauthorized'));
      }
      const body = await readJsonBody(request);
      const result = await rpc(body);
      if (result == null) {
        response.writeHead(202).end();
        return;
      }
      return send(response, 200, result);
    } catch (error) {
      return send(response, error?.code === 'REQUEST_TOO_LARGE' ? 413 : 400,
        errorResponse(null, -32600, safeServerMessage(error)));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : port;
  await writeReadyFile(readyFile, {
    schemaVersion: 1,
    runId,
    adapter: { id: adapter.id, kind: adapter.kind, server: adapter.server },
    port: listeningPort,
    readyAt: new Date().toISOString(),
  });
  await waitForShutdown(server);
}

export function createDataAdapterRpcHandler({ adapter, credential, fetchImpl = proxyAwareFetch, now = () => new Date() } = {}) {
  if (adapter.kind === OPENMETADATA_READ_ADAPTER_KIND) {
    return createOpenMetadataRpcHandler({ adapter, credential, fetchImpl });
  }
  if (adapter.kind === BIGQUERY_READ_ADAPTER_KIND) {
    return createBigQueryRpcHandler({ adapter, credential, fetchImpl, now });
  }
  throw serverError('DATA_ADAPTER_KIND_UNSUPPORTED', `Unsupported data adapter kind: ${adapter.kind}.`);
}

export async function createModuleMcpRpcHandler({ adapter, credential, capabilityRoot, fetchImpl = proxyAwareFetch } = {}) {
  if (adapter?.kind !== MODULE_MCP_READ_ADAPTER_KIND) {
    throw serverError('MODULE_MCP_ADAPTER_INVALID', 'Module MCP adapter configuration is invalid.');
  }
  const root = resolve(nonEmptyString(capabilityRoot, 'module MCP capability root'));
  const [rootInfo, canonicalRoot] = await Promise.all([lstat(root), realpath(root)]);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw serverError('MODULE_MCP_ROOT_UNSAFE', 'Module MCP capability root must be a directory and not a symlink.');
  }
  const requestedEntrypoint = resolve(canonicalRoot, adapter.entrypoint);
  const entrypointRelative = relative(canonicalRoot, requestedEntrypoint);
  if (!entrypointRelative || entrypointRelative.startsWith(`..${sep}`) || entrypointRelative === '..') {
    throw serverError('MODULE_MCP_ENTRYPOINT_UNSAFE', 'Module MCP entrypoint is outside its immutable capability snapshot.');
  }
  const [entrypointInfo, canonicalEntrypoint] = await Promise.all([
    lstat(requestedEntrypoint),
    realpath(requestedEntrypoint),
  ]);
  if (!entrypointInfo.isFile() || entrypointInfo.isSymbolicLink()
    || relative(canonicalRoot, canonicalEntrypoint).startsWith(`..${sep}`)) {
    throw serverError('MODULE_MCP_ENTRYPOINT_UNSAFE', 'Module MCP entrypoint must be a regular snapshot file.');
  }
  const module = await import(pathToFileURL(canonicalEntrypoint).href);
  if (typeof module.createMcpHandler !== 'function') {
    throw serverError('MODULE_MCP_EXPORT_INVALID', 'Module MCP entrypoint must export createMcpHandler().');
  }
  const handler = await module.createMcpHandler({
    environment: Object.freeze({ ...credential.environment }),
    fetchImpl: restrictedModuleFetch(fetchImpl, adapter.networkTargets),
  });
  if (typeof handler !== 'function') {
    throw serverError('MODULE_MCP_HANDLER_INVALID', 'Module MCP createMcpHandler() must return a request handler.');
  }
  const allowed = new Set(adapter.allowedTools);
  const listed = await handler({ jsonrpc: '2.0', id: 'agent-workbench-startup', method: 'tools/list' });
  const toolNames = Array.isArray(listed?.result?.tools)
    ? listed.result.tools.map((tool) => tool?.name).filter((name) => typeof name === 'string')
    : [];
  if (toolNames.length !== allowed.size || toolNames.some((name) => !allowed.has(name))
    || [...allowed].some((name) => !toolNames.includes(name))) {
    throw serverError('MODULE_MCP_TOOLSET_MISMATCH', 'Module MCP tool catalog does not match the Environment allowlist.');
  }
  return async (request) => {
    const validation = validateJsonRpc(request);
    if (validation.notification) return null;
    if (request.method === 'initialize') return successResponse(request.id, {
      protocolVersion: request.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: adapter.server, version: '1' },
    });
    if (request.method === 'ping') return successResponse(request.id, {});
    if (request.method === 'tools/list') {
      const response = await handler(request);
      if (Array.isArray(response?.result?.tools)) {
        response.result.tools = response.result.tools.filter((tool) => allowed.has(tool?.name));
      }
      return response;
    }
    if (request.method !== 'tools/call') {
      return errorResponse(request.id, -32601, 'Method is outside the read-only adapter contract.');
    }
    const name = request.params?.name;
    if (typeof name !== 'string' || !allowed.has(name)) {
      return errorResponse(request.id, -32602, 'Tool is outside the read-only allowlist.');
    }
    try {
      return await handler(request);
    } catch (error) {
      return errorResponse(request.id, -32002, safeServerMessage(error));
    }
  };
}

function restrictedModuleFetch(fetchImpl, targets) {
  const allowed = targets.map((target) => new URL(target));
  return (value, options) => {
    let requested;
    try {
      requested = new URL(value);
    } catch {
      throw serverError('MODULE_MCP_NETWORK_REJECTED', 'Module MCP requested an invalid network target.');
    }
    const accepted = allowed.some((target) => requested.protocol === 'https:'
      && requested.origin === target.origin
      && (target.pathname === '/' || requested.pathname === target.pathname
        || requested.pathname.startsWith(`${target.pathname.replace(/\/$/, '')}/`)));
    if (!accepted || requested.username || requested.password) {
      throw serverError('MODULE_MCP_NETWORK_REJECTED', 'Module MCP requested a target outside its network allowlist.');
    }
    return fetchImpl(requested.toString(), options);
  };
}

function createOpenMetadataRpcHandler({ adapter, credential, fetchImpl }) {
  const allowed = new Set(adapter.allowedTools);
  return async (request) => {
    const validation = validateJsonRpc(request);
    if (validation.notification) return null;
    if (request.method === 'ping') return successResponse(request.id, {});
    if (request.method === 'tools/call') {
      const name = request.params?.name;
      if (typeof name !== 'string' || !allowed.has(name)) {
        return errorResponse(request.id, -32602, 'OpenMetadata tool is outside the read-only allowlist.');
      }
    } else if (!['initialize', 'tools/list'].includes(request.method)) {
      return errorResponse(request.id, -32601, 'Method is outside the read-only adapter contract.');
    }
    const upstream = await fetchImpl(adapter.target, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${credential.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    if (!upstream.ok) throw serverError('OPENMETADATA_UPSTREAM_FAILED', `OpenMetadata returned HTTP ${upstream.status}.`);
    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      throw serverError('OPENMETADATA_UPSTREAM_UNSUPPORTED', 'OpenMetadata returned an unsupported transport.');
    }
    const response = await upstream.json();
    if (request.method === 'initialize' && response?.result) {
      response.result.capabilities = { tools: { listChanged: false } };
    }
    if (request.method === 'tools/list' && Array.isArray(response?.result?.tools)) {
      response.result.tools = response.result.tools.filter((tool) => allowed.has(tool?.name));
    }
    return response;
  };
}

function createBigQueryRpcHandler({ adapter, credential, fetchImpl, now }) {
  const tokenProvider = createGoogleTokenProvider({ credential: credential.credential, fetchImpl, now });
  return async (request) => {
    const validation = validateJsonRpc(request);
    if (validation.notification) return null;
    if (request.method === 'initialize') return successResponse(request.id, {
      protocolVersion: request.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'agent-workbench-bigquery-read', version: '1' },
    });
    if (request.method === 'ping') return successResponse(request.id, {});
    if (request.method === 'tools/list') return successResponse(request.id, { tools: bigQueryTools(adapter) });
    if (request.method !== 'tools/call') {
      return errorResponse(request.id, -32601, 'Method is outside the read-only adapter contract.');
    }
    const name = request.params?.name;
    if (!['dry_run_query', 'run_query'].includes(name)) {
      return errorResponse(request.id, -32602, 'BigQuery tool is outside the read-only allowlist.');
    }
    const query = request.params?.arguments?.query;
    if (typeof query !== 'string' || !query.trim()) return errorResponse(request.id, -32602, 'query is required.');
    try {
      const dryRun = await dryRunBigQuery({ adapter, query: query.trim(), tokenProvider, fetchImpl });
      const result = name === 'dry_run_query'
        ? dryRun
        : await executeBigQuery({ adapter, query: query.trim(), dryRun, tokenProvider, fetchImpl });
      return successResponse(request.id, toolResult(result));
    } catch (error) {
      return errorResponse(request.id, -32002, safeServerMessage(error));
    }
  };
}

async function dryRunBigQuery({ adapter, query, tokenProvider, fetchImpl }) {
  const response = await googleRequest(fetchImpl, tokenProvider, `${BIGQUERY_API_TARGET}/projects/${encodeURIComponent(adapter.billingProject)}/jobs`, {
    method: 'POST',
    body: {
      configuration: {
        dryRun: true,
        query: {
          query,
          useLegacySql: false,
          maximumBytesBilled: String(adapter.maximumBytesBilled),
        },
      },
    },
  });
  const statistics = response.statistics?.query || {};
  if (statistics.statementType !== 'SELECT') {
    throw serverError('BIGQUERY_STATEMENT_REJECTED', 'BigQuery dry-run did not classify the statement as SELECT.');
  }
  const referencedTables = (statistics.referencedTables || []).map((table) => ({
    projectId: table.projectId,
    datasetId: table.datasetId,
    tableId: table.tableId,
  }));
  const denied = referencedTables.filter((table) => !adapter.allowedProjects.includes(table.projectId));
  if (denied.length) {
    throw serverError('BIGQUERY_PROJECT_REJECTED', `BigQuery query references a project outside the allowlist: ${denied[0].projectId}.`);
  }
  const totalBytesProcessed = numericString(statistics.totalBytesProcessed || '0', 'BigQuery totalBytesProcessed');
  if (BigInt(totalBytesProcessed) > BigInt(adapter.maximumBytesBilled)) {
    throw serverError('BIGQUERY_BYTES_REJECTED', 'BigQuery dry-run exceeds maximumBytesBilled.');
  }
  return {
    statementType: statistics.statementType,
    referencedTables,
    totalBytesProcessed,
    maximumBytesBilled: String(adapter.maximumBytesBilled),
  };
}

async function executeBigQuery({ adapter, query, dryRun, tokenProvider, fetchImpl }) {
  const response = await googleRequest(fetchImpl, tokenProvider, `${BIGQUERY_API_TARGET}/projects/${encodeURIComponent(adapter.billingProject)}/queries`, {
    method: 'POST',
    body: {
      query,
      useLegacySql: false,
      maximumBytesBilled: String(adapter.maximumBytesBilled),
      maxResults: String(adapter.maximumRows),
      timeoutMs: 200_000,
      useQueryCache: true,
    },
  });
  if (response.jobComplete !== true) throw serverError('BIGQUERY_JOB_INCOMPLETE', 'BigQuery query did not complete within the bounded request.');
  if (response.errors?.length) throw serverError('BIGQUERY_QUERY_FAILED', 'BigQuery query returned errors.');
  const totalRows = numericString(response.totalRows || String(response.rows?.length || 0), 'BigQuery totalRows');
  const rows = Array.isArray(response.rows) ? response.rows.slice(0, adapter.maximumRows) : [];
  return {
    dryRun,
    schema: response.schema || { fields: [] },
    rows,
    returnedRows: rows.length,
    totalRows,
    truncated: Boolean(response.pageToken) || BigInt(totalRows) > BigInt(rows.length),
  };
}

function createGoogleTokenProvider({ credential, fetchImpl, now }) {
  let cached = null;
  return async () => {
    const current = new Date(now()).getTime();
    if (cached && cached.expiresAt - current > 60_000) return cached.accessToken;
    const parameters = credential.type === 'authorized_user'
      ? new URLSearchParams({
          client_id: credential.client_id,
          client_secret: credential.client_secret,
          refresh_token: credential.refresh_token,
          grant_type: 'refresh_token',
        })
      : new URLSearchParams({
          assertion: serviceAccountAssertion(credential, current),
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        });
    const response = await fetchImpl(GOOGLE_OAUTH_TARGET, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: parameters,
    });
    if (!response.ok) throw serverError('GOOGLE_OAUTH_FAILED', `Google OAuth returned HTTP ${response.status}.`);
    const document = await response.json();
    if (typeof document.access_token !== 'string' || !document.access_token
      || !Number.isFinite(Number(document.expires_in)) || Number(document.expires_in) < 60) {
      throw serverError('GOOGLE_OAUTH_INVALID', 'Google OAuth returned an invalid token response.');
    }
    cached = { accessToken: document.access_token, expiresAt: current + Number(document.expires_in) * 1_000 };
    return cached.accessToken;
  };
}

function serviceAccountAssertion(credential, current) {
  if (credential.token_uri !== GOOGLE_OAUTH_TARGET) {
    throw serverError('GOOGLE_OAUTH_TARGET_INVALID', 'Google service-account token_uri is outside the fixed OAuth target.');
  }
  const header = base64Json({ alg: 'RS256', typ: 'JWT' });
  const claims = base64Json({
    iss: credential.client_email,
    scope: GOOGLE_BIGQUERY_JOB_SCOPE,
    aud: GOOGLE_OAUTH_TARGET,
    iat: Math.floor(current / 1_000),
    exp: Math.floor(current / 1_000) + 3_600,
  });
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${signer.sign(credential.private_key, 'base64url')}`;
}

async function googleRequest(fetchImpl, tokenProvider, url, { method, body }) {
  const accessToken = await tokenProvider();
  const response = await fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw serverError('BIGQUERY_UPSTREAM_FAILED', `BigQuery returned HTTP ${response.status}.`);
  return response.json();
}

function bigQueryTools(adapter) {
  const inputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: { query: { type: 'string', minLength: 1 } },
  };
  return [
    {
      name: 'dry_run_query',
      description: `Validate a SELECT query against the fixed project allowlist and ${adapter.maximumBytesBilled}-byte ceiling without executing it.`,
      inputSchema,
    },
    {
      name: 'run_query',
      description: `Dry-run and execute a validated SELECT query, returning at most ${adapter.maximumRows} rows.`,
      inputSchema,
    },
  ];
}

function validateJsonRpc(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    throw serverError('JSON_RPC_INVALID', 'Request must be one JSON-RPC 2.0 object.');
  }
  return { notification: request.id == null };
}

function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function successResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function send(response, status, body) {
  const content = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(content),
    'cache-control': 'no-store',
  });
  response.end(content);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw serverError('REQUEST_TOO_LARGE', 'Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function safeBearer(value, expectedToken) {
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  const actual = Buffer.from(String(value || ''));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function numericString(value, label) {
  const normalized = String(value);
  if (!/^\d+$/.test(normalized)) throw serverError('BIGQUERY_RESPONSE_INVALID', `${label} is invalid.`);
  return normalized;
}

function base64Json(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function writeReadyFile(path, document) {
  if (typeof path !== 'string' || !path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.writing-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await chmod(temporary, 0o600);
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function waitForShutdown(server) {
  return new Promise((resolve, reject) => {
    const stop = () => server.close((error) => error ? reject(error) : resolve());
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    server.once('error', reject);
  });
}

function safeServerMessage(error) {
  if (String(error?.code || '').startsWith('BIGQUERY_')
    || String(error?.code || '').startsWith('OPENMETADATA_')
    || String(error?.code || '').startsWith('GOOGLE_')
    || String(error?.code || '').startsWith('MODULE_MCP_')) return error.message;
  return 'Data adapter request was rejected.';
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw serverError('MODULE_MCP_CONFIGURATION_INVALID', `${label} is required.`);
  return value.trim();
}

function serverError(code, message) {
  return Object.assign(new Error(message), { code });
}

function proxyAwareFetch(url, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError(options.signal));
      return;
    }
    const body = options.body == null
      ? null
      : Buffer.from(options.body instanceof URLSearchParams ? options.body.toString() : String(options.body));
    const headers = { ...(options.headers || {}) };
    if (body && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-length')) {
      headers['content-length'] = String(body.length);
    }
    let request;
    const removeAbortListener = () => options.signal?.removeEventListener('abort', abortRequest);
    const abortRequest = () => request?.destroy(abortError(options.signal));
    request = httpsRequest(url, {
      method: options.method || 'GET',
      headers,
      agent: new HttpsAgent({ proxyEnv: process.env }),
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 10 * 1024 * 1024) {
          response.destroy(serverError('DATA_ADAPTER_RESPONSE_TOO_LARGE', 'Data adapter upstream response is too large.'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', (error) => {
        removeAbortListener();
        reject(error);
      });
      response.once('end', () => {
        removeAbortListener();
        resolve(createBufferedFetchResponse(Buffer.concat(chunks), {
          status: response.statusCode,
          statusText: response.statusMessage,
          headers: response.headers,
        }));
      });
    });
    options.signal?.addEventListener('abort', abortRequest, { once: true });
    request.setTimeout(60_000, () => request.destroy(serverError('DATA_ADAPTER_UPSTREAM_TIMEOUT', 'Data adapter upstream timed out.')));
    request.once('error', (error) => {
      removeAbortListener();
      reject(error);
    });
    if (body) request.write(body);
    request.end();
  });
}

export function createBufferedFetchResponse(body, {
  status = 200,
  statusText = '',
  headers = {},
} = {}) {
  const normalizedStatus = Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502;
  const responseBody = [204, 205, 304].includes(normalizedStatus) ? null : body;
  return new Response(responseBody, {
    status: normalizedStatus,
    statusText: typeof statusText === 'string' ? statusText : '',
    headers: new Headers(headers),
  });
}

function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
}

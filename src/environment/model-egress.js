import { timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';

import { readStagedCodexCredential } from './codex-credential.js';

const ALLOWED_PATHS = new Set(['/responses', '/responses/compact']);

export async function runModelEgressBroker({
  credentialPath,
  serviceTokenPath,
  port,
  host = '0.0.0.0',
  readyFile = null,
  runId = null,
  now = () => new Date(),
  requestUpstream = null,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new TypeError('Model broker port is invalid');
  const credential = await readStagedCodexCredential(credentialPath, { now });
  const resolvedServiceTokenPath = resolve(serviceTokenPath);
  const [serviceTokenInfo, canonicalServiceTokenPath] = await Promise.all([
    lstat(resolvedServiceTokenPath),
    realpath(resolvedServiceTokenPath),
  ]);
  if (!serviceTokenInfo.isFile() || serviceTokenInfo.isSymbolicLink()
    || (serviceTokenInfo.mode & 0o077) !== 0) {
    throw new TypeError('Model broker service token must be a private regular file and not a symlink');
  }
  const serviceToken = (await readFile(canonicalServiceTokenPath, 'utf8')).trim();
  if (!serviceToken) throw new TypeError('Model broker service token is empty');
  const proxyAwareAgent = requestUpstream ? null : new HttpsAgent({ proxyEnv: process.env });
  const upstreamRequest = requestUpstream
    || ((options, callback) => httpsRequest({ ...options, agent: proxyAwareAgent }, callback));
  const server = createServer((incoming, outgoing) => {
    void proxyModelRequest(incoming, outgoing, { credential, serviceToken, now, requestUpstream: upstreamRequest });
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
  if (readyFile) {
    try {
      const address = server.address();
      await writeFile(resolve(readyFile), `${JSON.stringify({
        schemaVersion: 1,
        runId,
        pid: process.pid,
        port: typeof address === 'object' && address ? address.port : port,
        target: credential.target,
        expiresAt: credential.expiresAt,
        readyAt: new Date().toISOString(),
      }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (error) {
      await new Promise((resolvePromise) => server.close(resolvePromise));
      throw error;
    }
  }
  const stop = async () => {
    if (!server.listening) return;
    await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
  };
  process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));
  process.once('SIGINT', () => void stop().finally(() => process.exit(130)));
  return server;
}

async function proxyModelRequest(incoming, outgoing, { credential, serviceToken, now, requestUpstream }) {
  try {
    if (!authorized(incoming.headers.authorization, serviceToken)) return sendError(outgoing, 401, 'MODEL_BROKER_UNAUTHORIZED');
    if (new Date(credential.expiresAt).getTime() <= new Date(now()).getTime()) return sendError(outgoing, 401, 'MODEL_BROKER_CREDENTIAL_EXPIRED');
    if (incoming.method !== 'POST') return sendError(outgoing, 405, 'MODEL_BROKER_METHOD_DENIED');
    const requestUrl = new URL(incoming.url || '/', 'http://model-broker.local');
    if (!ALLOWED_PATHS.has(requestUrl.pathname)) return sendError(outgoing, 403, 'MODEL_BROKER_PATH_DENIED');
    const targetBase = new URL(credential.target);
    const upstreamPath = `${targetBase.pathname.replace(/\/$/, '')}${requestUrl.pathname}${requestUrl.search}`;
    const upstream = requestUpstream({
      protocol: targetBase.protocol,
      hostname: targetBase.hostname,
      port: targetBase.port || 443,
      method: incoming.method,
      path: upstreamPath,
      headers: upstreamHeaders(incoming.headers, credential, targetBase.host),
    }, (response) => {
      outgoing.writeHead(response.statusCode || 502, responseHeaders(response.headers));
      response.pipe(outgoing);
    });
    upstream.setTimeout(5 * 60_000, () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!outgoing.headersSent) sendError(outgoing, 502, 'MODEL_BROKER_UPSTREAM_UNAVAILABLE');
      else outgoing.destroy();
    });
    incoming.on('aborted', () => upstream.destroy());
    incoming.pipe(upstream);
  } catch {
    if (!outgoing.headersSent) sendError(outgoing, 500, 'MODEL_BROKER_REQUEST_FAILED');
    else outgoing.destroy();
  }
}

function upstreamHeaders(headers, credential, host) {
  const result = { ...headers };
  for (const name of [
    'authorization',
    'x-api-key',
    'chatgpt-account-id',
    'openai-organization',
    'openai-project',
    'cookie',
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ]) delete result[name];
  result.host = host;
  result.authorization = `Bearer ${credential.accessToken}`;
  result['chatgpt-account-id'] = credential.accountId;
  return result;
}

function responseHeaders(headers) {
  const result = { ...headers };
  for (const name of ['connection', 'keep-alive', 'set-cookie', 'transfer-encoding', 'upgrade']) delete result[name];
  return result;
}

function authorized(header, expected) {
  const prefix = 'Bearer ';
  if (typeof header !== 'string' || !header.startsWith(prefix)) return false;
  const actual = Buffer.from(header.slice(prefix.length));
  const target = Buffer.from(expected);
  return actual.length === target.length && timingSafeEqual(actual, target);
}

function sendError(response, status, code) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify({ error: { code, message: 'Model broker request was rejected.' } })}\n`);
}

import { timingSafeEqual } from 'node:crypto';
import { connect as connectSocket, createServer } from 'node:net';

const MAX_HEADER_BYTES = 16 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;

export async function startFixedTargetProxyRelay({
  upstreamProxyUrl,
  authToken,
  targetHost = 'chatgpt.com',
  targetPort = 443,
  targets = null,
  host = '0.0.0.0',
  port = 0,
  connect = connectSocket,
} = {}) {
  const proxy = parseUpstreamProxy(upstreamProxyUrl);
  if (typeof authToken !== 'string' || authToken.length < 32) {
    throw new TypeError('Host proxy relay requires a strong per-Run auth token');
  }
  const allowedTargets = normalizeTargets(targets || [{ host: targetHost, port: targetPort }]);
  const expectedAuthorization = `Basic ${Buffer.from(`agent-workbench:${authToken}`).toString('base64')}`;
  const sockets = new Set();
  const server = createServer((client) => {
    sockets.add(client);
    client.once('close', () => sockets.delete(client));
    readHeaders(client).then(({ head, remainder }) => {
      const request = parseConnectRequest(head);
      const selectedTarget = request ? allowedTargets.get(request.target) : null;
      if (!selectedTarget) {
        return reject(client, 403, 'Forbidden');
      }
      if (!safeEqual(request.authorization, expectedAuthorization)) {
        return reject(client, 407, 'Proxy Authentication Required', { 'Proxy-Authenticate': 'Basic realm="agent-workbench"' });
      }
      return openTunnel(client, remainder, {
        proxy,
        targetHost: selectedTarget.host,
        targetPort: selectedTarget.port,
        connect,
      });
    }).catch(() => reject(client, 400, 'Bad Request'));
  });
  await new Promise((resolve, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(port, host, () => {
      server.off('error', rejectPromise);
      resolve();
    });
  });
  const address = server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : port;
  return {
    host,
    port: listeningPort,
    containerProxyUrl: `http://agent-workbench:${encodeURIComponent(authToken)}@host.docker.internal:${listeningPort}`,
    async stop() {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) return;
      await new Promise((resolve, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolve()));
    },
  };
}

function normalizeTargets(targets) {
  if (!Array.isArray(targets) || !targets.length) throw new TypeError('Host proxy relay requires at least one fixed target');
  const normalized = new Map();
  for (const target of targets) {
    if (!target || !validHostname(target.host) || !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535) {
      throw new TypeError('Host proxy relay target is invalid');
    }
    normalized.set(`${target.host}:${target.port}`, { host: target.host, port: target.port });
  }
  return normalized;
}

async function openTunnel(client, initialClientData, { proxy, targetHost, targetPort, connect }) {
  const upstream = connect(proxy ? { host: proxy.hostname, port: proxy.port } : { host: targetHost, port: targetPort });
  let connected = false;
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('connect timeout')));
  upstream.once('error', () => {
    if (!connected) reject(client, 502, 'Bad Gateway');
    else client.destroy();
  });
  client.once('error', () => upstream.destroy());
  client.once('close', () => upstream.destroy());
  if (!proxy) {
    upstream.once('connect', () => {
      connected = true;
      upstream.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (initialClientData.length) upstream.write(initialClientData);
      client.pipe(upstream).pipe(client);
    });
    return;
  }
  upstream.once('connect', async () => {
    try {
      upstream.write(proxyConnectRequest(proxy, targetHost, targetPort));
      const { head, remainder } = await readHeaders(upstream);
      if (!/^HTTP\/1\.[01] 200(?:\s|$)/i.test(head.split('\r\n', 1)[0])) {
        upstream.destroy();
        return reject(client, 502, 'Bad Gateway');
      }
      connected = true;
      upstream.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (remainder.length) client.write(remainder);
      if (initialClientData.length) upstream.write(initialClientData);
      client.pipe(upstream).pipe(client);
    } catch {
      upstream.destroy();
      reject(client, 502, 'Bad Gateway');
    }
  });
}

function proxyConnectRequest(proxy, targetHost, targetPort) {
  const target = `${targetHost}:${targetPort}`;
  const lines = [
    `CONNECT ${target} HTTP/1.1`,
    `Host: ${target}`,
    'Proxy-Connection: keep-alive',
  ];
  if (proxy.authorization) lines.push(`Proxy-Authorization: ${proxy.authorization}`);
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function parseUpstreamProxy(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('Host proxy relay requires an upstream HTTPS proxy');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Host HTTPS proxy URL is invalid');
  }
  if (url.protocol !== 'http:' || url.pathname !== '/' || url.search || url.hash) {
    throw new TypeError('Host proxy relay currently supports only an http:// proxy URL');
  }
  const port = Number(url.port || 80);
  if (!validHostname(url.hostname) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('Host HTTPS proxy endpoint is invalid');
  }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  return {
    hostname: url.hostname,
    port,
    authorization: username || password
      ? `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
      : null,
  };
}

function parseConnectRequest(head) {
  const lines = head.split('\r\n');
  const match = lines[0]?.match(/^CONNECT\s+([^\s]+)\s+HTTP\/1\.[01]$/i);
  if (!match) return null;
  const headers = {};
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { target: match[1], authorization: headers['proxy-authorization'] || '' };
}

function readHeaders(socket) {
  return new Promise((resolve, rejectPromise) => {
    let body = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const onEnd = () => {
      cleanup();
      rejectPromise(new Error('socket ended before headers'));
    };
    const onError = (error) => {
      cleanup();
      rejectPromise(error);
    };
    const onData = (chunk) => {
      body = Buffer.concat([body, chunk]);
      if (body.length > MAX_HEADER_BYTES) {
        cleanup();
        return rejectPromise(new Error('headers too large'));
      }
      const boundary = body.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      cleanup();
      resolve({
        head: body.subarray(0, boundary).toString('latin1'),
        remainder: body.subarray(boundary + 4),
      });
    };
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

function reject(socket, status, message, headers = {}) {
  if (socket.destroyed) return;
  const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join('');
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n${extra}Content-Length: 0\r\n\r\n`);
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validHostname(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 253 && !/[\s/\\]/.test(value);
}

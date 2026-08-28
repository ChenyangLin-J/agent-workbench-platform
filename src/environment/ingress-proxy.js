import { createServer, request as httpRequest } from 'node:http';

export async function runFixedIngressProxy({
  upstreamHost,
  upstreamPort,
  port,
  host = '0.0.0.0',
} = {}) {
  if (typeof upstreamHost !== 'string' || !upstreamHost.trim()) throw new TypeError('Ingress upstreamHost is required');
  for (const [label, value] of [['upstreamPort', upstreamPort], ['port', port]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new TypeError(`Ingress ${label} is invalid`);
  }
  const server = createServer((incoming, outgoing) => {
    const target = new URL(incoming.url || '/', 'http://ingress.local');
    const upstream = httpRequest({
      hostname: upstreamHost,
      port: upstreamPort,
      method: incoming.method,
      path: `${target.pathname}${target.search}`,
      headers: forwardedHeaders(incoming.headers),
    }, (response) => {
      outgoing.writeHead(response.statusCode || 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'application/json' });
      outgoing.end('{"error":{"code":"HOST_UPSTREAM_UNAVAILABLE","message":"Minimal Host is starting."}}\n');
    });
    incoming.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const stop = async () => {
    if (!server.listening) return;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));
  process.once('SIGINT', () => void stop().finally(() => process.exit(130)));
  return server;
}

function forwardedHeaders(headers) {
  const result = { ...headers };
  for (const name of ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']) delete result[name];
  return result;
}

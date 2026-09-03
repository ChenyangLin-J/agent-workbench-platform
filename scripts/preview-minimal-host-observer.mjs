import { randomBytes } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  EnvironmentSessionStore,
  buildMinimalHostAssets,
  createMinimalHost,
} from '../src/environment/index.js';

const options = commandLineOptions(process.argv.slice(2));
const runRoot = resolve(options.run);
const manifest = JSON.parse(await readFile(join(runRoot, 'manifest.json'), 'utf8'));
if (resolve(manifest.paths?.root || '') !== runRoot) {
  throw new Error('Run manifest root does not match --run.');
}

const assetsRoot = await mkdtemp(join(tmpdir(), 'awb-observer-preview-'));
await buildMinimalHostAssets({ outputDirectory: assetsRoot });
const accessToken = randomBytes(32).toString('hex');
const observerHeader = 'x-agent-workbench-local-observer';
const host = createMinimalHost({
  manifest: {
    ...manifest,
    features: { sessionWorkspace: true },
  },
  kernel: readOnlyKernel(),
  sessionStore: new EnvironmentSessionStore({
    stateRoot: manifest.paths.sessionState || manifest.paths.state,
    runId: manifest.id,
    crossProcess: Boolean(manifest.paths.sessionState),
  }),
  assetsRoot,
  accessToken,
  sessionObserverHeader: observerHeader,
});
const hostAddress = await host.start();
const proxy = createReadOnlyProxy({
  upstreamPort: hostAddress.port,
  accessToken,
  observerHeader,
});
const previewAddress = await listen(proxy, options.port);

console.log(`Observer acceptance URL: http://127.0.0.1:${previewAddress.port}/?view=observer`);
console.log(`Reading Sessions from Run: ${manifest.id}`);
console.log('This preview proxy permits only Observer GET requests and static assets.');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await close(proxy);
  await host.stop();
  await rm(assetsRoot, { recursive: true, force: true });
}

process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));

function createReadOnlyProxy({ upstreamPort, accessToken: token, observerHeader: header }) {
  return createServer((incoming, outgoing) => {
    const url = new URL(incoming.url || '/', 'http://127.0.0.1');
    if (incoming.method !== 'GET') {
      outgoing.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end('Read-only preview');
      return;
    }
    if (url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/observer/')) {
      outgoing.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    if (url.pathname === '/bootstrap.js') {
      outgoing.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
      }).end('globalThis.__AGENT_WORKBENCH_BOOTSTRAP__={accessToken:null,features:{}};\n');
      return;
    }
    const headers = { ...incoming.headers };
    delete headers['x-agent-workbench-token'];
    delete headers[header];
    headers['x-agent-workbench-token'] = token;
    headers[header] = 'true';
    const upstream = httpRequest({
      host: '127.0.0.1',
      port: upstreamPort,
      method: 'GET',
      path: incoming.url || '/',
      headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode || 500, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', (error) => outgoing.destroy(error));
    outgoing.on('close', () => upstream.destroy());
    upstream.end();
  });
}

function readOnlyKernel() {
  return {
    attach: denyMutation,
    submit: denyMutation,
    capabilities: () => ({}),
    getPendingRequests: () => [],
    subscribe: () => () => {},
    on: () => {},
    off: () => {},
    close: () => {},
  };
}

function denyMutation() {
  throw Object.assign(new Error('Observer preview is read-only.'), { status: 405 });
}

function commandLineOptions(argumentsList) {
  let run = '';
  let port = 4319;
  for (let index = 0; index < argumentsList.length; index += 1) {
    if (argumentsList[index] === '--run') run = argumentsList[++index] || '';
    else if (argumentsList[index] === '--port') port = Number(argumentsList[++index]);
    else throw new Error(`Unknown argument: ${argumentsList[index]}`);
  }
  if (!run) throw new Error('--run <run-root> is required.');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new Error('--port must be a valid TCP port.');
  return { run, port };
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port }, () => {
      server.off('error', reject);
      resolveListen(server.address());
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

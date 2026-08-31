import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import test from 'node:test';

import { startFixedTargetProxyRelay } from '../src/environment/host-proxy-relay.js';

test('host proxy relay requires per-Run auth and permits only the fixed ChatGPT tunnel', async (t) => {
  let observedUpstreamRequest = '';
  const upstreamProxy = createServer((socket) => {
    socket.once('data', (chunk) => {
      observedUpstreamRequest = chunk.toString('latin1');
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\nUPSTREAM_READY');
    });
  });
  const upstreamPort = await listen(upstreamProxy);
  t.after(() => close(upstreamProxy));

  const authToken = 'a'.repeat(43);
  const relay = await startFixedTargetProxyRelay({
    upstreamProxyUrl: `http://proxy-user:proxy-password@127.0.0.1:${upstreamPort}`,
    authToken,
    host: '127.0.0.1',
  });
  t.after(() => relay.stop());

  const unauthorized = await connectRequest(relay.port, [
    'CONNECT chatgpt.com:443 HTTP/1.1',
    'Host: chatgpt.com:443',
    '',
    '',
  ].join('\r\n'));
  assert.match(unauthorized, /^HTTP\/1\.1 407 Proxy Authentication Required/);

  const authorization = `Basic ${Buffer.from(`agent-workbench:${authToken}`).toString('base64')}`;
  const forbidden = await connectRequest(relay.port, [
    'CONNECT example.com:443 HTTP/1.1',
    'Host: example.com:443',
    `Proxy-Authorization: ${authorization}`,
    '',
    '',
  ].join('\r\n'));
  assert.match(forbidden, /^HTTP\/1\.1 403 Forbidden/);

  const accepted = await connectRequest(relay.port, [
    'CONNECT chatgpt.com:443 HTTP/1.1',
    'Host: chatgpt.com:443',
    `Proxy-Authorization: ${authorization}`,
    '',
    '',
  ].join('\r\n'), { waitFor: 'UPSTREAM_READY' });
  assert.match(accepted, /^HTTP\/1\.1 200 Connection Established/);
  assert.match(accepted, /UPSTREAM_READY/);
  assert.match(observedUpstreamRequest, /^CONNECT chatgpt\.com:443 HTTP\/1\.1/m);
  assert.match(observedUpstreamRequest, new RegExp(`Proxy-Authorization: Basic ${Buffer.from('proxy-user:proxy-password').toString('base64')}`));
  assert.equal(observedUpstreamRequest.includes(authToken), false);
});

test('host proxy relay can enforce a small explicit target set', async (t) => {
  const observedTargets = [];
  const upstreamProxy = createServer((socket) => {
    socket.once('data', (chunk) => {
      observedTargets.push(chunk.toString('latin1').split('\r\n', 1)[0]);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\nREADY');
    });
  });
  const upstreamPort = await listen(upstreamProxy);
  t.after(() => close(upstreamProxy));
  const authToken = 'b'.repeat(43);
  const relay = await startFixedTargetProxyRelay({
    upstreamProxyUrl: `http://127.0.0.1:${upstreamPort}`,
    authToken,
    host: '127.0.0.1',
    targets: [
      { host: 'bigquery.googleapis.com', port: 443 },
      { host: 'oauth2.googleapis.com', port: 443 },
    ],
  });
  t.after(() => relay.stop());
  const authorization = `Basic ${Buffer.from(`agent-workbench:${authToken}`).toString('base64')}`;
  for (const host of ['bigquery.googleapis.com', 'oauth2.googleapis.com']) {
    const accepted = await connectRequest(relay.port, [
      `CONNECT ${host}:443 HTTP/1.1`,
      `Host: ${host}:443`,
      `Proxy-Authorization: ${authorization}`,
      '',
      '',
    ].join('\r\n'), { waitFor: 'READY' });
    assert.match(accepted, /^HTTP\/1\.1 200 Connection Established/);
  }
  const forbidden = await connectRequest(relay.port, [
    'CONNECT storage.googleapis.com:443 HTTP/1.1',
    'Host: storage.googleapis.com:443',
    `Proxy-Authorization: ${authorization}`,
    '',
    '',
  ].join('\r\n'));
  assert.match(forbidden, /^HTTP\/1\.1 403 Forbidden/);
  assert.deepEqual(observedTargets, [
    'CONNECT bigquery.googleapis.com:443 HTTP/1.1',
    'CONNECT oauth2.googleapis.com:443 HTTP/1.1',
  ]);
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function connectRequest(port, request, { waitFor = '\r\n\r\n' } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let body = '';
    const finish = () => {
      socket.destroy();
      resolve(body);
    };
    socket.setTimeout(3_000, () => reject(new Error('proxy response timed out')));
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      body += chunk.toString('latin1');
      if (body.includes(waitFor)) finish();
    });
    socket.once('connect', () => socket.write(request));
    socket.once('end', finish);
  });
}

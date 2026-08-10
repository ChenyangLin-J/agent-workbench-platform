import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeAppServer } from './core-testkit.js';

import {
  AppServerConnection,
  AppServerHostPool,
  bundledCodexLaunch,
  CODEX_PROVIDER_VERSION,
} from '../src/runtime/core/index.js';

test('Codex Provider resolves its exact package-local CLI', async () => {
  const launch = bundledCodexLaunch();
  assert.equal(CODEX_PROVIDER_VERSION, '0.147.0');
  assert.equal(launch.command, process.execPath);
  assert.match(launch.args[0], /node_modules\/@openai\/codex\/bin\/codex\.js$/);
  const packageJson = JSON.parse(await (await import('node:fs/promises')).readFile(
    new URL('../package.json', import.meta.url),
    'utf8',
  ));
  assert.equal(packageJson.dependencies['@openai/codex'], CODEX_PROVIDER_VERSION);
});

test('connection initializes once and correlates concurrent JSONL requests', async (t) => {
  const fake = createFakeAppServer({
    onRequest(message, server) {
      if (message.method === 'initialize') server.respond(message, { userAgent: 'codex-test' });
      if (message.method === 'alpha') server.respond(message, { value: 'a' });
      if (message.method === 'beta') server.respond(message, { value: 'b' });
    },
  });
  const connection = new AppServerConnection({ childProcess: fake.child });
  t.after(() => connection.close());
  const initialized = await connection.start();
  const [alpha, beta] = await Promise.all([
    connection.request('alpha'),
    connection.request('beta'),
  ]);
  assert.equal(initialized.userAgent, 'codex-test');
  assert.deepEqual(alpha, { value: 'a' });
  assert.deepEqual(beta, { value: 'b' });
  assert.equal(fake.messages.filter((message) => message.method === 'initialize').length, 1);
  assert.equal(fake.messages.some((message) => message.method === 'initialized' && message.id === undefined), true);
});

test('connection surfaces typed server requests and rejects pending work on exit', async () => {
  const fake = createFakeAppServer({
    onRequest(message, server) {
      if (message.method === 'initialize') server.respond(message, {});
    },
  });
  const connection = new AppServerConnection({ childProcess: fake.child, requestTimeoutMs: 5_000 });
  await connection.start();
  const requestHandled = new Promise((resolve) => {
    connection.once('server-request', async (request) => {
      assert.equal(request.method, 'item/tool/requestUserInput');
      await request.respond({ answers: {} });
      resolve();
    });
  });
  fake.request(900, 'item/tool/requestUserInput', { threadId: 'thread-a', questions: [] });
  await requestHandled;
  assert.deepEqual(fake.messages.find((message) => message.id === 900), { id: 900, result: { answers: {} } });
  const pending = connection.request('never-responds');
  fake.exit(1);
  await assert.rejects(pending, (error) => error.code === 'APP_SERVER_EXITED');
});

test('connection accepts a final response without a trailing newline', async () => {
  const fake = createFakeAppServer({
    onRequest(message, server) {
      if (message.method === 'initialize') server.respond(message, {});
    },
  });
  const connection = new AppServerConnection({ childProcess: fake.child });
  await connection.start();
  const pending = connection.request('final-response');
  const request = fake.messages.find((message) => message.method === 'final-response');
  fake.child.stdout.write(JSON.stringify({ id: request.id, result: { ok: true } }));
  fake.exit(0);
  assert.deepEqual(await pending, { ok: true });
});

test('host pool reuses one connection per execution host', () => {
  const created = [];
  const pool = new AppServerHostPool({
    createConnection(host) {
      const connection = Object.assign(new EventTarget(), { state: 'idle', host, close() { this.state = 'closed'; } });
      connection.once = () => {};
      created.push(connection);
      return connection;
    },
  });
  assert.equal(pool.connectionFor({ id: 'mac' }), pool.connectionFor({ id: 'mac' }));
  assert.notEqual(pool.connectionFor({ id: 'mac' }), pool.connectionFor({ id: 'linux' }));
  assert.equal(created.length, 2);
  pool.close();
});

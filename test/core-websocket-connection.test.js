import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodexAppServerProvider,
  WebSocketAppServerConnection,
} from '../src/runtime/core/index.js';

class FakeWebSocket extends EventTarget {
  static instances = [];
  static behaviors = [];
  static initializeBehaviors = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    const behavior = this.constructor.behaviors.shift() || 'open';
    queueMicrotask(() => {
      if (behavior === 'error') {
        this.readyState = 3;
        this.dispatchEvent(new Event('error'));
        return;
      }
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(line) {
    const message = JSON.parse(line);
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.method === 'initialize') {
        const behavior = this.constructor.initializeBehaviors.shift() || 'success';
        if (behavior === 'success') this.serverSend({ id: message.id, result: { userAgent: 'fake-ws' } });
        if (behavior === 'error') this.serverSend({ id: message.id, error: { code: -32_000, message: 'initialize failed' } });
      }
      if (message.method === 'thread/start') {
        this.serverSend({
          id: message.id,
          result: {
            thread: { id: 'thread-ws' },
            model: 'gpt-5.6-sol',
            sandbox: { type: 'dangerFullAccess' },
            approvalPolicy: 'never',
          },
        });
      }
      if (message.method === 'turn/start') {
        this.serverSend({ id: message.id, result: { turn: { id: 'turn-ws', status: 'inProgress' } } });
      }
    });
  }

  serverSend(message) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { code: 1000 }));
  }
}

test('WebSocket connection initializes once and keeps server requests typed', async () => {
  let ensured = 0;
  const connection = new WebSocketAppServerConnection({
    url: 'ws://127.0.0.1:9999',
    WebSocketImpl: FakeWebSocket,
    ensureServer: () => { ensured += 1; },
  });
  assert.deepEqual(await connection.start(), { userAgent: 'fake-ws' });
  assert.equal(ensured, 1);
  const socket = FakeWebSocket.instances.at(-1);
  const handled = new Promise((resolve) => connection.once('server-request', async (request) => {
    assert.equal(request.method, 'item/commandExecution/requestApproval');
    await request.respond({ decision: 'decline' });
    resolve();
  }));
  socket.serverSend({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-ws' } });
  await handled;
  assert.deepEqual(socket.sent.find((message) => message.id === 99), { id: 99, result: { decision: 'decline' } });
  connection.close();
});

test('WebSocket connection reports activity and reconnects after an idle disconnect', async () => {
  let ensured = 0;
  const activity = [];
  const connection = new WebSocketAppServerConnection({
    url: 'ws://127.0.0.1:9997',
    WebSocketImpl: FakeWebSocket,
    ensureServer: () => { ensured += 1; },
  });
  connection.on('activity', (event) => activity.push(event));
  await connection.start();
  const firstSocket = FakeWebSocket.instances.at(-1);
  connection.disconnect();
  assert.equal(connection.state, 'stopped');
  assert.equal(firstSocket.readyState, 3);
  await connection.start();
  assert.equal(ensured, 2);
  assert.notEqual(FakeWebSocket.instances.at(-1), firstSocket);
  assert.equal(activity.some((event) => event.method === 'initialize'), true);
  assert.equal(activity.some((event) => event.direction === 'inbound'), true);
  connection.close();
});

test('WebSocket startup failures remain retryable on the same connection object', async (t) => {
  let ensureAttempts = 0;
  const ensureConnection = new WebSocketAppServerConnection({
    url: 'ws://127.0.0.1:9996',
    WebSocketImpl: FakeWebSocket,
    ensureServer: () => {
      ensureAttempts += 1;
      if (ensureAttempts === 1) throw new Error('server unavailable');
    },
  });
  t.after(() => ensureConnection.close());
  await assert.rejects(ensureConnection.start(), /server unavailable/);
  assert.equal(ensureConnection.state, 'stopped');
  assert.deepEqual(await ensureConnection.start(), { userAgent: 'fake-ws' });
  assert.equal(ensureAttempts, 2);

  class ConnectRetryWebSocket extends FakeWebSocket {}
  ConnectRetryWebSocket.behaviors = ['error', 'open'];
  ConnectRetryWebSocket.initializeBehaviors = [];
  const connectConnection = new WebSocketAppServerConnection({
    url: 'ws://127.0.0.1:9995',
    WebSocketImpl: ConnectRetryWebSocket,
  });
  t.after(() => connectConnection.close());
  await assert.rejects(connectConnection.start(), (error) => error.code === 'APP_SERVER_CONNECTION_FAILED');
  assert.equal(connectConnection.state, 'stopped');
  assert.deepEqual(await connectConnection.start(), { userAgent: 'fake-ws' });

  class InitializeRetryWebSocket extends FakeWebSocket {}
  InitializeRetryWebSocket.behaviors = [];
  InitializeRetryWebSocket.initializeBehaviors = ['timeout', 'success'];
  const initializeConnection = new WebSocketAppServerConnection({
    url: 'ws://127.0.0.1:9994',
    WebSocketImpl: InitializeRetryWebSocket,
    requestTimeoutMs: 20,
  });
  t.after(() => initializeConnection.close());
  await assert.rejects(initializeConnection.start(), (error) => error.code === 'APP_SERVER_REQUEST_TIMEOUT');
  assert.equal(initializeConnection.state, 'stopped');
  assert.deepEqual(await initializeConnection.start(), { userAgent: 'fake-ws' });
});

test('explicit close stays terminal and stale sockets cannot disturb a replacement', async () => {
  const connection = new WebSocketAppServerConnection({
    url: 'ws://127.0.0.1:9993',
    WebSocketImpl: FakeWebSocket,
  });
  const notifications = [];
  const protocolErrors = [];
  connection.on('notification', (message) => notifications.push(message));
  connection.on('protocol-error', (error) => protocolErrors.push(error));
  await connection.start();
  const staleSocket = FakeWebSocket.instances.at(-1);
  connection.disconnect();
  await connection.start();
  const currentSocket = FakeWebSocket.instances.at(-1);
  assert.notEqual(currentSocket, staleSocket);

  staleSocket.serverSend({ method: 'stale/event', params: {} });
  staleSocket.dispatchEvent(new Event('error'));
  staleSocket.dispatchEvent(new CloseEvent('close', { code: 1006 }));
  assert.equal(connection.state, 'ready');
  assert.equal(connection.socket, currentSocket);
  assert.deepEqual(notifications, []);
  assert.deepEqual(protocolErrors, []);

  connection.close();
  assert.equal(connection.state, 'closed');
  await assert.rejects(connection.start(), (error) => error.code === 'APP_SERVER_NOT_STARTABLE');
});

test('closing a runtime Session only removes local subscriptions', async () => {
  const connection = new WebSocketAppServerConnection({
    url: 'ws://127.0.0.1:9998',
    WebSocketImpl: FakeWebSocket,
  });
  const session = new CodexAppServerProvider({ connection }).createSession();
  await session.start();
  const created = await session.create();
  assert.deepEqual(created.runtimeProfile, {
    model: 'gpt-5.6-sol',
    sandbox: { type: 'dangerFullAccess' },
    approvalPolicy: 'never',
  });
  await session.startTurn('keep running');
  let exited = false;
  session.on('exit', () => { exited = true; });
  session.close();
  assert.equal(exited, false);
  connection.close();
});

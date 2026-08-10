import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CodexAppServerProvider,
  WebSocketAppServerConnection,
} from '../src/runtime/core/index.js';

class FakeWebSocket extends EventTarget {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(line) {
    const message = JSON.parse(line);
    this.sent.push(message);
    queueMicrotask(() => {
      if (message.method === 'initialize') this.serverSend({ id: message.id, result: { userAgent: 'fake-ws' } });
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

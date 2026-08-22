import assert from 'node:assert/strict';
import test from 'node:test';

import { createFakeAppServer } from './core-testkit.js';

import { AppServerConnection, CodexAppServerProvider, configureCodexSkillRoots } from '../src/runtime/core/index.js';

function providerHarness() {
  let threadSequence = 0;
  let turnSequence = 0;
  const fake = createFakeAppServer({
    onRequest(message, server) {
      if (message.method === 'initialize') server.respond(message, { userAgent: 'codex-test' });
      if (message.method === 'thread/start') {
        server.respond(message, { thread: { id: `thread-${++threadSequence}`, turns: [] } });
      }
      if (message.method === 'thread/resume') {
        server.respond(message, { thread: { id: message.params.threadId, turns: [] }, initialTurnsPage: { data: [] } });
      }
      if (message.method === 'thread/read') {
        server.respond(message, { thread: { id: message.params.threadId, turns: [] } });
      }
      if (message.method === 'turn/start') {
        const id = `turn-${++turnSequence}`;
        server.respond(message, { turn: { id, status: 'inProgress' } });
      }
      if (message.method === 'turn/steer') server.respond(message, { turnId: message.params.expectedTurnId });
      if (message.method === 'turn/interrupt') server.respond(message, {});
      if (message.method === 'thread/unsubscribe') server.respond(message, {});
    },
  });
  const connection = new AppServerConnection({ childProcess: fake.child });
  const provider = new CodexAppServerProvider({ connection });
  return { fake, connection, provider };
}

test('two Codex runtime Sessions isolate events and requests on one connection', async (t) => {
  const { fake, connection, provider } = providerHarness();
  t.after(() => connection.close());
  const first = provider.createSession();
  const second = provider.createSession();
  await Promise.all([first.start(), second.start()]);
  await first.create();
  await second.create();
  const firstEvents = [];
  const secondEvents = [];
  first.on('event', (event) => firstEvents.push(event));
  second.on('event', (event) => secondEvents.push(event));
  fake.notify('turn/started', { threadId: first.runtimeSessionId, turn: { id: 'turn-first' } });
  fake.notify('turn/started', { threadId: second.runtimeSessionId, turn: { id: 'turn-second' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(firstEvents.map((event) => event.runtimeTurnId), ['turn-first']);
  assert.deepEqual(secondEvents.map((event) => event.runtimeTurnId), ['turn-second']);

  const firstRequest = new Promise((resolve) => first.once('request', resolve));
  fake.request(901, 'item/commandExecution/requestApproval', {
    threadId: first.runtimeSessionId,
    turnId: 'turn-first',
    command: 'pwd',
  });
  const request = await firstRequest;
  assert.equal(request.type, 'command_approval');
  assert.equal(second.listenerCount('request'), 0);
  await request.respond({ decision: 'decline' });
  assert.deepEqual(fake.messages.find((message) => message.id === 901), { id: 901, result: { decision: 'decline' } });
});

test('Codex provider handles completion before turn/start response', async (t) => {
  const fake = createFakeAppServer({
    onRequest(message, server) {
      if (message.method === 'initialize') server.respond(message, {});
      if (message.method === 'thread/start') server.respond(message, { thread: { id: 'thread-fast' } });
      if (message.method === 'turn/start') {
        server.notify('turn/completed', {
          threadId: 'thread-fast',
          turn: { id: 'turn-fast', status: 'completed' },
        });
        server.respond(message, { turn: { id: 'turn-fast', status: 'inProgress' } });
      }
    },
  });
  const connection = new AppServerConnection({ childProcess: fake.child });
  t.after(() => connection.close());
  const session = new CodexAppServerProvider({ connection }).createSession();
  await session.start();
  await session.create();
  const result = await session.startTurn('fast');
  assert.equal(result.status, 'completed');
  assert.equal(session.activeTurnId, null);
});

test('Codex provider prepares each connection once and maps product execution settings at the protocol boundary', async (t) => {
  const prepared = [];
  const { fake, connection } = providerHarness();
  t.after(() => connection.close());
  const provider = new CodexAppServerProvider({
    connection,
    prepareConnection: async (value) => prepared.push(value),
  });
  const first = provider.createSession({ settings: { model: 'gpt-test', reasoningEffort: 'high', accessMode: 'full' } });
  const second = provider.createSession();
  await Promise.all([first.start(), second.start()]);
  assert.equal(prepared.length, 1);
  await first.create();
  const request = fake.messages.find((message) => message.method === 'thread/start');
  assert.equal(request.params.effort, 'high');
  assert.equal(request.params.sandbox, 'danger-full-access');
  assert.equal('reasoningEffort' in request.params, false);
  assert.equal('accessMode' in request.params, false);
});

test('Codex Skill root preparation validates the expected runtime inventory', async () => {
  const requests = [];
  const connection = { request: async (method, params) => {
    requests.push({ method, params });
    if (method === 'skills/list') return { data: [{ skills: [{ name: 'one', path: '/skills/one', enabled: true }] }] };
    return {};
  } };
  const status = await configureCodexSkillRoots(connection, {
    extraRoots: ['/skills'], cwds: ['/workspace'], expectedSkills: ['one', 'two'],
  });
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, ['two']);
  assert.deepEqual(requests.map((item) => item.method), ['skills/extraRoots/set', 'skills/list']);
});

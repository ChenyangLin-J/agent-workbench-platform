import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CHATGPT_CODEX_BASE_URL,
  createCodexNativeCredentialBroker,
  normalizeEnvironmentProfile,
  prepareMinimalRuntimeConfiguration,
  runModelEgressBroker,
} from '../src/environment/index.js';

test('Codex credential broker stages only an unexpired ChatGPT access token', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-codex-credential-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex-home');
  await mkdir(codexHome, { mode: 0o700 });
  const now = new Date('2026-08-28T08:00:00.000Z');
  const accessToken = jwt({ exp: Math.floor(now.getTime() / 1_000) + 3_600, marker: 'fixture-secret' });
  await writeFile(join(codexHome, 'auth.json'), `${JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: accessToken, refresh_token: 'must-not-stage', account_id: 'account-fixture' },
  })}\n`, { mode: 0o600 });
  await chmod(join(codexHome, 'auth.json'), 0o600);
  const profile = brokerProfile();
  const broker = createCodexNativeCredentialBroker({ codexHome, now: () => now });
  const inspection = await broker.inspect({ profile });
  assert.equal(inspection.ready, true);
  assert.equal(JSON.stringify(inspection).includes('fixture-secret'), false);
  const stagedDirectory = join(root, 'credentials', 'broker');
  const staged = await broker.stage({ profile, directory: stagedDirectory });
  assert.equal(staged.expiresAt, '2026-08-28T09:00:00.000Z');
  const document = JSON.parse(await readFile(join(stagedDirectory, 'model.json'), 'utf8'));
  assert.equal(document.accessToken, accessToken);
  assert.equal(document.accountId, 'account-fixture');
  assert.equal(JSON.stringify(document).includes('must-not-stage'), false);
});

test('Codex credential broker rejects long-lived or expiring credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-codex-credential-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = join(root, 'codex-home');
  await mkdir(codexHome, { mode: 0o700 });
  const authPath = join(codexHome, 'auth.json');
  await writeFile(authPath, JSON.stringify({ auth_mode: 'apiKey', OPENAI_API_KEY: 'fixture-key' }), { mode: 0o600 });
  await chmod(authPath, 0o600);
  const broker = createCodexNativeCredentialBroker({ codexHome });
  assert.match((await broker.inspect({ profile: brokerProfile() })).reason, /long-lived API keys/);
  const now = new Date('2026-08-28T08:00:00.000Z');
  await writeFile(authPath, JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { access_token: jwt({ exp: Math.floor(now.getTime() / 1_000) + 60 }), account_id: 'account-fixture' },
  }));
  assert.match((await createCodexNativeCredentialBroker({ codexHome, now: () => now }).inspect({ profile: brokerProfile() })).reason, /expires too soon/);
});

test('fixed model egress broker replaces caller auth and denies every other route', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-model-broker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const credentialPath = join(root, 'model.json');
  const tokenPath = join(root, 'service-token');
  await writeFile(credentialPath, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'chatgpt-access-token',
    target: CHATGPT_CODEX_BASE_URL,
    accessToken: 'upstream-access-token',
    accountId: 'account-fixture',
    expiresAt: '2026-08-28T09:00:00.000Z',
  })}\n`, { mode: 0o600 });
  await writeFile(tokenPath, 'run-service-token\n', { mode: 0o600 });
  let observed;
  const server = await runModelEgressBroker({
    credentialPath,
    serviceTokenPath: tokenPath,
    port: 0,
    now: () => new Date('2026-08-28T08:00:00.000Z'),
    requestUpstream(options, callback) {
      const stream = new PassThrough();
      const chunks = [];
      stream.setTimeout = () => stream;
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('finish', () => {
        observed = { options, body: Buffer.concat(chunks).toString('utf8') };
        const response = Readable.from(['{"ok":true}\n']);
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json', 'set-cookie': 'must-not-forward=1' };
        callback(response);
      });
      return stream;
    },
  });
  t.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
  const { port } = server.address();
  const accepted = await fetch(`http://127.0.0.1:${port}/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer run-service-token',
      cookie: 'must-not-forward=1',
      'x-api-key': 'must-not-forward',
      'openai-organization': 'must-not-forward',
    },
    body: '{"input":"hello"}',
  });
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), '{"ok":true}\n');
  assert.equal(accepted.headers.has('set-cookie'), false);
  assert.equal(observed.options.hostname, 'chatgpt.com');
  assert.equal(observed.options.path, '/backend-api/codex/responses');
  assert.equal(observed.options.headers.authorization, 'Bearer upstream-access-token');
  assert.equal(observed.options.headers['chatgpt-account-id'], 'account-fixture');
  assert.equal(observed.options.headers.cookie, undefined);
  assert.equal(observed.options.headers['x-api-key'], undefined);
  assert.equal(observed.options.headers['openai-organization'], undefined);
  assert.equal(observed.body, '{"input":"hello"}');
  assert.equal((await fetch(`http://127.0.0.1:${port}/responses`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/models`, {
    method: 'POST',
    headers: { authorization: 'Bearer run-service-token' },
  })).status, 403);
});

test('brokered Runtime config contains only the Run-local endpoint and hides its service token from shells', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-model-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = join(root, 'runtime');
  const codexHome = join(runtime, 'codex-home');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const tokenPath = join(root, 'service-token');
  await writeFile(tokenPath, 'run-service-token\n', { mode: 0o600 });
  const prepared = await prepareMinimalRuntimeConfiguration({
    manifest: {
      runtime: {
        provider: 'codex',
        model: 'gpt-test',
        modelBroker: {
          baseUrl: 'http://awb-0123456789abcdef-model-egress:4190',
          envKey: 'AGENT_WORKBENCH_MODEL_BROKER_TOKEN',
        },
      },
      paths: { runtime },
    },
    brokerTokenPath: tokenPath,
  });
  assert.deepEqual(prepared.environment, { AGENT_WORKBENCH_MODEL_BROKER_TOKEN: 'run-service-token' });
  const config = await readFile(prepared.configPath, 'utf8');
  assert.match(config, /model_provider = "agent-workbench-broker"/);
  assert.match(config, /base_url = "http:\/\/awb-0123456789abcdef-model-egress:4190"/);
  assert.match(config, /exclude = \["AGENT_WORKBENCH_MODEL_BROKER_TOKEN"\]/);
  assert.equal(config.includes('run-service-token'), false);
});

function brokerProfile() {
  return normalizeEnvironmentProfile({
    id: 'brokered-model',
    runtime: { provider: 'codex', model: 'gpt-test' },
    isolation: {
      provider: 'docker',
      minimumLevel: 'ephemeral-machine',
      credentialReferences: ['credentials.codex-native'],
      networkTargets: [CHATGPT_CODEX_BASE_URL],
    },
  });
}

function jwt(payload) {
  return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
}

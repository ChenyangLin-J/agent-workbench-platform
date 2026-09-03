import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BIGQUERY_API_TARGET,
  GOOGLE_OAUTH_TARGET,
  adapterDirectoryName,
  createDataAdapterCredentialBroker,
  createDataAdapterRpcHandler,
  createModuleMcpRpcHandler,
  dataAdapterRequest,
  normalizeEnvironmentBindings,
  normalizeEnvironmentProfile,
  readStagedDataAdapterCredential,
} from '../src/environment/index.js';
import { createBufferedFetchResponse } from '../src/environment/data-adapter-server.js';

test('adapter network responses implement the standard Fetch body contract', async () => {
  const response = createBufferedFetchResponse(Buffer.from('{"ok":true}'), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json', 'x-test': 'present' },
  });
  assert.equal(response.ok, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-test'), 'present');
  assert.deepEqual(JSON.parse(Buffer.from(await response.arrayBuffer()).toString('utf8')), { ok: true });

  const empty = createBufferedFetchResponse(Buffer.alloc(0), { status: 204 });
  assert.equal(empty.status, 204);
  assert.equal(await empty.text(), '');
});

test('data adapter requirements are exact, additive, and read-only', () => {
  const profile = adapterProfile();
  const request = dataAdapterRequest(profile);
  assert.equal(request.requested, true);
  assert.deepEqual(request.credentialReferences, ['credentials.google-adc', 'credentials.metadata-pat']);
  assert.deepEqual(request.networkTargets, [
    BIGQUERY_API_TARGET,
    GOOGLE_OAUTH_TARGET,
    'https://metadata.example.test/mcp',
  ].sort());
  assert.deepEqual(request.externalEffects, { read: ['metadata.read', 'warehouse.read'], write: [] });
});

test('controller-only bindings reject embedded values and resolve file paths', () => {
  const bindings = normalizeEnvironmentBindings({
    schema: 'agent-workbench.environment-bindings/v1',
    credentials: {
      'credentials.metadata-pat': { source: 'environment', key: 'OPENMETADATA_PAT' },
      'credentials.google-adc': { source: 'file', path: './adc.json' },
    },
    storage: { sessionPersistence: { root: './sessions' } },
  }, { baseDirectory: '/private/controller' });
  assert.equal(bindings.credentials['credentials.google-adc'].path, '/private/controller/adc.json');
  assert.equal(bindings.storage.sessionPersistence.root, '/private/controller/sessions');
  assert.throws(() => normalizeEnvironmentBindings({
    credentials: { 'credentials.metadata-pat': { source: 'environment', key: 'OPENMETADATA_PAT', value: 'secret' } },
  }), /unsupported field: value/);
  assert.throws(() => normalizeEnvironmentBindings({
    credentials: {},
    storage: { sessionPersistence: { root: './sessions', token: 'not-allowed' } },
  }), /unsupported field: token/);
});

test('data adapter broker stages one private credential per adapter without leaking bindings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-data-adapters-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adcPath = join(root, 'adc.json');
  await writeFile(adcPath, `${JSON.stringify({
    type: 'authorized_user',
    client_id: 'test-client',
    client_secret: 'test-secret',
    refresh_token: 'test-refresh',
  })}\n`, { mode: 0o600 });
  const broker = createDataAdapterCredentialBroker({
    bindings: {
      credentials: {
        'credentials.metadata-pat': { source: 'environment', key: 'OPENMETADATA_PAT' },
        'credentials.google-adc': { source: 'file', path: adcPath },
      },
    },
    environment: { OPENMETADATA_PAT: 'metadata-token' },
  });
  const profile = adapterProfile();
  assert.equal((await broker.inspect({ profile })).ready, true);
  const staged = await broker.stage({ profile, directory: join(root, 'staged') });
  assert.deepEqual(staged.adapters.map((adapter) => adapter.id), ['adapters.metadata', 'adapters.warehouse']);
  const metadataAdapter = profile.capabilities.adapters.find((adapter) => adapter.kind === 'openmetadata-mcp-read');
  const warehouseAdapter = profile.capabilities.adapters.find((adapter) => adapter.kind === 'bigquery-read');
  const metadataPath = join(staged.directory, adapterDirectoryName(metadataAdapter.id), 'credential.json');
  const warehousePath = join(staged.directory, adapterDirectoryName(warehouseAdapter.id), 'credential.json');
  assert.equal((await readStagedDataAdapterCredential(metadataPath, metadataAdapter)).token, 'metadata-token');
  assert.equal((await readStagedDataAdapterCredential(warehousePath, warehouseAdapter)).credential.type, 'authorized_user');
  assert.equal(JSON.stringify(staged).includes('metadata-token'), false);
  assert.equal(JSON.stringify(staged).includes(adcPath), false);
  assert.equal((await readFile(metadataPath, 'utf8')).includes('OPENMETADATA_PAT'), false);
  await chmod(adcPath, 0o644);
  assert.equal((await broker.inspect({ profile })).ready, false);
});

test('data adapter broker fails closed for missing or wrong binding sources', async () => {
  const missing = createDataAdapterCredentialBroker({ bindings: { credentials: {} }, environment: {} });
  assert.equal((await missing.inspect({ profile: adapterProfile() })).ready, false);
  const wrong = createDataAdapterCredentialBroker({
    bindings: { credentials: {
      'credentials.metadata-pat': { source: 'file', path: '/tmp/not-used' },
      'credentials.google-adc': { source: 'environment', key: 'GOOGLE_ADC' },
    } },
    environment: { GOOGLE_ADC: '{}' },
  });
  const inspection = await wrong.inspect({ profile: adapterProfile() });
  assert.equal(inspection.ready, false);
  assert.match(inspection.reason, /must come from an environment binding/);
  assert.match(inspection.reason, /must come from a private file binding/);
});

test('OpenMetadata adapter filters discovery and rejects write tools before upstream', async () => {
  const adapter = adapterProfile().capabilities.adapters.find((entry) => entry.kind === 'openmetadata-mcp-read');
  const requests = [];
  const rpc = createDataAdapterRpcHandler({
    adapter,
    credential: { token: 'metadata-token' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      const request = JSON.parse(options.body);
      if (request.method === 'initialize') return jsonResponse({
        jsonrpc: '2.0', id: request.id,
        result: { capabilities: { tools: {}, prompts: {}, resources: {} }, serverInfo: { name: 'upstream' } },
      });
      if (request.method === 'tools/list') return jsonResponse({
        jsonrpc: '2.0', id: request.id,
        result: { tools: [
          { name: 'search_metadata', inputSchema: { type: 'object' } },
          { name: 'patch_entity', inputSchema: { type: 'object' } },
        ] },
      });
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: { content: [] } });
    },
  });
  const initialized = await rpc(rpcRequest(1, 'initialize', { protocolVersion: '2025-06-18' }));
  assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });
  const listed = await rpc(rpcRequest(2, 'tools/list'));
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['search_metadata']);
  const rejected = await rpc(rpcRequest(3, 'tools/call', { name: 'patch_entity', arguments: {} }));
  assert.match(rejected.error.message, /outside the read-only allowlist/);
  assert.equal(requests.length, 2);
  const allowed = await rpc(rpcRequest(4, 'tools/call', { name: 'search_metadata', arguments: { query: 'orders' } }));
  assert.deepEqual(allowed.result, { content: [] });
  assert.equal(requests[2].options.headers.authorization, 'Bearer metadata-token');
  assert.equal(JSON.stringify(requests[2].options.headers).includes('caller-token'), false);
});

test('BigQuery adapter dry-runs every query and executes only allowlisted SELECT', async () => {
  const adapter = adapterProfile().capabilities.adapters.find((entry) => entry.kind === 'bigquery-read');
  const requests = [];
  const rpc = createDataAdapterRpcHandler({
    adapter,
    credential: { credential: {
      type: 'authorized_user', client_id: 'client', client_secret: 'secret', refresh_token: 'refresh',
    } },
    now: () => new Date('2026-08-31T00:00:00.000Z'),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url === GOOGLE_OAUTH_TARGET) return jsonResponse({ access_token: 'google-token', expires_in: 3600 });
      if (url.endsWith('/jobs')) {
        const query = JSON.parse(options.body).configuration.query.query;
        if (query.includes('DELETE')) return jsonResponse({ statistics: { query: { statementType: 'DELETE' } } });
        if (query.includes('denied')) return jsonResponse({ statistics: { query: {
          statementType: 'SELECT', totalBytesProcessed: '10',
          referencedTables: [{ projectId: 'denied-project', datasetId: 'd', tableId: 't' }],
        } } });
        return jsonResponse({ statistics: { query: {
          statementType: 'SELECT', totalBytesProcessed: '10',
          referencedTables: [{ projectId: 'source-project', datasetId: 'd', tableId: 't' }],
        } } });
      }
      if (url.endsWith('/queries')) return jsonResponse({
        jobComplete: true,
        schema: { fields: [{ name: 'value', type: 'INTEGER' }] },
        rows: [{ f: [{ v: '1' }] }],
        totalRows: '1',
      });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  const tools = await rpc(rpcRequest(1, 'tools/list'));
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ['dry_run_query', 'run_query']);
  const mutation = await rpc(rpcRequest(2, 'tools/call', { name: 'run_query', arguments: { query: 'DELETE FROM `source-project.d.t` WHERE true' } }));
  assert.match(mutation.error.message, /did not classify the statement as SELECT/);
  assert.equal(requests.some(({ url }) => url.endsWith('/queries')), false);
  const denied = await rpc(rpcRequest(3, 'tools/call', { name: 'run_query', arguments: { query: 'SELECT * FROM `denied-project.d.t`' } }));
  assert.match(denied.error.message, /outside the allowlist/);
  assert.equal(requests.some(({ url }) => url.endsWith('/queries')), false);
  const result = await rpc(rpcRequest(4, 'tools/call', { name: 'run_query', arguments: { query: 'SELECT * FROM `source-project.d.t`' } }));
  assert.equal(result.result.structuredContent.returnedRows, 1);
  assert.equal(requests.filter(({ url }) => url.endsWith('/jobs')).length, 3);
  assert.equal(requests.filter(({ url }) => url.endsWith('/queries')).length, 1);
  const execution = requests.find(({ url }) => url.endsWith('/queries'));
  assert.equal(execution.options.headers.authorization, 'Bearer google-token');
  assert.equal(JSON.parse(execution.options.body).maximumBytesBilled, '1024');
  assert.equal(JSON.parse(execution.options.body).maxResults, '20');
});

test('BigQuery service-account tokens request the Jobs API scope', async () => {
  const adapter = adapterProfile().capabilities.adapters.find((entry) => entry.kind === 'bigquery-read');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let requestedScope = null;
  const rpc = createDataAdapterRpcHandler({
    adapter,
    credential: { credential: {
      type: 'service_account',
      client_email: 'bigquery-reader@example.test',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: GOOGLE_OAUTH_TARGET,
    } },
    now: () => new Date('2026-09-02T00:00:00.000Z'),
    fetchImpl: async (url, options) => {
      if (url === GOOGLE_OAUTH_TARGET) {
        const assertion = new URLSearchParams(options.body).get('assertion');
        const claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString('utf8'));
        requestedScope = claims.scope;
        return jsonResponse({ access_token: 'service-account-token', expires_in: 3600 });
      }
      if (url.endsWith('/jobs')) return jsonResponse({ statistics: { query: {
        statementType: 'SELECT', totalBytesProcessed: '0', referencedTables: [],
      } } });
      throw new Error(`unexpected URL: ${url}`);
    },
  });
  const result = await rpc(rpcRequest(1, 'tools/call', { name: 'dry_run_query', arguments: { query: 'SELECT 1' } }));
  assert.equal(result.error, undefined);
  assert.equal(requestedScope, 'https://www.googleapis.com/auth/bigquery');
});

test('module MCP adapter stages named credentials and enforces tool and network allowlists', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-module-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'solver-read');
  await mkdir(capabilityRoot, { mode: 0o700 });
  await writeFile(join(capabilityRoot, 'package.json'), '{"name":"solver-read","type":"module"}\n', { mode: 0o600 });
  await writeFile(join(capabilityRoot, 'adapter.mjs'), `
export async function createMcpHandler({ environment, fetchImpl }) {
  return async (request) => {
    if (request.method === 'tools/list') return { jsonrpc: '2.0', id: request.id, result: { tools: [
      { name: 'query_solver_engine', inputSchema: { type: 'object' } },
    ] } };
    if (request.method === 'tools/call') {
      const response = await fetchImpl(request.params.arguments.url, {
        headers: { authorization: 'Bearer ' + environment.SOLVER_TOKEN },
      });
      return { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: await response.text() }] } };
    }
  };
}
`, { mode: 0o600 });
  const profile = moduleAdapterProfile(capabilityRoot);
  const adapter = profile.capabilities.adapters[0];
  const broker = createDataAdapterCredentialBroker({
    bindings: { credentials: { 'credentials.solver-token': { source: 'environment', key: 'SOLVER_PRIVATE_TOKEN' } } },
    environment: { SOLVER_PRIVATE_TOKEN: 'private-solver-token' },
  });
  const staged = await broker.stage({ profile, directory: join(root, 'staged') });
  const credentialPath = join(staged.directory, adapterDirectoryName(adapter.id), 'credential.json');
  const credential = await readStagedDataAdapterCredential(credentialPath, adapter);
  assert.deepEqual(credential.environment, { SOLVER_TOKEN: 'private-solver-token' });
  assert.equal(JSON.stringify(staged).includes('private-solver-token'), false);

  const requests = [];
  const rpc = await createModuleMcpRpcHandler({
    adapter,
    credential,
    capabilityRoot,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response('solver-ok');
    },
  });
  const tools = await rpc(rpcRequest(1, 'tools/list'));
  assert.deepEqual(tools.result.tools.map((tool) => tool.name), ['query_solver_engine']);
  const rejectedTool = await rpc(rpcRequest(2, 'tools/call', { name: 'create_experiment', arguments: {} }));
  assert.match(rejectedTool.error.message, /outside the read-only allowlist/);
  const result = await rpc(rpcRequest(3, 'tools/call', {
    name: 'query_solver_engine',
    arguments: { url: 'https://solver.example.test/api/experiments' },
  }));
  assert.equal(result.result.content[0].text, 'solver-ok');
  assert.equal(requests[0].options.headers.authorization, 'Bearer private-solver-token');
  const rejectedNetwork = await rpc(rpcRequest(4, 'tools/call', {
    name: 'query_solver_engine',
    arguments: { url: 'https://other.example.test/api/experiments' },
  }));
  assert.match(rejectedNetwork.error.message, /outside its network allowlist/);
  assert.equal(requests.length, 1);
});

function adapterProfile() {
  return normalizeEnvironmentProfile({
    id: 'adapter-test',
    capabilities: {
      lock: { capabilities: [
        { id: 'adapters.metadata', kind: 'read-only-adapter', scope: 'data', version: '1' },
        { id: 'adapters.warehouse', kind: 'read-only-adapter', scope: 'data', version: '1' },
      ] },
      adapters: [
        {
          id: 'adapters.metadata',
          kind: 'openmetadata-mcp-read',
          server: 'openmetadata',
          target: 'https://metadata.example.test/mcp',
          credentialReference: 'credentials.metadata-pat',
          effect: 'metadata.read',
          allowedTools: ['search_metadata', 'get_entity_details', 'get_entity_lineage'],
        },
        {
          id: 'adapters.warehouse',
          kind: 'bigquery-read',
          server: 'bigquery',
          credentialReference: 'credentials.google-adc',
          effect: 'warehouse.read',
          billingProject: 'billing-project',
          allowedProjects: ['source-project'],
          maximumBytesBilled: 1024,
          maximumRows: 20,
        },
      ],
    },
  });
}

function moduleAdapterProfile(source) {
  return normalizeEnvironmentProfile({
    id: 'module-adapter-test',
    capabilities: {
      lock: { capabilities: [
        { id: 'adapters.solver', kind: 'mcp-server', scope: 'experiment', version: '1' },
      ] },
      sources: [{ id: 'adapters.solver', path: source }],
      adapters: [{
        id: 'adapters.solver',
        kind: 'module-mcp-read',
        server: 'solver',
        entrypoint: 'adapter.mjs',
        credentialEnvironment: { SOLVER_TOKEN: 'credentials.solver-token' },
        networkTargets: ['https://solver.example.test/api'],
        effect: 'experiment.read',
        allowedTools: ['query_solver_engine'],
      }],
    },
  });
}

function rpcRequest(id, method, params) {
  return { jsonrpc: '2.0', id, method, ...(params == null ? {} : { params }) };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

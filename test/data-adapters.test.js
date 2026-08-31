import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BIGQUERY_API_TARGET,
  GOOGLE_OAUTH_TARGET,
  adapterDirectoryName,
  createDataAdapterCredentialBroker,
  createDataAdapterRpcHandler,
  dataAdapterRequest,
  normalizeEnvironmentBindings,
  normalizeEnvironmentProfile,
  readStagedDataAdapterCredential,
} from '../src/environment/index.js';

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
  }, { baseDirectory: '/private/controller' });
  assert.equal(bindings.credentials['credentials.google-adc'].path, '/private/controller/adc.json');
  assert.throws(() => normalizeEnvironmentBindings({
    credentials: { 'credentials.metadata-pat': { source: 'environment', key: 'OPENMETADATA_PAT', value: 'secret' } },
  }), /unsupported field: value/);
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

function rpcRequest(id, method, params) {
  return { jsonrpc: '2.0', id, method, ...(params == null ? {} : { params }) };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

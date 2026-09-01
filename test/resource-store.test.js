import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';

import { FilesystemResourceStore } from '../src/filesystem-resource-store.js';
import {
  RESOURCE_KINDS,
  RESOURCE_LIFECYCLE_CLASSES,
  RESOURCE_LIFECYCLE_STATES,
  RESOURCE_MODES,
  RESOURCE_SCHEMA,
  normalizeResourceDescriptor,
} from '../src/resources.js';

test('published Resource schema matches the public descriptor contract', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/resource.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.schema.const, RESOURCE_SCHEMA);
  assert.deepEqual(schema.properties.kind.enum, RESOURCE_KINDS);
  assert.deepEqual(schema.properties.mode.enum, RESOURCE_MODES);
  assert.deepEqual(schema.properties.lifecycle.properties.class.enum, RESOURCE_LIFECYCLE_CLASSES);
  assert.deepEqual(schema.properties.lifecycle.properties.state.enum, RESOURCE_LIFECYCLE_STATES);
  assert.equal(schema.additionalProperties, false);
});

test('resource descriptors contain portable metadata and reject private path fields by omission', () => {
  const resource = normalizeResourceDescriptor({
    schema: RESOURCE_SCHEMA,
    id: 'res_resource-0001',
    kind: 'session-input',
    mode: 'managed',
    owner: { sessionId: 'session-a' },
    display: { name: '../../report.txt', mimeType: 'TEXT/PLAIN', size: 3 },
    origin: { type: 'upload', createdAt: '2026-09-01T00:00:00.000Z' },
    lifecycle: { class: 'draft', state: 'staged', updatedAt: '2026-09-01T00:00:00.000Z' },
    capabilities: { preview: true, download: true },
    storedPath: '/private/should-not-leak',
  });
  assert.equal(resource.display.name, 'report.txt');
  assert.equal(resource.display.mimeType, 'text/plain');
  assert.equal(JSON.stringify(resource).includes('/private/should-not-leak'), false);
});

test('FilesystemResourceStore stages, commits, reads, and inspects Session resources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let currentTime = new Date('2026-09-01T00:00:00.000Z');
  let sequence = 0;
  const store = new FilesystemResourceStore({
    root,
    now: () => currentTime,
    uuid: () => `resource-${String(++sequence).padStart(4, '0')}`,
  });
  const bytes = Buffer.from('RESOURCE_CANARY_OK');
  const staged = await store.stage({
    owner: { sessionId: 'session-a' },
    display: { name: '../canary.txt', mimeType: 'text/plain', size: bytes.length },
    bytes,
  });

  assert.equal(staged.id, 'res_resource-0001');
  assert.equal(staged.lifecycle.state, 'staged');
  assert.equal(staged.lifecycle.class, 'draft');
  assert.equal('path' in staged, false);
  assert.equal('storedPath' in staged, false);
  assert.equal('draftId' in staged.owner, false);
  assert.equal(staged.integrity.digest.length, 64);

  const opened = await store.open(staged.id, { sessionId: 'session-a' });
  assert.equal(relative(store.root, opened.path).startsWith('..'), false);
  assert.equal((await readFile(opened.path, 'utf8')), 'RESOURCE_CANARY_OK');
  await assert.rejects(
    store.open(staged.id, { sessionId: 'session-b' }),
    (error) => error.code === 'RESOURCE_SESSION_MISMATCH' && error.status === 403,
  );

  currentTime = new Date('2026-09-01T00:01:00.000Z');
  const committed = await store.commit(staged.id, { sessionId: 'session-a', turnId: 'turn-a' });
  assert.equal(committed.lifecycle.state, 'ready');
  assert.equal(committed.lifecycle.class, 'session-durable');
  assert.equal(committed.owner.turnId, 'turn-a');
  assert.equal('draftId' in committed.owner, false);
  assert.deepEqual(await store.commit(staged.id, { sessionId: 'session-a', turnId: 'turn-a' }), committed);
  await assert.rejects(
    store.commit(staged.id, { sessionId: 'session-a', turnId: 'turn-b' }),
    (error) => error.code === 'RESOURCE_ALREADY_COMMITTED' && error.status === 409,
  );

  assert.deepEqual(await store.inspectUsage(), {
    resources: 1,
    bytes: bytes.length,
    byClass: { 'session-durable': 1 },
    byState: { ready: 1 },
  });
});

test('FilesystemResourceStore keeps external handles private and collection planning side-effect free', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sequence = 0;
  const store = new FilesystemResourceStore({
    root,
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    uuid: () => `resource-${String(++sequence).padStart(4, '0')}`,
  });
  const staged = await store.stage({
    owner: { sessionId: 'session-a' },
    display: { name: 'draft.txt', mimeType: 'text/plain', size: 5 },
    bytes: Buffer.from('draft'),
  });
  const external = await store.registerExternal({
    kind: 'workspace-directory',
    owner: { sessionId: 'session-a', workspaceId: 'workspace-a' },
    display: { name: 'Project', mimeType: 'inode/directory', size: 0 },
    handle: { path: '/Users/example/Project' },
  });

  assert.equal(external.mode, 'external');
  assert.equal(JSON.stringify(external).includes('/Users/example/Project'), false);
  assert.deepEqual(
    (await store.resolveExternal(external.id, { sessionId: 'session-a' })).handle,
    { path: '/Users/example/Project' },
  );
  const bound = await store.commit(external.id, { sessionId: 'session-a', turnId: 'turn-a' });
  assert.equal(bound.owner.turnId, 'turn-a');
  assert.equal(bound.lifecycle.class, 'workspace');
  await assert.rejects(
    store.commit(external.id, { sessionId: 'session-a', turnId: 'turn-b' }),
    (error) => error.code === 'RESOURCE_ALREADY_COMMITTED' && error.status === 409,
  );
  await assert.rejects(
    store.resolveExternal(external.id, { sessionId: 'session-b' }),
    (error) => error.code === 'RESOURCE_SESSION_MISMATCH',
  );

  const plan = await store.planCollection({
    draftMaxAgeMs: 1,
    now: new Date('2026-09-01T00:00:00.002Z'),
  });
  assert.deepEqual(plan.resources, [{
    id: staged.id,
    sessionId: 'session-a',
    bytes: 5,
    class: 'draft',
    state: 'staged',
    ageMs: 2,
    reason: 'draft-expired',
  }]);
  assert.equal((await store.get(staged.id, { sessionId: 'session-a' })).lifecycle.state, 'staged');
});

test('FilesystemResourceStore promotes transient output atomically and idempotently', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let currentTime = new Date('2026-09-01T00:00:00.000Z');
  const store = new FilesystemResourceStore({
    root,
    now: () => currentTime,
    uuid: () => 'transient-0001',
  });
  const bytes = Buffer.from('GENERATED_ARTIFACT');
  const transient = await store.stageTransient({
    owner: { runId: 'run-a' },
    display: { name: 'result.txt', mimeType: 'text/plain', size: bytes.length },
    bytes,
    originType: 'browser',
  });

  assert.equal(transient.kind, 'transient-output');
  assert.equal(transient.lifecycle.class, 'transient');
  assert.equal(transient.lifecycle.state, 'ready');
  assert.deepEqual(transient.capabilities, {
    preview: false,
    download: false,
    openInWorkspace: false,
  });
  assert.equal('path' in transient, false);
  await assert.rejects(
    store.commit(transient.id, { turnId: 'turn-a' }),
    (error) => error.code === 'RESOURCE_PROMOTION_REQUIRED' && error.status === 409,
  );
  await assert.rejects(
    store.promote(transient.id, { runId: 'run-b', sessionId: 'session-a', turnId: 'turn-a' }),
    (error) => error.code === 'RESOURCE_RUN_MISMATCH' && error.status === 403,
  );

  currentTime = new Date('2026-09-01T00:01:00.000Z');
  const promoted = await store.promote(transient.id, {
    runId: 'run-a',
    sessionId: 'session-a',
    turnId: 'turn-a',
  });
  assert.equal(promoted.id, transient.id);
  assert.equal(promoted.kind, 'session-artifact');
  assert.equal(promoted.owner.runId, 'run-a');
  assert.equal(promoted.owner.sessionId, 'session-a');
  assert.equal(promoted.owner.turnId, 'turn-a');
  assert.equal(promoted.lifecycle.class, 'session-durable');
  assert.equal(promoted.lifecycle.state, 'promoted');
  assert.equal(promoted.integrity.digest, transient.integrity.digest);
  assert.deepEqual((await store.read(promoted.id, { sessionId: 'session-a' })).bytes, bytes);
  const retries = await Promise.all(Array.from({ length: 4 }, () => store.promote(transient.id, {
    runId: ' run-a ',
    sessionId: ' session-a ',
    turnId: ' turn-a ',
  })));
  assert.deepEqual(retries, [promoted, promoted, promoted, promoted]);
  await assert.rejects(
    store.promote(transient.id, {
      runId: 'run-a',
      sessionId: 'session-a',
      turnId: 'turn-b',
    }),
    (error) => error.code === 'RESOURCE_PROMOTION_CONFLICT' && error.status === 409,
  );
  assert.deepEqual(await store.inspectUsage(), {
    resources: 1,
    bytes: bytes.length,
    byClass: { 'session-durable': 1 },
    byState: { promoted: 1 },
  });
});

test('FilesystemResourceStore plans expired transient collection without selecting promoted output', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let sequence = 0;
  const store = new FilesystemResourceStore({
    root,
    now: () => new Date('2026-09-01T00:00:00.000Z'),
    uuid: () => `transient-${String(++sequence).padStart(4, '0')}`,
  });
  const display = { name: 'output.png', mimeType: 'image/png', size: 3 };
  const expired = await store.stageTransient({
    owner: { runId: 'run-a' },
    display,
    bytes: Buffer.from('one'),
    originType: 'browser',
  });
  const durable = await store.stageTransient({
    owner: { sessionId: 'session-a', runId: 'run-a' },
    display,
    bytes: Buffer.from('two'),
    originType: 'browser',
  });
  await store.promote(durable.id, {
    runId: 'run-a',
    sessionId: 'session-a',
    kind: 'visualization',
  });

  const plan = await store.planCollection({
    transientMaxAgeMs: 1,
    now: new Date('2026-09-01T00:00:00.002Z'),
  });
  assert.deepEqual(plan.resources, [{
    id: expired.id,
    sessionId: null,
    bytes: 3,
    class: 'transient',
    state: 'ready',
    ageMs: 2,
    reason: 'transient-expired',
  }]);
  assert.equal((await store.get(expired.id)).lifecycle.state, 'ready');
  assert.equal((await store.get(durable.id, { sessionId: 'session-a' })).lifecycle.state, 'promoted');
});

test('FilesystemResourceStore refuses promotion when managed transient content changed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FilesystemResourceStore({
    root,
    uuid: () => 'transient-0001',
  });
  const transient = await store.stageTransient({
    owner: { sessionId: 'session-a' },
    display: { name: 'result.txt', mimeType: 'text/plain', size: 4 },
    bytes: Buffer.from('safe'),
  });
  const opened = await store.open(transient.id);
  await writeFile(opened.path, 'risk');

  await assert.rejects(
    store.promote(transient.id, { sessionId: 'session-a' }),
    (error) => error.code === 'RESOURCE_CONTENT_INVALID' && error.status === 409,
  );
  assert.equal((await store.get(transient.id)).lifecycle.state, 'ready');
});

test('FilesystemResourceStore never removes an existing blob when an id collision is rejected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-resources-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new FilesystemResourceStore({
    root,
    uuid: () => 'collision-0001',
  });
  const first = await store.stage({
    owner: { sessionId: 'session-a' },
    display: { name: 'first.txt', mimeType: 'text/plain', size: 5 },
    bytes: Buffer.from('first'),
  });
  await assert.rejects(store.stage({
    owner: { sessionId: 'session-a' },
    display: { name: 'second.txt', mimeType: 'text/plain', size: 6 },
    bytes: Buffer.from('second'),
  }), (error) => error.code === 'EEXIST');
  assert.equal((await store.read(first.id, { sessionId: 'session-a' })).bytes.toString(), 'first');
});

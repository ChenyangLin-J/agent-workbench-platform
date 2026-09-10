import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FilesystemResourceStore } from '../src/filesystem-resource-store.js';
import { MinimalHostResultFileProjector } from '../src/environment/result-file-projector.js';

test('result file projector publishes only file-change candidates explicitly referenced by the final answer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-result-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const store = new FilesystemResourceStore({ root: join(root, 'resources') });
  await writeFile(join(workspace, 'report.sql'), 'select 1');
  await writeFile(join(workspace, 'notes.txt'), 'not published');
  const projector = new MinimalHostResultFileProjector({
    resourceStore: store,
    runId: 'run-a',
    workspaceRoot: workspace,
  });
  const common = { sessionId: 'session-a', runtimeTurnId: 'turn-a', type: 'item_completed' };
  await projector.projectEvent({ ...common, payload: { item: {
    id: 'files-a',
    type: 'fileChange',
    changes: [
      { path: join(workspace, 'report.sql'), kind: { type: 'update' } },
      { path: join(workspace, 'notes.txt'), kind: { type: 'add' } },
    ],
  } } });
  const projected = await projector.projectEvent({ ...common, payload: { item: {
    id: 'answer-a',
    type: 'agentMessage',
    status: 'completed',
    text: '已生成 [SQL](report.sql)。',
  } } });
  assert.equal(projected.payload.item.publishedArtifacts.length, 1);
  const attachment = projected.payload.item.publishedArtifacts[0];
  assert.equal(attachment.name, 'report.sql');
  assert.equal(attachment.resource.kind, 'session-artifact');
  assert.equal(attachment.resource.lifecycle.state, 'promoted');
  assert.equal((await store.read(attachment.id, { sessionId: 'session-a' })).bytes.toString(), 'select 1');
  assert.deepEqual((await store.list({ sessionId: 'session-a' })).map((resource) => resource.display.name), ['report.sql']);
});

test('result file projector does not publish a path that is only a prefix of a final reference', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-result-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'report.sql'), 'select 1');
  const store = new FilesystemResourceStore({ root: join(root, 'resources') });
  await store.ready;
  const projector = new MinimalHostResultFileProjector({
    resourceStore: store,
    runId: 'run-a',
    workspaceRoot: workspace,
  });
  const common = { sessionId: 'session-a', runtimeTurnId: 'turn-a', type: 'item_completed' };
  await projector.projectEvent({ ...common, payload: { item: {
    id: 'files-a', type: 'fileChange', changes: [{ path: 'report.sql' }],
  } } });
  const projected = await projector.projectEvent({ ...common, payload: { item: {
    id: 'answer-a', type: 'agentMessage', status: 'completed', text: '请查看 report.sql.backup。',
  } } });
  assert.equal(projected.payload.item.publishedArtifacts, undefined);
});

test('result file projector supports empty results and reports missing referenced candidates without losing successes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-result-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const store = new FilesystemResourceStore({ root: join(root, 'resources') });
  await writeFile(join(workspace, 'empty.csv'), '');
  const projector = new MinimalHostResultFileProjector({ resourceStore: store, runId: 'run-a', workspaceRoot: workspace });
  const common = { sessionId: 'session-a', runtimeTurnId: 'turn-a', type: 'item_completed' };
  await projector.projectEvent({ ...common, payload: { item: {
    id: 'files-a', type: 'fileChange', changes: [{ path: 'empty.csv' }, { path: 'missing.md' }],
  } } });
  const projected = await projector.projectEvent({ ...common, payload: { item: {
    id: 'answer-a', type: 'agentMessage', status: 'completed', text: '结果：[CSV](empty.csv)；[说明](missing.md)',
  } } });
  assert.equal(projected.payload.item.publishedArtifacts[0].name, 'empty.csv');
  assert.deepEqual(projected.payload.item.artifactPublicationErrors, [{ name: 'missing.md', code: 'RESULT_FILE_NOT_FOUND' }]);
});

test('result file projector denies a symlink that escapes the authorized workspace', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-result-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'private');
  await symlink(outside, join(workspace, 'escape.txt'));
  const store = new FilesystemResourceStore({ root: join(root, 'resources') });
  await store.ready;
  const projector = new MinimalHostResultFileProjector({
    resourceStore: store,
    runId: 'run-a',
    workspaceRoot: workspace,
  });
  const common = { sessionId: 'session-a', runtimeTurnId: 'turn-a', type: 'item_completed' };
  await projector.projectEvent({ ...common, payload: { item: {
    id: 'files-a', type: 'fileChange', changes: [{ path: 'escape.txt' }],
  } } });
  const projected = await projector.projectEvent({ ...common, payload: { item: {
    id: 'answer-a', type: 'agentMessage', status: 'completed', text: '[file](escape.txt)',
  } } });
  assert.equal(projected.payload.item.publishedArtifacts, undefined);
  assert.deepEqual(projected.payload.item.artifactPublicationErrors, [{
    name: 'escape.txt', code: 'RESULT_FILE_PATH_UNAUTHORIZED',
  }]);
});

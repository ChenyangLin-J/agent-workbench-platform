import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  EnvironmentSessionStore,
  createEnvironment,
  createEnvironmentRun,
  migrateRunSessionPersistence,
} from '../src/environment/index.js';
import { FilesystemResourceStore } from '../src/filesystem-resource-store.js';
import { resourceDescriptorAttachment } from '../src/resources.js';

test('Session persistence migration copies durable transcripts and resources but not Runtime bindings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-session-migration-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = await createEnvironment({
    storageRoot: join(root, 'environments'),
    environmentId: 'migration-environment',
    profile: { id: 'migration-profile' },
  });
  const run = await createEnvironmentRun(environment.paths.root, { runId: 'source-run' });
  const sourceSessions = new EnvironmentSessionStore({ stateRoot: run.paths.state, runId: run.id });
  const session = await sourceSessions.create({ title: '需要迁移的 Session' });
  const sourceResources = new FilesystemResourceStore({ root: run.paths.resources });
  const content = 'MIGRATION_CANARY_OK';
  const staged = await sourceResources.stage({
    owner: { sessionId: session.sessionId },
    display: { name: 'evidence.txt', mimeType: 'text/plain', size: Buffer.byteLength(content) },
    bytes: Buffer.from(content),
  });
  const resource = await sourceResources.commit(staged.id, {
    sessionId: session.sessionId,
    turnId: 'turn-source',
  });
  await sourceSessions.recordUserInput(session.sessionId, '保留附件', {
    attachments: [resourceDescriptorAttachment(resource)],
    turnId: 'turn-source',
  });
  await sourceSessions.save(session.sessionId, {
    runtimeSessionId: 'runtime-source',
    activeTurnId: 'turn-source',
    status: 'running',
  });

  const destinationRoot = join(root, 'portable-sessions');
  const report = await migrateRunSessionPersistence(run.paths.root, { destinationRoot });
  const canonicalDestinationRoot = await realpath(destinationRoot);
  assert.deepEqual(report, {
    sourceRunId: 'source-run',
    destinationRoot: canonicalDestinationRoot,
    sessions: 1,
    resources: 1,
    bytes: Buffer.byteLength(content),
    sourceRetained: true,
    runtimeBindingsMigrated: false,
  });
  const migratedManifest = JSON.parse(await readFile(join(destinationRoot, 'state', 'manifest.json'), 'utf8'));
  assert.equal(migratedManifest.schema, 'agent-workbench.session-store/v2');
  const migratedRuntime = JSON.parse(await readFile(join(destinationRoot, 'state', 'session-runtime.json'), 'utf8'));
  assert.deepEqual(migratedRuntime.bindings, {});
  assert.deepEqual(migratedRuntime.queuedTurns, {});
  const migratedSessions = new EnvironmentSessionStore({ stateRoot: join(destinationRoot, 'state') });
  const migratedSession = await migratedSessions.get(session.sessionId);
  assert.equal(migratedSession.createdRunId, 'source-run');
  assert.equal(migratedSession.status, 'idle');
  assert.equal(migratedSession.messages[0].content, '保留附件');
  const migratedResources = new FilesystemResourceStore({ root: join(destinationRoot, 'resources') });
  const opened = await migratedResources.open(resource.id, { sessionId: session.sessionId });
  assert.equal(await readFile(opened.path, 'utf8'), content);
  assert.equal((await sourceSessions.load(session.sessionId)).runtimeSessionId, 'runtime-source');
  await assert.rejects(
    () => migrateRunSessionPersistence(run.paths.root, { destinationRoot }),
    { code: 'SESSION_PERSISTENCE_DESTINATION_EXISTS' },
  );
  const alreadyPortable = await createEnvironmentRun(environment.paths.root, {
    runId: 'already-portable-run',
    sessionPersistenceRoot: join(root, 'already-portable-data'),
  });
  await assert.rejects(
    () => migrateRunSessionPersistence(alreadyPortable.paths.root, {
      destinationRoot: join(root, 'should-not-be-created'),
    }),
    { code: 'SESSION_PERSISTENCE_SOURCE_ALREADY_PORTABLE' },
  );
});

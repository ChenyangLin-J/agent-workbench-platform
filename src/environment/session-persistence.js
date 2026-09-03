import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { FilesystemResourceStore } from '../filesystem-resource-store.js';
import { isPathContained } from './paths.js';
import { readEnvironmentManifest } from './store.js';

export async function migrateRunSessionPersistence(runTarget, {
  destinationRoot,
  uuid = randomUUID,
} = {}) {
  const manifest = await readEnvironmentManifest(runTarget);
  if (manifest.kind !== 'run') throw new TypeError('Session persistence migration requires a Run target');
  if (manifest.paths.sessionState || manifest.paths.sessionResources) {
    throw migrationError(
      'SESSION_PERSISTENCE_SOURCE_ALREADY_PORTABLE',
      'The source Run already uses portable Session persistence.',
    );
  }
  if (manifest.status === 'running') {
    throw migrationError('SESSION_PERSISTENCE_SOURCE_ACTIVE', 'Stop the source Run before migrating Session persistence.');
  }
  const destination = await safeDestinationRoot(destinationRoot);
  const environmentRoot = dirname(dirname(manifest.paths.root));
  if (isPathContained(environmentRoot, destination)) {
    throw migrationError(
      'SESSION_PERSISTENCE_ROOT_UNSAFE',
      'Session persistence destination must be outside the Environment tree.',
    );
  }
  await assertMissing(destination);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(destination), `.${basename(destination)}.migrating-${uuid()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    const sourceDocument = await readLegacySessionDocument(join(manifest.paths.state, 'sessions.json'));
    const sessions = structuredClone(sourceDocument.sessions);
    for (const session of Object.values(sessions)) {
      session.createdRunId ||= manifest.id;
      if (['running', 'waiting', 'connecting'].includes(session.status)) session.status = 'idle';
    }
    const stateRoot = join(temporary, 'state');
    const resourcesRoot = join(temporary, 'resources');
    await mkdir(stateRoot, { mode: 0o700 });
    await writeJsonExclusive(join(stateRoot, 'sessions.json'), {
      version: sourceDocument.version,
      sessions,
      bindings: {},
      queuedTurns: {},
    });
    if (await exists(manifest.paths.resources)) {
      await cp(manifest.paths.resources, resourcesRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
    } else {
      await mkdir(resourcesRoot, { mode: 0o700 });
    }
    await verifyRegularResourceTree(resourcesRoot);
    const resourceReport = await verifyMigratedResources(resourcesRoot, sessions);
    await rename(temporary, destination);
    return {
      sourceRunId: manifest.id,
      destinationRoot: destination,
      sessions: Object.keys(sessions).length,
      resources: resourceReport.resources,
      bytes: resourceReport.bytes,
      sourceRetained: true,
      runtimeBindingsMigrated: false,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function readLegacySessionDocument(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw migrationError('SESSION_PERSISTENCE_SOURCE_INVALID', 'Source Run Session store must be a regular file.');
    }
    const document = JSON.parse(await readFile(path, 'utf8'));
    if (document?.version !== 1 || !plainObject(document.sessions) || !plainObject(document.bindings)) {
      throw migrationError('SESSION_PERSISTENCE_SOURCE_INVALID', 'Source Run Session store is invalid.');
    }
    return document;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, sessions: {}, bindings: {}, queuedTurns: {} };
    if (error instanceof SyntaxError) {
      throw migrationError('SESSION_PERSISTENCE_SOURCE_INVALID', 'Source Run Session store is invalid JSON.');
    }
    throw error;
  }
}

async function verifyRegularResourceTree(root) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw migrationError('SESSION_PERSISTENCE_RESOURCE_INVALID', 'Session resources contain an unsupported filesystem entry.');
    }
    if (entry.isDirectory()) await verifyRegularResourceTree(path);
  }
}

async function verifyMigratedResources(root, sessions) {
  const store = new FilesystemResourceStore({ root });
  const resources = await store.list();
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  for (const session of Object.values(sessions)) {
    for (const message of session.messages || []) {
      for (const attachment of message.attachments || []) {
        const resourceId = attachment?.resource?.id || (/^res_/.test(String(attachment?.id || '')) ? attachment.id : null);
        if (resourceId && !byId.has(resourceId)) {
          throw migrationError(
            'SESSION_PERSISTENCE_RESOURCE_MISSING',
            `Committed Session resource is missing: ${resourceId}`,
          );
        }
      }
    }
  }
  let bytes = 0;
  for (const resource of resources) {
    if (resource.mode !== 'managed') continue;
    const opened = await store.open(resource.id);
    const content = await readFile(opened.path);
    const expectedDigest = resource.integrity?.algorithm === 'sha256' ? resource.integrity.digest : null;
    if (expectedDigest && createHash('sha256').update(content).digest('hex') !== expectedDigest) {
      throw migrationError('SESSION_PERSISTENCE_RESOURCE_INVALID', `Session resource integrity check failed: ${resource.id}`);
    }
    bytes += content.length;
  }
  return { resources: resources.length, bytes };
}

async function safeDestinationRoot(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('destinationRoot is required');
  const requested = resolve(value);
  if (requested === resolve('/')) {
    throw migrationError('SESSION_PERSISTENCE_ROOT_UNSAFE', 'Session persistence root cannot be the filesystem root.');
  }
  await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
  const canonicalParent = await realpath(dirname(requested));
  return join(canonicalParent, basename(requested));
}

async function assertMissing(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw migrationError('SESSION_PERSISTENCE_DESTINATION_EXISTS', 'Session persistence destination must not already exist.');
}

async function exists(path) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw migrationError('SESSION_PERSISTENCE_RESOURCE_INVALID', 'Source Run resources must be a regular directory.');
    }
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeJsonExclusive(path, value) {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function migrationError(code, message) {
  return Object.assign(new Error(message), { code });
}

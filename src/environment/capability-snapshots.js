import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

const BLOCKED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', '__pycache__']);
const BLOCKED_FILE_NAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'auth.json',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'service-account.json',
  'service_account.json',
]);
const BLOCKED_FILE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx'];
const PRIVATE_KEY_MATERIAL = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const MAX_SNAPSHOT_FILES = 2_000;
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024;

export async function stageCapabilitySnapshots({ profile, targetRoot } = {}) {
  if (typeof targetRoot !== 'string' || !targetRoot.trim()) throw new TypeError('capability snapshot targetRoot is required');
  const lockEntries = profile?.capabilities?.lock?.capabilities || [];
  const sources = new Map((profile?.capabilities?.sources || []).map((source) => [source.id, source]));
  if (!lockEntries.length) {
    await mkdir(resolve(targetRoot), { recursive: true, mode: 0o700 });
    return [];
  }
  await mkdir(resolve(targetRoot), { recursive: true, mode: 0o700 });
  const snapshots = [];
  for (const entry of lockEntries) {
    if (entry.kind !== 'skill-source') {
      throw snapshotError('CAPABILITY_SNAPSHOT_KIND_UNSUPPORTED', `Environment snapshot staging does not support ${entry.kind}: ${entry.id}.`);
    }
    const source = sources.get(entry.id);
    if (!source) throw snapshotError('CAPABILITY_SNAPSHOT_SOURCE_MISSING', `Capability snapshot source is missing: ${entry.id}.`);
    const directory = createHash('sha256').update(entry.id).digest('hex').slice(0, 24);
    const result = await snapshotDirectory(source.path, join(resolve(targetRoot), directory));
    snapshots.push({
      id: entry.id,
      name: result.skillName,
      kind: entry.kind,
      scope: entry.scope,
      version: entry.version,
      directory,
      files: result.files,
      bytes: result.bytes,
      sha256: result.sha256,
    });
  }
  return snapshots;
}

export async function copyCapabilitySnapshots({ sourceRoot, targetRoot, snapshots = [] } = {}) {
  if (!Array.isArray(snapshots)) throw snapshotError('CAPABILITY_SNAPSHOT_METADATA_INVALID', 'Capability snapshots must be an array.');
  await mkdir(resolve(targetRoot), { recursive: true, mode: 0o700 });
  if (!snapshots.length) return [];
  const canonicalSourceRoot = await canonicalSnapshotRoot(sourceRoot);
  for (const snapshot of snapshots) {
    validateSnapshotMetadata(snapshot);
    const source = join(canonicalSourceRoot, snapshot.directory);
    const target = join(resolve(targetRoot), snapshot.directory);
    const result = await snapshotDirectory(source, target);
    if (result.sha256 !== snapshot.sha256 || result.files !== snapshot.files || result.bytes !== snapshot.bytes
      || result.skillName !== snapshot.name) {
      throw snapshotError('CAPABILITY_SNAPSHOT_HASH_MISMATCH', `Capability snapshot changed after Environment creation: ${snapshot.id}.`);
    }
  }
  return structuredClone(snapshots);
}

export async function verifyCapabilitySnapshots({ sourceRoot, snapshots = [] } = {}) {
  if (!Array.isArray(snapshots)) throw snapshotError('CAPABILITY_SNAPSHOT_METADATA_INVALID', 'Capability snapshots must be an array.');
  if (typeof sourceRoot !== 'string' || !sourceRoot.trim()) {
    throw snapshotError('CAPABILITY_SNAPSHOT_ROOT_REQUIRED', 'Capability snapshot root is required.');
  }
  const canonicalSourceRoot = await canonicalSnapshotRoot(sourceRoot);
  for (const snapshot of snapshots) {
    validateSnapshotMetadata(snapshot);
    const source = join(canonicalSourceRoot, snapshot.directory);
    const sourceInfo = await lstat(source).catch((error) => {
      throw snapshotError('CAPABILITY_SNAPSHOT_SOURCE_UNAVAILABLE', `Capability snapshot is unavailable (${error.code || 'error'}).`);
    });
    if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
      throw snapshotError('CAPABILITY_SNAPSHOT_SOURCE_UNSAFE', 'Capability snapshot must be a directory and not a symlink.');
    }
    const result = await summarizeDirectory(source);
    if (result.sha256 !== snapshot.sha256 || result.files !== snapshot.files || result.bytes !== snapshot.bytes
      || result.skillName !== snapshot.name) {
      throw snapshotError('CAPABILITY_SNAPSHOT_HASH_MISMATCH', `Capability snapshot no longer matches its manifest: ${snapshot.id}.`);
    }
  }
  return true;
}

async function canonicalSnapshotRoot(sourceRoot) {
  if (typeof sourceRoot !== 'string' || !sourceRoot.trim()) {
    throw snapshotError('CAPABILITY_SNAPSHOT_ROOT_REQUIRED', 'Capability snapshot root is required.');
  }
  const requested = resolve(sourceRoot);
  const [info, canonical] = await Promise.all([
    lstat(requested).catch((error) => {
      throw snapshotError('CAPABILITY_SNAPSHOT_SOURCE_UNAVAILABLE', `Capability snapshot root is unavailable (${error.code || 'error'}).`);
    }),
    realpath(requested).catch((error) => {
      throw snapshotError('CAPABILITY_SNAPSHOT_SOURCE_UNAVAILABLE', `Capability snapshot root is unavailable (${error.code || 'error'}).`);
    }),
  ]);
  if (!info.isDirectory() || info.isSymbolicLink() || canonical !== requested) {
    throw snapshotError('CAPABILITY_SNAPSHOT_SOURCE_UNSAFE', 'Capability snapshot root must be a canonical directory and not a symlink.');
  }
  return canonical;
}

export function capabilitySnapshotsReady(profile = {}, snapshots = []) {
  const entries = profile.capabilities?.lock?.capabilities || [];
  if (!entries.length) return Array.isArray(snapshots) && snapshots.length === 0;
  if (!Array.isArray(snapshots) || snapshots.length !== entries.length) return false;
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  if (byId.size !== snapshots.length) return false;
  return entries.every((entry) => {
    const snapshot = byId.get(entry.id);
    return entry.kind === 'skill-source'
      && snapshot?.kind === entry.kind
      && snapshot.scope === entry.scope
      && snapshot.version === entry.version
      && validSkillName(snapshot.name)
      && /^[a-f0-9]{24}$/.test(snapshot.directory || '')
      && typeof snapshot.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(snapshot.sha256)
      && Number.isSafeInteger(snapshot.files)
      && snapshot.files >= 1
      && Number.isSafeInteger(snapshot.bytes)
      && snapshot.bytes >= 0;
  });
}

async function snapshotDirectory(sourcePath, targetPath) {
  const sourceInfo = await lstat(sourcePath).catch((error) => {
    throw snapshotError('CAPABILITY_SNAPSHOT_SOURCE_UNAVAILABLE', `Capability snapshot source is unavailable (${error.code || 'error'}).`);
  });
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw snapshotError('CAPABILITY_SNAPSHOT_SOURCE_UNSAFE', 'Capability snapshot source must be a directory and not a symlink.');
  }
  const canonicalSource = await realpath(sourcePath);
  if (!(await stat(join(canonicalSource, 'SKILL.md')).catch(() => null))?.isFile()) {
    throw snapshotError('CAPABILITY_SNAPSHOT_MANIFEST_MISSING', 'Skill capability snapshot requires SKILL.md.');
  }
  const inventory = await inventoryDirectory(canonicalSource);
  await mkdir(targetPath, { recursive: false, mode: 0o700 });
  for (const item of inventory) {
    const target = join(targetPath, ...item.relative.split('/'));
    if (item.kind === 'directory') {
      await mkdir(target, { mode: 0o700 });
      continue;
    }
    await mkdir(resolve(target, '..'), { recursive: true, mode: 0o700 });
    await copyFile(item.path, target);
    await chmod(target, 0o600);
  }
  return summarizeDirectory(targetPath);
}

async function summarizeDirectory(root) {
  const inventory = await inventoryDirectory(root);
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  for (const item of inventory) {
    hash.update(item.kind).update('\0').update(item.relative).update('\0');
    if (item.kind === 'file') {
      const content = await readFile(item.path);
      if (PRIVATE_KEY_MATERIAL.test(content.toString('utf8'))) {
        throw snapshotError('CAPABILITY_SNAPSHOT_SECRET_FILE', `Capability snapshot contains private key material: ${item.relative}.`);
      }
      files += 1;
      bytes += content.byteLength;
      hash.update(content);
    }
    hash.update('\0');
  }
  return {
    files,
    bytes,
    sha256: hash.digest('hex'),
    skillName: await readSkillName(join(root, 'SKILL.md')),
  };
}

async function inventoryDirectory(root) {
  const inventory = [];
  let files = 0;
  let bytes = 0;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = relative(root, path).split(sep).join('/');
      if (entry.isSymbolicLink()) throw snapshotError('CAPABILITY_SNAPSHOT_SYMLINK', `Capability snapshot contains a symlink: ${relativePath}.`);
      if (entry.isDirectory()) {
        if (BLOCKED_DIRECTORY_NAMES.has(entry.name)) throw snapshotError('CAPABILITY_SNAPSHOT_BLOCKED_PATH', `Capability snapshot contains a blocked directory: ${relativePath}.`);
        inventory.push({ kind: 'directory', path, relative: relativePath });
        await visit(path);
        continue;
      }
      if (!entry.isFile()) throw snapshotError('CAPABILITY_SNAPSHOT_FILE_UNSUPPORTED', `Capability snapshot contains an unsupported file: ${relativePath}.`);
      if (blockedFile(entry.name)) throw snapshotError('CAPABILITY_SNAPSHOT_SECRET_FILE', `Capability snapshot contains a blocked secret file: ${relativePath}.`);
      const info = await stat(path);
      files += 1;
      bytes += info.size;
      if (files > MAX_SNAPSHOT_FILES || bytes > MAX_SNAPSHOT_BYTES) {
        throw snapshotError('CAPABILITY_SNAPSHOT_TOO_LARGE', `Capability snapshot exceeds ${MAX_SNAPSHOT_FILES} files or ${MAX_SNAPSHOT_BYTES} bytes.`);
      }
      inventory.push({ kind: 'file', path, relative: relativePath });
    }
  }
  await visit(root);
  return inventory;
}

function blockedFile(name) {
  const lower = basename(name).toLowerCase();
  return BLOCKED_FILE_NAMES.has(lower)
    || lower.startsWith('.env.')
    || BLOCKED_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function validateSnapshotMetadata(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !/^[a-f0-9]{24}$/.test(snapshot.directory || '')
    || !/^[a-f0-9]{64}$/.test(snapshot.sha256 || '')
    || typeof snapshot.id !== 'string' || !snapshot.id
    || !validSkillName(snapshot.name)
    || !Number.isSafeInteger(snapshot.files) || snapshot.files < 1
    || !Number.isSafeInteger(snapshot.bytes) || snapshot.bytes < 0) {
    throw snapshotError('CAPABILITY_SNAPSHOT_METADATA_INVALID', 'Capability snapshot metadata is invalid.');
  }
}

async function readSkillName(path) {
  const source = await readFile(path, 'utf8');
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] || '';
  const value = frontmatter.match(/^name:\s*([^\r\n]+?)\s*$/m)?.[1] || '';
  const name = value.replace(/^(?:"([^"]+)"|'([^']+)')$/, '$1$2').trim();
  if (!validSkillName(name)) {
    throw snapshotError('CAPABILITY_SNAPSHOT_MANIFEST_INVALID', 'Skill capability snapshot requires a valid frontmatter name.');
  }
  return name;
}

function validSkillName(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,127}$/.test(value);
}

function snapshotError(code, message) {
  return Object.assign(new Error(message), { code });
}

import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export async function resolveContainedPath(root, candidate, { allowMissing = false } = {}) {
  const rootPath = await realpath(resolve(root));
  const candidatePath = resolveCandidate(rootPath, candidate);
  assertLexicallyContained(rootPath, candidatePath);
  let cursor = candidatePath;
  while (true) {
    try {
      const info = await lstat(cursor);
      const resolvedCursor = info.isSymbolicLink() ? await realpath(cursor) : await realpath(cursor);
      assertLexicallyContained(rootPath, resolvedCursor);
      if (cursor === candidatePath) return resolvedCursor;
      if (!allowMissing) throw pathError('ENVIRONMENT_PATH_NOT_FOUND', `Path does not exist: ${candidatePath}`);
      return candidatePath;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (cursor === rootPath) throw error;
      cursor = dirname(cursor);
    }
  }
}

export function isPathContained(root, candidate) {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === '' || (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation));
}

function resolveCandidate(root, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new TypeError('candidate path is required');
  return isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
}

function assertLexicallyContained(root, candidate) {
  if (!isPathContained(root, candidate)) {
    throw pathError('ENVIRONMENT_PATH_ESCAPE', `Path escapes environment root: ${candidate}`, { root, candidate });
  }
}

function pathError(code, message, details = undefined) {
  return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) });
}

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const CODEX_NATIVE_CREDENTIAL_REFERENCE = 'credentials.codex-native';
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';

const DEFAULT_MINIMUM_TTL_MS = 5 * 60_000;

export function codexModelBrokerRequest(profile = {}) {
  const credentialReferences = profile.isolation?.credentialReferences || [];
  const networkTargets = profile.isolation?.networkTargets || [];
  if (!credentialReferences.length && !networkTargets.length) {
    return { requested: false, supported: true, credentialReference: null, target: null, reasons: [] };
  }
  const reasons = [];
  if (profile.runtime?.provider !== 'codex' || !profile.runtime?.model) {
    reasons.push('The built-in model broker requires runtime.provider=codex and an explicit runtime.model.');
  }
  if (credentialReferences.length !== 1 || credentialReferences[0] !== CODEX_NATIVE_CREDENTIAL_REFERENCE) {
    reasons.push(`The built-in model broker requires only ${CODEX_NATIVE_CREDENTIAL_REFERENCE}.`);
  }
  if (networkTargets.length !== 1 || normalizeTarget(networkTargets[0]) !== CHATGPT_CODEX_BASE_URL) {
    reasons.push(`The built-in model broker requires only ${CHATGPT_CODEX_BASE_URL}.`);
  }
  return {
    requested: true,
    supported: reasons.length === 0,
    credentialReference: credentialReferences[0] || null,
    target: networkTargets[0] ? normalizeTarget(networkTargets[0]) : null,
    reasons,
  };
}

export function createCodexNativeCredentialBroker({
  codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'),
  now = () => new Date(),
  minimumTtlMs = DEFAULT_MINIMUM_TTL_MS,
} = {}) {
  const sourcePath = join(resolve(codexHome), 'auth.json');
  return Object.freeze({
    id: 'codex-native-chatgpt',
    async inspect({ profile } = {}) {
      const request = codexModelBrokerRequest(profile);
      if (!request.requested) return { ready: true, requested: false };
      if (!request.supported) return { ready: false, requested: true, reason: request.reasons.join(' ') };
      try {
        const credential = await readChatGptCredential(sourcePath, { now, minimumTtlMs });
        return {
          ready: true,
          requested: true,
          credentialReference: request.credentialReference,
          target: request.target,
          expiresAt: credential.expiresAt,
        };
      } catch (error) {
        return {
          ready: false,
          requested: true,
          reason: `Codex credential broker is unavailable: ${safeCredentialError(error)}.`,
        };
      }
    },
    async stage({ profile, directory } = {}) {
      const request = codexModelBrokerRequest(profile);
      if (!request.requested || !request.supported) {
        throw credentialError('CODEX_CREDENTIAL_PROFILE_UNSUPPORTED', request.reasons.join(' ') || 'Codex credential broker was not requested.');
      }
      if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('credential broker directory is required');
      const credential = await readChatGptCredential(sourcePath, { now, minimumTtlMs });
      const targetDirectory = resolve(directory);
      const temporaryDirectory = `${targetDirectory}.staging-${randomUUID()}`;
      await mkdir(dirname(targetDirectory), { recursive: true, mode: 0o700 });
      await mkdir(temporaryDirectory, { mode: 0o700 });
      try {
        await writeFile(join(temporaryDirectory, 'model.json'), `${JSON.stringify({
          schemaVersion: 1,
          kind: 'chatgpt-access-token',
          target: request.target,
          accessToken: credential.accessToken,
          accountId: credential.accountId,
          expiresAt: credential.expiresAt,
        }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporaryDirectory, targetDirectory);
      } catch (error) {
        await rm(temporaryDirectory, { recursive: true, force: true });
        throw error;
      }
      return {
        directory: targetDirectory,
        credentialReference: request.credentialReference,
        target: request.target,
        expiresAt: credential.expiresAt,
      };
    },
  });
}

export async function readStagedCodexCredential(path, { now = () => new Date() } = {}) {
  const credentialPath = resolve(path);
  const [info, canonical] = await Promise.all([lstat(credentialPath), realpath(credentialPath)]);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw credentialError('CODEX_CREDENTIAL_STAGED_UNSAFE', 'Staged Codex credential must be a private regular file and not a symlink.');
  }
  const document = JSON.parse(await readFile(canonical, 'utf8'));
  if (document?.schemaVersion !== 1 || document.kind !== 'chatgpt-access-token') {
    throw credentialError('CODEX_CREDENTIAL_INVALID', 'Staged Codex credential has an unsupported schema.');
  }
  const target = normalizeTarget(document.target);
  if (target !== CHATGPT_CODEX_BASE_URL) {
    throw credentialError('CODEX_CREDENTIAL_TARGET_INVALID', 'Staged Codex credential target is not allowed.');
  }
  const accessToken = nonEmptyString(document.accessToken, 'staged Codex access token');
  const accountId = nonEmptyString(document.accountId, 'staged Codex account id');
  const expiresAt = validExpiry(document.expiresAt, now(), 0);
  return { target, accessToken, accountId, expiresAt };
}

async function readChatGptCredential(sourcePath, { now, minimumTtlMs }) {
  const [info, canonical] = await Promise.all([lstat(sourcePath), realpath(sourcePath)]);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw credentialError('CODEX_CREDENTIAL_SOURCE_UNSAFE', 'auth.json must be a regular file and not a symlink.');
  }
  if ((info.mode & 0o077) !== 0) {
    throw credentialError('CODEX_CREDENTIAL_SOURCE_PERMISSIONS', 'auth.json must not be readable by group or other users.');
  }
  let document;
  try {
    document = JSON.parse(await readFile(canonical, 'utf8'));
  } catch (error) {
    throw credentialError('CODEX_CREDENTIAL_SOURCE_INVALID', `auth.json is not readable JSON (${error.code || 'invalid'}).`);
  }
  if (document.auth_mode === 'apiKey' || document.OPENAI_API_KEY) {
    throw credentialError('CODEX_CREDENTIAL_NOT_SHORT_LIVED', 'long-lived API keys are not accepted by the strong-isolation broker.');
  }
  const accessToken = nonEmptyString(document.tokens?.access_token, 'Codex ChatGPT access token');
  const claims = jwtClaims(accessToken);
  const accountId = document.tokens?.account_id
    || claims['https://api.openai.com/auth']?.chatgpt_account_id
    || claims.chatgpt_account_id;
  const expiresAt = validExpiry(claims.exp, now(), minimumTtlMs, { seconds: true });
  return {
    accessToken,
    accountId: nonEmptyString(accountId, 'Codex ChatGPT account id'),
    expiresAt,
  };
}

function jwtClaims(token) {
  const parts = token.split('.');
  if (parts.length < 2) throw credentialError('CODEX_CREDENTIAL_TOKEN_INVALID', 'ChatGPT access token is not a JWT.');
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw credentialError('CODEX_CREDENTIAL_TOKEN_INVALID', 'ChatGPT access token claims are invalid.');
  }
}

function validExpiry(value, current, minimumTtlMs, { seconds = false } = {}) {
  const expires = seconds ? new Date(Number(value) * 1_000) : new Date(value);
  if (!Number.isFinite(expires.getTime())) throw credentialError('CODEX_CREDENTIAL_EXPIRY_INVALID', 'ChatGPT access token has no valid expiry.');
  if (expires.getTime() - new Date(current).getTime() < minimumTtlMs) {
    throw credentialError('CODEX_CREDENTIAL_EXPIRING', 'ChatGPT access token expires too soon; refresh Codex login first.');
  }
  return expires.toISOString();
}

function normalizeTarget(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function safeCredentialError(error) {
  if (error?.code === 'ENOENT') return 'Codex auth.json was not found';
  if (String(error?.code || '').startsWith('CODEX_CREDENTIAL_')) return String(error.message);
  return 'credential validation failed';
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw credentialError('CODEX_CREDENTIAL_FIELD_MISSING', `${label} is missing.`);
  return value.trim();
}

function credentialError(code, message) {
  return Object.assign(new Error(message), { code });
}

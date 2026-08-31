import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MODEL_BROKER_ENV_KEY = 'AGENT_WORKBENCH_MODEL_BROKER_TOKEN';

export async function prepareMinimalRuntimeConfiguration({
  manifest,
  brokerTokenPath = process.env.AGENT_WORKBENCH_MODEL_BROKER_TOKEN_FILE || null,
} = {}) {
  const broker = manifest?.runtime?.modelBroker;
  const capabilitySnapshots = manifest?.capabilities?.snapshots || [];
  validateCapabilitySnapshots(
    capabilitySnapshots,
    manifest?.capabilities?.lock?.capabilities || [],
    manifest?.paths?.capabilities,
  );
  if (!broker && !capabilitySnapshots.length) return { environment: {}, configPath: null };
  let serviceToken = null;
  if (broker) {
    validateModelBroker(broker);
    if (typeof manifest.runtime?.model !== 'string' || !manifest.runtime.model.trim()) {
      throw runtimeConfigError('MODEL_BROKER_MODEL_REQUIRED', 'Brokered Codex Runtime requires an explicit model.');
    }
    if (typeof brokerTokenPath !== 'string' || !brokerTokenPath.trim()) {
      throw runtimeConfigError('MODEL_BROKER_TOKEN_FILE_REQUIRED', 'Brokered Codex Runtime requires a service-token file.');
    }
    serviceToken = (await readFile(brokerTokenPath, 'utf8')).trim();
    if (!serviceToken) throw runtimeConfigError('MODEL_BROKER_TOKEN_EMPTY', 'Model broker service-token file is empty.');
  }
  const configPath = join(manifest.paths.runtime, 'codex-home', 'config.toml');
  const temporaryPath = `${configPath}.writing-${randomUUID()}`;
  const config = [
    ...(broker ? [
      'model_provider = "agent-workbench-broker"',
      `model = ${tomlString(manifest.runtime.model)}`,
    ] : []),
    'check_for_update_on_startup = false',
    '',
    ...(broker ? [
      '[model_providers.agent-workbench-broker]',
      'name = "Agent Workbench fixed model broker"',
      `base_url = ${tomlString(broker.baseUrl)}`,
      `env_key = ${tomlString(broker.envKey)}`,
      'wire_api = "responses"',
      'requires_openai_auth = false',
      'supports_websockets = false',
      '',
      '[shell_environment_policy]',
      'inherit = "core"',
      `exclude = [${tomlString(broker.envKey)}]`,
      '',
    ] : []),
    ...capabilitySnapshots.flatMap((snapshot) => [
      '[[skills.config]]',
      `path = ${tomlString(join(manifest.paths.capabilities, snapshot.directory, 'SKILL.md'))}`,
      'enabled = true',
      '',
    ]),
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n');
  await writeFile(temporaryPath, config, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  try {
    await rename(temporaryPath, configPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return {
    configPath,
    environment: broker ? { [broker.envKey]: serviceToken } : {},
  };
}

function validateCapabilitySnapshots(snapshots, lockEntries, capabilityRoot) {
  if (!Array.isArray(snapshots)) {
    throw runtimeConfigError('CAPABILITY_SNAPSHOTS_INVALID', 'Capability snapshots must be an array.');
  }
  if (snapshots.length && (typeof capabilityRoot !== 'string' || !capabilityRoot.trim())) {
    throw runtimeConfigError('CAPABILITY_SNAPSHOT_ROOT_REQUIRED', 'Capability snapshot root is required.');
  }
  const seen = new Set();
  const locked = new Map(lockEntries.map((entry) => [entry.id, entry]));
  if (snapshots.length !== locked.size) {
    throw runtimeConfigError('CAPABILITY_SNAPSHOTS_INVALID', 'Capability snapshots do not match the capability lock.');
  }
  for (const snapshot of snapshots) {
    const entry = locked.get(snapshot?.id);
    if (!snapshot || snapshot.kind !== 'skill-source'
      || typeof snapshot.id !== 'string' || !snapshot.id
      || !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(snapshot.name || '')
      || !/^[a-f0-9]{24}$/.test(snapshot.directory || '')
      || !/^[a-f0-9]{64}$/.test(snapshot.sha256 || '')
      || entry?.kind !== snapshot.kind
      || entry.scope !== snapshot.scope
      || entry.version !== snapshot.version
      || seen.has(snapshot.id)) {
      throw runtimeConfigError('CAPABILITY_SNAPSHOTS_INVALID', 'Capability snapshot metadata is invalid.');
    }
    seen.add(snapshot.id);
  }
}

function validateModelBroker(broker) {
  if (broker.envKey !== MODEL_BROKER_ENV_KEY) {
    throw runtimeConfigError('MODEL_BROKER_ENV_INVALID', 'Model broker environment key is not supported.');
  }
  let url;
  try {
    url = new URL(broker.baseUrl);
  } catch {
    throw runtimeConfigError('MODEL_BROKER_URL_INVALID', 'Model broker URL is invalid.');
  }
  if (url.protocol !== 'http:' || url.port !== '4190' || url.pathname !== '/'
    || !/^awb-[a-f0-9]{16}-model-egress$/.test(url.hostname)) {
    throw runtimeConfigError('MODEL_BROKER_URL_INVALID', 'Model broker URL is outside the fixed Run-local Docker channel.');
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function runtimeConfigError(code, message) {
  return Object.assign(new Error(message), { code });
}

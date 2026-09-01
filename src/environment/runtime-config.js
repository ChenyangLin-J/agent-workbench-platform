import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const MODEL_BROKER_ENV_KEY = 'AGENT_WORKBENCH_MODEL_BROKER_TOKEN';

export async function prepareMinimalRuntimeConfiguration({
  manifest,
  brokerTokenPath = process.env.AGENT_WORKBENCH_MODEL_BROKER_TOKEN_FILE || null,
} = {}) {
  const broker = manifest?.runtime?.modelBroker;
  const dataAdapters = manifest?.runtime?.dataAdapters || [];
  const capabilitySnapshots = manifest?.capabilities?.snapshots || [];
  const skillSnapshots = capabilitySnapshots.filter((snapshot) => snapshot.kind === 'skill-source');
  validateCapabilitySnapshots(
    capabilitySnapshots,
    manifest?.capabilities?.lock?.capabilities || [],
    manifest?.paths?.capabilities,
  );
  validateDataAdapters(dataAdapters, manifest?.paths?.credentials);
  if (!broker && !dataAdapters.length && !capabilitySnapshots.length) return { environment: {}, configPath: null };
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
  const adapterTokens = {};
  for (const adapter of dataAdapters) {
    const token = (await readFile(adapter.tokenFile, 'utf8')).trim();
    if (!token) throw runtimeConfigError('DATA_ADAPTER_TOKEN_EMPTY', `Data adapter service-token file is empty: ${adapter.server}.`);
    adapterTokens[adapter.tokenEnvKey] = token;
  }
  const secretEnvironmentKeys = [
    ...(broker ? [broker.envKey] : []),
    ...dataAdapters.map((adapter) => adapter.tokenEnvKey),
  ];
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
    ] : []),
    ...dataAdapters.flatMap((adapter) => [
      `[mcp_servers.${tomlString(adapter.server)}]`,
      `url = ${tomlString(adapter.url)}`,
      'enabled = true',
      `bearer_token_env_var = ${tomlString(adapter.tokenEnvKey)}`,
      'startup_timeout_sec = 20',
      'tool_timeout_sec = 120',
      `enabled_tools = [${adapter.enabledTools.map(tomlString).join(', ')}]`,
      '',
    ]),
    ...(secretEnvironmentKeys.length ? [
      '[shell_environment_policy]',
      'inherit = "core"',
      `exclude = [${secretEnvironmentKeys.map(tomlString).join(', ')}]`,
      '',
    ] : []),
    ...skillSnapshots.flatMap((snapshot) => [
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
    environment: {
      ...(broker ? { [broker.envKey]: serviceToken } : {}),
      ...adapterTokens,
    },
  };
}

function validateDataAdapters(adapters, credentialRoot) {
  if (!Array.isArray(adapters)) throw runtimeConfigError('DATA_ADAPTERS_INVALID', 'Runtime data adapters must be an array.');
  const servers = new Set();
  const environmentKeys = new Set();
  for (const adapter of adapters) {
    let url;
    try {
      url = new URL(adapter?.url);
    } catch {
      throw runtimeConfigError('DATA_ADAPTER_URL_INVALID', 'Data adapter URL is invalid.');
    }
    if (url.protocol !== 'http:' || url.port !== '4200' || url.pathname !== '/mcp'
      || !/^awb-[a-f0-9]{16}-data-\d+$/.test(url.hostname)) {
      throw runtimeConfigError('DATA_ADAPTER_URL_INVALID', 'Data adapter URL is outside the fixed Run-local Docker channel.');
    }
    if (typeof adapter.server !== 'string' || !/^[a-z][a-z0-9_-]{0,62}$/.test(adapter.server) || servers.has(adapter.server)) {
      throw runtimeConfigError('DATA_ADAPTER_SERVER_INVALID', 'Data adapter server name is invalid or duplicated.');
    }
    if (typeof adapter.tokenEnvKey !== 'string'
      || !/^AGENT_WORKBENCH_DATA_ADAPTER_\d+_TOKEN$/.test(adapter.tokenEnvKey)
      || environmentKeys.has(adapter.tokenEnvKey)) {
      throw runtimeConfigError('DATA_ADAPTER_TOKEN_ENV_INVALID', 'Data adapter token environment key is invalid or duplicated.');
    }
    const relativeTokenFile = typeof credentialRoot === 'string' && typeof adapter.tokenFile === 'string'
      ? relative(join(resolve(credentialRoot), 'data-adapters'), resolve(adapter.tokenFile))
      : '';
    if (!/^[a-f0-9]{2,48}\/service-token$/.test(relativeTokenFile)) {
      throw runtimeConfigError('DATA_ADAPTER_TOKEN_FILE_INVALID', 'Data adapter token file is outside the fixed workload credential mount.');
    }
    if (!Array.isArray(adapter.enabledTools) || !adapter.enabledTools.length
      || adapter.enabledTools.some((tool) => typeof tool !== 'string' || !/^[a-z][a-z0-9_]{1,62}$/.test(tool))) {
      throw runtimeConfigError('DATA_ADAPTER_TOOLS_INVALID', 'Data adapter enabled tool allowlist is invalid.');
    }
    servers.add(adapter.server);
    environmentKeys.add(adapter.tokenEnvKey);
  }
}

function validateCapabilitySnapshots(snapshots, lockEntries, capabilityRoot) {
  if (!Array.isArray(snapshots)) {
    throw runtimeConfigError('CAPABILITY_SNAPSHOTS_INVALID', 'Capability snapshots must be an array.');
  }
  if (snapshots.length && (typeof capabilityRoot !== 'string' || !capabilityRoot.trim())) {
    throw runtimeConfigError('CAPABILITY_SNAPSHOT_ROOT_REQUIRED', 'Capability snapshot root is required.');
  }
  const seen = new Set();
  const locked = new Map(lockEntries
    .filter((entry) => ['skill-source', 'mcp-server'].includes(entry.kind))
    .map((entry) => [entry.id, entry]));
  if (snapshots.length !== locked.size) {
    throw runtimeConfigError('CAPABILITY_SNAPSHOTS_INVALID', 'Capability snapshots do not match the capability lock.');
  }
  for (const snapshot of snapshots) {
    const entry = locked.get(snapshot?.id);
    if (!snapshot || !['skill-source', 'mcp-server'].includes(snapshot.kind)
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

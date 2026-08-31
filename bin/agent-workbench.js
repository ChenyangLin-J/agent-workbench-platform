#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IsolationProviderRegistry,
  createDataAdapterCredentialBroker,
  createDevelopmentIsolationProvider,
  createDockerIsolationProvider,
  createEnvironment,
  createEnvironmentRun,
  inspectEnvironment,
  runDataAdapterServer,
  runFixedIngressProxy,
  runModelEgressBroker,
  launchEnvironmentRun,
  listEnvironmentRuns,
  readEnvironmentBindings,
  readEnvironmentManifest,
  readStoredEnvironmentProfile,
  resolveEnvironmentTarget,
  runDockerSupervisor,
  runInternalMinimalHost,
  stopEnvironmentRun,
} from '../src/environment/index.js';

const CLI_PATH = fileURLToPath(import.meta.url);
const DEFAULT_STORAGE_ROOT = join(homedir(), '.agent-workbench', 'environments');

await main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify({
    error: {
      code: String(error?.code || 'AGENT_WORKBENCH_CLI_ERROR'),
      message: String(error?.message || error),
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
});

async function main(argv) {
  if (argv[0] === '--internal-host') {
    const options = parseOptions(argv.slice(2));
    await runInternalMinimalHost(resolve(argv[1]), {
      port: integerOption(options.port, 'port', 0, 0, 65535),
      bindHost: process.env.AGENT_WORKBENCH_BIND_HOST || '127.0.0.1',
      profilePath: process.env.AGENT_WORKBENCH_PROFILE_PATH || null,
      parentManagesLifecycle: process.env.AGENT_WORKBENCH_PARENT_MANAGES_LIFECYCLE === '1',
      readyFile: process.env.AGENT_WORKBENCH_READY_FILE || null,
      socketPath: process.env.AGENT_WORKBENCH_SOCKET_PATH || null,
    });
    return;
  }
  if (argv[0] === '--internal-docker-supervisor') {
    const options = parseOptions(argv.slice(2));
    await runDockerSupervisor(resolve(argv[1]), {
      requestedPort: integerOption(options.port, 'port', 0, 0, 65535),
    });
    return;
  }
  if (argv[0] === '--internal-ingress-proxy') {
    const options = parseOptions(argv.slice(1));
    await runFixedIngressProxy({
      upstreamHost: requiredOption(options['upstream-host'], '--upstream-host'),
      upstreamPort: integerOption(options['upstream-port'], 'upstream-port', null, 1, 65535),
      port: integerOption(options.port, 'port', null, 1, 65535),
    });
    return;
  }
  if (argv[0] === '--internal-model-egress') {
    const options = parseOptions(argv.slice(1));
    await runModelEgressBroker({
      credentialPath: resolve(requiredOption(options['credential-file'], '--credential-file')),
      serviceTokenPath: resolve(requiredOption(options['service-token-file'], '--service-token-file')),
      readyFile: resolve(requiredOption(options['ready-file'], '--ready-file')),
      runId: requiredOption(options['run-id'], '--run-id'),
      port: integerOption(options.port, 'port', null, 1, 65535),
    });
    return;
  }
  if (argv[0] === '--internal-data-adapter') {
    const options = parseOptions(argv.slice(1));
    const adapter = JSON.parse(await readFile(resolve(requiredOption(options['adapter-file'], '--adapter-file')), 'utf8'));
    await runDataAdapterServer({
      adapter,
      credentialPath: resolve(requiredOption(options['credential-file'], '--credential-file')),
      serviceTokenPath: resolve(requiredOption(options['service-token-file'], '--service-token-file')),
      readyFile: resolve(requiredOption(options['ready-file'], '--ready-file')),
      runId: requiredOption(options['run-id'], '--run-id'),
      port: integerOption(options.port, 'port', null, 1, 65535),
    });
    return;
  }
  if (!argv.length || ['help', '--help', '-h'].includes(argv[0])) {
    process.stdout.write(helpText());
    return;
  }
  if (argv[0] !== 'env') throw cliError('CLI_COMMAND_UNKNOWN', `Unknown command: ${argv[0]}`);
  const command = argv[1];
  const { positional, options } = parseCommandArguments(argv.slice(2));
  const storageRoot = resolve(options.root || DEFAULT_STORAGE_ROOT);
  const bindings = options.bindings
    ? await readEnvironmentBindings(resolve(options.bindings))
    : { schema: 'agent-workbench.environment-bindings/v1', credentials: {} };
  const providers = new IsolationProviderRegistry([
    createDevelopmentIsolationProvider(),
    createDockerIsolationProvider({ dataAdapterCredentialBroker: createDataAdapterCredentialBroker({ bindings }) }),
  ]);

  if (command === 'create') {
    const profilePath = requiredOption(options.profile, '--profile');
    const profile = JSON.parse(await readFile(resolve(profilePath), 'utf8'));
    const manifest = await createEnvironment({
      storageRoot,
      profile,
      profileSource: resolve(profilePath),
      providers,
      environmentId: options.id || null,
    });
    return print({ environment: manifest, next: `agent-workbench env run ${manifest.paths.root}` });
  }

  if (command === 'inspect') {
    const target = await resolveEnvironmentTarget(requiredTarget(positional), { storageRoot });
    const manifest = await inspectEnvironment(target);
    const runs = manifest.kind === 'environment'
      ? (await listEnvironmentRuns(target)).map(runSummary)
      : undefined;
    return print({ manifest, ...(runs === undefined ? {} : { runs }) });
  }

  if (command === 'run') {
    const target = await resolveEnvironmentTarget(requiredTarget(positional), { storageRoot });
    const selected = await readEnvironmentManifest(target);
    const run = selected.kind === 'environment'
      ? await createEnvironmentRun(target, { providers })
      : selected;
    const profile = await readStoredEnvironmentProfile(run.paths.root);
    const provider = providers.get(profile.isolation.provider);
    const result = await launchEnvironmentRun(run.paths.root, {
      provider,
      executable: process.execPath,
      internalHostScript: CLI_PATH,
      port: integerOption(options.port, 'port', 0, 0, 65535),
    });
    return print({
      run: result.manifest,
      url: result.url,
      reused: result.reused,
      next: `agent-workbench env inspect ${result.manifest.paths.root}`,
    });
  }

  if (command === 'stop') {
    const target = await resolveEnvironmentTarget(requiredTarget(positional), { storageRoot });
    const selected = await readEnvironmentManifest(target);
    const runs = selected.kind === 'run'
      ? [selected]
      : (await listEnvironmentRuns(target)).filter((run) => run.status === 'running');
    const results = [];
    for (const run of runs) {
      const profile = await readStoredEnvironmentProfile(run.paths.root);
      results.push(await stopEnvironmentRun(run.paths.root, { provider: providers.get(profile.isolation.provider) }));
    }
    return print({ stopped: results.filter((result) => result.stopped).length, runs: results.map((result) => runSummary(result.manifest)) });
  }

  throw cliError('CLI_COMMAND_UNKNOWN', `Unknown env command: ${command || '(missing)'}`);
}

function parseCommandArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    const optionValue = argv[index + 1];
    if (!optionValue || optionValue.startsWith('--')) throw cliError('CLI_OPTION_VALUE_REQUIRED', `Option --${name} requires a value.`);
    options[name] = optionValue;
    index += 1;
  }
  return { positional, options };
}

function parseOptions(argv) {
  return parseCommandArguments(argv).options;
}

function runSummary(run) {
  return {
    id: run.id,
    status: run.status,
    effectiveIsolation: run.isolation.effectiveLevel,
    requestedIsolation: run.isolation.requestedLevel,
    pid: run.process?.pid || null,
    port: run.process?.port || null,
    createdAt: run.lifecycle.createdAt,
    startedAt: run.lifecycle.startedAt,
    stoppedAt: run.lifecycle.stoppedAt,
    path: run.paths.root,
  };
}

function integerOption(value, label, fallback, minimum, maximum) {
  if (value == null) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw cliError('CLI_OPTION_INVALID', `${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function requiredTarget(positional) {
  if (positional.length !== 1) throw cliError('CLI_TARGET_REQUIRED', 'Exactly one Environment or Run target is required.');
  return positional[0];
}

function requiredOption(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw cliError('CLI_OPTION_REQUIRED', `${label} is required.`);
  return value;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function helpText() {
  return `Agent Workbench runnable Minimal Host\n\nUsage:\n  agent-workbench env create --profile <profile.json> [--bindings <private-bindings.json>] [--root <storage>] [--id <id>]\n  agent-workbench env run <environment-or-run> [--bindings <private-bindings.json>] [--root <storage>] [--port <port>]\n  agent-workbench env inspect <environment-or-run> [--root <storage>]\n  agent-workbench env stop <environment-or-run> [--root <storage>]\n\nThe built-in development provider is explicitly non-isolated. A Profile that requires\nguarded-host or ephemeral-machine will fail at run time instead of downgrading.\n`;
}

function cliError(code, message) {
  return Object.assign(new Error(message), { code });
}

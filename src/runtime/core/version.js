import { fileURLToPath } from 'node:url';

export const CODEX_PROVIDER_VERSION = '0.147.0';

export function bundledCodexLaunch({ args = ['app-server'] } = {}) {
  const codexBinUrl = import.meta.resolve('@openai/codex/bin/codex.js');
  return {
    command: process.execPath,
    args: [fileURLToPath(codexBinUrl), ...args],
    version: CODEX_PROVIDER_VERSION,
  };
}

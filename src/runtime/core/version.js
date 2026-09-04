import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CODEX_BIN_PATH = fileURLToPath(import.meta.resolve('@openai/codex/bin/codex.js'));
export const CODEX_PROVIDER_VERSION = JSON.parse(readFileSync(
  join(dirname(dirname(CODEX_BIN_PATH)), 'package.json'),
  'utf8',
)).version;

export function bundledCodexLaunch({ args = ['app-server'] } = {}) {
  return {
    command: process.execPath,
    args: [CODEX_BIN_PATH, ...args],
    version: CODEX_PROVIDER_VERSION,
  };
}

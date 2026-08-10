import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const providerRoot = path.dirname(require.resolve('@playwright/mcp/package.json'));
const outputFile = path.join(root, 'src', 'browser', 'playwright-mcp-tools.json');
const temporaryOutput = path.join(os.tmpdir(), `workbench-playwright-manifest-${process.pid}`);
await mkdir(path.dirname(outputFile), { recursive: true });
await mkdir(temporaryOutput, { recursive: true });

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(providerRoot, 'cli.js'), '--cdp-endpoint', 'http://127.0.0.1:1', '--output-dir', temporaryOutput, '--output-max-size', '1048576', '--codegen', 'none'],
  stderr: 'pipe',
});
transport.stderr?.on('data', () => {});
const client = new Client({ name: 'agent-platform-playwright-manifest', version: '0.1.0' });
try {
  await client.connect(transport);
  const result = await client.listTools();
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  const names = tools.map((tool) => String(tool?.name || '')).filter(Boolean);
  if (!tools.length || names.length !== tools.length || new Set(names).size !== names.length) {
    throw new Error('Playwright MCP returned an invalid tool manifest.');
  }
  await writeFile(outputFile, `${JSON.stringify(tools, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${tools.length} Playwright MCP tools.\n`);
} finally {
  await client.close().catch(() => {});
  await rm(temporaryOutput, { recursive: true, force: true });
}

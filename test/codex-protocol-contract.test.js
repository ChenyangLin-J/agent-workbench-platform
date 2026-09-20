import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { bundledCodexLaunch } from '../src/runtime/core/index.js';

test('bundled Codex protocol keeps execution-setting request fields compatible', async (t) => {
  const output = await mkdtemp(join(tmpdir(), 'agent-workbench-codex-schema-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const launch = bundledCodexLaunch({ args: ['app-server', 'generate-json-schema', '--out', output] });
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)(launch.command, launch.args, { timeout: 30_000 });

  const properties = async (name) => Object.keys(JSON.parse(await readFile(
    join(output, 'v2', `${name}.json`),
    'utf8',
  )).properties || {});

  for (const request of ['ThreadStartParams', 'ThreadResumeParams', 'ThreadForkParams']) {
    const fields = await properties(request);
    assert.ok(fields.includes('config'), `${request} must accept config overrides.`);
    assert.equal(fields.includes('effort'), false, `${request} must not receive the Turn-only effort field.`);
  }
  assert.ok((await properties('TurnStartParams')).includes('effort'));
});

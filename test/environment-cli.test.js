import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const CLI = new URL('../bin/agent-workbench.js', import.meta.url).pathname;

test('CLI creates, runs, inspects, and stops a project-free Minimal Host', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-cli-'));
  const storageRoot = join(root, 'environments');
  const profilePath = join(root, 'profile.json');
  await writeFile(profilePath, `${JSON.stringify({
    schema: 'agent-workbench.environment-profile/v1',
    id: 'cli-minimal',
    features: { attachments: false },
    isolation: { provider: 'development', minimumLevel: 'development' },
  }, null, 2)}\n`);
  let runRoot = null;
  t.after(async () => {
    if (runRoot) await cli(['env', 'stop', runRoot, '--root', storageRoot]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  const created = await cli(['env', 'create', '--profile', profilePath, '--root', storageRoot, '--id', 'cli-environment']);
  assert.equal(created.environment.kind, 'environment');
  const running = await cli(['env', 'run', created.environment.paths.root, '--root', storageRoot]);
  runRoot = running.run.paths.root;
  assert.equal(running.run.status, 'running');
  assert.equal(running.run.isolation.effectiveLevel, 'development');
  const page = await fetch(running.url).then((response) => response.text());
  assert.match(page, /minimal-host\.js/);
  assert.match(page, /bootstrap\.js/);
  const inspected = await cli(['env', 'inspect', runRoot, '--root', storageRoot]);
  assert.equal(inspected.manifest.process.pid, running.run.process.pid);
  const stopped = await cli(['env', 'stop', runRoot, '--root', storageRoot]);
  assert.equal(stopped.stopped, 1);
  runRoot = null;
});

test('CLI refuses to downgrade an unmet isolation requirement', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'awb-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storageRoot = join(root, 'environments');
  const profilePath = join(root, 'profile.json');
  await writeFile(profilePath, `${JSON.stringify({
    id: 'guarded-required',
    isolation: { provider: 'development', minimumLevel: 'guarded-host' },
  })}\n`);
  const created = await cli(['env', 'create', '--profile', profilePath, '--root', storageRoot]);
  await assert.rejects(
    () => cli(['env', 'run', created.environment.paths.root, '--root', storageRoot]),
    (error) => error.payload?.error?.code === 'ISOLATION_REQUIREMENT_UNSATISFIED',
  );
});

async function cli(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args], {
      timeout: 30_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    try { error.payload = JSON.parse(error.stderr); } catch {}
    throw error;
  }
}

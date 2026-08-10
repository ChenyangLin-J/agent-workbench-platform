import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const DEFAULT_CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function isCdpReady(endpoint, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(new URL('/json/version', endpoint), { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureMacChrome({
  cdpEndpoint = 'http://127.0.0.1:49222',
  profileDir,
  chromePath = DEFAULT_CHROME_PATH,
  spawnImpl = spawn,
  fetchImpl = fetch,
  timeoutMs = 15_000,
} = {}) {
  if (!profileDir) throw new TypeError('profileDir is required.');
  if (await isCdpReady(cdpEndpoint, fetchImpl)) return { started: false, endpoint: cdpEndpoint };
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const endpoint = new URL(cdpEndpoint);
  const child = spawnImpl(chromePath, [
    `--remote-debugging-address=${endpoint.hostname}`,
    `--remote-debugging-port=${endpoint.port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.unref?.();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpReady(cdpEndpoint, fetchImpl)) return { started: true, endpoint: cdpEndpoint, pid: child.pid || null };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Chrome Browser Hand-off did not expose its local CDP endpoint.');
}

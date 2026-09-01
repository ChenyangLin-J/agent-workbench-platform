import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const CLIENT_ENTRY = fileURLToPath(new URL('./host-client.jsx', import.meta.url));
const INDEX_TEMPLATE = fileURLToPath(new URL('./assets/index.html', import.meta.url));

export async function buildMinimalHostAssets({ outputDirectory } = {}) {
  if (typeof outputDirectory !== 'string' || !outputDirectory.trim()) throw new TypeError('outputDirectory is required');
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await build({
    entryPoints: [CLIENT_ENTRY],
    outfile: join(outputDirectory, 'minimal-host.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file' },
    assetNames: 'assets/[name]-[hash]',
  });
  const script = await readFile(join(outputDirectory, 'minimal-host.js'));
  const stylesheet = await readFile(join(outputDirectory, 'minimal-host.css'));
  const assetVersion = createHash('sha256')
    .update(script)
    .update(stylesheet)
    .digest('hex')
    .slice(0, 12);
  const index = (await readFile(INDEX_TEMPLATE, 'utf8'))
    .replaceAll('__MINIMAL_HOST_ASSET_VERSION__', assetVersion);
  await writeFile(join(outputDirectory, 'index.html'), index);
  return {
    root: outputDirectory,
    index: join(outputDirectory, 'index.html'),
    script: join(outputDirectory, 'minimal-host.js'),
    stylesheet: join(outputDirectory, 'minimal-host.css'),
  };
}

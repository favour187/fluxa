// Fluxa build pipeline.
//  1. bundles the browser client  -> public/app.js
//  2. bundles the signalling server -> dist/server/index.js
//  3. transpiles src/** and test/** -> dist/** (ESM, no bundling) so `node --test` can run them
import { build } from 'esbuild';
import { mkdir, copyFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  target: ['es2022'],
};

async function main() {
  await rm(path.join(root, 'dist'), { recursive: true, force: true });
  await mkdir(path.join(root, 'public'), { recursive: true });

  // 1. client bundle — one source of truth for the visible/web version too.
  const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
  await build({
    ...common,
    entryPoints: [path.join(root, 'src/client/main.ts')],
    outfile: path.join(root, 'public/app.js'),
    format: 'esm',
    platform: 'browser',
    target: ['chrome120', 'firefox121', 'safari17'],
    minify: false,
    define: { 'process.env.NODE_ENV': '"production"', FLUXA_VERSION: JSON.stringify(version) },
  });

  // 2. server bundle (ws stays external: it is a CJS package with optional native deps)
  await build({
    ...common,
    entryPoints: [path.join(root, 'src/server/index.ts')],
    outfile: path.join(root, 'dist/server/index.js'),
    format: 'esm',
    platform: 'node',
    packages: 'external',
  });

  // 3. transpile every module for unit tests
  await build({
    ...common,
    entryPoints: [
      ...globSources(path.join(root, 'src')),
      ...globSources(path.join(root, 'test')),
    ],
    outdir: path.join(root, 'dist'),
    outbase: root,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    bundle: false,
    sourcemap: true,
  });

  // 4. static assets
  for (const asset of ['index.html', 'styles.css']) {
    const from = path.join(root, 'src/client', asset);
    if (existsSync(from)) await copyFile(from, path.join(root, 'public', asset));
  }
  console.log('fluxa build complete');
  if (!watch) process.exit(0);
}

function globSources(dir) {
  const { readdirSync } = require('node:fs');
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

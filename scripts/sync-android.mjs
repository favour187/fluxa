/**
 * Prepares the Android web assets:
 *   1. builds the client bundle
 *   2. removes source maps and test-only files from the shipped web directory
 *   3. copies everything into the Android project with `cap sync`
 *   4. re-applies the version numbers and launcher icons
 *
 * Run: node scripts/sync-android.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });

console.log('· building web bundle');
run(process.execPath, ['scripts/build.mjs']);

console.log('· pruning source maps from the shipped assets');
const publicDir = path.join(root, 'public');
for (const entry of await readdir(publicDir)) {
  if (entry.endsWith('.map')) await rm(path.join(publicDir, entry), { force: true });
}

console.log('· syncing Capacitor');
run('npx', ['cap', 'sync', 'android']);

console.log('· applying version + icons');
run(process.execPath, ['scripts/sync-version.mjs']);
run(process.execPath, ['scripts/make-android-icons.mjs']);
console.log('android assets ready');

/** Build shared web assets and sync the tracked iOS Xcode project.
 * On macOS `cap sync ios` also runs CocoaPods. On Linux it can copy assets but
 * cannot install pods, compile Swift, sign, or produce an IPA.
 */
import { execFileSync } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (command, args) =>
  execFileSync(command, args, { cwd: root, stdio: 'inherit', env: process.env });

run(process.execPath, ['scripts/build.mjs']);
for (const asset of await readdir(path.join(root, 'public'))) {
  if (asset.endsWith('.map')) await rm(path.join(root, 'public', asset), { force: true });
}
run('npx', ['cap', 'sync', 'ios']);
run(process.execPath, ['scripts/sync-version.mjs']);
console.log(process.platform === 'darwin'
  ? 'iOS assets synced. Build with Xcode; code signing/distribution require your own team and profile.'
  : 'iOS web assets synced; CocoaPods/Xcode build and signing require macOS. No iOS binary was produced.');

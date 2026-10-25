import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('CI manifests scan the matching desktop outputs and reject empty platform builds', async () => {
  // Run a copy of the CLI in an isolated miniature repository: never use or
  // modify real build outputs, and do not depend on the host having built them.
  const root = await mkdtemp(join(tmpdir(), 'fluxa-manifest-'));
  const script = join(root, 'scripts', 'build-manifest.mjs');
  const fixtures = [
    { platform: 'linux', dir: 'dist-linux', name: 'Fluxa-linux.AppImage' },
    { platform: 'windows', dir: 'dist-windows', name: 'Fluxa-setup.exe' },
    { platform: 'macos-unsigned', dir: 'dist-macos', name: 'Fluxa-mac-x64.zip' },
  ];
  try {
    await mkdir(join(root, 'scripts'));
    await copyFile(resolve(process.cwd(), 'scripts', 'build-manifest.mjs'), script);
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fluxa', version: '0.2.0' }));
    for (const { platform, dir, name } of fixtures) {
      await mkdir(join(root, dir));
      await writeFile(join(root, dir, name), `${platform}-test-bytes`);
    }
    for (const { platform, dir, name } of fixtures) {
      const out = `manifest-${platform}`;
      execFileSync(process.execPath, [script, '--platform', platform, '--out', out, '--require-artifacts', '--quiet'], { cwd: root });
      const manifest = JSON.parse(await readFile(join(root, out, 'build-manifest.json'), 'utf8'));
      assert.equal(manifest.platform, platform);
      assert.deepEqual(manifest.artifacts.map((artifact: { name: string }) => artifact.name), [name]);
      assert.equal(manifest.artifacts[0].path, join(dir, name));
      assert.equal(manifest.artifacts[0].signed, false);
      assert.equal(manifest.artifacts[0].sha256, createHash('sha256').update(`${platform}-test-bytes`).digest('hex'));
    }
    assert.throws(
      () => execFileSync(process.execPath, [script, '--platform', 'web', '--require-artifacts', '--quiet'], { cwd: root }),
      (error: unknown) => {
        assert.match((error as { stderr: Buffer }).stderr.toString(), /no web artifacts found/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

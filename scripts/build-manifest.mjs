#!/usr/bin/env node
/**
 * Build manifest generator.
 *
 * Produces a machine-readable record of what was actually built: version,
 * identifiers, commit, per-artifact size/SHA-256 and the signing state we can
 * verify from the file itself. CI stores the JSON next to the artifacts so a
 * download can always be traced back to a commit and re-checked by hash.
 *
 * Usage:
 *   node scripts/build-manifest.mjs                    # scan default locations
 *   node scripts/build-manifest.mjs --out docs-out     # choose output directory
 *   node scripts/build-manifest.mjs --platform android # scan release Android outputs
 *   node scripts/build-manifest.mjs --include path ... # add extra files
 *   node scripts/build-manifest.mjs --platform linux --require-artifacts # CI: fail on empty
 *
 * Exit codes: 0 ok (empty allowed unless --require-artifacts), 1 on usage/IO error.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath (not URL.pathname) so this also works on Windows, where the
// pathname would come back as "/C:/..." and every fs call would fail.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** CI builds each platform into a separate directory; never attest another job's outputs. */
const PLATFORM_SCAN_DIRS = {
  linux: ['dist-linux', 'release'],
  windows: ['dist-windows', 'release'],
  'macos-unsigned': ['dist-macos', 'release'],
  macos: ['dist-macos', 'release'],
  web: ['artifacts/web'],
  android: [
    'android/app/build/outputs/apk/release',
    'android/app/build/outputs/bundle/release',
  ],
};
const DEFAULT_SCAN_DIRS = [...new Set(Object.values(PLATFORM_SCAN_DIRS).flat()), 'android/app/build/outputs/apk/debug'];

/** Files that are build by-products, not deliverables. */
const IGNORED =
  /(\.blockmap|\.map|\.ya?ml|\.icns|\.png|\.ico|output-metadata\.json|builder-.*\.yml|\.d\.ts)$/i;

function parseArgs(argv) {
  const opts = { out: 'artifacts/manifest', platform: null, include: [], quiet: false, requireArtifacts: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--platform') opts.platform = argv[++i];
    else if (arg === '--include') opts.include.push(argv[++i]);
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--require-artifacts') opts.requireArtifacts = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/build-manifest.mjs [--out DIR] [--platform NAME] [--include FILE ...] [--require-artifacts]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Recursively collect candidate artifact files. */
async function collect(dir, acc) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || /unpacked$/.test(entry.name) || entry.name === 'mac' || entry.name === 'mac-arm64') continue;
      await collect(full, acc);
    } else if (!IGNORED.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Minimal ZIP central-directory reader: enough to list entry names and confirm
 * an APK/AAB carries a JAR signature block without pulling in a dependency.
 */
function zipEntryNames(buffer) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return null;
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function classify(file) {
  const name = basename(file).toLowerCase();
  const ext = extname(name);
  if (ext === '.apk') return { format: 'APK (Android package)', kind: 'apk' };
  if (ext === '.aab') return { format: 'AAB (Android App Bundle)', kind: 'aab' };
  if (ext === '.appimage') return { format: 'AppImage (portable Linux)', kind: 'linux' };
  if (ext === '.deb') return { format: 'deb (Debian/Ubuntu)', kind: 'linux' };
  if (ext === '.exe') {
    return name.includes('portable')
      ? { format: 'Windows portable executable', kind: 'exe' }
      : { format: 'Windows NSIS installer', kind: 'exe' };
  }
  if (ext === '.dmg') return { format: 'macOS disk image', kind: 'mac' };
  if (ext === '.zip') {
    if (name.includes('web')) return { format: 'ZIP (static web build)', kind: 'web' };
    if (name.includes('mac')) return { format: 'ZIP (macOS .app archive)', kind: 'mac' };
    return { format: 'ZIP', kind: 'other' };
  }
  return { format: extensionLabel(ext), kind: 'other' };
}

function extensionLabel(ext) {
  return ext ? ext.replace('.', '').toUpperCase() : 'binary';
}

/** Signature state we can honestly determine from the bytes alone. */
async function signatureInfo(file, kind) {
  if (kind === 'apk' || kind === 'aab') {
    const buffer = await readFile(file);
    const names = zipEntryNames(buffer);
    if (!names) return { signed: null, note: 'not a readable ZIP, signature unknown' };
    const jars = names.filter((n) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(n));
    const hasV2 = names.some((n) => n === 'META-INF/MANIFEST.MF');
    if (jars.length > 0) {
      return {
        signed: true,
        note: `JAR signature block present (${jars[0]}); run apksigner verify for scheme v1/v2/v3 detail`,
        hasManifest: hasV2,
      };
    }
    return { signed: false, note: 'no META-INF signature block: unsigned build' };
  }
  if (kind === 'exe') {
    return { signed: false, note: 'no Authenticode code-signing certificate configured' };
  }
  if (kind === 'mac') {
    return { signed: false, note: 'not code-signed or notarised (requires an Apple Developer ID + macOS runner)' };
  }
  if (kind === 'linux') {
    return { signed: false, note: 'no GPG signature or repository metadata signing configured' };
  }
  if (kind === 'web') {
    return { signed: null, note: 'static assets, served over your own origin; no signing applies' };
  }
  return { signed: null, note: 'signature not applicable' };
}

async function describe(file) {
  const info = await stat(file);
  const buffer = await readFile(file);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const { format, kind } = classify(file);
  const signature = await signatureInfo(file, kind);
  return {
    name: basename(file),
    path: relative(REPO_ROOT, file),
    bytes: info.size,
    megabytes: Number((info.size / 1024 / 1024).toFixed(2)),
    sha256,
    format,
    kind,
    signed: signature.signed,
    signatureNote: signature.note,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkg = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8'));

  let versionCode = null;
  try {
    const props = await readFile(join(REPO_ROOT, 'android/version.properties'), 'utf8');
    const match = props.match(/versionCode=(\d+)/);
    if (match) versionCode = Number(match[1]);
  } catch {
    // Android project not generated: fine on web-only builds.
  }

  const platformDirs = opts.platform && opts.platform !== 'all'
    ? PLATFORM_SCAN_DIRS[opts.platform]
    : DEFAULT_SCAN_DIRS;
  if (!platformDirs) throw new Error(`unsupported platform: ${opts.platform}`);
  const found = [];
  for (const dir of platformDirs) await collect(join(REPO_ROOT, dir), found);
  for (const extra of opts.include) found.push(resolve(REPO_ROOT, extra));

  const unique = [...new Set(found)].filter((f) => !IGNORED.test(basename(f)));
  const artifacts = [];
  for (const file of unique) {
    try {
      artifacts.push(await describe(file));
    } catch (error) {
      console.error(`! could not read ${file}: ${error.message}`);
    }
  }
  artifacts.sort((a, b) => a.name.localeCompare(b.name));
  if (opts.requireArtifacts && artifacts.length === 0) {
    throw new Error(`no ${opts.platform ?? 'build'} artifacts found in ${platformDirs.join(', ')}`);
  }

  const manifest = {
    product: pkg.build?.productName ?? pkg.name,
    displayName: pkg.build?.productName ?? pkg.name,
    version: pkg.version,
    versionCode,
    identifiers: {
      electronAppId: pkg.build?.appId ?? null,
      androidApplicationId: 'com.fluxa.transfer',
      iosBundleId: null,
    },
    platform: opts.platform ?? 'all',
    source: {
      repository: 'https://github.com/favour187/fluxa',
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      commit: git(['rev-parse', 'HEAD']),
      commitShort: git(['rev-parse', '--short=7', 'HEAD']),
      describe: git(['describe', '--tags', '--always', '--dirty']),
      tag: process.env.CIRCLE_TAG ?? null,
    },
    build: {
      generatedAt: new Date().toISOString(),
      node: process.version,
      ci: process.env.CI === 'true' || Boolean(process.env.CIRCLECI),
      buildNumber: process.env.CIRCLE_BUILD_NUM ?? null,
      workflowJob: process.env.CIRCLE_JOB ?? null,
    },
    artifacts,
  };

  const outDir = resolve(REPO_ROOT, opts.out);
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, 'build-manifest.json');
  await writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const lines = [
    `${manifest.product} ${manifest.version}${versionCode ? ` (versionCode ${versionCode})` : ''}`,
    `commit ${manifest.source.commitShort ?? 'unknown'}${manifest.source.tag ? ` tag ${manifest.source.tag}` : ''}`,
    `platform ${manifest.platform} · built ${manifest.build.generatedAt}`,
    '',
  ];
  if (artifacts.length === 0) {
    lines.push('No artifacts found in the scanned locations.');
  } else {
    for (const a of artifacts) {
      const sig = a.signed === true ? 'signed' : a.signed === false ? 'unsigned' : 'n/a';
      lines.push(`${a.name}  ${a.bytes} bytes  sha256 ${a.sha256}  [${sig}]`);
    }
  }
  const textPath = join(outDir, 'build-manifest.txt');
  await writeFile(textPath, `${lines.join('\n')}\n`);

  // SHA-256 sidecar consumed by release tooling and manual verification.
  await writeFile(
    join(outDir, 'SHA256SUMS'),
    `${artifacts.map((a) => `${a.sha256}  ${a.name}`).join('\n')}${artifacts.length ? '\n' : ''}`,
  );

  if (!opts.quiet) {
    console.log(lines.join('\n'));
    console.log(`\nmanifest: ${relative(REPO_ROOT, jsonPath)}`);
  }
}

main().catch((error) => {
  console.error(`build-manifest: ${error.message}`);
  process.exit(1);
});

/**
 * Keeps one version number across every target.
 *
 * Source of truth: package.json "version".
 *   - android/app/build.gradle      versionName / versionCode
 *   - android/app/src/main/res/values/strings.xml (app name)
 *   - desktop/main.mjs              (reads app.getVersion() from package.json)
 *   - web build                     (bakes FLUXA_VERSION into the bundle)
 *
 * versionCode is derived as major*10000 + minor*100 + patch, so it always
 * increases for semver releases and Android accepts it as an update.
 *
 * Run: node scripts/sync-version.mjs [--check]
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const check = process.argv.includes('--check');

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const [, major, minor, patch] = /^(\d+)\.(\d+)\.(\d+)/.exec(version) ?? [];
if (!major) {
  console.error(`package.json version "${version}" is not semver`);
  process.exit(1);
}
const versionCode = Number(major) * 10000 + Number(minor) * 100 + Number(patch);

const targets = [
  {
    // Single source for the Gradle build: version name + code live here so the
    // APK/AAB names, the manifest metadata and CI all agree.
    file: 'android/version.properties',
    create: `versionName=${version}\nversionCode=${versionCode}\n`,
    transform: () => `versionName=${version}\nversionCode=${versionCode}\n`,
    verify: (text) => text.includes(`versionName=${version}`) && text.includes(`versionCode=${versionCode}`),
  },
  {
    file: 'ios/App/App.xcodeproj/project.pbxproj',
    transform: (text) => text
      .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
      .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${versionCode};`),
    verify: (text) => text.includes(`MARKETING_VERSION = ${version};`) &&
      text.includes(`CURRENT_PROJECT_VERSION = ${versionCode};`),
  },
  {
    file: 'android/app/src/main/res/values/strings.xml',
    transform: (text) =>
      text
        .replace(/<string name="app_name">[^<]*<\/string>/, '<string name="app_name">Fluxa</string>')
        .replace(/<string name="title_activity_main">[^<]*<\/string>/, '<string name="title_activity_main">Fluxa</string>'),
    verify: (text) => text.includes('>Fluxa<'),
  },
];

let failed = false;
for (const target of targets) {
  const file = path.join(root, target.file);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    if (!target.create) {
      console.log(`- ${target.file} not present, skipping`);
      continue;
    }
    text = '';
  }
  const next = target.transform(text);
  if (check) {
    if (!target.verify(text)) {
      console.error(`✗ ${target.file} is out of sync with ${version} (versionCode ${versionCode})`);
      failed = true;
    } else {
      console.log(`✓ ${target.file}`);
    }
    continue;
  }
  if (next !== text) await writeFile(file, next);
  console.log(`↻ ${target.file} -> ${version} (versionCode ${versionCode})`);
}

if (check && failed) process.exit(1);
console.log(`version ${version} (versionCode ${versionCode})`);

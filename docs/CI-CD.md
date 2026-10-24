# CI/CD

Fluxa is built and tested by CircleCI. The pipeline configuration lives in
[`.circleci/config.yml`](../.circleci/config.yml) and uses no orbs: every job is
written out so the exact commands are visible in review.

## Verified run

The `main` workflow ran green for commit `70daec2`:

**https://app.circleci.com/pipelines/github/favour187/fluxa**

| Job | Result |
| --- | --- |
| `validate` | success — `tsc --noEmit`, 60/60 unit tests, production build |
| `security` | success — production audit clean, secret scan clean |
| `e2e-browser` | success — **12/12** Playwright tests, JUnit stored |
| `e2e-desktop` | success — 4/4 Electron tests under Xvfb |
| `build-web` | success — `Fluxa-0.2.0-web.zip` |
| `build-linux` | success — AppImage + deb built on CircleCI |
| `build-windows` | success — NSIS + portable.exe built on a **Windows machine executor** |
| `build-android` | success — **signed** APK + AAB (keystore from project env vars), v1+v2 verified |
| `build-macos-unsigned` | success — unsigned `Fluxa-0.2.0-mac-x64.zip` built on Linux |
| `build-macos` (dmg) | not run — the plan rejects macOS executors (`resource-class-not-in-plan`); gated behind the `macos_runner` parameter |

Everything above was executed by CircleCI, not locally. The jobs that could not
run are called out rather than silently skipped.

## Workflows

| Workflow | Trigger | Jobs |
| --- | --- | --- |
| `pull-request` | every branch push (including PR branches) | `validate`, `security`, `e2e-browser`, `e2e-desktop`, `build-web`, `build-linux` |
| `main` | pushes to `main` | the above plus `build-windows`, `build-android`, `build-macos` |
| `release` | tags matching `v*.*.*` | all test jobs, all platform builds, then a **manual approval** (`hold-for-release`) before `publish-github-release` |

Nothing is uploaded to an app store or a production service by CI. The only
publishing step is a **draft** GitHub release that a human must review and
publish.

## Jobs

| Job | Executor | What it proves | Artifacts |
| --- | --- | --- | --- |
| `validate` | `cimg/node:20.20.2` | lockfile install works, `tsc --noEmit` clean, `node --test` green, production build emits `dist/` | `logs/typecheck.log`, `logs/unit-tests.log`, `logs/build.log`, `logs/build-output.log` |
| `security` | `cimg/node:20.20.2` | no critical advisories in shipped dependencies; no credential-shaped strings or signing files in the tree | `security-logs/*` |
| `e2e-browser` | `mcr.microsoft.com/playwright:v1.64.1-noble` | the real two-client browser suite (pairing, negotiation, transfer, SHA-256, accept/decline/cancel, disconnect) | `e2e-results/` (JUnit + JSON + traces), `playwright-report/` |
| `e2e-desktop` | Playwright image | Electron shell boots, preload bridge attached, mDNS discovery fires, 1 MB transfer hash matches | `desktop-e2e-results/` |
| `build-web` | `cimg/node:20.20.2` | `Fluxa-<version>-web.zip` containing the static web build | `web/` |
| `build-linux` | `cimg/node:20.20.2` | AppImage + deb are produced by electron-builder | `linux/`, `linux-manifest/` |
| `build-windows` | Windows `machine` (`windows-server-2022-gui`) | NSIS installer + portable exe, and the version resource really is inside `Fluxa.exe` | `windows/`, `windows-manifest/` |
| `build-android` | `cimg/android:2026.10-node` | signed release APK + AAB with the correct `applicationId`, `versionCode`, label and launcher icon | `android-apk/`, `android-aab/`, `android-manifest/` |
| `build-macos-unsigned` | `cimg/node:20.20.2` | a real macOS `.app`/`.zip` produced from Linux, with `CFBundleIdentifier`/version read back out of `Info.plist`; **unsigned and not notarisable from here** | `macos-unsigned/`, `macos-unsigned-manifest/` |
| `build-macos` | macOS `machine` (`xcode:16.4.0`) | signed-capable `.dmg` + `.zip`; only runs when the pipeline is triggered with `macos_runner: true` | `macos/`, `macos-manifest/` |
| `publish-github-release` | `cimg/node:20.20.2`, context `fluxa-release` | collects every artifact, writes `SHA256SUMS`, creates a draft GitHub release (only when a token is present) | `release/` |

Each build job also runs `scripts/build-manifest.mjs`, which writes
`build-manifest.json` + `build-manifest.txt` + `SHA256SUMS` describing version,
versionCode, commit, per-file hashes and the *actual* signing state of each
artifact.

## Optional pipeline parameter

```bash
# run the real macOS job (needs a plan with macOS executors)
curl -X POST -H "Circle-Token: $CIRCLE_TOKEN" -H "Content-Type: application/json" \
  -d '{"branch":"main","parameters":{"macos_runner":true}}' \
  https://circleci.com/api/v2/project/gh/favour187/fluxa/pipeline
```

`macos_runner` defaults to `false`, because the CircleCI plan attached to this
project does not include macOS executors: the default branch stays green instead
of reporting a failure that is a billing limitation, and the `build-macos`
workflow simply does not appear.

## Required environment variables

Configure these on the CircleCI project (**Project Settings → Environment
Variables**) or, better, in a context. Never commit them.

Already configured on this project (values masked by CircleCI):
`FLUXA_ANDROID_KEYSTORE_B64`, `FLUXA_ANDROID_STORE_PASSWORD`,
`FLUXA_ANDROID_KEY_ALIAS`, `FLUXA_ANDROID_KEY_PASSWORD`. That is why
`build-android` produced a **signed** APK/AAB instead of an unsigned test one.

| Variable | Needed by | Purpose |
| --- | --- | --- |
| `FLUXA_ANDROID_KEYSTORE_B64` | `build-android` | base64 of the release keystore (`base64 -w0 fluxa-release.keystore`) |
| `FLUXA_ANDROID_STORE_PASSWORD` | `build-android` | keystore password |
| `FLUXA_ANDROID_KEY_ALIAS` | `build-android` | key alias, currently `fluxa` |
| `FLUXA_ANDROID_KEY_PASSWORD` | `build-android` | key password |
| `GH_RELEASE_TOKEN` | `publish-github-release` | fine-grained PAT with **Contents: Read and write** on `favour187/fluxa`; used only for the draft release |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | `build-macos` (optional) | base64 Developer ID `.p12` + password, once an Apple account exists |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | `build-macos` (optional) | notarisation, once an Apple account exists |

If `FLUXA_ANDROID_KEYSTORE_B64` is absent, `build-android` still builds a
**release APK but unsigned**, names it as a test build in the log, and skips
`apksigner verify`. That is deliberate: a green pipeline should never be
mistaken for a distributable package.

The `publish-github-release` job is attached to the context `fluxa-release`.
Create that context and add `GH_RELEASE_TOKEN` to it. Without the context or
the variable the job logs the reason and exits 0 — it does not publish.

## How to reproduce a job locally

```bash
# validate
npm ci && npm run check && npm test && npm run build

# browser E2E (needs Chromium deps; on Linux install
# libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0
# libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0
# libcairo2 libasound2)
npx playwright install --with-deps chromium
npm run test:e2e

# desktop E2E
xvfb-run -a npx playwright test -c e2e-desktop/playwright.desktop.config.ts

# packages
npm run dist:linux    # AppImage + deb
npm run dist:win      # nsis + portable (Windows, or Linux + wine)
npm run dist:mac      # dmg + zip (macOS only)
node scripts/sync-android.mjs && (cd android && ./gradlew assembleRelease bundleRelease)
```

## Caching

* npm: `v2-npm-<platform>-<checksum package-lock.json>`
* Gradle: `v2-gradle-<checksum android/version.properties>`

Caches are keyed per platform because the Windows and Linux jobs install
different native binaries for Electron.

## Versioning

`package.json` is the single source of truth.

```bash
npm version patch          # or minor / major; edits package.json + tag source
node scripts/sync-version.mjs
```

`sync-version.mjs` propagates the version to `android/version.properties`
(`versionName` + `versionCode = major*10000 + minor*100 + patch`) and to the
Android `strings.xml`. Gradle, the APK/AAB filenames and the build manifest all
read from there, so a version bump cannot drift between targets.

## GitHub Releases

`publish-github-release`:

1. gathers `release/*` (Linux/Windows/macOS), `*.apk`, `*.aab` and the manifest;
2. writes `SHA256SUMS`;
3. `POST /repos/favour187/fluxa/releases` with `draft: true`,
   `generate_release_notes: true`, `tag_name: $CIRCLE_TAG`;
4. uploads each asset to the draft.

Required token permission: a **fine-grained personal access token** with
`Contents: Read and write` (classic tokens need the `repo` scope). Put it in the
`fluxa-release` context as `GH_RELEASE_TOKEN`.

To attach artifacts to a release outside CI you can also run:

```bash
gh release create v0.2.0 release/*.AppImage release/*.deb release/*.exe \
  android/app/build/outputs/apk/release/*.apk \
  android/app/build/outputs/bundle/release/*.aab \
  --generate-notes --draft
```

## Security posture of the pipeline

* No secret is written into a tracked file. `android/keystore.properties` is
  generated only inside the job, from environment variables, and deleted in an
  `always` step.
* The secret scan fails the build on credential-shaped strings; it prints file
  names and line numbers only, never the value.
* Forks do not receive project environment variables, so a fork PR cannot get
  at the signing key or the release token.
* `npm audit --omit=dev --audit-level=critical` is the gate. Dev-only advisories
  are logged for review but do not fail the build, because they cannot ship in
  the packaged app (Electron bundles only what is listed in `build.files`, and
  the Android bundle only ships `public/`).

## Known gaps

* macOS and Windows jobs require executors that a free CircleCI plan may not
  include. If the plan rejects them the jobs fail at scheduling, which is
  reported in the run rather than hidden.
* No code-signing certificates for Windows (Authenticode) or macOS (Developer ID)
  exist yet, so those builds are explicitly unsigned. The manifest records this
  per artifact.
* Android signing material is generated but is **not** registered in Google Play
  yet; the AAB is signed with a local key, suitable for internal testing.

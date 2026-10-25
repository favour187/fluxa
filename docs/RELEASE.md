# Build and release guide — Fluxa 0.2.0 / transfer protocol 2

This guide describes reproducible builds. A **signed upstream Android CI APK exists** (job 173 on old commit `e58c3ff`); it does **not** establish a signed build of this revision, real-device tests, App Store/Play uploads or production TURN. Run
`node scripts/sync-version.mjs --check` before every package build. Updates from
protocol v1 must update both peers and the signalling broker together; old
direct tickets and incomplete v1 journals cannot be reinterpreted as verified
v2 sessions.

## Common verification before considering a release

```bash
npm ci --no-audit --no-fund
npm run check
npm test
npx playwright install --with-deps chromium
npm run test:e2e
xvfb-run -a npm run test:desktop    # Linux Electron display
npm audit --omit=dev --audit-level=critical
node scripts/sync-version.mjs --check
```

Browser E2E covers real DataChannels, 32 MB stream, direct code, interrupted
restart/reselection, tampered OPFS partial, sharing consent, cancellation and
history. Desktop E2E covers two local Electron instances and a real native
save-dialog IPC write (including no overwrite); it does not prove Windows or
macOS compatibility. See [TEST-REPORT.md](TEST-REPORT.md) for actual dated runs.

## Web and Linux desktop

```bash
npm run build
npm run dist:linux      # unsigned AppImage and deb in release/
```

A web ZIP is made by the `build-web` CI job. Linux packages need `electron-builder`
and, for GUI smoke tests, Xvfb + GTK system libraries. Local `.deb`/AppImage builds **were run** for this working tree; their hashes
and a packaged-binary smoke test are recorded in [TEST-REPORT.md](TEST-REPORT.md).
CI's baseline artifacts do **not** prove the unpushed changes passed CI.

## Windows and macOS desktop

On a real Windows executor, `npm run dist:win` builds an NSIS installer and a
portable exe. Without a code-signing certificate the exe is **unsigned** and
SmartScreen can warn. No Windows compatibility test of this source revision ran
in this Linux workspace. Provide your own Authenticode certificate through CI
secrets; never add it to the repository.

On a Mac, `npm run dist:mac` builds dmg/zip. The CircleCI macOS job is optional
(`macos_runner: true`) because the current plan may not have a Mac executor.
A Linux-produced **unsigned macOS x64 zip was built locally** (see TEST-REPORT), but is not a notarised, Mac-tested release.
Normal distribution requires an Apple Developer ID certificate and notarisation
with an actual developer account; no such signing/notarisation was performed here.

## Android

The tracked Capacitor Android project shares the same browser bundle. Install
Android SDK platform/build-tools 34, JDK 17 (AGP 8.2.1), and use:

```bash
npm run android:sync
(cd android && ./gradlew --no-daemon --max-workers=1 \
  '-Dorg.gradle.jvmargs=-Xmx640m -XX:MaxMetaspaceSize=256m' \
  assembleRelease bundleRelease assembleDebug)
```

The lower heap/one-worker override is for a **2 GiB Linux test sandbox** and
does not skip lint or release checks. On a normal machine the project defaults
usually suffice. Release outputs are under `android/app/build/outputs/`.
Without locally provisioned release credentials, `assembleRelease` writes an
**unsigned** APK/AAB: `apksigner verify` fails for the local release APK and these
are **not installable/distributable release packages**. The Gradle debug keystore
signs the `assembleDebug` APK, installable for **testing only** (not a Play upload
certificate). This workspace did **not** install an APK on a device or run a
mobile WebRTC scenario.

**A real CI release key already exists.** Public CircleCI Android job
[173](https://app.circleci.com/pipelines/github/favour187/fluxa/17/workflows)
for old commit `e58c3ff` produced a signed release APK and AAB. Its public
manifest records both as signed; independently downloaded APK hash
`aa6a74c87e586cce85e488ce5643096cc31128e885046368c18d8919b9a32520`
matched the manifest, and `apksigner verify --verbose --print-certs` verified
v1 and v2 signatures from `CN=Fluxa, OU=Fluxa Releases`. This is **not** a signed
build of the unpushed revision. After the single authorised push, inspect the
new job's manifest and verify its own APK signature and AAB JAR signature.

Keep the existing key **outside the repository**, in CI project secrets
`FLUXA_ANDROID_KEYSTORE_B64`, `FLUXA_ANDROID_STORE_PASSWORD`,
`FLUXA_ANDROID_KEY_ALIAS` and `FLUXA_ANDROID_KEY_PASSWORD`; for local signing,
provision `android/keystore.properties` securely if authorised. The CI job
verifies signed output when those inputs exist. Play Store publishing additionally
requires an owned account, listing/privacy policy, review and a stable
signing/upload-key strategy; CI does not upload to Play. The upstream signed
0.2.0 APK already uses `versionCode=200`; an actual Play Store **update** must
use a *higher* versionCode than any published build (confirm publication state
with the account owner before attempting an update).

## iOS

`ios/App/` is a tracked Capacitor Xcode project (iOS 17 minimum, Fluxa icon,
local-network permission, `fluxa://pair` URL scheme and Files/Documents
configuration). `npm run ios:sync` builds shared web assets, copies native
plugins and synchronises version metadata. On **Linux**, Capacitor skips
CocoaPods and Xcode; sync success is **not** an iOS build.

On a Mac with Xcode and CocoaPods installed:

```bash
npm ci
npm run ios:sync
xcodebuild -workspace ios/App/App.xcworkspace -scheme App \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath ios/DerivedData CODE_SIGNING_ALLOWED=NO build
```

An optional CircleCI Mac job performs that **unsigned Simulator compile** if
`macos_runner: true`; it is not enabled by a default `main` workflow and has
not run on these changes. A real device/IPA/TestFlight/App Store build needs a
Mac, registered bundle id `com.fluxa.transfer`, Apple developer team, valid
provisioning/profile, signing, and physical/simulator compatibility tests of
WKWebView OPFS, file export, local-network prompts and WebRTC. None can be
honestly marked ready from this Linux environment alone.

## Deployment / release gate

Read [NETWORKING.md](NETWORKING.md) before running a public WSS+coturn relay.
Do not reuse CircleCI/GitHub tokens as device enrolment/REST TURN secrets. CI
has separate `validate`, `security`, browser E2E, Electron E2E, web, Linux,
Windows, Android and unsigned-mac jobs; the macOS and iOS Simulator jobs need
an explicitly enabled Mac executor. The tag workflow could create a draft
GitHub release only **after** manual approval and an operator-controlled token.
For this implementation task **do not tag, publish, or trigger that workflow**.

A release-ready decision additionally requires independent real-device coverage
across platforms and representative LAN/NAT/TURN networks, signing and
installation checks, and review of remaining limitations. A successful source
build or CI baseline is not equivalent to these checks.

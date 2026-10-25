# Fluxa 0.2.0 — verification and release-readiness record

## Android two-phone incident and native Share follow-up (2026-10-25)

**Baseline, not fixed:** merged PR #5 `e5940ed8aabd167dabff27bf6db29d96f6295cf9` passed all nine [pipeline-42](https://app.circleci.com/pipelines/github/favour187/fluxa/42) jobs. Its downloaded signed APK (SHA-256 `e9f33beba807818832ad3a8d875509d14017f5b094d54454c20c52dbc9238e71`) and signed AAB (SHA-256 `ec161225cfe112af257a6fdc6cebc496c04ee90caf36b217ab2efe693dba0846`) matched that job's manifests and signatures, and the APK's camera features are optional. The user installed this version on two real Android phones: after exchanging Direct invitation/reply QRs and approving the SAS **while both apps remained open**, the connection immediately dropped. That failure is real; no cause has been confirmed from the single screenshot. Earlier test results below are historical, not success claims for those phones.

**Follow-up source, NOT a release:** Branch `work/android-stability-native-share` now keeps the first WebRTC disconnect reason/ICE state, postpones a manual QR deadline until the reply, guards late peer-handshake events, prevents an asynchronous Direct completion from republishing a stale ticket after SAS, and replaces old sessions when re-pairing. It adds a native `ACTION_SEND`/`ACTION_SEND_MULTIPLE` staging inbox requiring sender review and verified receiver consent. A new re-pair browser test initially failed, exposed the stale-ticket race, then passed three consecutive isolated repeats and the final full suite. This is not proof of the two-phone root cause. Local checks after the last TypeScript/native edits:

| Check | Actual result |
| --- | --- |
| `npm run check`; `npm test` | Passed strict TypeScript; **102/102** Node/unit/security/extension tests. |
| `npm run test:e2e -- --reporter=line` | **35/35** Chromium tests passed (~6.2 min), including serverless Direct WebRTC, repeated pairing after SAS and one Android Share test with a **simulated Capacitor plugin**. Not a real Android share-sheet/ContentResolver test. |
| `npm run android:sync` | Passed; refreshed packaged web bundle. Not proof of an installed app. |
| `:app:testDebugUnitTest :app:assembleDebug assembleRelease bundleRelease` | Passed locally using JDK 17/Android SDK 34 and one worker; two Java filename-sanitization tests, Android release vital lint, debug APK and unsigned release APK/AAB. An earlier combined build with two workers exhausted the ~2 GiB sandbox and its daemon vanished; the complete lower-heap one-worker retry passed without disabling lint/tests. |
| Compiled APK inspection | `aapt2 dump xmltree`: `SEND` + `SEND_MULTIPLE`. DEX includes `FluxaIncomingSharePlugin`. `aapt2 dump badging`: all implied camera hardware optional. `apksigner verify` confirms the debug APK has the **Android debug** certificate and the release APK **does not verify**. `jarsigner -verify` reports the local AAB unsigned. |
| `git diff --check` | Passed. No revised CircleCI run or signing for this branch. |

**Testing artifact (debug only):** locally built `com.fluxa.transfer.debug` (**Fluxa Test** launcher/share-sheet label), SHA-256 `2878ead50f6138bbc83665c33a9b8588ef2fad9c6602f16fa0c46b933223a9ed`. It installs alongside—not over—the old `com.fluxa.transfer` release, with a *different* identity and data store. It must be installed on **both** test phones to compare the new source. The local release APK SHA-256 `8f49d59842f272b290b5de89111c988d39c3b023a8a3ab8fe8cc47d2e16dca79` and AAB SHA-256 `352bd0349f300b05b8b3c703cddf3af44214d99679a0f77e94154f44e9d2d901` are unsigned: **do not install or distribute them**. There has been no retest on actual phones or installed package and no new release-key signature. Physical verification plus CI on the follow-up commit are still gates.

## Post-merge CI and Android hardware-filter correction (2026-10-25)

PR #4's combined feature commit `aff40bc` passed **all six** branch pipeline 39 jobs (validate, security, browser E2E, desktop E2E, web, Linux). PR #4 was **merged** as `393fa38f0559`; [main pipeline 40](https://app.circleci.com/pipelines/github/favour187/fluxa/40) passed **all nine** jobs, including Android, Windows and unsigned-mac package builds. PR #4's earlier pipeline 38 failures are historical and do not describe the merged code.

Pipeline 40 Android job 331 produced an APK and AAB for **`393fa38`**, both release-signed and independently downloaded. The APK SHA-256 is `43c1e90164e5dfe2d7a06756435b7cbc548092d0198058cc886c820e3fa5c5de`; the AAB SHA-256 is `c0140d475fd0cdcf575d4abb7614a3f20d8e6f8310ef4b063e732459c2d52918`. Both match the CI manifest. Independent `apksigner verify` confirmed APK v1/v2 release signatures with one `CN=Fluxa, OU=Fluxa Releases` signer; `jarsigner -verify` verified the AAB JAR signature (self-signed release certificate, as expected for Android upload keys). **However**, compiled APK badging also revealed that `android.permission.CAMERA` silently implied a **required** `android.hardware.camera` feature despite optional `camera.any`. This would filter camera-less devices even though manual pairing works. The follow-up source marks all camera hardware optional and makes the CI Android job assert the *built* APK has no implied required camera. **Pipeline 40's signed artifact is not a corrected final package**; verify the follow-up revision's own APK/AAB after its CI build. No phone install, iOS Xcode build or store publication was performed.

## Local feature verification before PR #4's remote merge

The following checks were run on `work/all-features-and-pr4` before it was pushed. The Android-only follow-up later passed strict TypeScript, **94/94** Node/unit/extension tests, Android asset/plugin sync and version/whitespace checks; browser/desktop feature code was unchanged, and CI runs those suites again per pushed commit. The table records the original combined feature commit's local results.

| Check | Observed result |
| --- | --- |
| `npm run check` | Passed strict TypeScript after the final feature/race fixes. |
| `npm test` | **93/93 passed** Node/unit/security/extension-link checks. |
| `npm run test:e2e` | **33/33 passed** Chromium browser E2E after the camera-policy assertion and early-stop media-negotiation fixes (~5.0 min). An earlier targeted QR run saw one transient pairing timeout; the complete 33-test rerun passed, and the boot-time pairing case passed 3/3 on an isolated repeat. Do not claim zero flakiness. |
| `xvfb-run -a npm run test:desktop` | **6/6 passed** actual Linux Electron process E2E after the final changes (including a simulated canceled OS screen-picker request that settles cleanly). |
| `npm run android:sync`, `npm run ios:sync` | Both passed after adding Android CAMERA permission and iOS camera usage string, reporting Capacitor App, Clipboard, Filesystem and Share plugin registrations. This source-only sync did **not** catch the later compiled APK's implied required camera feature. Linux skipped CocoaPods/Xcode. No Android SDK/Gradle build or iOS compile of this tree. |
| `npm audit --omit=dev --audit-level=critical`; `git diff --check`; `node scripts/sync-version.mjs --check` | Passed; audit reported `found 0 vulnerabilities` in production dependencies at that run. |
| Unpacked Chromium extension | Manifest V3 loaded in a headful Linux Chromium extension manager; the URL fragment/review flow passed browser E2E. Store signing and installed-app protocol dispatch in a real browser remain untested. |

Feature E2E exercised: QR pairing from a simulated camera without `BarcodeDetector` and camera cleanup; claim-at-boot; phone-width layout; verified peer chat/file/ripple/swipe; double-consent live clipboard text with denial/stop/feedback-loop prevention (mock OS clipboard); double-consent screen media via an actual WebRTC transceiver (simulated capture picker), repeat-sharing and two different early-stop/renegotiation races; selected-tab handoff to an existing app tab without disrupting its connection; manual receipt/open actions; per-device bounded auto-accept, block and immediate-picker rules; restarted verified OPFS recovery. **Mock permissions/camera/clipboard sources are not real phone/OS compatibility evidence.** An earlier main pipeline 32 for `e310d79` completed all nine jobs with independently checked genuinely release-signed Android APK/AAB artifacts; those are for that earlier commit, not this combined tree.

### Historical baseline below (not the latest tree)

**Date:** 2026-10-25. **Working branch:** `work/universal-transfer`, based on
`origin/main` at `e58c3ffc56a29d058a037bc6908d2529b6e61d70`.
At the time of this record, the new work has **not** been built by CircleCI,
installed on a phone or published. Package version remains **0.2.0**; the
incompatible transfer/signalling protocol is **v2**. Read this alongside
[PLATFORM-NOTES.md](PLATFORM-NOTES.md), [NETWORKING.md](NETWORKING.md), and
[RELEASE.md](RELEASE.md).

## Actual local commands and results

| Command / inspection | Observed result |
| --- | --- |
| `npm ci --no-audit --no-fund` | Completed; lockfile-exact install. |
| `npm run check` | Passed, strict `tsc --noEmit`. |
| `npm test` | Passed, **79/79** Node unit and server integration tests. |
| `npm run test:e2e` | Passed, **18/18** real Chromium E2E tests with two isolated profiles and real WebRTC DataChannels (**3.9 min**). |
| `npm run test:e2e -- --grep 'cancelling mid-transfer stops' --repeat-each=3` | Passed, **3/3** cancellation repeats. |
| `xvfb-run -a npm run test:desktop` | Passed, **4/4** Linux Electron E2E tests (dev application instances, not packaged installer runs). |
| `node scripts/sync-version.mjs --check` | Passed for Android and iOS native version metadata (0.2.0 / 200). |
| `npm audit --omit=dev --audit-level=critical` | `found 0 vulnerabilities` at the time run. |
| `npm run ios:sync` | Passed asset/plugin sync. Explicitly skipped CocoaPods and Xcode on Linux; **no iOS compile, simulator run or IPA**. |
| `npm run android:sync` | Passed asset/plugin/version/icon sync after the final transfer edit. |
| `(cd android && ./gradlew --no-daemon --max-workers=1 '-Dorg.gradle.jvmargs=-Xmx640m -XX:MaxMetaspaceSize=256m' lintVitalRelease assembleRelease bundleRelease assembleDebug)` | **BUILD SUCCESSFUL** in 25 s (382 tasks; no lintVitalRelease bypass). JDK 17, Android SDK/build-tools 34. Local **release APK/AAB unsigned**; debug APK signed with the normal debug key. |
| `npm run dist:linux` | Completed; Linux x86_64 AppImage and amd64 deb generated from this working tree. |
| `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac zip --publish never -c.directories.output=dist-macos` | Completed a **Linux-cross-built, unsigned** macOS x64 `.app` ZIP; **not** a Mac run or notarised release. |
| Packaged Linux `release/linux-unpacked/fluxa` under Xvfb, Playwright Electron launch | Started with `app.isPackaged=true`, version `0.2.0`, `app.asar`, desktop bridge present and signalling **online** after startup. The first smoke attempt sampled `offline` before connection establishment; rerunning with an explicit wait for `online` passed. Neither deb installation nor AppImage FUSE execution was tested. |
| `git diff --check`, Python YAML parsing | No whitespace errors; CircleCI YAML parses. This does not substitute for a run of the new CI config. |

One earlier **full** browser run ended **17 passed / 1 failed**: an existing
cancellation test timed out *during pairing setup* waiting for the six-digit
SAS, before any cancellation started. Screenshots showed both sessions back
on the Devices screen; no definitive cause was identified. The focused test
then passed 3/3 and the next complete suite passed 18/18. Do **not** describe
pairing flakiness as fixed or claim a measured zero-failure rate.

The complete browser suite covers: empty/text/binary/8 MiB files; an actual
32 MiB browser disk-backed stream (observed receiver JS heap growth **0.4 MiB**
in that run); ordered batch transfers; decline/cancel/queue/progress/verification/
disconnect; no-server direct offer/reply; small-screen layout; explicit
clipboard/link/work-note consent; and a restarted two-profile resume from
IDB journals and rehashed OPFS bytes. It rejects modified source selection
and a corrupted saved prefix. The Linux Electron tests cover local embedded
broker/mDNS, pairing and file save through actual bounded native IPC with an
OS chooser stub, save-name collision rejection, and identity persistence.
Node tests additionally cover framing/manifest rejection, hashes, safety,
TURN credential issuance/denial and recovery/export helpers. **None** of
these stand in for mobile WebView or external-network hardware tests.

## Artifact inventory: distinguish this tree from prior CI

All *local* binaries below incorporate the revised web bundle. The Android
files are copied to `/home/user/fluxa-artifacts/` with `SHA256SUMS`; Linux/mac
outputs are in the build directories (git-ignored). Hashes were computed from
those actual files, not inferred from a successful command.

| Local file | SHA-256 | Package/signing inspection |
| --- | --- | --- |
| `release/Fluxa-0.2.0-linux-x86_64.AppImage` | `c58376a2e9617281bea68d4095657a5b666aab168dd9c2a93ed4d613f2921ae9` | AppImage `--appimage-version` answered; unpacked app GUI smoke passed; no distro signing. |
| `release/Fluxa-0.2.0-linux-amd64.deb` | `2203bfb5d01a890f7e3dc13255bcbfdad744040ef9226381bff91263e079501b` | `dpkg-deb --field`: `fluxa`, version `0.2.0`, `amd64`; not installed on an OS. |
| `dist-macos/Fluxa-0.2.0-mac-x64.zip` | `e671093e89fa38c42f27fb355f4ab30c91a71a76841331c7f433441c668b595a` | `.app/Contents/Info.plist`: `com.fluxa.transfer`, `0.2.0`, macOS 11 minimum; **unsigned**, no Mac compile/runtime or notarisation. |
| `/home/user/fluxa-artifacts/Fluxa-0.2.0-debug-signed.apk` | `0a34c58096f019d6b7b533ad5a663e5107165ef4b464b6ce4e9d59f10846bf46` | `apksigner verify` v1+v2, `CN=Android Debug`; **test-only** app ID `com.fluxa.transfer.debug`, `versionName=0.2.0-debug`. No install test. |
| `/home/user/fluxa-artifacts/Fluxa-0.2.0-release-unsigned.apk` | `f4eda26b3490b7df8648af00510576bd3c99062b39686abf9e4f77a380fea899` | `apksigner verify`: **DOES NOT VERIFY**; ID `com.fluxa.transfer`, version `0.2.0` / code `200`. Not a distributable release. |
| `/home/user/fluxa-artifacts/Fluxa-0.2.0-release-unsigned.aab` | `f8b7d3ed99f91fde977bc5b5d70530246ed924d4bd178cea51659d7c76b8b8ee` | `jarsigner -verify`: **jar is unsigned**. Not a Play upload artifact. |

**CI signing correction, independently checked:** the app owner's signing
material *does exist on CircleCI*. The successful upstream [pipeline 17](https://app.circleci.com/pipelines/github/favour187/fluxa/17)
Android job **173** for **old commit `e58c3ff`** publicly exposes a release
APK, AAB and JSON build manifest. Both downloaded hashes match that manifest:

| Upstream signed artifact (old source) | SHA-256 | Independent signature check |
| --- | --- | --- |
| [Release APK](https://output.circle-artifacts.com/output/job/07838611-9a72-41a8-9179-d15ef6455caf/artifacts/0/android-apk/Fluxa-0.2.0-release.apk) | `aa6a74c87e586cce85e488ce5643096cc31128e885046368c18d8919b9a32520` | `apksigner verify --verbose --print-certs` **Verifies**, v1 and v2 true, one release signer `CN=Fluxa, OU=Fluxa Releases` (not the Android debug signer). |
| [Release AAB](https://output.circle-artifacts.com/output/job/07838611-9a72-41a8-9179-d15ef6455caf/artifacts/0/android-aab/Fluxa-0.2.0-release.aab) | `583616da28a3638815ec2c17223c31f58583fb1876faec02e9d11fe68630798c` | `jarsigner -verify`: **jar verified.** Self-signed release certificate; no signing timestamp. |

The [CI build manifest](https://output.circle-artifacts.com/output/job/07838611-9a72-41a8-9179-d15ef6455caf/artifacts/0/android-manifest/build-manifest.json)
identifies old commit `e58c3ffc56a29d058a037bc6908d2529b6e61d70`, job 173,
version 0.2.0, code 200 and both outputs as signed. **Never substitute either
old signed file for the new unsigned build.** The CI keystore is not available
locally and must not be extracted or committed. Only the single approved push
can start a new signed CI build of *this* revision; inspect that job's output
and signatures independently. The previous CI success also had Windows
NSIS/portable and an unsigned Linux-built macOS ZIP, but **neither tests these
new changes**. This report cannot assert their new CI outcomes in advance.

## Source/build/test/device/distribution status

| Target | Source | Current build | Automated execution | Physical/runtime validation & distribution |
| --- | --- | --- | --- | --- |
| Browser/web | Shared TypeScript source | Web/server bundle built | 79 Node + 18 Chromium E2E | No Firefox/Safari or remote physical devices; deploy behind HTTPS/WSS. |
| Linux desktop x64 | Electron source | AppImage + deb built locally | 4 Linux Electron E2E; separately smoke-tested packaged unpacked app | No `.deb` install or AppImage FUSE test, distro signature or multi-host LAN test. |
| Windows desktop | Electron source | Prior upstream Windows CI only | No Windows runtime/test of this revision | New Windows CI NSIS/portable build and runtime test pending; no Authenticode signing. |
| macOS desktop | Electron source | New **unsigned cross-built ZIP**; prior upstream unsigned CI ZIP | No macOS runtime test | No actual Mac `.dmg`, Developer ID signing or notarisation; normal distribution not ready. |
| Android | Capacitor project | This revision: unsigned release APK/AAB and debug-key signed test APK. **Old** CI release APK/AAB verified signed | Gradle release lint/build only; **no** emulator/phone test | New signed CI artifacts and real-device WebView/ICE/OPFS/share/install tests pending. |
| iOS/iPadOS | Tracked iOS Xcode project and plugin config | Linux sync only; optional Mac Simulator CI job unrun | No compile, Simulator, iPhone or signing tests | Mac/Xcode/CocoaPods, Apple developer team/provisioning, physical checks and signed IPA required. |

## Capabilities versus remaining work

- One transfer/protocol implementation serves web, desktop and native webviews;
  it has per-file SHA-256 commitments, verified restart offsets/prefixes,
  receiver completion receipts, consent and one-at-a-time queueing. Recovery is
  **manual** and needs an intact browser profile/OPFS partial and the original
  source files. It is not OS-background migration or guaranteed durability.
- Browser folder export preserves relative paths only with a user-selected
  directory picker; a plain browser download can flatten paths. Mobile export
  writes to Documents then offers a share sheet, not arbitrary destination
  access. Those native operations are **not hardware-validated**.
- Direct codes work in local Chromium tests without a signalling server.
  Remote ICE needs deployer-operated WSS signalling, STUN and often a public
  coturn relay. TURN uses access-key-gated, expiring REST credentials. Unit/WS
  tests cover credential control; **no live public relay or two-NAT physical
  transfer was tested**. See [NETWORKING.md](NETWORKING.md) for TLS, origin
  allowlisting, coturn setup, ports, quotas and key rotation.
- Optional clipboard text, links and work notes require send action, recipient
  consent and a separate Copy/Open action. No passive clipboard monitor,
  installed-app transfer, cookies, logins or live browser-session migration.
- Protocol v2 deliberately rejects v1; upgrade both peers and the broker.
  Old pending v1 transfers cannot be silently resumed.

**Release gate not met:** new CI jobs must pass on the one pushed commit, and
hardware tests, cross-NAT/TURN trials, iOS compilation/signing, desktop
platform/runtime checks and distribution credentials remain outstanding. A
Play Store update would also need a `versionCode` **higher than any already
published build**; the previously signed 0.2.0 CI package used code 200, but
its store publication status was not verified. Nothing here claims a universal,
production-ready release or a published tag.

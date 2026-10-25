# Fluxa

**Move anything. Anywhere.** Fluxa 0.2.0 is an open-source, device-to-device
file/folder transfer app sharing one TypeScript/WebRTC engine across browsers,
Electron desktop and Capacitor mobile projects. The **transfer wire protocol is
v2**, intentionally incompatible with v1: update both clients and their broker
together.

Two devices pair with a single-use six-character code (or exchange direct
serverless offer/reply codes), compare a six-digit fingerprint code **out of
band**, then explicitly accept files. Bytes move over an encrypted WebRTC
DataChannel; each file has a SHA-256 commitment and receiver verification.
`doneAck` prevents the sender from claiming success before receiver commit.
Interrupted transfers can be retried from verified OPFS partials after
re-pairing, re-verifying and reselecting the original sources. Clipboard text,
links and work notes are an **optional, user-initiated** module, not passive
clipboard monitoring or account/session migration.

![A previously captured Chromium transfer UI](docs/screenshots/received.png)

## Run locally

```bash
npm ci
npm run build
npm start                        # http://localhost:8787
```

Open the app in **two independent browser profiles** (a normal + private
profile is sufficient; two tabs of one profile are one identity). On one device
choose *Pair device*, enter the code on the other, compare the six digits on
both, then drop/choose files and accept the incoming offer. *Direct code*
works without a broker **when ICE has a viable network path**.

```bash
npm run check                   # strict TypeScript
npm test                        # Node unit/server/integration tests
npm run test:e2e                # real Chromium pair/transfer/restart/consent
xvfb-run -a npm run test:desktop # two Electron Linux instances, file IPC/mDNS
npm audit --omit=dev --audit-level=critical
```

First install Playwright Chromium/deps with
`npx playwright install --with-deps chromium`. Most build and verification
commands are recorded in [TEST-REPORT.md](docs/TEST-REPORT.md).

## Capabilities and non-capabilities

| Feature | Current implementation |
| --- | --- |
| Files, large streams and folders | 64 KiB chunks, bounded ack window, relative paths, SHA-256, accept/decline/cancel, honest speed/ETA/history. Browser folder export uses a user-selected directory where available; fallback downloads do not preserve folder paths. |
| Recovery | IDB metadata + OPFS partial bytes; both sides hash before offset reuse. Restart requires fresh pairing/SAS, sender re-selection and receiver approval. No durable recovery without OPFS; no background transfer. |
| Pairing/security | Signed device identity, pinned public keys, DTLS-bound session, manual SAS confirmation, protocol-v2 version check, limited codes, private-host restriction on plaintext broker URLs. |
| Connectivity | Same-host/LAN host ICE, optional STUN, optional self-hosted coturn with short-lived **access-controlled** REST credentials; no hosted relay, no guarantee across NATs without deployment. |
| Clipboard/links/work handoff | User enters/pastes content; recipient approves; copying/opening requires an additional action. No passive monitoring, cookies, logins, tabs or installed-app migration. |
| Desktop | Electron embedded LAN broker, mDNS discovery, native save dialog and bounded exclusive-commit IPC. No background service, shell integration or automatic install. |
| Android/iOS | Shared Capacitor source with filesystem/share plugins and `fluxa://pair` handlers. Source/build/test readiness differs by OS (below). |

## Actual platform readiness

| Target | Source | Local build/test status for this work | Distribution readiness |
| --- | --- | --- | --- |
| Web/Chromium Linux | Present | TypeScript + Node tests, real two-browser E2E including interrupted resume and consent | Serve securely; other browsers/phones untested |
| Linux desktop | Present | Linux Electron GUI E2E passed; AppImage/deb built locally and unpacked packaged app smoke-tested | Unsigned AppImage/deb; no distro signing or installer run |
| Windows desktop | Present | Earlier **upstream** CircleCI Windows build passed, not this unpushed revision | New CI build and Windows runtime test needed; no Authenticode certificate here |
| macOS desktop | Present | Unsigned x64 `.app` ZIP cross-built on Linux; no Mac compile/runtime for this revision | Need actual macOS build, Developer ID and notarisation |
| Android | Present | Local Linux Gradle built unsigned release APK/AAB and a **debug-key signed** test APK; no device run. Upstream CircleCI pipeline 17 produced a **release-key signed** APK (v1/v2 verified), but for the *old* commit | This revised code still needs its own signed CI build and physical Android validation |
| iOS/iPadOS | Tracked Xcode project | Capacitor asset/plugin sync passed on Linux; CocoaPods/Xcode **not run** | Needs Mac, signed IPA/Apple team and actual device/Simulator tests |

**A source file, CI success on an older commit, or an unsigned archive is not
proof of platform compatibility.** All platforms need hardware, permissions,
background/resume and cross-network testing before a universal distribution
claim. No release tag or app-store publication is part of this work.

## More detail

- [Protocol, recovery and trust architecture](docs/ARCHITECTURE.md)
- [Networking, WSS, coturn deployment and operator access controls](docs/NETWORKING.md)
- [Platform-specific restrictions](docs/PLATFORM-NOTES.md)
- [Build, signing and release instructions](docs/RELEASE.md)
- [Actual tests and known blockers](docs/TEST-REPORT.md)
- [Security model](docs/SECURITY.md)
- [CircleCI workflows and monitoring](docs/CI-CD.md)

MIT licensed. Files received from another device are **not automatically safe**
just because their checksum matches: the checksum proves integrity, not that an
installer or document is trustworthy.

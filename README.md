# Fluxa

**Move anything. Anywhere.** — verified, device-to-device transfer that feels like
dragging a window onto another screen.

Fluxa is a working cross-device transfer application: two independent clients pair
with a single-use code (or QR link), compare a 6-digit key-verification code, and
then stream files to each other over an encrypted WebRTC DataChannel with
per-file SHA-256 verification and honest, acknowledgement-driven progress.

The same transfer engine ships in three shapes from one codebase: the **browser
client**, an **Electron desktop application** for Windows/macOS/Linux, and an
**Android application** (Capacitor). Releases are built and tested by CircleCI.

This repository is a **real implementation with a verified end-to-end transfer
path** — not a mock. It is also deliberately honest about what is *not* built yet;
see [Capability matrix](#capability-matrix) and
[Platform status](#platform-status).

![Fluxa — a completed transfer, with the receiving device showing a verified connection and SHA-256-checked file](docs/screenshots/received.png)

<sub>Real screenshots from the running app (two browser profiles, 8 MB / 3-file
transfer). Also: [pairing](docs/screenshots/pairing.png) ·
[key verification](docs/screenshots/verify.png) ·
[incoming transfer](docs/screenshots/incoming.png) ·
[mid-transfer progress](docs/screenshots/transferring.png)</sub>

---

## Quick start

```bash
npm install
npm run build
npm start                 # http://localhost:8787
```

Open the URL in **two different browser profiles** (or a normal window plus a
private window — device identity lives in the browser profile, so two tabs of the
same profile are the *same* device and cannot pair with themselves).

1. On device A: **Pair device** → a 6-character code and a QR link appear.
2. On device B: **Pair device** → type the code → **Join**.
3. Both devices show the same 6-digit code: compare them out of band, then press
   **Codes match** on both.
4. Drop a file (or a folder) on the drop zone and accept it on the other device.

## Verify it yourself

```bash
npm run check        # TypeScript, strict, no emit
npm test             # build + 68 unit/integration tests (node:test)
npm run test:e2e     # 14 Playwright tests: two real browsers, plus a no-server
                     # direct-pairing run and a 360×640 layout check
npm run test:desktop # 4 Electron tests under Xvfb (bridge, mDNS, 1 MB transfer)
npm audit --omit=dev # production dependency audit
```

Latest run: **60/60 unit + 12/12 browser tests passing**, `npm audit` clean. See
[docs/TEST-REPORT.md](docs/TEST-REPORT.md) for the exact commands, file sizes,
hashes and limitations.

---

## Capability matrix

Legend: ✅ implemented and verified · ⚠️ implemented with documented limits ·
🚧 designed, not implemented · ❌ not supported (and why)

| Capability | Status | Notes |
|---|---|---|
| Browser client (Chromium/Firefox/Safari engines) | ✅ | Single-page app, no framework; built with TypeScript + esbuild |
| Desktop app (Windows / macOS / Linux) | ✅ | Electron shell (`desktop/`) hosting the same client; AppImage, deb, NSIS installer and portable exe are built from it. Packaged binary verified: correct app name/version, `app.isPackaged`, working desktop bridge and a real 1 MB transfer in the packaged runtime |
| Android app | ⚠️ | Capacitor WebView build; signed release APK + AAB are produced and their contents/signature verified. **Not yet exercised on physical hardware** |
| iOS app | ❌ | Requires a macOS runner plus an Apple Developer account and provisioning profiles. Nothing is claimed here |
| Single / multiple file transfer | ✅ | Verified with 0 B, 41 B, 512 KB, 8 MB, 32 MB and mixed batches |
| **Pairing with no server at all** | ✅ | *Direct code*: the two devices exchange an offer/reply ticket (SDP + identities, deflated base64) with no signalling server and no network service. Verified end to end in `e2e/direct.spec.ts` (pair → verify → 3 MB transfer with matching SHA-256, both devices `offline` throughout) |
| Folder transfer (structure preserved) | ⚠️ | Directory picker uploads nested paths; the manifest and OPFS layout keep the structure, but "Save" downloads files individually (browser restriction) |
| Chunked transfer, bounded memory | ✅ | 64 KiB chunks + ack window; measured **3.3 MB** JS-heap growth for a 32 MB transfer |
| SHA-256 integrity verification | ✅ | Incremental hashing; completion requires a verified digest on both sides |
| Accurate speed / ETA / progress | ✅ | Progress is driven by receiver acknowledgements, never by bytes handed to the socket |
| Cancellation, decline, failure states | ✅ | Covered by unit and browser tests; partial data is discarded |
| **Resumable** transfers | ❌ | Not implemented. An interrupted transfer fails cleanly; see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#resumability-not-implemented) |
| Device identity (ECDSA P-256) + pinned trust | ✅ | Non-extractable key in IndexedDB; device id = SHA-256 of the public key |
| Pairing by short-lived code / QR link | ✅ | 2-minute TTL, single use, per-device rate limits |
| 6-digit key verification (SAS) | ✅ | Derived from both identity keys + ephemeral ECDH + DTLS fingerprints |
| Rename / revoke / disconnect devices | ✅ | Trust is revoked locally; changing a trusted key is refused |
| Local-network discovery (mDNS/broadcast) | ⚠️ | The **desktop app** advertises and browses `_fluxa._tcp` over mDNS (verified by a test that asserts real discovery). Browsers cannot open raw mDNS sockets, so the browser build discovers nothing and relies on the signalling server |
| Direct P2P across networks (STUN) | ⚠️ | Works when ICE host/srflx candidates succeed; needs `FLUXA_ICE_SERVERS` configured |
| Relay fallback (TURN) | ⚠️ | Supported by configuration; **no relay service is bundled or operated** |
| Honest direct-vs-relay indicator | ✅ | Reported from ICE stats (`host`/`srflx` = direct, else relayed) |
| Clipboard / links / browser handoff | 🚧 | Not implemented. No clipboard monitoring exists in this build |
| Transferring package files (APK, MSI, DMG, DEB) | ⚠️ | Transferred as ordinary files only; Fluxa never installs or migrates an app |
| Screen sharing / task continuity | 🚧 | Interfaces are described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#future-continuity); none is implemented |

Anything marked 🚧 or ❌ is *not* present in the UI — Fluxa does not pretend to have
features it lacks.

---

## Platform status

| Platform | Distribution | Built here | Signed | Verified how |
| --- | --- | --- | --- | --- |
| Web (any modern browser) | served from `dist/` + `public/` | ✅ `Fluxa-0.2.0-web.zip` | n/a | 12 Playwright tests, two real browser contexts |
| Linux x86-64 | AppImage, `.deb` | ✅ | ❌ no GPG/repo signing | packaged binary launched under Xvfb: name, version, `isPackaged`, bridge, 1 MB transfer |
| Windows x86-64 | NSIS installer, portable `.exe` | ✅ | ❌ no Authenticode certificate | icon resources and `0.2.0` version resource present in `Fluxa.exe`; installer produced by electron-builder |
| macOS (x64 → also arm64 via CI) | `.dmg`, `.zip` | ⚠️ zip built on Linux | ❌ not signed/notarised | `Info.plist` identifiers/version verified; the dmg is produced only on macOS (see [docs/RELEASE.md](docs/RELEASE.md)) |
| Android (API 24+, target 34) | signed `.apk`, `.aab` | ✅ | ✅ local release key | `apksigner verify` v1+v2, `aapt2 dump badging` (`com.fluxa.transfer`, versionCode 200, versionName 0.2.0, label `Fluxa`, adaptive icon) |
| iOS | — | ❌ | — | needs macOS + Apple Developer account |

**A compiler emitting a file is not proof.** The checks above were run against
the produced files; the exact commands are in
[docs/RELEASE.md](docs/RELEASE.md) and [docs/TEST-REPORT.md](docs/TEST-REPORT.md).

### Desktop application

```bash
npm run desktop        # run the Electron app against the local build
npm run desktop:pack   # unpacked app in release/
```

The desktop build adds what a browser cannot do: mDNS discovery on the LAN, a
native save dialog for received files, a per-user data directory for identity and
received files, and a persistent signalling-server setting (Settings → *Signalling
server*). It is **not** a renamed web page: the renderer is served from
`app.asar` through a privileged protocol handler with a strict CSP, file writes go
through a context-isolated preload bridge (`window.fluxaDesktop`), and remote
content cannot load.

### Pairing modes

| Mode | Needs | How it works |
| --- | --- | --- |
| **Same network** (default) | any Fluxa signalling server — the desktop app's embedded one, or `npm start` | 6-character code + QR, 2-minute TTL, single use |
| **Direct code** | nothing | one device shows `FLX1…` (offer), the other reads it and shows `FLX1…` (reply), the first pastes the reply back. No server, no account, no network service. Tickets can be copied or sent with the system share sheet |

The direct flow pins each device's identity key from the ticket *before* the
WebRTC channel opens, so the same signature + DTLS-binding + 6-digit
verification checks apply — the server was never what made the session secure.

### Android application

```bash
node scripts/sync-android.mjs                 # build web assets → cap sync → version + icons
cd android && ./gradlew assembleRelease bundleRelease
```

Outputs: `android/app/build/outputs/apk/release/Fluxa-0.2.0-release.apk` and
`android/app/build/outputs/bundle/release/Fluxa-0.2.0-release.aab`.

Sideloading needs "install unknown apps" enabled for the file manager; the AAB
is for Play Console upload or `bundletool`. Signing material is generated locally
and **is not registered with Google Play** — see
[docs/RELEASE.md](docs/RELEASE.md#android).

## Packaging and artifacts

```bash
npm run dist:linux   # release/Fluxa-<version>-linux-x86_64.AppImage + .deb
npm run dist:win     # release/Fluxa-<version>-x64-setup.exe + -portable.exe
npm run dist:mac     # macOS only: release/Fluxa-<version>-mac-*.dmg/.zip
npm run version:sync # package.json → android/version.properties + strings.xml
node scripts/build-manifest.mjs --out artifacts/manifest   # hashes + signing state
```

Artifacts are never committed; CI uploads them to the CircleCI job and, on a
version tag, to a **draft** GitHub release. Every build writes
`build-manifest.json` (version, commit, per-file SHA-256, signing state) next to
the files.

## Continuous integration

[![CircleCI](https://dl.circleci.com/status-badge/img/gh/favour187/fluxa/tree/main.svg?style=shield)](https://app.circleci.com/pipelines/github/favour187/fluxa)


CircleCI runs `.circleci/config.yml`: `validate` (type-check, 60 unit tests,
production build), `security` (production audit + secret scan), `e2e-browser`,
`e2e-desktop`, and platform builds for web, Linux, Windows, Android and macOS.
Tags `v*` add a manual approval before a draft GitHub release. Setup, required
environment variables and the exact commands are in
[docs/CI-CD.md](docs/CI-CD.md).

Latest green run: `main` @ `70daec2` — all ten available jobs passed, including
12/12 browser E2E, 4/4 desktop E2E, and Android signed with the release key
imported from project environment variables.

## How a transfer actually works

```
 A (browser)                                            B (browser)
 ───────────                                            ───────────
 1. identity key (ECDSA P-256, non-extractable, IndexedDB)
 2. ── hello + signature ──►  signalling server  ◄── hello + signature ──
 3. ── createCode ─►  [6-char code, TTL 2 min, single use]
 4. ◄──────────── claimCode ────────────────────────────┘
 5. ── SDP offer / ICE ──►  relay (server only forwards)  ── answer / ICE ──
 6. ══ DTLS handshake, direct peer-to-peer, no file bytes on the server ══
 7. both sides sign a hello that binds (identity keys, session nonce, DTLS fingerprints)
    → both compute the same 6-digit code → humans compare → session unlocked
 8. manifest → accept → 64 KiB chunks → chunkAck → fileEnd(sha256) → fileResult
 9. done  (only after every file verified and finalised)
```

The server is a signalling and static-file host. It never receives file bytes.
For remote networks it can be configured with STUN/TURN; TURN relays encrypted
DTLS packets without being able to read them. See
[docs/NETWORKING.md](docs/NETWORKING.md).

### Project layout

```
src/shared/      protocol framing, crypto helpers, filename safety, validation
src/server/      HTTP static host + WebSocket signalling, pairing store, rate limits
src/client/      identity, signalling client, WebRTC peer session, transfer engine, UI
desktop/         Electron main process + context-isolated preload bridge (mDNS, fs, save dialog)
android/         Capacitor Android project (generated, tuned: signing, manifest, icons, splash)
scripts/         build, icon/splash generation, version sync, Android sync, build manifest
e2e/             Playwright: two real browsers, real WebRTC, real files
e2e-desktop/     Playwright + Electron: packaged runtime behaviour
test/unit/       Node tests: protocol, crypto, pairing, signalling (real sockets), transfer engine
.circleci/       CircleCI pipeline (validate, security, E2E, per-platform builds, tag release)
docs/            architecture, security, networking, CI/CD, release, test report, platform notes
```

## Security in one paragraph

Devices are identified by an ECDSA key pair, not by a display name. Pairing codes
are random, expire in two minutes, are single use, and are rate limited. The
transport is DTLS between the two browsers (direct, or relayed end-to-end through
TURN). Each session's 6-digit verification code is derived from both identity
keys, an ephemeral ECDH exchange and the negotiated DTLS fingerprints, so a
machine-in-the-middle — including a malicious signalling server — changes the code
the users see. Files are hashed while they stream and a file is only reported as
received after its SHA-256 matches. Read
[docs/SECURITY.md](docs/SECURITY.md) for the threat model, the assumptions, and
the things this design does **not** protect against.

## Requirements

* Node.js ≥ 20 (server, tests, builds) and npm
* A modern browser with WebRTC DataChannels and IndexedDB
* Linux/macOS/Windows for the server; it is a single process with no database
* Packaging: electron-builder (downloads its own tooling); Android needs JDK 17+
  and the Android SDK (build-tools 35, platform 34)
* Optional for Windows packages on a Linux host: `wine` + `wine32`

## License

MIT — see [LICENSE](LICENSE).

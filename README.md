# Fluxa

**Move anything. Anywhere.** Fluxa is an open-source, device-to-device transfer and handoff app. Web, Electron desktop and Capacitor mobile projects share one TypeScript/WebRTC engine. Transfer protocol **v2** is incompatible with v1: update the app and broker together.

## Get started

```bash
npm ci
npm run build
npm start                         # http://localhost:8787 on this computer
```

Open Fluxa on two independent browser profiles/devices. On one, tap **Pair device**; on the other, scan its QR in Fluxa or enter the six-character code. **Compare the same six-digit verification code on both screens** (in person or over a trusted call) before accepting. Choose files and use **Send now** or swipe the staged card to the edge; the recipient approves. If no signalling server is reachable, use **Direct code**: exchange offer and reply tickets, then verify. Direct peer traffic still requires a viable ICE network path.

For a **phone and desktop** on the same Wi-Fi, the phone needs the desktop's private-LAN server address, *not* `127.0.0.1`. A desktop that is actually listening on the LAN advertises its candidate LAN addresses in Settings; its QR includes the reachable endpoint for an installed Fluxa app. Scan with Fluxa's camera or configure the same server on both devices. A plain HTTP LAN site may lack browser WebCrypto/camera secure-context features: prefer the packaged mobile app or HTTPS. A public broker must use `wss://`. Both devices still verify the SAS; the QR/server is not a trust signal.

## Useful controls

| Action | How it works |
| --- | --- |
| Files and folders | Pick, drop or stage files and swipe the edge to send; default is **ask the recipient**. Peer-to-peer DTLS DataChannel, bounded chunks, SHA-256 integrity, speed/ETA, cancellation and local history. Receiver exports verified files explicitly. |
| Recovery | OPFS + IndexedDB retain partial bytes/metadata where supported. After interruption, pair/verify again, reselect the original source and rehash prefixes; this is **not** automatic background resume. |
| Messages and manual sharing | Verified, delivery-acknowledged chat. Send text, clipboard content, links or a work URL/note only by action; recipient approves, then explicitly copies or opens. |
| Live clipboard sync | Select a verified device → **Sync text clipboard** → both sides opt in. Only later changes to plain text up to 16 KiB are mirrored, not the initial clipboard; either side can stop. Browser tabs must stay focused; packaged mobile apps stay in the foreground and OS paste prompts may apply. The desktop app can mirror while open. **Do not copy passwords/secrets while sync is on.** Nothing is saved to history or signalling. |
| Live screen sharing | **Share screen** invokes the browser/desktop OS source picker. The other verified device must tap **View screen**. Encrypted WebRTC video travels over the existing peer connection; no audio, recording or remote control. Both can stop; source capture ends on disconnect. Screen capture availability is browser/OS-dependent; mobile WebView capture is not claimed. |
| Transfer rules | In a verified device's **Transfer rules**, keep **Ask** (default), **Block**, or opt into auto-accept for small allowlisted extensions, with a 1–100 MiB batch cap. Automatic receipts stay in app-private durable storage and are never opened or saved to a public folder. Unsupported types, oversized batches or missing storage fall back to Ask. Optional file-picker immediate-send skips staging; desktop-only background auto-accept requires a separate opt-in. |
| Tab handoff / extension | A Manifest V3 Chrome/Edge/Firefox-compatible companion explicitly captures only the selected tab's URL/title; Fluxa shows a draft for review and a verified destination choice. Recipient approves and opens separately. No third-party cookies, passwords, account session or app data is copied. See [extension installation](extension/README.md). |

The handoff's “secure other method” is **verified device identity, a DTLS-protected channel and two-sided review**, not a shared Fluxa login. A destination must sign in to third-party websites itself. URLs can themselves contain sensitive query tokens: review the entire address before sending. Browser extension web mode uses a local fragment and same-origin mailbox to avoid interrupting an already-connected Fluxa tab; installed desktop mode uses a `fluxa://handoff` OS handler when registered.

## Validate this revision

```bash
npm run check
npm test                         # Node/unit/security and extension link tests
npm run test:e2e                 # Chromium browser pair/transfer/consent/recovery
xvfb-run -a npm run test:desktop # Linux Electron IPC, two-instance transfer, mDNS
npm run android:sync             # native source/plugin registration, NOT an APK build
npm run ios:sync                 # native source/plugin registration, NOT an iOS build
npm audit --omit=dev --audit-level=critical
```

On the local combined PR #4 + feature working tree (2026-10-25): **93 unit/extension tests, 33 browser E2E and six Linux Electron E2E passed; TypeScript, builds, both Capacitor syncs and the production critical audit passed.** QR scanning used a simulated camera; screen E2E used a simulated capture source but genuine browser WebRTC media. These are *not* phone/hardware tests. The current feature tree has **not** produced or verified a new Android/iOS/Windows/macOS binary, nor been store-published. An earlier, separate merged commit `e310d79` **did** pass CircleCI pipeline 32, including genuinely release-signed APK/AAB outputs; those artifacts are for that older commit, not this revision. An unpacked Chrome extension was loaded locally; browser-store signing and real OS custom-protocol opening remain unverified.

| Platform | Status for this revision | Remaining verification/distribution |
| --- | --- | --- |
| Web/Chromium on Linux | Browser E2E and unit tests above passed | Real LAN, physical phone, Safari/Firefox/Edge and NAT tests remain |
| Linux Electron | Six real-process E2E passed, including clipboard IPC, local handoff handler and simulated picker cancellation | Fresh installer build, real OS screen-source selection/protocol link, physical LAN test and package signing remain |
| Windows/macOS Electron | Shared source | This revision needs target builds, runtime tests, OS protocol association and appropriate signing/notarisation |
| Android | Capacitor assets/plugins synced, including Clipboard | No Android SDK/build or physical device test here. A new CircleCI run/build must be checked by its commit. Earlier signed PR #3 artifacts are not current binaries |
| iOS/iPadOS | Capacitor assets/Podfile synced | No CocoaPods/Xcode/IPA or device test on Linux; Apple signing and Mac verification needed |
| Extension | Manifest V3 source, unpacked Chrome load, link tests and web-handoff E2E | Not on browser stores; desktop OS handoff launch and Firefox/Edge UI need real browser tests |

No repository-operated public relay, account-sync service, auto-login, background mobile service or universal device compatibility is implied. Same-Wi-Fi transfers depend on direct ICE connectivity; remote/NAT-blocked routes may require an independently deployed STUN/TURN and WSS signalling server. More: [architecture](docs/ARCHITECTURE.md), [networking](docs/NETWORKING.md), [platform notes](docs/PLATFORM-NOTES.md), [release/signing](docs/RELEASE.md), [security](docs/SECURITY.md), [tests](docs/TEST-REPORT.md).

MIT licensed. A matching checksum proves received bytes were not changed, **not** that an executable or document is safe to run.

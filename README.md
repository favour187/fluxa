# Fluxa

**Move anything. Anywhere.** Fluxa is an open-source, device-to-device transfer and handoff app. Web, Electron desktop and Capacitor mobile projects share one TypeScript/WebRTC engine. Transfer protocol **v2** is incompatible with v1: update the app and broker together.

> **Android follow-up (source branch, 2026-10-25):** A real two-phone test of the previously signed APK (`e5940ed`) reported an immediate disconnect after Direct QR / six-digit approval. This branch removes the pre-reply 25-second QR timeout, prevents a stale QR ticket from returning after SAS, preserves the FIRST actual WebRTC failure reason on screen, and adds Android's **Share → Fluxa** target for links, text and files. A local Android debug build and browser tests are not proof that the two phones now stay connected. The old signed APK does **not** contain these fixes; this branch is not a signed release. See [Android follow-up notes](docs/PLATFORM-NOTES.md#android-direct-qr--share-target-follow-up-2026-10-25).

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
| Android Share target (no extension) | In Chrome/Files/Photos or another Android app, use **Share → Fluxa**. Fluxa stages text, URLs and content-provider files in a bounded private inbox; review the full link, select a live verified device and tap Send. The receiver still approves. Each item remains queued until receipt/approval or manual discard. Up to 32 files, 512 MiB per file, 1 GiB total staged data and 20 items; large shares can still use Fluxa's in-app file picker. Sending still needs Fluxa open on both phones and a viable network path: this is not a universal cross-app edge gesture or autonomous background transfer. |
| Tab handoff / extension (optional on desktop/web) | A Manifest V3 Chrome/Edge/Firefox-compatible companion explicitly captures only the selected tab's URL/title; Fluxa shows a draft for review and a verified destination choice. Recipient approves and opens separately. No third-party cookies, passwords, account session or app data is copied. See [extension installation](extension/README.md). |

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

**Verification by commit (2026-10-25):** PR #4 and the optional-camera PR #5 were merged; final `main` at `e5940ed8aabd167dabff27bf6db29d96f6295cf9` passed [pipeline 42](https://app.circleci.com/pipelines/github/favour187/fluxa/42), all nine jobs. Its Android release APK/AAB were independently checked for the expected commit, SHA-256, release signatures, and optional compiled camera features. **Real two-phone use exposed a Direct QR disconnect after six-digit approval.** A passing CI package did not establish phone compatibility. This working follow-up branch has locally passed strict TypeScript, 102 unit/extension tests, 35 Chromium E2E (including Direct re-pairing and one mock-native Android Share E2E), Android debug and unsigned release compilation, release vital lint and two native JUnit tests; it has **not** been release-signed, merged or physically retested. QR camera/OS share source and screen picker browser E2E used simulations, not phone hardware.

| Platform | Verified evidence | Still required |
| --- | --- | --- |
| Web/Chromium on Linux | Browser E2E, including serverless Direct WebRTC and explicit consent | Real LAN, Android/other browser combinations and NAT tests |
| Linux Electron | Real-process E2E and unsigned Linux builds for final `main` | Installed runtime, real OS screen picker and platform signing |
| Windows/macOS Electron | Final-main CI built Windows and unsigned cross-built macOS artifacts | Native runtime/installation, proper signing/notarisation |
| Android | Final-main APK/AAB are correctly release-signed, **but the user's two-phone pairing failed**. Follow-up source compiled in debug and native JUnit passed | Determine the physical cause, two-phone retest, CI on the follow-up commit, separately verified release signing and distribution |
| iOS/iPadOS | Capacitor source/Podfile synced | Mac CocoaPods/Xcode build, signing and devices |
| Extension | Source, unpacked Chrome and browser handoff E2E | Store distribution and OS handoff testing; Android Share target does not need it |

No repository-operated public relay, account-sync service, auto-login, background mobile service or universal device compatibility is implied. Same-Wi-Fi transfers depend on direct ICE connectivity; remote/NAT-blocked routes may require an independently deployed STUN/TURN and WSS signalling server. More: [architecture](docs/ARCHITECTURE.md), [networking](docs/NETWORKING.md), [platform notes](docs/PLATFORM-NOTES.md), [release/signing](docs/RELEASE.md), [security](docs/SECURITY.md), [tests](docs/TEST-REPORT.md).

MIT licensed. A matching checksum proves received bytes were not changed, **not** that an executable or document is safe to run.

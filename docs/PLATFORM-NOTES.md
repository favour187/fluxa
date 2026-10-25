# Platform status and restrictions

One TypeScript/WebRTC engine serves web, Electron, Android WebView and iOS WKWebView. **Shared source and Capacitor sync do not prove an installed app works.** The latest dated results are in [TEST-REPORT.md](TEST-REPORT.md); the signed Android artifact correction below distinguishes commits.

| Target | Evidence for the PR #4 merge and this follow-up (2026-10-25) | Still required |
| --- | --- | --- |
| Chromium browser on Linux | TypeScript, 93 Node/extension tests and **33 Chromium E2E** passed after the final camera-policy and screen-negotiation-race fixes. QR camera and display capture are **simulated streams**, but decoding/WebRTC media and peer verification are real in tests | Real phone, same-Wi-Fi, network permission and other browsers |
| Linux Electron | Six real Electron-process E2E passed: bridge consent, handoff receiver, simulated screen-picker cancellation, two-instance transfer, mDNS, profile restart. Pipeline 40 built unsigned Linux packages for `393fa38` | Fresh packaged-app distribution/runtime, real OS screen picker/protocol dispatch and physical LAN |
| Windows/macOS | Main pipeline 40 built unsigned Windows packages and a Linux-cross-built unsigned macOS ZIP for merge commit `393fa38` | Runtime/install on target OS, desktop protocol and appropriate Authenticode/Developer ID/notarisation |
| Android | Main pipeline 40 produced genuinely release-signed APK/AAB for `393fa38`; independent badging showed an **implied required camera feature**. This follow-up declares camera hardware optional and adds an APK-level CI check | Follow-up's own signed CI artifacts and no-required-camera badging check, then phone tests; **do not treat the older signed APK as final** |
| iOS/iPadOS | iOS project, camera usage string, URL handler and Clipboard/App/Filesystem/Share Podfile synced on Linux | CocoaPods/Xcode compile, simulator/phone, code signing/provisioning and IPA require macOS |
| Browser extension | Manifest V3 unpacked Chrome load, pure link-builder tests, same-origin handoff browser E2E | Real Chrome/Edge/Firefox extension popup and installed desktop external-protocol flow; browser-store signing/listing |

**Signing by commit:** PR #3's `e310d7963d52` passed main pipeline 32 with genuinely signed APK/AAB (see `FLUXA-PR3-MERGE-RESULTS.md`). PR #4 merged at `393fa38f0559` after branch pipeline 39 passed six jobs; its main pipeline 40 passed nine jobs. For `393fa38`, the new APK and AAB were downloaded and independently SHA-256/signature verified. The APK has a release signer but erroneously implied required camera hardware. This follow-up source corrects that packaging policy; **only** its own subsequent CI artifact can attest the corrected package. None of these builds is a phone compatibility test, iOS build or store upload.

## Browser and native permissions

Web browsers require secure contexts for WebCrypto, clipboard API, QR camera and display capture. `localhost` is a special local secure context; **plain HTTP to a computer's LAN IP often is not**. For phone-to-desktop pairing, use the packaged mobile app (`https://localhost` WebView origin) with a reachable private-LAN broker, or deploy HTTPS/WSS. The local desktop server exposes candidate Wi-Fi/LAN addresses, but interface selection, firewall, NAT and ICE still need real-hardware checks. Scanner JS has a bundled QR decoder fallback for browsers without `BarcodeDetector`; phone camera hardware was not tested. Android declares CAMERA permission while marking `camera`, `camera.any` and autofocus hardware **not required**; the camera is requested only when the QR scanner opens. CI now checks the *compiled APK badging* as well as source XML, because camera permission alone can imply required hardware. iOS declares `NSCameraUsageDescription`; OS permission handling remains to be checked on-device.

Live clipboard sync is a **two-device opt-in session** for subsequent plain text up to 16 KiB. Browser tabs require focus, packaged mobile apps only poll while visible (iOS may prompt to paste), and an open desktop app can poll even when its window is not foregrounded. It is not a credential manager; copied secrets can leak to the other opted-in device. Manual per-item shares remain available. Screen capture uses `getDisplayMedia` and the Electron OS source picker where supported; no audio/remote control. Mobile WebView screen-source capture is not guaranteed, and an inactive app cannot keep a screen stream alive reliably.

OPFS enables durable large-file recovery where available. Without it, transfers use bounded in-memory fallback and cannot resume after restart. Site-data clearing/eviction can remove keys, trust or partial data. Browser download fallback can flatten folders; a user-picked directory preserves paths in supporting Chromium browsers. Capacitor native exports write unique Documents directories then may offer the OS share sheet, **not** arbitrary unrestricted filesystem access.

Transfer automation is per verified device and defaults to Ask. Optional auto-accept applies only to bounded, allowlisted file extensions into private durable storage, and never auto-opens files. Only desktop users can explicitly enable auto-accept while the window is not visible; no mobile/background service or OS-wide automation is shipped. File-picker immediate-send is an opt-in local preference and still begins with a user selecting files. Interruption recovery remains explicit: pair → verify → reselect sources → rehash committed bytes → resume when possible.

The tab-handoff extension provides a reviewed URL/title, not third-party cookies or sign-in continuity. The destination must sign in to web services independently. The registered desktop `fluxa://handoff` receiver only prepares a local draft; normal OS association/browser prompts are not guaranteed on an unpacked build.

**Transferring** APK/MSI/DMG/deb files is ordinary file transfer: Fluxa does not install apps, bypass OS permissions or validate third-party publisher signatures. Same-network and remote transfers still depend on viable WebRTC ICE and, when needed, user-deployed WSS/TURN; no universal offline route is claimed.

## Android Direct QR / Share Target follow-up (2026-10-25)

**Why this exists:** Two actual Android phones using the final signed `e5940ed` APK
exchanged the offer/reply QRs, reached the six-digit SAS, and then immediately
disconnected **while both apps were foregrounded**. A browser test did not
reproduce it. The old signed APK is not a remedy. We do not know the first
WebRTC/ICE error from those phones, so do not claim this follow-up definitively
fixes that physical-device failure.

**Source changes on the follow-up branch:** The Direct host previously started
its 25-second data-channel deadline when it *displayed the invitation*, before
any human could scan the two QRs; it now starts after the host applies the
reply. Peer teardown latches the first reason, so an Android WebView's secondary
`onclose` cannot replace `connection failed` with a reasonless `Disconnected`.
The selected device card now retains the reason (with ICE/transport state),
provides **Pair again**, and labels serverless status as **No pairing server**
(or **Direct connected**) instead of falsely implying the phone has no network.
An asynchronous handshake cannot resurrect a closed connection or republish a
stale Direct ticket *after* the verification dialog has taken over. A repeated
Direct pairing replaces the previous live session rather than being cancelled
by an unrelated connected peer; this precise sequence now has browser E2E
coverage. Trust is not saved merely for scanning a direct reply before SAS
approval. All new sessions still require explicit SAS comparison.

The installed Android app now registers `ACTION_SEND`/`ACTION_SEND_MULTIPLE`
for **Share → Fluxa**, in addition to its existing pairing deep link. The
native plugin copies only explicitly shared text and granted `content://` files
into app-private storage with 64 KiB I/O, bounded item/size limits, and no
clipboard polling, overlay or Accessibility Service. Mixed file+text shares
create separate inbox cards so each can be acknowledged independently. On
restart the inbox can be reviewed again; nothing is remotely delivered until
**a live verified peer is selected and Send is tapped**. Text/links require the
recipient's approval (then explicit copy/open); files are removed from the
local inbox only after the receiver's verified completion acknowledgement.
Android links may contain sensitive query tokens; inspect the full link before
sending. The staging area is app-private, not end-to-end encrypted at rest;
Android storage protection and `allowBackup=false` apply. Share target limits:
32 files per action, 512 MiB per file, 1 GiB total local inbox, 20 queued
items and 16 KiB of text. Android `ACTION_SEND` content URIs need the sharing
app's read grant. Unsupported app content or oversized input fails visibly;
ordinary in-app pickers remain the fallback for larger sources.

**Limits that remain:** Android cannot universally intercept swipes along the
screen edge in Chrome/other apps, enumerate browser tabs, or read the clipboard
in the background as a normal app. Other apps must expose Share; no browser
extension is needed for the Android Share path. This is **not** a foreground
service, native background WebRTC engine, background receiver, auto-reconnect,
or cross-app drag target. A Direct QR ticket requires a viable local ICE path
(both phones typically on the same Wi-Fi without guest/client isolation).
Phone/laptop delivery works while the destination Fluxa instance is connected;
a desktop app may provide a separate pairing broker, but these Direct QRs use
no broker. Leave Fluxa open until the other device confirms receipt. If the
physical Android disconnect recurs, the retained **Reason** on BOTH devices
would be useful; a redacted `adb logcat` around the failure could help if
available. Without those observations the physical root cause may remain
unknown. Do not send QR tickets (they can reveal local network addresses), file
contents or signing credentials in logs.

**Evidence for this branch (not a release):** strict TypeScript, 102 Node/unit/
extension tests, **35/35** Chromium E2E (including serverless Direct WebRTC,
re-pairing after verification and a *simulated* Android plugin-boundary test
exercising review, approval and streamed receipt). Local SDK/JDK 17 `:app:testDebugUnitTest`, `:app:assembleDebug`,
`assembleRelease`, `bundleRelease` and Android release vital lint passed. Compiled
APK manifest/DEX contain Share actions/plugin, with camera hardware optional.
The debug APK is signed with Android's *debug* certificate, not the release key;
it uses a separate `.debug` package/data store. The local release APK/AAB are
**unsigned**. No two-physical-phone retest of this source, new CI-signed release
APK/AAB, iOS build or guarantee of background phone operation. CI adds native
JUnit and compiled manifest/DEX share-target gates for a future pushed
revision; their success is not claimed until CI runs.

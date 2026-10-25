# Platform status and restrictions

The app has **one TypeScript/WebRTC transfer implementation**, reused by web,
Electron, Android WebView and iOS WKWebView. Source sharing is not equivalent to
having built/signed/tested every target. The latest dated verification results
are in [TEST-REPORT.md](TEST-REPORT.md).

| Platform | Source | Local build | Real-device run | Distribution |
| --- | --- | --- | --- | --- |
| Chromium browser on Linux | Present | Yes | Two local headless contexts (including restart/resume) | Web app; PWA depends on a secure deployment |
| Linux desktop | Electron source | E2E launched Linux Electron; local AppImage/deb built, packaged-unpacked binary smoke-tested | No external LAN/physical device or installer run | Unsigned AppImage/deb; no distro signing |
| Windows desktop | Electron source | Windows CI **baseline** built NSIS/portable, not this unpushed diff | No Windows machine test of this diff | Needs platform test; no Authenticode credential |
| macOS desktop | Electron source | New unsigned x64 `.app` ZIP cross-built on Linux; Mac job gated on a Mac executor | No macOS machine test of this diff | Needs real Mac build, Apple Developer ID + notarisation for normal distribution |
| Android | Capacitor project + plugins | Local `assembleRelease bundleRelease` passed; local release outputs **unsigned** and debug APK debug-signed. Previous upstream CircleCI job 173 produced a **release-key signed** APK (v1/v2 independently verified) and AAB, for *earlier source* | No Android phone/emulator test of this change | Existing CI key is not available locally; this revision needs its own signed CI build and physical Android check |
| iOS/iPadOS | Xcode/Capacitor project, iOS 17 deployment target | `cap sync ios` copied assets/plugins on Linux; pods/Xcode **not** run | No simulator or iPhone test | Needs Mac/Xcode, a developer team and signing/provisioning for an IPA |

## Browser/WebView dependencies

Requires WebRTC DataChannels, WebCrypto ECDSA/ECDH, IndexedDB CryptoKey storage
and an origin-private filesystem (OPFS) for **durable** large-file recovery.
When OPFS is missing, receive falls back to bounded in-memory storage and
interruption **cannot** be resumed. Users must grant file/directory picker or
clipboard access through explicit actions. Site-data clearing/OS eviction may
remove identity keys or OPFS bytes. Always re-check SAS if the identity changes.

On Chromium, user-selected directory export preserves nested paths and verifies
written bytes; browsers without `showDirectoryPicker` download files
individually. Browser download folders are outside Fluxa's control. Neither a
website nor an iOS WebView can silently enumerate or install apps, inspect
another app's data, read browser cookies/tabs, or continuously monitor the
clipboard. Link/session handoff only shares a **manually entered URL/note**;
it does not move authentication state or open tabs automatically.

## Native constraints

Android/iOS app origins use packaged WebViews with Capacitor Filesystem, Share
and App plugins. Native exports use Documents + an optional OS share sheet and
unique directories, **not** unrestricted access to the system Downloads folder
or all Files app locations. Android's network security config enables cleartext
for user-selected private LAN broker addresses; remote brokers need WSS.
iOS declares local-network usage and custom `fluxa://pair` links and permits
local ATS networking. These settings need on-device verification, including
permission prompts, foreground/background transitions, iOS WebKit OPFS behaviour,
link handling, Files exports and interoperability with desktops. Pairing links
do not grant trust; both users still compare six digits.

Mobile OS background suspension may stop a transfer. The restart flow is
re-pair → verify → approve → reselect the same source(s) → compare committed
prefix hashes. There is no background service/tray, automatic resume or
cross-network access without a reachable broker and viable ICE/TURN.

Desktop Electron provides a native save dialog, bounded streaming IPC, an
embedded LAN broker and mDNS discovery. The renderer has no Node globals and
cannot save to an arbitrary path without a one-use dialog capability. Normal
macOS distribution needs signing/notarisation, Windows may warn without
Authenticode, and Linux packages are not distro-repository signed.

**Transferring** an APK/MSI/DMG/deb is ordinary file transfer; installation,
installer permissions and package signatures are always the operating system's
decision. No privileged installer or full-device migration is part of Fluxa.

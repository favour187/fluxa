# Platform notes and honest restrictions

Fluxa's reference client is a **web application**. This page records what that
means per platform, and what a native client would and would not be allowed to do.

## Today: web client

| Platform | Runs Fluxa? | Restrictions you will notice |
|---|---|---|
| Windows 10/11 | Yes (Chrome, Edge, Firefox) | Files land wherever the browser's download folder is; no system tray or background service; drag-and-drop from Explorer works |
| macOS | Yes (Safari 17+, Chrome, Firefox) | Safari requires a user gesture for downloads; large-file reception uses OPFS (Safari supports it) |
| Linux | Yes (Chromium, Firefox) | Same as above |
| Android | Yes (Chrome, Firefox) | Backgrounding the browser can suspend the tab and abort a transfer; no "share to Fluxa" target without a native app; file picker writes to Downloads |
| iOS / iPadOS | Yes (Safari 17+) | Aggressive tab suspension; **background transfers are not reliable**; iOS will not let a web app install an app package or read other apps' data |

### Browser APIs Fluxa depends on

* WebRTC DataChannels (all current browsers)
* IndexedDB with non-extractable `CryptoKey` storage (all current browsers)
* Origin Private File System for files > 8 MiB (Chrome/Edge/Firefox 111+/Safari 16.4+;
  Fluxa falls back to in-memory storage with a smaller size ceiling)
* WebCrypto ECDSA/ECDH/HKDF/SHA-256

### What the web build deliberately does not do

| Feature | Why not |
|---|---|
| Local-network discovery | No browser API exposes LAN peers; discovery needs a native client or explicit pairing |
| Clipboard monitoring | There is no permission model for "silently watch the clipboard", and the brief forbids it. Clipboard sharing is not implemented at all in this build |
| Browser tab handoff | Requires a browser extension with `tabs` permission; not built |
| Installing transferred packages | Fluxa transfers *files*. Installing an APK/MSI/DMG/DEB is the OS's decision, with its own signing and permission rules |
| Copying installed iOS apps or protected app data | Prohibited by iOS; Fluxa does not attempt it |
| Session/cookie transfer | Never implemented. Authentication cookies, passwords and tokens are out of scope |
| Permanent background transfers | Browsers expire background tabs; a resumed-on-reconnect design is required (see ARCHITECTURE.md) |

## What the desktop shell already provides

Fluxa ships an Electron shell (`desktop/`) that hosts the exact same client inside
`app.asar`, served through a privileged protocol handler with a strict CSP. It
adds, today and verified by tests:

* **mDNS discovery** of `_fluxa._tcp` peers on the local network (browsers cannot
  open raw mDNS sockets). The desktop test asserts a real advertisement is
  discovered — discovery is a shortcut to pairing, never trust.
* **Native save dialog** for received files, and a per-user data directory that
  survives restarts.
* **Persistent signalling-server setting**, so a self-hosted server does not have
  to be re-entered per session.

What the shell still does **not** do: background transfers after the window
closes, tray/menu-bar presence, OS share targets, platform keystores for the
identity key (it is still IndexedDB inside the app's origin), or folder sinks.

## What a deeper native client would add

The protocol, transfer engine and validation code are transport- and platform-
neutral. A fully native client would add:

* LAN discovery (mDNS on macOS/Linux, DNS-SD/`NsdManager` on Android, `NWBrowser` on
  iOS) with the same pairing/verification flow on top — discovery is never trust.
* Real background transfers, system notifications, share-sheet targets, "send to
  device" context menus.
* Platform keystores for the identity key instead of IndexedDB.
* A directory sink so folders can be written as folders (the web client can only
  download file-by-file without the File System Access API directory picker).
* APK handling on Android: transferring an `application/vnd.android.package-archive`
  is allowed, and the OS installer then applies its own checks. iOS has no
  equivalent, and Fluxa must not pretend otherwise.

## Testing status per platform

* **Verified:** headless Chromium (Linux container) via Playwright — 12 end-to-end
  tests, two independent browser contexts, real WebRTC and real files.
* **Verified:** the packaged Linux desktop app (`release/linux-unpacked/fluxa`) under
  Xvfb — app name/version/`isPackaged`, preload bridge, mDNS discovery, 1 MB
  transfer with matching SHA-256, identity persistence.
* **Built and inspected, not run on real hardware:** Android release APK/AAB
  (signature, badging, assets, icons, splash), Windows NSIS/portable exe (version
  resource, icons), macOS `.app`/`.zip` (`Info.plist`).
* **Not verified anywhere yet:** Safari, Firefox, iOS, and any physical phone or
  Windows/macOS machine. The code paths are standards-based and the UI is
  responsive, but nobody should read this repository as "tested on every
  platform" until those runs exist. A reproducibility script is in
  TEST-REPORT.md.

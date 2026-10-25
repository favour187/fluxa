# Fluxa product scope and acceptance checklist

This document preserves the product requirements for Fluxa. It is the target scope, not a claim that every item is already implemented or tested.

## Core experience

- **Edge gesture and ripple:** users can select content and use a clear edge-directed touch gesture to send it to a chosen nearby device. Both endpoints should show a coordinated ripple, with motion that respects reduced-motion settings. Keep standard file-picker and drag-and-drop fallbacks.
- **Six-character pairing:** easy manual entry, QR pairing where practical, expiry and replay protection, and a short code that resolves connection setup rather than truncating the underlying connection data. Keep the six-digit out-of-band security verification.
- **Local-first transfer:** prioritize a direct WebRTC path on the same Wi-Fi or phone hotspot when the network permits it. Do not promise offline direct connectivity on networks that block peer traffic; clearly explain when signalling or a relay is required.
- **Real messaging:** bidirectional text messages between verified connected devices, with timestamps and clear sending/delivery/error states. Messages must use the authenticated peer channel, not a pretend local-only chat UI.
- **Files and folders:** transfer single and multiple files, folder trees, photos, videos, documents, archives, APKs, and developer project artifacts. Preserve relative paths when the platform permits it.
- **Transfer controls:** consent/acceptance, rejection, cancellation, progress, speed, ETA, integrity verification, clear failures, retry and interrupted-transfer recovery where supported.
- **Web Share:** receive supported content from the OS/browser share sheet into Fluxa, and share supported Fluxa content outward. Use native share plugins on mobile and the Web Share API/share-target integration where supported, with graceful fallbacks.
- **Links, clipboard and handoff:** manual link/text shares still require receiving approval. Live clipboard text mirroring may monitor *only after both verified devices explicitly opt in* and must stop on either device; copied secrets are not filtered. Browser handoff shares only the selected tab URL/title after sender review and receiver approval. Never read or transfer third-party cookies, passwords, application login sessions or browsing history.
- **Screen sharing:** sender explicitly picks a source; the verified recipient consents; video is encrypted, stop-able and never recorded or remotely controlled by Fluxa. Mobile capture is conditional on platform support.
- **Transfer preferences:** per-verified-device Ask (default), Block, or bounded allowlisted auto-accept into private storage; optional explicit-selection immediate-send and desktop-only opted-in window-background auto-accept. No silent auto-open or OS-wide mobile background service.
- **Device and history management:** verified/trusted devices, connection state, transfer history, useful notifications, and controls to remove trust or clear local data.
- **Cross-platform UX:** web, Android, iOS/iPadOS, Windows, macOS, and Linux, while documenting OS/browser limitations instead of implying identical capabilities.
- **Quality:** responsive mobile and desktop layouts, keyboard/accessibility support, reduced-motion support, secure input/path validation, useful loading/empty/error states, and working controls.

## Implementation guardrails

1. Preserve the existing signed identity, six-digit verification, encrypted WebRTC data channel, chunk acknowledgements, SHA-256 checks, consent, and safe file-export boundaries.
2. Never shorten a direct SDP/identity ticket by truncation. A short direct code needs a real discovery/exchange mechanism or must use an available signalling service.
3. Same-network discovery and phone-to-phone offline setup are different platform problems. Browser clients cannot automatically host a reachable LAN signalling service on every mobile OS.
4. Web Share Target requires a supported browser/PWA manifest and server-side handling; native share-sheet support does not automatically implement browser inbound sharing.
5. Keep platform status honest. A shared source tree is not proof of a signed, built, or device-tested release.

## Verification checklist

- [x] Final TypeScript, 93 Node/unit/extension-link, 33 Chromium E2E and six Linux Electron E2E passed locally after feature/race fixes.
- [x] Two independent Chromium contexts pair, verify, exchange messages and transfer files; browser E2E also exercised clipboard, screen/video, handoff draft, QR and rules.
- [ ] Same-LAN/hotspot path and phone-to-phone offline route are tested on real devices; no-internet claims remain limited to tested ICE conditions.
- [ ] Edge swipe and CSS transfer ripple have automated browser coverage, but real touch/hardware timing and screen-reader usability need validation. Send now is the explicit button/keyboard fallback.
- [ ] Browser OS Share Target/inbound share and platform-specific share-out have not all been validated; native Capacitor Share is wired but hardware checks are pending.
- [x] Folder paths, cancellation, integrity failures, retry/recovery and partial rehash were exercised by automated tests.
- [x] Android, iOS, Windows, macOS and Linux source/build/runtime evidence is recorded separately, including **not built** where appropriate.

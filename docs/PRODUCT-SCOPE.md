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
- **Links, clipboard and handoff:** explicit user-initiated link/text/clipboard sharing with receiver approval. Do not silently monitor clipboard contents, browser tabs, cookies, credentials, or application sessions.
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

- [ ] TypeScript check and unit/server tests pass.
- [ ] Two independent browser clients pair, verify, exchange messages, and transfer files in both directions.
- [ ] Same-LAN/hotspot path is tested on real devices; no-internet claims are limited to the tested network path.
- [ ] Edge gesture is usable on touch screens, has a keyboard/fallback path, and triggers synchronized sender/receiver feedback.
- [ ] Share-in and share-out work on each supported platform or show an explicit fallback.
- [ ] Folder paths, cancellation, integrity failures, retries and recovery are tested.
- [ ] Android, iOS, Windows, macOS and Linux builds/runtime checks are recorded separately.

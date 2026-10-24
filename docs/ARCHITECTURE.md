# Fluxa architecture

## Goals

1. **Immediate feel, honest numbers.** Progress reflects bytes the receiver has
   acknowledged, not bytes the sender handed to a socket.
2. **Correctness before features.** A file is "received" only after its SHA-256
   matches the sender's digest, and a transfer is "complete" only when every file
   is verified.
3. **Small, reviewable protocol.** Every message is defined once in
   `src/shared/protocol.ts` and shared by client, server tests and browser tests.
4. **Extensibility without rewrites.** Transport, session and transfer layers are
   separate; content types are just files with a MIME string, so clipboard text,
   links or future app-state payloads reuse the same machinery.

## Layers

```
┌──────────────────────────────────────────────────────────────┐
│ UI (src/client/ui.ts)          projection of AppSnapshot      │
├──────────────────────────────────────────────────────────────┤
│ App (src/client/app.ts)        sessions, devices, transfers   │
├──────────────────────────────────────────────────────────────┤
│ TransferManager                routes traffic, enforces rules │
│   SendTask            ReceiveTask (sinks: memory / OPFS)      │
├──────────────────────────────────────────────────────────────┤
│ PeerSession (WebRTC)   identity pinning, DTLS binding, SAS    │
├──────────────────────────────────────────────────────────────┤
│ SignalClient (WS)      hello signature, code claim, relay     │
└──────────────────────────────────────────────────────────────┘
        ▲                                    ▲
        │  src/shared/protocol.ts            │  src/shared/crypto.ts
        └──────────────┬─────────────────────┘
                       │
        Signalling server (src/server): static host, identity
        verification, pairing store, relay authorisation
```

### Identity

* One ECDSA P-256 key pair per browser profile, generated on first load, stored as
  a **non-extractable** `CryptoKey` in IndexedDB (`fluxa` database).
* `deviceId = base64url(SHA-256(SPKI public key))  →  43 characters`.
* Display names, platforms and fingerprints are *presentation only*; every trust
  decision uses the device id and public key.
* Trusted devices are pinned locally. If a trusted device presents a different
  public key for the same id, Fluxa refuses the session (`trustDevice` throws and
  the app surfaces an error) rather than silently re-pinning.

### Pairing

1. Device A asks the server for a code: 6 characters from a 32-symbol alphabet
   (no `I`, `O`, `0`, `1`), TTL 120 s, single use, one outstanding code per device.
2. Device B submits the code. The server consumes it *before* replying, so a
   concurrent second claim fails.
3. Both sides receive each other's `{connId, deviceId, publicKey, fingerprint,
   name, platform, sessionNonce}`. `sessionNonce` is fresh per pairing and is
   mixed into the verification transcript.
4. QR codes encode `https://host/?pair=CODE`; opening the link claims the code.

### Transport

* WebRTC `RTCPeerConnection`, one ordered `DataChannel` named `fluxa`.
* `PeerSession` (initiator = the device that claimed the code) creates the channel
  and the offer; ICE candidates are trickled through the server and buffered until
  the remote description exists.
* The server authorises relay only between two connections that completed a
  pairing, and only for the message types `offer`, `answer`, `ice`, `bye`,
  `renegotiate`. It cannot inject file data: file bytes never go through it.

### Session verification (the part that must not be skipped)

Both peers, once the DataChannel is open, send a signed `hello`:

```
sig = ECDSA(identityKey, "fluxa/1/hello|deviceId|peerDeviceId|sessionNonce|
                          identityFingerprint|dtlsFingerprint|nonce|ephPub")
```

Acceptance requires all of:

1. `hello.deviceId` and `hello.publicKey` equal the values pinned during pairing.
2. `hello.dtls` equals the SHA-256 fingerprint that actually appears in the
   negotiated SDP (`a=fingerprint:sha-256 …`) — this binds the authenticated key to
   the DTLS session that carries the bytes.
3. The signature verifies over the full transcript.

Then both sides exchange ephemeral ECDH public keys and compute

```
SAS = first 6 digits of SHA-256("fluxa/1/sas" | sessionNonce | sorted(
        (deviceId, fingerprint, ephPub, nonce) for both peers))
```

SAS digits are displayed on both screens. **Nothing can be transferred until both
users confirm.** The 6 digits are order-independent (both peers compute the same
value regardless of who claimed the code) and change if any key, nonce or DTLS
fingerprint differs.

### Transfer protocol

Control frames are JSON, chunk frames are binary, both framed with a 1-byte magic
and a type tag (`src/shared/protocol.ts`):

| Frame | Layout |
|---|---|
| Control | `F1 01 0000 <len:u32be> <json>` |
| Chunk | `F1 02 <streamId:u32be> <offset:f64be> <payload…>` |

Message flow: `manifest → accept → chunk* + chunkAck* → fileEnd(sha256) →
fileResult → … → done`.

Rules enforced by the receiver:

* The manifest is validated and every name/path is sanitised
  (`sanitizeFilename`, `sanitizeRelPath`): no traversal, no absolute paths, no NUL
  bytes, no Windows reserved names, bounded length and depth.
* Chunks for unknown streams, out-of-order offsets, or data beyond the declared
  size are hard failures, not best-effort writes.
* Writes are serialised through a promise chain so asynchronous disk writes can
  never reorder bytes.
* Per-file SHA-256 is computed incrementally (WebCrypto has no streaming digest, so
  `src/client/sha256.ts` implements one and is tested against Node's crypto).
* `done` is only accepted when every stream is finalised and verified.

Backpressure is enforced twice: the sender waits for `bufferedamountlow` when the
DataChannel buffer exceeds 1 MiB, and it also keeps at most 8 MiB unacknowledged.

Progress = acknowledged bytes. Speed is an EWMA of acknowledged throughput; the
ETA is therefore stable and cannot claim faster-than-real progress.

### Storage on the receiving side

* Files ≤ 8 MiB, or any transfer in a browser without OPFS: `MemorySink`
  (a `Blob` the user can save).
* Larger files: `OpfsSink` writes to the Origin Private File System in 64 KiB
  chunk writes, so file size is bounded by quota, not by RAM. Measured heap growth
  for a 32 MB transfer: **3.3 MB**.
* Nothing is finalised until the digest matches. On failure or cancellation, both
  sinks discard their data (`abort()` also removes the OPFS entry).

### Resumability (not implemented)

Resume is deliberately absent: a correct implementation has to persist transfer
id, stream ids, per-stream byte ranges, hashes of received ranges and the session
nonce, and both peers must agree on all of it after reconnecting — resuming on
filename/size alone is unsafe because it can splice two different files together.
The intended design is a `resume` control message carrying
`{transferId, streamId, nextOffset, partialDigest}` validated against a persisted
receive log; until that exists, interrupted transfers fail cleanly and the partial
file is deleted.

### Native clients

The transport-agnostic layers (`shared/protocol`, `shared/filename`, the transfer
engine, `sha256`) contain no browser-only API except WebCrypto and timers, so a
native shell can reuse them by supplying:

* a key store backed by the platform keystore (Keychain / Keystore / TPM),
* a socket transport (WebRTC via `flutter_webrtc`, or a TLS-QUIC channel with the
  same framing),
* a file sink using the platform's file APIs.

The browser client is the reference implementation: Windows/macOS/Linux/Android/
iOS apps are **planned, not built**.

### Future continuity

The following are design notes only — none is implemented:

* **Screen sharing / remote assistance**: a second media track plus an explicit,
  revocable session grant; never auto-enabled.
* **Browser/tab handoff**: send `{url, title, scroll, selection}` as a `link`
  content type; requires a browser extension for tab APIs, which is not built.
* **Task continuity / app-state handoff**: a `state` content type with a signed,
  expiring payload, plus per-app adapters. Authentication cookies, passwords and
  session tokens are explicitly out of scope.

## Why no framework

The UI is ~900 lines of TypeScript creating DOM nodes directly. That keeps the
bundle at ~188 KB (including the QR encoder), removes a whole dependency tree from
the security surface, and makes the render path obvious. The UI is a pure
projection of `AppSnapshot`; transfer rows are built once and patched in place so
that progress updates never destroy focus or buttons.

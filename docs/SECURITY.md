# Fluxa security model

This document states what Fluxa protects, how, and — just as importantly — what it
does **not** protect. Everything below describes code in this repository; nothing
here is aspirational.

## Assets

| Asset | Where it lives | Protection |
|---|---|---|
| File contents in transit | Peer-to-peer WebRTC DataChannel | DTLS 1.2/1.3 between the two browsers |
| File contents at rest (receiver) | Memory / Origin Private File System | Browser origin sandbox; SHA-256 verified before exposure |
| Device private key | IndexedDB as a non-extractable `CryptoKey` | Not exportable by JavaScript; same-origin only |
| Pairing codes | Server memory only | Random, 2-minute TTL, single use, rate limited |
| Trust list | IndexedDB per browser profile | Local only; no account, no sync |

## Identity and pairing

* Identity keys are ECDSA P-256, generated per browser profile. `deviceId` is
  `SHA-256(publicKey)`; **display names are never trusted**.
* A device proves possession of its key on every WebSocket connection: the server
  sends a random challenge, the client signs
  `fluxa/1/signaling|<challenge>|<deviceId>`, and the server checks the signature
  against the presented key *and* re-derives `deviceId` from that key. Replaying a
  signature from a previous connection fails because the challenge is fresh.
* Pairing codes are 6 symbols from a 32-symbol alphabet (~30 bits), independent of
  the device identity, expire after 120 s, and are consumed before use so they
  cannot be reused. Codes are rate limited per authenticated device (6/min) with a
  per-IP backstop (60/min); claims are limited per IP (60/min) and a code dies after
  5 wrong attempts.
* A device cannot claim its own code (a common mis-click that would otherwise pair
  a device with itself).

## Channel verification

After the DataChannel opens, each side sends a signed hello that binds:

* both identity keys and their fingerprints,
* the pairing `sessionNonce`,
* the DTLS fingerprint of the negotiated SDP,
* a fresh per-hello nonce and an ephemeral ECDH public key.

The peer's hello is rejected unless its key matches the pinned pairing key **and**
its advertised DTLS fingerprint equals the one actually negotiated. That closes the
classic SDP-swap attack: a party that replaces the offer/answer cannot produce a
hello whose fingerprint matches the connection it is actually terminating.

From the ephemeral ECDH exchange both peers derive the same 6-digit code. Users
compare it out of band and must both confirm before any file bytes are accepted.

### What the 6-digit code does and does not give you

* If a machine-in-the-middle (including a malicious signalling server) swaps keys,
  the two devices compute **different** codes, so comparing them detects the attack.
* It only detects the attack **if a human compares the codes**. Fluxa makes this
  unavoidable before transferring (no send path exists until verification), and it
  warns against comparing over the same channel used to pair.
* 6 digits = 1,000,000 combinations, not a cryptographic authenticator. It is a
  detection mechanism for an active attacker who must be present *during* that one
  pairing, not a replacement for a long-term identity.

## Transport

* WebRTC DataChannels are encrypted with DTLS between peers. In a direct
  connection no third party carries the bytes.
* When a TURN relay is configured, TURN forwards **DTLS-encrypted** packets: the
  relay can observe traffic volume and IP addresses/timing metadata but not file
  contents. This is why Fluxa can describe the data path as end-to-end encrypted in
  both direct and relayed cases.
* The signalling server sees: device ids, display names, platform strings, pairing
  codes, SDP/ICE payloads and timestamps. It never sees file contents, file names or
  digests.

## Application security

* Strict Content-Security-Policy (`default-src 'self'`, no inline scripts, no
  third-party origins), `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `Permissions-Policy` disabling camera/microphone/geolocation,
  `Cross-Origin-Opener-Policy: same-origin`.
* Path traversal is blocked in two places: `sanitizeRelPath` on every manifest entry
  and the static-file server's resolved-path check.
* All peer-controlled strings are inserted with `textContent`/escaping; a peer
  cannot inject markup into the UI.
* Malformed frames (wrong magic, wrong length, unknown type, oversized) are
  rejected before any state changes.
* Rate limits: hello per connection (4/min), relay per connection (200 msg/s),
  pairing as described above, WebSocket payload capped at 128 KiB, control frames
  at 256 KiB.
* Bounded resources: 2000 files per transfer, 64 GiB per file, 128 GiB per
  transfer, 8 concurrent links per device, 8 MiB of unacknowledged data.

## Threat model

**Mitigated**

| Threat | Mitigation |
|---|---|
| Passive network eavesdropper | DTLS; file bytes never cross the signalling server |
| Attacker guessing a pairing code | 2-minute TTL, single use, rate limits, 5 attempts per code |
| Device impersonation via display name | Identity = key; names are cosmetic |
| Key substitution during pairing | Pinned keys + SAS comparison |
| SDP/ICE manipulation by the server | DTLS fingerprint bound into the signed hello |
| Replay of signalling auth | Fresh server challenge per connection |
| Malicious peer sending `../../etc/passwd` | Manifest validation + sanitisation, OPFS sandbox |
| Malicious peer corrupting bytes | Per-file SHA-256 over exactly the received bytes |
| Malicious peer flooding with frames | Frame size caps, bounded queues, timeouts, disconnect |
| Partial file presented as complete | Completion only after digest match + finalise |

**Not mitigated (documented gaps)**

1. **A user who ignores the 6-digit code** is not protected from an active MITM.
2. **Compromised browser profile.** The private key is non-extractable but usable by
   any script running in that origin; someone with code execution in the profile can
   act as the device.
3. **Re-installing / clearing site data** creates a new identity. Peers will see a
   new device id; an old trusted record is never silently overwritten (the session
   is refused instead), but a user could delete the record and re-pair.
4. **No account recovery or device revocation propagation.** Revoking a device is
   local: the other side keeps its own trust record.
5. **Metadata.** The server learns which device ids pair and when, plus IP
   addresses; TURN (if you deploy it) learns IP addresses and volume. No attempt is
   made to hide that from an operator you chose to trust.
6. **Denial of service.** Rate limits are in-memory and per-process; a distributed
   flood can still exhaust a single node. Deploy behind a reverse proxy with
   connection limits (see `docs/NETWORKING.md`).
7. **Files at rest on the receiver** are protected only by the browser's origin
   sandbox and OS account permissions. There is no Fluxa-level encryption at rest.
8. **Malicious file *content*.** Fluxa verifies integrity, not safety: a transferred
   executable is still an executable. The UI labels installers as files and never
   runs them.
9. **Clipboard, cookies and credentials** are never read or transmitted by this
   build. There is no clipboard integration at all.

## Reporting

This is a reference implementation, not an audited product. Before running it for
real data, commission a review of `src/shared/crypto.ts`, `src/client/peer.ts` and
`src/server/pairing.ts` — they are where the security properties live.

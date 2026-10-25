# Fluxa security model

This document states what Fluxa protects, how, and — just as importantly — what it
does **not** protect. Everything below describes code in this repository; nothing
here is aspirational.

## Assets

| Asset | Where it lives | Protection |
|---|---|---|
| File contents in transit | Peer-to-peer WebRTC DataChannel | DTLS 1.2/1.3 between the two browsers |
| File contents at rest (receiver) | Memory / Origin Private File System | Browser origin sandbox; SHA-256 verified before exposure. Pending OPFS bytes and IndexedDB journal metadata are not separately encrypted by Fluxa |
| Device private key | IndexedDB as a non-extractable `CryptoKey` | Not exportable by JavaScript; same-origin only |
| Pairing codes | Server memory only | Random, 2-minute TTL, single use, rate limited |
| Trust list | IndexedDB per browser profile | Local only; no account, no sync |
| Live clipboard text | OS clipboard and ephemeral verified peer channel | Two-party opt-in, 16 KiB plain-text cap, no signalling/history persistence; **do not copy passwords while enabled** |
| Screen video | OS-selected capture and WebRTC DTLS-SRTP | Separate peer approval, no recording/audio/remote control; ends on stop/disconnect |
| Transfer rules | Local browser storage per pinned device id | Default Ask; optional bounded allowlist auto-accept into private storage only |

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
  connection no third party carries the bytes. After two-sided screen consent,
  a media transceiver uses encrypted DTLS-SRTP on that same peer connection;
  its offer/answer travels inside the verified DataChannel and must retain the
  certificate fingerprint that was bound to the SAS.
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
  no-referrer`, `Permissions-Policy` permitting **same-origin camera only** for
  user-triggered QR scanning while disabling microphone/geolocation, and
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
| Partial file presented as complete | Per-file digest, receiver-side durable `doneAck`, verified source/prefix on restart (protocol v2) |
| Unauthorised TURN bandwidth use | Separate enrolment key required for expiring REST credentials over WSS; key rotation, reverse-proxy limits and coturn quotas remain operator responsibilities |
| Accidental automated file acceptance | Default Ask; opt-in rule limited to SAS-verified peer, allowlisted extensions and 1–100 MiB batch with durable private storage; never auto-open or auto-export |
| Remote screen/clipboard request before consent | Control messages ignored outside a verified session and separately accepted share/sync state; either side can stop. No initial clipboard text sent |

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
9. **Live clipboard sync deliberately monitors subsequent text changes after
   both verified devices opt in.** It does not copy the initial clipboard or
   persist it, but **there is no reliable password/secret detector**: copying a
   password, OTP or token while enabled can send it to the other device. Keep
   sync off when handling secrets, stop it from either device, and use the
   per-item approval flow for individual shares. OS paste/privacy prompts and
   background suspension vary by platform.
10. **TURN enrolment is a shared operator key, not per-user authorisation.**
   Someone with that key may consume relay bandwidth. Store it on trusted
   devices, rotate if leaked, and set quotas/limits on the relay/proxy.
11. **Private partial files are not protected against local profile compromise**
   and can be evicted separately from IDB. Recovery re-reads actual OPFS bytes;
   it never trusts a journal offset alone. A lost source/evicted partial requires
   a new transfer rather than an invented completion.
12. **Tab handoff is not account/session migration.** The extension requests only
   `activeTab` and `storage`, then passes an explicitly selected URL/title for
   local review. It never accesses cookies, passwords, tab history or third-party
   app storage. URLs *can* themselves contain sensitive query/hash tokens; the
   sender must inspect the full link before sending. The destination signs in
   separately, approves receipt, and chooses when to open it. No Fluxa account
   server exists; paired keys are the device authentication method.
13. **Automation is scoped, not a background service.** A verified device may
   have an opt-in private-storage auto-accept rule. File extensions are only
   filters, not malware checks; received files must still be treated as untrusted.
   Browser and mobile OS background work may be suspended. Desktop app screen
   picker/custom URI handler require physical OS/browser validation.

## Reporting

This is a reference implementation, not an audited product. Before running it for
real data, commission a review of `src/shared/crypto.ts`, `src/client/peer.ts` and
`src/server/pairing.ts` — they are where the security properties live.

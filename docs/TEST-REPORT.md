# Fluxa — verification report

Date of record: **2026-10-24**. Everything below was executed in this repository on
that date. Nothing is claimed that was not run.

## TL;DR

| Command | Result |
|---|---|
| `npm run check` (`tsc --noEmit`, strict) | ✅ exit 0, no errors |
| `npm test` (build + `node --test`) | ✅ **60 / 60 passing**, 1.3 s |
| `npm run test:e2e` (Playwright, 2 browser contexts) | ✅ **12 / 12 passing**, ~1.5 min |
| `npm audit --omit=dev` | ✅ `found 0 vulnerabilities` |
| `npm audit` (dev included) | ✅ `found 0 vulnerabilities` |

Two real browsers, real WebRTC, real files; SHA-256 compared on every transfer.

---

## 1. Repository state

There was **no pre-existing Fluxa repository**: the workspace was empty. This
project was therefore created from scratch as a complete, runnable application
(browser client + signalling server + transfer engine + tests), not as a rewrite of
anything.

## 2. Files

```
package.json  tsconfig.json  playwright.config.ts  .env.example  .gitignore  LICENSE
scripts/build.mjs                     esbuild pipeline (client bundle, server bundle, test transpile)

src/shared/protocol.ts                wire format, limits, manifest validation
src/shared/crypto.ts                  identity, signatures, ECDH, SAS derivation
src/shared/filename.ts                filename / relative-path sanitisation

src/server/index.ts                   HTTP static host + WebSocket signalling
src/server/pairing.ts                 short-lived single-use pairing codes
src/server/ratelimit.ts               token-bucket limiter

src/client/main.ts                    bootstrap + read-only debug surface
src/client/app.ts                     application state, sessions, devices, transfers
src/client/ui.ts                      DOM rendering (no framework)
src/client/index.html  styles.css     app shell + design system
src/client/identity.ts                device identity (IndexedDB, non-extractable key) + trust store
src/client/signal.ts                  signalling client (hello signature, codes, relay)
src/client/peer.ts                    WebRTC session, identity pinning, DTLS binding, SAS
src/client/sha256.ts                  incremental SHA-256 (WebCrypto has no streaming digest)
src/client/transfer/manager.ts        routing, one-transfer-at-a-time rules
src/client/transfer/sender.ts         streaming sender with ack window + backpressure
src/client/transfer/receiver.ts       ordered writes, incremental hashing, finalisation
src/client/transfer/sink.ts           MemorySink + OPFS sink + storage checks
src/client/transfer/types.ts          shared transfer state types

test/unit/protocol.test.ts            frame codec, malformed frames, manifest validation
test/unit/filename.test.ts            traversal, reserved names, unicode, dedupe
test/unit/sha256.test.ts              vectors + parity with node:crypto
test/unit/crypto.test.ts              identity, signatures, ECDH, SAS transcript
test/unit/pairing.test.ts             TTL, single use, attempts, rate limiter
test/unit/signaling.test.ts           real WebSocket server: auth, pairing, relay rules
test/unit/transfer.test.ts            engine: corruption, ordering, cancel, disconnect, busy

e2e/helpers.ts  e2e/transfer.spec.ts  two-browser end-to-end suite

docs/ARCHITECTURE.md  SECURITY.md  NETWORKING.md  PLATFORM-NOTES.md  TEST-REPORT.md
```

## 3. Bugs found and fixed during verification

These were found by the tests written here, i.e. real defects, not test scaffolding.

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Integrity hashes occasionally wrong (63 hex digits, wrong digest) for certain inputs | `Sha256.digestHex()` iterated *32-bit words* with 2-digit padding, dropping leading zero nibbles | Emit 8 hex digits per word (`src/client/sha256.ts`); caught by parity tests against `node:crypto` at sizes 0…65 537 |
| 2 | `Sha256` threw `update after digest` on the padding block | `finished` flag set before the padding update | Set the flag after padding (`src/client/sha256.ts`) |
| 3 | Every pairing after the 10th from one IP failed | hello rate limit keyed per IP; NAT/multi-device deployments burned the bucket | Limit per WebSocket connection (4/min), since the challenge is per connection |
| 4 | All WebSocket `hello`s rejected with `bad_key` | Public-key regex capped at 88 chars; P-256 SPKI base64url is 122 | Corrected bound (`src/server/index.ts`) |
| 5 | Trusted devices never persisted; "no devices yet" after a successful verification | `IDBObjectStore.put(value, key)` throws `DataError` when the store has a key path | Only pass an explicit key for out-of-line stores (`src/client/identity.ts`) |
| 6 | Verification dialog vanished immediately after pairing | Closing the pairing dialog in the same render pass also removed the newly opened verification dialog | `closeModal()` closes exactly one dialog; render order fixed (`src/client/ui.ts`) |
| 7 | Second device's pairing dialog never closed, blocking the whole UI with an invisible overlay | The claimant never had a `pairing` object, so the "code consumed" path never ran | Close the dialog on successful claim; errors surface as toasts |
| 8 | Multi-file transfers failed after the first file | Receiver switched to `verifying` per file, then rejected the next file's chunks as "outside an active transfer" | Stay `transferring` until the last stream is finalised (`src/client/transfer/receiver.ts`) |
| 9 | Fast/small transfers reported **0 bytes** of progress until completion | Receiver only acked at 256 KiB boundaries; small transfers finished first | 100 ms ack timer + final ack on `fileEnd` (`receiver.ts`) |
| 10 | Cancel button un-clickable during transfers | Activity list was rebuilt on every progress frame, detaching elements under the pointer | Rows built once and patched in place; progress emissions coalesced to one per animation frame (`ui.ts`, `app.ts`) |
| 11 | Sender could "send" into a dead session | `verified` stayed true after the peer disconnected | Sending requires `state === 'connected'`; the stage shows "Connection unavailable" |
| 12 | Unverified peer invisible in the device list after deferring verification | Device list only contained trusted devices | List trusted devices *plus* live unverified sessions, badged "Not verified", with a Verify action |
| 13 | Sender's transfer state was `failed` instead of `declined` when the receiver pressed Decline | Decline path reused the generic failure path | Explicit `declined` state (`sender.ts`) |
| 14 | Device rename was not visible to the peer | Name was only sent in the initial `hello` | `profile` signalling message + server update (`signal.ts`, `server/index.ts`) |
| 15 | Tests left timers alive, hanging the suite for 95 s | Sender kept looping after failure and scheduling waiters | Abort guard in the send loop, reader cancellation, `done` checks in waiters |

Additionally, a UX/a11y fix: the device row was an `li[role=button]` containing a
`button` (invalid nesting); it is now a real `button` plus a sibling remove control,
and keyboard operable.

## 4. Browser tests (Playwright, Chromium)

Each test creates **two independent browser contexts** (separate storage, separate
identities) and performs the entire real flow: signalling connection, pairing code,
WebRTC negotiation, 6-digit verification compared on both screens, transfer,
accept/reject, and hash comparison.

| # | Test | What it proves | Time |
|---|---|---|---|
| 1 | empty file (0 B) | zero-byte stream finalises and verifies | 5.7 s |
| 2 | small text file (41 B) | smallest non-trivial path | 5.8 s |
| 3 | binary file (512 KiB) | binary framing, multi-chunk | 5.7 s |
| 4 | larger file (8 MiB) | sustained throughput, ack window | 8.6 s |
| 5 | 32 MiB file streamed to disk | OPFS sink; **receiver JS heap grew 2.5 MB** (< 24 MB asserted) | 8.5 s |
| 6 | batch of 3 files (9 B, 70 000 B, 7 B) | ordering, per-file verification, multi-file `done` | 4.7 s |
| 7 | decline | sender lands in `declined`, receiver exposes no save control, nothing completed | 5.0 s |
| 8 | cancel mid-transfer (24 MiB) | both sides end `cancelled`, no file exposed, no save control | 12.8 s |
| 9 | second send during a transfer | queued, not run in parallel (exactly one `transferring`/`incoming`) | 11.8 s |
| 10 | progress before verification | state sequence includes `complete` only after hashing; digest matches source | 8.1 s |
| 11 | unverified peer | no drop-zone exists; deferral works; rejecting closes the session and surfaces a toast | 7.1 s |
| 12 | peer disconnects | badge clears, toast shown, no drop-zone remains | 5.2 s |

### File sizes and SHA-256 results

Deterministic fixtures (hash computed twice: from the source bytes in Node, and by
the receiver over the bytes it actually received):

| File | Size | SHA-256 | Sender hash = receiver hash = saved-file hash |
|---|---|---|---|
| `empty.txt` | 0 B | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | ✅ |
| `notes.txt` | 41 B | `3b6256f156cbd74c86c6adb9b4f6137ed901a0a16aff63657026d4fef60859f9` | ✅ |
| `one.txt` | 5 B | `a7937b64b8caa58f03721bb6bacf5c78cb235febe0e70b1b84cd99541461a08e` | ✅ |
| `three.md` | 7 B | `f4c39d0dbc56eed05655b946e8408c0104a9097d43c8633e1d86cd304a5337db` | ✅ |

Random fixtures (fresh bytes per run, compared programmatically rather than
listed): `blob.bin` 512 KiB, `video-sample.mp4` 8 MiB, `large-video.mp4` 32 MiB,
`big-cancel.bin` 24 MiB, `busy.bin` 16 MiB, `two.bin` 70 000 B. For every one, the
test asserted:

1. `receiver-reported sha256 === sha256(source bytes)` computed in Node,
2. `sha256(bytes read back from the browser download) === sha256(source bytes)`,
3. `received size === source size`,
4. both sides' transfer state reached `complete` only after that.

Because the digest for a 32 MiB file is checked over the bytes the *browser* wrote
to disk, a corrupted or truncated write cannot pass.

## 5. Protocol / engine tests (`node --test`)

60 tests across 7 files (1.3 s). Highlights:

* **Framing**: control and chunk round-trips, byte-exact payloads, `Uint8Array`
  views with non-zero offsets, and rejection of bad magic, bad length, bad JSON,
  unknown types, oversized chunks and negative offsets.
* **SHA-256**: known vectors plus parity with `node:crypto` at 13 boundary sizes and
  irregular incremental chunking; digest reuse throws.
* **Filename safety**: `../../etc/passwd`, Windows separators, NUL/control bytes,
  reserved device names (`CON`, `LPT1`), trailing dots/spaces, 200-character
  unicode truncation without splitting code points, path-depth limit, dedupe.
* **Manifest validation**: traversal, duplicate `streamId`, duplicate paths,
  negative size, wrong `totalBytes`, empty manifest, wrong protocol version.
* **Pairing store**: single use, case/format tolerance, TTL expiry, one code per
  device, self-claim refused, cancel, sweep, rate-limiter refill/isolation.
* **Signalling server over real sockets**: hello without proof is refused; forged
  signature, mismatched device id and replayed challenge are refused; valid hello
  returns negotiated config; pairing + relay works; **code reuse fails**; **expired
  code fails**; self-claim fails; relay of an unpaired target or unknown type is
  refused; rejecting verification tears the link down; peer-left notification.
* **Transfer engine**: multi-file with an empty file; **corrupted bytes → integrity
  failure, zero files exposed**; **scrambled offsets → out-of-order failure**;
  hostile manifest refused; busy manifest refused; cancel is honoured on both
  sides; connection loss fails both sides instead of hanging; queued second send;
  progress never exceeds the total; received bytes re-hash to the source.

## 6. Known security limitations

Documented in full in [SECURITY.md](SECURITY.md). Summary:

1. The 6-digit code protects you **only if it is actually compared**; it is a
   MITM-detection mechanism, not a long-term authenticator.
2. Device identity is protected by the browser profile, not by hardware; anyone
   with script execution in that origin can act as the device.
3. Clearing site data creates a new identity; peers will not silently re-pin a
   changed key, but a user can re-pair.
4. Pairing state is in-memory and single-node; there is no account, no revocation
   propagation, and rate limits reset on restart.
5. Metadata (device ids, pairing times, IPs, and traffic volume if you deploy TURN)
   is visible to the operator. File names and contents are not.
6. Integrity ≠ safety: a transferred executable is still executable. Fluxa never
   runs installers.
7. No clipboard, cookie, password or session transfer exists in this build.

## 7. Known networking limitations

* **Same-machine and same-LAN**: verified in this environment (ICE `host`
  candidate, reported as "Direct host").
* **Cross-network (different NATs)**: requires STUN and, when the NAT is symmetric,
  TURN. Both are configuration-only here — **no relay service is bundled or
  operated**. Not verified end-to-end in this sandbox.
* **No ICE restart**: an interruption fails the session cleanly rather than
  recovering. Sessions do not survive a signalling reconnect (a new `connId`
  invalidates the pairing link).
* **No local discovery** (mDNS/broadcast): pairing is by code or QR link.
* **No resumable transfers**: interrupted transfers delete partial data. See
  ARCHITECTURE.md for the resume design and why resuming by name/size is unsafe.
* Single-node only; pairing is not shared between instances.

## 8. Reproducing locally

```bash
# 1. Install and build
npm install
npx playwright install --with-deps chromium     # first time only
npm run build

# 2. Static checks and fast tests
npm run check
npm test
npm audit --omit=dev

# 3. Browser tests (starts its own server on 127.0.0.1:8787)
npm run test:e2e

# 4. Run the app by hand
npm start                      # http://localhost:8787
#    open in two different browser profiles / one private window,
#    pair with the 6-character code, compare the 6-digit verification code,
#    then drop a file.
```

Notes for reproducing:

* The e2e config disables Chromium's mDNS local-IP obfuscation
  (`--disable-features=WebRtcHideLocalIpsWithMdns`) so ICE host candidates are
  directly usable inside a container; a normal LAN pair does not need this.
* If `npm run test:e2e` reports pairing timeouts, make sure no stale server is
  already listening on port 8787 (`reuseExistingServer` is enabled outside CI).
* Tests never print file contents or secrets; failures write a Playwright trace to
  `test-results/`.

## 9. What was explicitly *not* verified

* Firefox, Safari, Android, iOS, Windows and macOS browser runs.
* Cross-network transfers through STUN/TURN (no relay deployed, and the brief
  forbids introducing production credentials without authorisation).
* Resumability, clipboard/link sharing, browser handoff, screen sharing, native
  apps, and app-package installation — none of these is implemented, so none is
  claimed.

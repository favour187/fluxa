# Architecture and protocol (v0.2.0 client, wire protocol v2)

```
Browser / Capacitor WKWebView / Android WebView / Electron renderer
    identity.ts   -> non-extractable IndexedDB P-256 key + pinned trust
    signal.ts     -> signed challenge, pairing-code/SDP/ICE over WS/WSS
    direct.ts     -> compressed offer/reply codes without a broker
    peer.ts       -> DTLS-bound ECDH transcript + six-digit SAS
    transfer/*    -> shared chunked sender, receiver, journal, OPFS sink, exports
    share.ts      -> optional explicitly approved text/link/work-link module
    app.ts / ui.ts -> ephemeral verified-peer chat, staged file send, ripple
                         |
              verified WebRTC DataChannel
                         |
                another device with the same protocol

Node broker: static UI, short pairing codes, ICE signalling, optional short-
lived coturn REST credentials. It NEVER accepts file bytes for forwarding.
Desktop: embedded LAN broker + mDNS/IPC-backed save dialog.
Mobile: one shared Capacitor web bundle + native Filesystem/Share/App plugins.
```

## What is authenticated

The signalling server challenges each connection; each client signs its
challenge using its persistent ECDSA P-256 key. The server verifies the public
key's derived device id and sends protocol v2 configuration. This proof does
**not** enrol users or trust new devices. Pairing code TTL is two minutes and
single-use. The WebRTC DataChannel handshake separately checks the same key,
its signature over session nonce/ephemeral ECDH/DTLS fingerprints, and the
negotiated peer certificate. Both users must compare the derived six-digit SAS
and tap *Codes match*. Revoking a device removes local pinned trust.

Direct codes (`FLX1…`) encode the offer/answer and public identity; their
`protocolVersion: 2` prevents accidentally pairing with the previous wire
format. Each new pairing needs a fresh SAS, even for a previously trusted key.
No server can silently verify on the user's behalf. On direct codes, the
signalling stage is skipped, not the peer authentication stage. Rendered QR
codes use a four-module white quiet zone; tickets that cannot fit a QR keep
the full Copy/Share fallback rather than truncating the pairing data.

## Files, folders, and recovery

A verified sender computes a **whole-file SHA-256 commitment** for every
selected source before offering a manifest with total size, bounded paths,
stream ids and hashes. The receiver checks limits and traversal, asks the user
to accept, and creates a transfer journal in IndexedDB before sending `accept`.
The sender streams 64 KiB chunks with an acknowledgement window; progress
counts receiver acknowledgements, not queued socket bytes. The receiver writes
committed chunks into OPFS, hashes on receipt, checks every file and sends a
file result. The sender only declares `complete` after a separate `doneAck`
recording receiver-side verified completion. Cancellation/failure never reports
success.

On a restart, the journal contains identity/manifest **metadata only**, not
file bytes. OPFS stores the partial. After reconnecting and comparing a new
SAS, the sender must reselect the *same* source(s) and re-hash them; the receiver
rehashes actual partial bytes before offering each resume offset/prefix digest.
The sender rehashes that source prefix and rejects any mismatch **before**
appending data. A completed receiver journal permits a lost completion receipt
to be replayed without claiming an unverified send. In-memory fallback is
bounded and **not durable**; browser eviction, private mode, permission changes,
missing sources, and cleared site data can prevent resume. Transfers do not
resume automatically or run in the background.

Path handling sanitises relative paths and prevents `..`/absolute/duplicate
names. Chromium's user-selected directory export writes bounded chunks, checks
SHA-256 again, retains subfolders and avoids known name collisions. Electron
uses a native save-dialog capability, bounded IPC writes to a 0600 temporary
file, hash/size check and an exclusive commit (no silent overwrite). Native
Capacitor exports write 64 KiB base64 chunks into a unique Documents directory,
then may offer the OS share sheet. On browsers without a directory picker, Save
falls back to downloads and cannot guarantee a folder tree in Downloads.

Files chosen through the file/folder picker are staged for the selected device;
the sender must swipe the card to the screen edge or activate **Send now**.
Switching devices cannot silently redirect the staged batch. Drag-and-drop
remains a direct-send path, with the receiver's usual explicit approval.
During transfer the sender and receiver show a visual pulse; reduced-motion
settings disable its animation. Neither gesture nor animation changes the
verified file protocol.

## Quick messages

The client sends text only to a verified connected device over the same
authenticated WebRTC control channel, with a 4,000 **UTF-8 byte** limit. Each
message has a unique id and timestamp; the receiver acknowledges it, and the
sender displays sending, delivered or failed (including connection loss or a
30-second acknowledgement timeout). Duplicate ids are not displayed twice.
Messages live in the current app session only: no broker store, offline queue,
cross-restart history, guarantee of remote reading, or unverified-device chat.

## Content sharing is deliberately separate

`share.ts` carries at most 16 KiB of a user-entered clipboard text, URL, or
work-link note over the already verified channel. Incoming content is only
shown in an approval dialog; it is not copied or opened until the recipient
approves **and then** explicitly presses Copy/Open. A click on *Paste clipboard*
is the only clipboard-read action and may require OS/browser permission.
This is not passive clipboard sync, installed-app migration, cookies/password
transfer, browser-tab capture, or background session continuity.

## Compatibility and limitations

`PROTOCOL_VERSION=2` is intentionally incompatible with v1, which could not
prove a durable final receipt/resume contract. The server rejects old hello
messages, the new client rejects old challenges, the DataChannel validates
version 2, and direct tickets without `protocolVersion: 2` are rejected. All
participants (including an embedded desktop broker) must update together.
The **product version remains 0.2.0**; wire and package versions are separate.
No migration reinterprets an old incomplete v1 journal as a verified v2 send.

Automatic discovery is Electron-only (mDNS); browsers and mobile use manual
pairing/QR/direct codes. No package installation, remote clipboard polling,
public hosted TURN service, offline remote transfer, guaranteed iOS background
transfer, or provider-mediated user accounts are implemented. See
[NETWORKING.md](NETWORKING.md) and [PLATFORM-NOTES.md](PLATFORM-NOTES.md).

# Connectivity and self-hosting (protocol v2)

Fluxa streams **encrypted WebRTC DataChannel bytes** between peers. The Node
server hosts the UI, signs neither file nor device identities, brokers single-use
pairing codes, and relays SDP/ICE *signalling* only. When direct ICE fails, an
**optional, separately deployed coturn server** forwards encrypted packets; it
never decrypts the DTLS application channel. Both people must compare and
approve the same six-digit SAS after *every new pairing*. Discovery and URLs are
not trust signals.

## What each path requires

| Path | Needed | Verified in this repository |
| --- | --- | --- |
| Same browser host / compatible private LAN | Fluxa Node or desktop broker; reachable UDP host candidates | Two Chromium contexts and two Linux Electron instances passed transfer E2E locally. LAN hardware/firewall not tested. |
| Direct offer/reply code | No signalling server; viable WebRTC ICE path | Chromium E2E passed with server disconnected. Still needs real network connectivity. |
| NAT traversal (srflx) | Reachable STUN service in `FLUXA_ICE_SERVERS` | Configuration and ICE path reporting are implemented; no multi-NAT device test. |
| Remote relay | Public `wss://` Fluxa server **and** reachable coturn with TLS/UDP/TCP, operator access key, bandwidth quotas | REST credential issuance tested with real WebSockets. No external TURN server or two-network hardware test was run here. |

A desktop app binds an embedded LAN broker and allows other **private-LAN**
Electron origins/ports and the three explicitly listed packaged-mobile origins;
the ordinary public server rejects arbitrary browser origins. Browsers cannot
run an mDNS broker; the desktop shell advertises `_fluxa._tcp` for convenience.
An mDNS sighting never bypasses SAS verification. Android/iOS require a reachable
separate broker or a serverless direct code: they do not run one themselves.

## Configure the signalling server

Run `npm ci && npm run build && PORT=8787 HOST=127.0.0.1 npm start`. On a local
LAN, set `HOST=0.0.0.0` and open the firewall appropriately. On the public
internet **do not expose plaintext HTTP/WS**: put a TLS reverse proxy in front
and set `FLUXA_PUBLIC_URL=https://fluxa.example.com`. In app Settings →
**Signalling server**, enter that hostname; public `ws://` is intentionally
rejected. Private/loopback `ws://` remains an explicit LAN-only option.

```text
fluxa.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8787
}
```

Caddy above obtains a certificate and proxies WebSocket upgrades. Set exact
`FLUXA_ALLOWED_ORIGINS`, e.g.
`https://fluxa.example.com,https://localhost,http://localhost,capacitor://localhost`
when you actually support packaged mobile WebViews. Do **not** set
`FLUXA_TRUST_PROXY=1` unless the proxy strips untrusted forwarded headers and
provides a trustworthy `X-Forwarded-For`. `PORT`, `HOST`, `FLUXA_PUBLIC_URL`,
`FLUXA_ALLOWED_ORIGINS`, `FLUXA_TRUST_PROXY`, `FLUXA_ICE_SERVERS`,
`FLUXA_TURN_URLS`, `FLUXA_TURN_SECRET`, `FLUXA_TURN_ACCESS_KEY`, and
`FLUXA_TURN_TTL_SECONDS` are read at server startup. Pairing state is in memory:
one node or sticky sessions are required. Neither static app server nor TURN is
operated by the repository maintainers.

Set `FLUXA_ICE_SERVERS='[{"urls":"stun:stun.example.com:3478"}]'` for STUN.
**Static TURN usernames/passwords in `FLUXA_ICE_SERVERS` now fail startup**,
rather than silently exposing reusable credentials. The public `/api/config`
endpoint contains no TURN secret or credential. The authenticated WebSocket
`ready` response includes an expiring credential **only when** the device
presents the operator-issued relay access key. The challenge signature alone
proves ownership of a *self-created* device identity, not authorisation to
consume your TURN bandwidth.

## Operate coturn with time-limited credentials

Generate **two distinct values** independently; never commit, log, embed in a
QR code or paste them into a chat. Example shell commands:

```bash
openssl rand -hex 32  # coturn REST shared secret, on server and coturn only
openssl rand -hex 32  # separate device-enrolment/access key, enter in Fluxa Settings
```

Minimal coturn configuration (adapt hostnames, external IP, TLS certificates,
quotas and firewall to your deployment):

```ini
listening-port=3478
tls-listening-port=5349
realm=relay.example.com
fingerprint
use-auth-secret
static-auth-secret=SET_THE_FIRST_INDEPENDENT_SECRET_HERE
stale-nonce
no-loopback-peers
no-multicast-peers
min-port=49152
max-port=49252
user-quota=4
total-quota=100
cert=/etc/letsencrypt/live/relay.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/relay.example.com/privkey.pem
# external-ip=PUBLIC_IP/PRIVATE_IP   # required when coturn is behind 1:1 NAT
```

Open UDP/TCP 3478, TCP 5349 and the selected UDP relay port range; for strict
networks deploy turns on 443 via a dedicated IP/port instead. Configure
`FLUXA_TURN_SECRET` to equal coturn's `static-auth-secret` and set the **other**
secret as `FLUXA_TURN_ACCESS_KEY` on the Fluxa server. For example:

```bash
FLUXA_PUBLIC_URL=https://fluxa.example.com \
FLUXA_ALLOWED_ORIGINS=https://fluxa.example.com \
FLUXA_ICE_SERVERS='[{"urls":"stun:relay.example.com:3478"}]' \
FLUXA_TURN_URLS='["turn:relay.example.com:3478?transport=udp","turn:relay.example.com:3478?transport=tcp","turns:relay.example.com:5349?transport=tcp"]' \
FLUXA_TURN_SECRET="$REST_SECRET" FLUXA_TURN_ACCESS_KEY="$ENROLMENT_KEY" \
PORT=8787 HOST=127.0.0.1 npm start
```

`REST_SECRET`/`ENROLMENT_KEY` above are illustrative environment variable names,
not literal credentials. Give authorised users only the *enrolment key*. Each
mobile/desktop/browser profile enters it into **Settings → Remote relay access
key** (stored per origin), then pairs again. The client refuses to transmit it
on `ws://`; use a public `wss://` endpoint. The REST credential includes a
random per-session username and an expiry (default 43,200 seconds; configure
600–86,400), and is HMAC-SHA1 signed as coturn expects. A user without the key
can still attempt host/STUN paths but receives **no** TURN credential.

The enrolment key is a shared service secret, **not** an account, per-user
subscription, or defence against a member abusing bandwidth. Rotate it when
leaked, protect the public reverse proxy from socket floods, apply coturn
bandwidth limits/monitoring and consider a separate proper auth service for
large multi-tenant deployments. No external relay availability, data cap, or
remote-device success is guaranteed by a green local build.

## Mobile and privacy notes

Android permits plaintext LAN signalling for user-selected private endpoints;
iOS has a local-network permission/ATS exception, both still require SAS and
WebRTC encryption. A public deployment uses WSS. Local signalling can reveal
identity/pairing metadata to someone on that LAN; files are never uploaded to
Node and TURN sees ciphertext. Android/iOS background suspension can interrupt
active streams; resumability needs persistent private storage and a new human
verification/re-selection, not an unrestricted background service.

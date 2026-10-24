# Networking, deployment and remote transfers

Fluxa ships with the signalling server and a static host. It does **not** ship a
STUN or TURN service, TLS certificates, or public infrastructure. This document is
the configuration and deployment guide, plus an honest description of what works
out of the box.

## What works with the default configuration

* Two devices on the same machine (different browser profiles): direct, verified,
  ~all of the transfer throughput your loopback allows.
* Two devices on the same LAN: works when ICE can gather **host** candidates and
  the two browsers can reach each other (no client isolation, no firewall blocking
  UDP). Fluxa reports `Direct host` in the device row.
* Anywhere else: ICE may fail. That is a networking reality (CGNAT, symmetric NAT,
  restrictive firewalls), not a bug. Configure STUN/TURN as below.

Fluxa never claims "remote transfers work" without a relay you operate.

## Configuration

The server reads environment variables (`src/server/index.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `FLUXA_PUBLIC_URL` | – | Base URL used to build QR/pairing links, e.g. `https://fluxa.example.com` |
| `FLUXA_ALLOWED_ORIGINS` | – (allow all) | Comma-separated WebSocket origin allow-list |
| `FLUXA_ICE_SERVERS` | `[]` | JSON array of `RTCIceServer` objects handed to clients |
| `FLUXA_TRUST_PROXY` | `0` | Set to `1` behind a reverse proxy to use `X-Forwarded-For` for rate limits |

Example `.env`-style values (see `.env.example`):

```bash
FLUXA_ICE_SERVERS='[
  {"urls":"stun:stun.example.com:3478"},
  {"urls":["turn:turn.example.com:3478?transport=udp","turn:turn.example.com:3478?transport=tcp"],
   "username":"fluxa","credential":"REPLACE_WITH_SECRET"}
]'
```

### STUN vs TURN

* **STUN** lets each peer discover its public reflexive address. It costs almost
  nothing and is required for most NAT-to-NAT direct connections. A public STUN is
  acceptable (`stun:stun.l.google.com:19302`) but self-hosting (coturn) removes a
  third-party dependency.
* **TURN** relays encrypted DTLS packets when a direct path cannot be found
  (symmetric NAT, CGNAT, enterprise firewalls, some mobile networks). TURN carries
  bandwidth: size it for expected concurrent transfers and enable its TCP/TLS
  transport on port 443 for restrictive networks.
* Fluxa's UI distinguishes direct (`host`/`srflx` candidate) from relayed
  connections, so support can tell the difference without guessing.

**Do not point Fluxa at a public TURN service with static, shared credentials.**
Use short-lived TURN credentials (coturn's `use-auth-secret` with a REST API
credential derived per user). Delivering those to browsers requires a small
authenticated endpoint; this repository does not implement one, because doing so
without knowing your identity provider would be guesswork.

## HTTPS and secure signalling

Browsers require a secure context for WebRTC on non-localhost origins, and
`wss://` is mandatory. Terminate TLS in front of the Node process:

```
[coturn]            udp/3478, tcp/3478, tls/5349
[nginx/caddy]   →   http://127.0.0.1:8787   (this app)
```

Example Caddyfile (automatic TLS, WebSocket proxying is automatic):

```
fluxa.example.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8787
}
```

Example nginx fragment:

```nginx
server {
  listen 443 ssl http2;
  server_name fluxa.example.com;
  # ssl_certificate ...;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 3600s;   # signalling sockets are long-lived
    client_max_body_size 1m;    # signalling only: no uploads pass through here
  }
}
```

Then start the app with:

```bash
FLUXA_TRUST_PROXY=1 \
FLUXA_PUBLIC_URL=https://fluxa.example.com \
FLUXA_ALLOWED_ORIGINS=https://fluxa.example.com \
FLUXA_ICE_SERVERS='[...]' \
PORT=8787 HOST=127.0.0.1 npm start
```

### Checklist before exposing a node

- [ ] TLS terminated, `wss://` only, HSTS at the proxy.
- [ ] `FLUXA_ALLOWED_ORIGINS` set to your exact origins.
- [ ] `FLUXA_TRUST_PROXY=1` **only** when a trusted proxy sets `X-Forwarded-For`.
- [ ] Reverse-proxy connection rate limits (e.g. nginx `limit_conn`), because the
      in-process limits are per-node and reset on restart.
- [ ] TURN credentials short-lived; TURN quotas monitored.
- [ ] Logging: Fluxa logs device id prefixes, never file names or contents. Keep it
      that way, and set a retention period.
- [ ] Single-node topology. Pairing state is **in memory**; multiple instances
      behind a load balancer will break pairing unless you add sticky sessions or a
      shared store (`src/server/pairing.ts` is the seam for that).

## Local-network discovery

Discovery over mDNS/UDP broadcast is **not implemented**. Devices pair with a code
or QR link, which works on any network without exposing a device list to everyone
on the subnet. If discovery is added later it must run browser-side (WebRTC does
not expose discovered peers without a signalling channel) or in a native client.

## Required work for real remote transfers

Implemented today: WebRTC negotiation, ICE server configuration plumbing, relay
authorisation on the signalling server, direct-vs-relay reporting, timeouts and
recovery on the session layer.

Still required before calling remote transfer "supported":

1. Deploy signalling behind TLS with an origin allow-list (steps above).
2. Deploy STUN, measure direct-connection success per network class.
3. Deploy TURN with short-lived credentials and capacity planning; add the
   authenticated credential endpoint.
4. Add ICE restart on `disconnected` (currently the session fails fast, which is
   honest but not resilient).
5. Load test signalling; move pairing state to a shared store if scaling past one
   node.

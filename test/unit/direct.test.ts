/**
 * Direct (server-less) pairing tickets.
 *
 * These cover the encoding layer only — no browser, no WebRTC. The point is that
 * a ticket survives a copy/paste round trip, rejects rubbish, and cannot be
 * turned into something that would be handed to RTCPeerConnection unsafely.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeTicket, encodeTicket, describeTicket, type DirectTicket } from '../../src/client/direct.js';
import { deriveDeviceId, exportPublicKeySpki, generateIdentityKeyPair, publicKeyFingerprint } from '../../src/shared/crypto.js';

const identity = {
  deviceId: 'GqCtAFSvwvhB5y3brbN-BvUrXHYhZ5u-YP46pMRhxZQ', // derived from publicKey
  name: 'Pocket Phone',
  platform: 'Android',
  publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE',
  fingerprint: 'ab'.repeat(32),
};

// Shaped like a real Chromium offer, including the noise that made the old
// codes ~1000 characters long.
const realSdp = `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=extmap-allow-mixed
a=msid-semantic: WMS
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=ice-ufrag:4ZcD
a=ice-pwd:x9c1R8Zg7Fh2Kk0Lm3Np6Qr1
a=ice-options:trickle
a=fingerprint:sha-256 7B:8A:19:2C:44:0D:5E:61:33:9F:AA:02:BC:11:7D:5C:1E:00:9A:3B:4C:5D:6E:7F:80:91:A2:B3:C4:D5:E6:F7
a=setup:actpass
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
a=candidate:1510613869 1 udp 2122260223 192.168.99.20 54321 typ host generation 0 ufrag 4ZcD network-id 1
a=candidate:1510613870 1 udp 1686052607 203.0.113.7 54321 typ srflx raddr 192.168.99.20 rport 54321 generation 0 ufrag 4ZcD network-id 2
a=candidate:1510613871 1 udp 41885439 198.51.100.9 61022 typ relay raddr 203.0.113.7 rport 54321 generation 0 ufrag 4ZcD network-id 1`.replace(/\n/g, '\r\n');

const ticket: DirectTicket = {
  v: 1,
  protocolVersion: 2,
  kind: 'offer',
  nonce: 'nonce-1234567890',
  sdp: { type: 'offer', sdp: realSdp },
  identity,
  candidates: [
    { candidate: 'candidate:1510613869 1 udp 2122260223 192.168.99.20 54321 typ host generation 0 ufrag 4ZcD network-id 1', sdpMid: '0' },
    { candidate: 'candidate:1510613870 1 udp 1686052607 203.0.113.7 54321 typ srflx raddr 192.168.99.20 rport 54321 generation 0 ufrag 4ZcD network-id 2', sdpMid: '0' },
  ],
};

test('a ticket round-trips through encode/decode', async () => {
  const encoded = await encodeTicket(ticket);
  assert.match(encoded, /^FLX1c\./);
  const decoded = await decodeTicket(encoded);
  assert.equal(decoded.sdp.type, 'offer');
  assert.equal(decoded.nonce, ticket.nonce);
  assert.equal(decoded.identity.publicKey, identity.publicKey);
  assert.equal(decoded.identity.name, identity.name);
  assert.equal(decoded.identity.deviceId, identity.deviceId, 'device id is re-derived from the key');
  assert.equal(decoded.candidates.length, 2);
  assert.match(decoded.candidates[0]!.candidate!, /192\.168\.99\.20 54321 typ host$/);
});

test('tickets survive the whitespace that copy/paste introduces', async () => {
  const encoded = await encodeTicket(ticket);
  const messy = `${encoded.slice(0, 40)}\n  ${encoded.slice(40, 90)}\r\n\t${encoded.slice(90)}`;
  const decoded = await decodeTicket(messy);
  assert.equal(decoded.nonce, ticket.nonce);
});

test('a pairing code without the prefix is rejected with a readable message', async () => {
  await assert.rejects(() => decodeTicket('hello world'), /does not look like a Fluxa pairing code/);
});

test('a damaged code fails cleanly instead of throwing something opaque', async () => {
  const encoded = await encodeTicket(ticket);
  const damaged = `${encoded.slice(0, encoded.length - 24)}AAAA`;
  await assert.rejects(() => decodeTicket(damaged), /damaged|could not be read|incomplete/i);
});

test('a code with missing identity is refused', async () => {
  const broken = { ...ticket, identity: { ...identity, publicKey: '' } };
  const encoded = await encodeTicket(broken as DirectTicket);
  await assert.rejects(() => decodeTicket(encoded), /incomplete|device identity/);
});

test('the wrong kind of ticket is reported, not silently accepted', async () => {
  const answer = { ...ticket, kind: 'answer' as const };
  const decoded = await decodeTicket(await encodeTicket(answer));
  assert.equal(decoded.kind, 'answer');
});

test('the code is short enough to read off a screen', async () => {
  const encoded = await encodeTicket(ticket);
  // The old full-ticket encoding was ~1000+ characters for this same session.
  assert.ok(encoded.length < 400, `code is ${encoded.length} characters`);
});

test('the rebuilt session description keeps everything WebRTC needs', async () => {
  const decoded = await decodeTicket(await encodeTicket(ticket));
  const sdp = decoded.sdp.sdp;
  assert.match(sdp, /a=ice-ufrag:4ZcD/);
  assert.match(sdp, /a=ice-pwd:x9c1R8Zg7Fh2Kk0Lm3Np6Qr1/);
  assert.match(sdp, /a=fingerprint:sha-256 7B:8A:19:2C/);
  assert.match(sdp, /a=setup:actpass/);
  assert.match(sdp, /a=mid:0/);
  assert.match(sdp, /a=sctp-port:5000/);
  assert.match(sdp, /m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel/);
  assert.ok(!sdp.includes('a=candidate:'), 'candidates travel in their own list, not twice');
});

test('full-ticket layout is accepted only with a valid identity and current protocol', async () => {
  const pair = await generateIdentityKeyPair();
  const publicKey = await exportPublicKeySpki(pair.publicKey);
  const current = { ...ticket, identity: {
    ...identity, publicKey, deviceId: await deriveDeviceId(publicKey),
    fingerprint: await publicKeyFingerprint(publicKey),
  } };
  const code = (t: unknown) => `FLX1p.${Buffer.from(JSON.stringify(t)).toString('base64url')}`;
  const decoded = await decodeTicket(code(current));
  assert.equal(decoded.nonce, ticket.nonce);
  assert.match(decoded.sdp.sdp, /a=ice-ufrag:4ZcD/);
  await assert.rejects(() => decodeTicket(code(ticket)), /invalid device identity/i);
  await assert.rejects(() => decodeTicket(code({ ...current, protocolVersion: 1 })), /incompatible transfer protocol/i);
});

test('describeTicket never leaks the payload', () => {
  const summary = describeTicket('FLX1z.abcdefghijklmnop');
  assert.match(summary, /^FLX1z\.abcdef…/);
  assert.ok(!summary.includes('SDP'));
});

test('oversized input is rejected before any decoding work', async () => {
  await assert.rejects(() => decodeTicket(`FLX1z.${'A'.repeat(70_000)}`), /too long/);
});

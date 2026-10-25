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

const identity = {
  deviceId: 'A'.repeat(43),
  name: 'Pocket Phone',
  platform: 'Android',
  publicKey: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE',
  fingerprint: 'ab'.repeat(32),
};

const ticket: DirectTicket = {
  v: 1,
  kind: 'offer',
  nonce: 'nonce-1234567890',
  sdp: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n' },
  identity,
  candidates: [{ candidate: 'candidate:1 1 udp 2130706431 192.168.99.20 54321 typ host', sdpMid: '0' }],
};

test('a ticket round-trips through encode/decode', async () => {
  const encoded = await encodeTicket(ticket);
  assert.match(encoded, /^FLX1[zp]\./);
  const decoded = await decodeTicket(encoded);
  assert.deepEqual(decoded.sdp, ticket.sdp);
  assert.equal(decoded.nonce, ticket.nonce);
  assert.deepEqual(decoded.identity, identity);
  assert.equal(decoded.candidates.length, 1);
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
  await assert.rejects(() => decodeTicket(encoded), /no device identity/);
});

test('the wrong kind of ticket is reported, not silently accepted', async () => {
  const answer = { ...ticket, kind: 'answer' as const };
  const decoded = await decodeTicket(await encodeTicket(answer));
  assert.equal(decoded.kind, 'answer');
});

test('describeTicket never leaks the payload', () => {
  const summary = describeTicket('FLX1z.abcdefghijklmnop');
  assert.match(summary, /^FLX1z\.abcdef…/);
  assert.ok(!summary.includes('SDP'));
});

test('oversized input is rejected before any decoding work', async () => {
  await assert.rejects(() => decodeTicket(`FLX1z.${'A'.repeat(70_000)}`), /too long/);
});

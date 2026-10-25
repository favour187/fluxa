import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerSession, type PeerEvents, type PeerState } from '../../src/client/peer.js';
import type { Identity } from '../../src/client/identity.js';
import type { PeerLink } from '../../src/client/signal.js';

// A deterministic network shell: the tests exercise deadline placement and
// terminal-event ordering, not cryptography or the browser ICE implementation.
class FakeChannel {
  readyState: RTCDataChannelState = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  binaryType = 'arraybuffer';
  bufferedAmountLowThreshold = 0;
  close(): void {
    this.readyState = 'closed';
    this.onclose?.(); // Android WebView can deliver this during pc teardown.
  }
}

class FakeConnection {
  channel = new FakeChannel();
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  createDataChannel(): RTCDataChannel { return this.channel as unknown as RTCDataChannel; }
  async createOffer(): Promise<RTCSessionDescriptionInit> { return { type: 'offer', sdp: 'offer' }; }
  async setLocalDescription(sdp: RTCSessionDescriptionInit): Promise<void> {
    this.localDescription = sdp;
    this.signalingState = 'have-local-offer';
  }
  async setRemoteDescription(sdp: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = sdp;
    this.signalingState = 'stable';
  }
  close(): void { this.channel.close(); this.onconnectionstatechange?.(); }
}

function newPeer(): { session: PeerSession; pc: FakeConnection; states: [PeerState, string | undefined][]; closed: string[] } {
  const states: [PeerState, string | undefined][] = [];
  const closed: string[] = [];
  const events: PeerEvents = {
    onState: (state, reason) => states.push([state, reason]),
    onControl: () => undefined, onChunk: () => undefined, onScreenTrack: () => undefined,
    onVerified: () => undefined, onClosed: (reason) => closed.push(reason),
  };
  const session = new PeerSession({
    identity: {} as Identity,
    peer: { connId: 'direct:test', deviceId: 'device-id', publicKey: '', fingerprint: '',
      name: 'phone', platform: 'android', sessionNonce: 'nonce', confirmed: false } as PeerLink,
    role: 'initiator', signal: { relay: () => undefined }, iceServers: [], events,
  });
  return { session, pc: session.pc as unknown as FakeConnection, states, closed };
}

const previous = globalThis.RTCPeerConnection;
const previousWindow = globalThis.window;
(globalThis as typeof globalThis & { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection =
  FakeConnection as unknown as typeof RTCPeerConnection;
globalThis.window = globalThis as unknown as Window & typeof globalThis;
test.after(() => {
  (globalThis as typeof globalThis & { RTCPeerConnection: typeof RTCPeerConnection }).RTCPeerConnection = previous;
  globalThis.window = previousWindow;
});

const timerOf = (session: PeerSession): number | null =>
  (session as unknown as { openTimer: number | null }).openTimer;

test('a manual QR invitation has no 25-second deadline before its reply is scanned', async () => {
  const { session, pc } = newPeer();
  await session.start({ manualTicket: true });
  assert.equal(timerOf(session), null, 'waiting while humans scan QR codes must not kill the host');
  await session.handleRelay('answer', { sdp: { type: 'answer', sdp: 'reply' } });
  assert.notEqual(timerOf(session), null, 'real network connection now gets a bounded deadline');
  session.close('test complete');
  assert.equal(timerOf(session), null);
  assert.equal(pc.channel.readyState, 'closed');
});

test('server-based negotiation still has an opening deadline', async () => {
  const { session } = newPeer();
  await session.start();
  assert.notEqual(timerOf(session), null);
  session.close('test complete');
});

test('a WebRTC failure remains the terminal reason when close and ICE callbacks cascade', async () => {
  const { session, pc, states, closed } = newPeer();
  await session.start();
  pc.connectionState = 'failed';
  pc.onconnectionstatechange?.();
  assert.equal(session.state, 'failed');
  assert.equal(states.at(-1)?.[0], 'failed');
  assert.match(states.at(-1)?.[1] ?? '', /WebRTC connection failed/);
  assert.equal(closed.length, 1, 'closing the channel during teardown cannot report a second terminal event');
  pc.channel.onclose?.();
  pc.onconnectionstatechange?.();
  assert.equal(session.state, 'failed');
  assert.equal(closed.length, 1);
});

test('a reply arriving after cancellation cannot resurrect a QR session', async () => {
  const { session, states } = newPeer();
  await session.start({ manualTicket: true });
  session.close('cancelled');
  await session.handleRelay('answer', { sdp: { type: 'answer', sdp: 'reply' } });
  assert.equal(timerOf(session), null);
  assert.deepEqual(states.map(([state]) => state), ['connecting', 'closed']);
});

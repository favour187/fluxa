/**
 * PeerSession — one WebRTC connection between two authenticated devices.
 *
 * Security properties implemented here:
 *  - The remote identity key is *pinned* from the signalling exchange (which the
 *    server verified), and the in-channel hello must present the exact same key.
 *  - The hello is signed by that identity key over a transcript that includes
 *    both session nonces and both DTLS fingerprints.
 *  - The DTLS fingerprint in the hello is compared with the fingerprint that
 *    actually appears in the negotiated SDP. This binds "the key I verified" to
 *    "the DTLS session carrying the bytes", so a malicious server that swaps
 *    SDP/ICE cannot silently MITM without the 6-digit code changing.
 *  - A 6-digit short authentication string derived from an ephemeral ECDH
 *    exchange + both identity keys is displayed on both screens. Users compare
 *    it out-of-band before any file is allowed to move.
 */
import {
  channelHelloSignInput,
  deriveDeviceId,
  publicKeyFingerprint,
  deriveSharedSecret,
  fingerprintFromSdp,
  generateEcdhKeyPair,
  randomToken,
  sasDigits,
  sha256,
  signWithIdentity,
  verifySignature,
  buildSasTranscript,
  exportPublicKeySpki,
} from '../shared/crypto.js';
import { decodeFrame, encodeChunk, encodeControl, PROTOCOL_VERSION, type ControlMessage } from '../shared/protocol.js';
import type { Identity } from './identity.js';
import type { PeerLink } from './signal.js';
import type { Relay } from './direct.js';

export type PeerState =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'awaiting-verification'
  | 'connected'
  | 'closed'
  | 'failed';

export interface PeerEvents {
  onState: (state: PeerState, detail?: string) => void;
  onControl: (msg: ControlMessage) => void;
  onChunk: (streamId: number, offset: number, data: Uint8Array) => void;
  onVerified: () => void;
  onClosed: (reason: string) => void;
}

interface ChannelHello {
  t: 'hello';
  v: number;
  deviceId: string;
  publicKey: string;
  fingerprint: string;
  dtls: string;
  nonce: string;
  ephPub: string;
  sig: string;
}

const CHANNEL_OPEN_TIMEOUT_MS = 25_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const PING_INTERVAL_MS = 10_000;

export class PeerSession {
  readonly peer: PeerLink;
  readonly role: 'initiator' | 'responder';
  state: PeerState = 'idle';
  sas: string | null = null;
  verified = false;
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null = null;

  private readonly identity: Identity;
  /**
   * Where negotiation messages go: the signalling client normally, a
   * ticket-capturing relay for direct (server-less) pairing. Only `relay` and
   * `verify` are used, so both satisfy the same shape.
   */
  private readonly signal: Relay & { verify?: (connId: string, ok: boolean) => void };
  private readonly events: PeerEvents;
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private localHello: ChannelHello | null = null;
  private remoteHello: ChannelHello | null = null;
  private ecdh: CryptoKeyPair | null = null;
  private sessionKey: Uint8Array | null = null;
  private openTimer: number | null = null;
  private handshakeTimer: number | null = null;
  private pingTimer: number | null = null;
  private closed = false;
  private verifying = false;

  constructor(opts: {
    identity: Identity;
    peer: PeerLink;
    role: 'initiator' | 'responder';
    signal: Relay & { verify?: (connId: string, ok: boolean) => void };
    iceServers: RTCIceServer[];
    events: PeerEvents;
  }) {
    this.identity = opts.identity;
    this.peer = opts.peer;
    this.role = opts.role;
    this.signal = opts.signal;
    this.events = opts.events;

    this.pc = new RTCPeerConnection({
      iceServers: opts.iceServers,
      // Do not leak pre-connection ICE candidates to a peer that has not been verified.
      iceCandidatePoolSize: 0,
      bundlePolicy: 'max-bundle',
    });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.signal.relay(this.peer.connId, 'ice', { candidate: e.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed') this.fail('connection failed');
      else if (s === 'disconnected') this.events.onState('connecting', 'connection interrupted');
      else if (s === 'connected' && this.state === 'connecting') this.events.onState('handshaking');
    };
    this.pc.ondatachannel = (e) => this.attachChannel(e.channel);
  }

  /**
   * Direct pairing learns the peer's identity from the ticket exchange rather
   * than from a server. It must happen before the remote description is applied
   * (i.e. before any hello can arrive), which is why it is guarded here: the
   * identity a session pins can never change after negotiation starts.
   */
  setPeerIdentity(info: { deviceId: string; publicKey: string; fingerprint: string; name: string; platform: string }): void {
    if (this.remoteDescriptionSet) throw new Error('peer identity cannot change after negotiation started');
    this.peer.deviceId = info.deviceId;
    this.peer.publicKey = info.publicKey;
    this.peer.fingerprint = info.fingerprint;
    this.peer.name = info.name || this.peer.name;
    this.peer.platform = info.platform || this.peer.platform;
  }

  /* ---------------------------------------------------------------- */
  /* Negotiation                                                       */
  /* ---------------------------------------------------------------- */

  async start(): Promise<void> {
    this.setState('connecting');
    this.openTimer = window.setTimeout(() => this.fail('timed out opening the data channel'), CHANNEL_OPEN_TIMEOUT_MS);
    try {
      if (this.role === 'initiator') {
        this.attachChannel(this.pc.createDataChannel('fluxa', { ordered: true }));
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.signal.relay(this.peer.connId, 'offer', { sdp: this.pc.localDescription });
      }
    } catch (err) {
      this.fail(`negotiation failed: ${(err as Error).message}`);
    }
  }

  async handleRelay(type: string, payload: unknown): Promise<void> {
    try {
      if (type === 'offer') {
        const { sdp } = payload as { sdp: RTCSessionDescriptionInit };
        await this.pc.setRemoteDescription(sdp);
        this.remoteDescriptionSet = true;
        await this.flushCandidates();
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signal.relay(this.peer.connId, 'answer', { sdp: this.pc.localDescription });
        return;
      }
      if (type === 'answer') {
        const { sdp } = payload as { sdp: RTCSessionDescriptionInit };
        if (!this.pc.signalingState || this.pc.signalingState !== 'have-local-offer') {
          throw new Error('unexpected answer in state ' + this.pc.signalingState);
        }
        await this.pc.setRemoteDescription(sdp);
        this.remoteDescriptionSet = true;
        await this.flushCandidates();
        return;
      }
      if (type === 'ice') {
        const { candidate } = payload as { candidate: RTCIceCandidateInit };
        if (!candidate) return;
        if (!this.remoteDescriptionSet) {
          if (this.pendingCandidates.length > 200) this.pendingCandidates.shift();
          this.pendingCandidates.push(candidate);
          return;
        }
        await this.pc.addIceCandidate(candidate).catch(() => {
          /* stale candidate after an ICE restart — safe to ignore */
        });
        return;
      }
      if (type === 'bye') {
        this.close('peer closed the session');
      }
    } catch (err) {
      this.fail(`signalling error: ${(err as Error).message}`);
    }
  }

  private async flushCandidates(): Promise<void> {
    for (const candidate of this.pendingCandidates.splice(0)) {
      await this.pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Channel + handshake                                               */
  /* ---------------------------------------------------------------- */

  private attachChannel(channel: RTCDataChannel): void {
    if (this.channel) return;
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 256 * 1024;
    channel.onopen = () => void this.sendHello();
    channel.onclose = () => this.close('data channel closed');
    channel.onerror = () => this.fail('data channel error');
    channel.onmessage = (event) => this.onFrame(event.data as ArrayBuffer);
  }

  private async sendHello(): Promise<void> {
    if (this.openTimer !== null) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.setState('handshaking');
    this.handshakeTimer = window.setTimeout(() => this.fail('handshake timed out'), HANDSHAKE_TIMEOUT_MS);
    try {
      this.ecdh = await generateEcdhKeyPair();
      const ephPub = await exportPublicKeySpki(this.ecdh.publicKey);
      const dtls = this.localDtlsFingerprint();
      if (!dtls) throw new Error('local DTLS fingerprint unavailable');
      const nonce = randomToken(16);
      const sig = await signWithIdentity(
        this.identity.privateKey,
        channelHelloSignInput({
          deviceId: this.identity.deviceId,
          peerDeviceId: this.peer.deviceId,
          sessionNonce: this.peer.sessionNonce,
          fingerprint: this.identity.fingerprint,
          dtlsFingerprint: dtls,
          nonce,
          ephPub,
        }),
      );
      this.localHello = {
        t: 'hello',
        v: PROTOCOL_VERSION,
        deviceId: this.identity.deviceId,
        publicKey: this.identity.publicKey,
        fingerprint: this.identity.fingerprint,
        dtls,
        nonce,
        ephPub,
        sig,
      };
      this.sendControl(this.localHello as unknown as ControlMessage);
      if (this.remoteHello) await this.completeHandshake();
    } catch (err) {
      this.fail(`handshake failed: ${(err as Error).message}`);
    }
  }

  private onFrame(raw: ArrayBuffer): void {
    let frame;
    try {
      frame = decodeFrame(raw);
    } catch (err) {
      this.fail(`malformed frame: ${(err as Error).message}`);
      return;
    }
    if (frame.kind === 'chunk') {
      if (this.state !== 'connected') return; // never accept bytes before verification
      this.events.onChunk(frame.streamId, frame.offset, frame.data);
      return;
    }
    const msg = frame.message;
    if (msg.t === 'hello') {
      void this.onRemoteHello(msg as unknown as ChannelHello);
      return;
    }
    if (msg.t === 'ping') {
      this.sendControl({ t: 'pong', ts: msg.ts });
      return;
    }
    if (msg.t === 'pong') return;
    if (this.state !== 'connected') return;
    this.events.onControl(msg);
  }

  private async onRemoteHello(hello: ChannelHello): Promise<void> {
    if (this.remoteHello) return; // ignore duplicates; the first hello wins
    try {
      // 1. Pinned identity: the key must be the one the server authenticated for
      //    this pairing. A display name or a new key is never accepted here.
      if (hello.deviceId !== this.peer.deviceId || hello.publicKey !== this.peer.publicKey ||
          await deriveDeviceId(hello.publicKey) !== hello.deviceId ||
          await publicKeyFingerprint(hello.publicKey) !== hello.fingerprint) {
        throw new Error('peer identity or fingerprint does not match the paired device');
      }
      // A previously trusted identity must not silently change after reconnect.
      // Device ids already bind keys; compare both fields to defend against a
      // corrupted local trust record or an inconsistent signalling server.
      if (this.peer.fingerprint && this.peer.fingerprint !== hello.fingerprint) {
        throw new Error('peer fingerprint changed during pairing');
      }
      // 2. DTLS binding: the fingerprint must be the one actually negotiated.
      const negotiated = this.remoteDtlsFingerprint();
      if (!negotiated || hello.dtls !== negotiated) {
        throw new Error('DTLS fingerprint mismatch — the connection was tampered with');
      }
      // 3. Proof of possession over the full transcript.
      const ok = await verifySignature(
        hello.publicKey,
        hello.sig,
        channelHelloSignInput({
          deviceId: hello.deviceId,
          peerDeviceId: this.identity.deviceId,
          sessionNonce: this.peer.sessionNonce,
          fingerprint: hello.fingerprint,
          dtlsFingerprint: hello.dtls,
          nonce: hello.nonce,
          ephPub: hello.ephPub,
        }),
      );
      if (!ok) throw new Error('peer signature is invalid');
      this.remoteHello = hello;
      if (this.localHello) await this.completeHandshake();
    } catch (err) {
      this.fail((err as Error).message);
    }
  }

  private async completeHandshake(): Promise<void> {
    if (!this.localHello || !this.remoteHello || !this.ecdh) return;
    try {
      const secret = await deriveSharedSecret(this.ecdh.privateKey, this.remoteHello.ephPub);
      const transcript = buildSasTranscript({
        sessionNonce: this.peer.sessionNonce,
        deviceA: this.identity.deviceId,
        deviceB: this.remoteHello.deviceId,
        fingerprintA: this.identity.fingerprint,
        fingerprintB: this.remoteHello.fingerprint,
        ephA: this.localHello.ephPub,
        ephB: this.remoteHello.ephPub,
        nonceA: this.localHello.nonce,
        nonceB: this.remoteHello.nonce,
      });
      const digest = await sha256(new TextEncoder().encode(transcript));
      this.sas = sasDigits(digest);
      this.sessionKey = secret; // reserved for a future authenticated channel layer
      if (this.handshakeTimer !== null) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.setState('awaiting-verification');
    } catch (err) {
      this.fail(`key agreement failed: ${(err as Error).message}`);
    }
  }

  /** Called when the local user confirms the 6-digit code matches. */
  confirmVerification(matches: boolean): void {
    if (this.verifying || this.state !== 'awaiting-verification' || !this.sas || !this.remoteHello || !this.localHello) return;
    this.verifying = true;
    if (!matches) {
      this.signal.verify?.(this.peer.connId, false);
      this.close('verification rejected');
      return;
    }
    this.signal.verify?.(this.peer.connId, true);
    this.verified = true;
    this.setState('connected');
    this.startPing();
    this.events.onVerified();
  }

  private startPing(): void {
    if (this.pingTimer !== null) return;
    this.pingTimer = window.setInterval(() => {
      this.sendControl({ t: 'ping', ts: Date.now() });
    }, PING_INTERVAL_MS);
  }

  /* ---------------------------------------------------------------- */
  /* I/O                                                               */
  /* ---------------------------------------------------------------- */

  sendControl(msg: ControlMessage): void {
    if (this.channel?.readyState !== 'open') return;
    try {
      this.channel.send(encodeControl(msg));
    } catch (err) {
      this.fail(`failed to send control message: ${(err as Error).message}`);
    }
  }

  /** Returns false when the channel is gone or the chunk was rejected locally. */
  sendChunk(streamId: number, offset: number, data: Uint8Array): boolean {
    if (this.channel?.readyState !== 'open') return false;
    try {
      this.channel.send(encodeChunk(streamId, offset, data));
      return true;
    } catch (err) {
      this.fail(`failed to send chunk: ${(err as Error).message}`);
      return false;
    }
  }

  get bufferedAmount(): number {
    return this.channel?.bufferedAmount ?? 0;
  }

  waitForDrain(threshold: number, timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const channel = this.channel;
      if (!channel || channel.readyState !== 'open') return reject(new Error('data channel is not open'));
      if (channel.bufferedAmount <= threshold) return resolve();
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('timed out waiting for the peer to drain the channel'));
      }, timeoutMs);
      const onLow = () => {
        if (channel.bufferedAmount > threshold) return;
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('data channel closed while draining'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        channel.removeEventListener('bufferedamountlow', onLow);
        channel.removeEventListener('close', onClose);
      };
      channel.addEventListener('bufferedamountlow', onLow);
      channel.addEventListener('close', onClose);
      channel.bufferedAmountLowThreshold = Math.min(threshold, 256 * 1024);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Teardown                                                          */
  /* ---------------------------------------------------------------- */

  fail(reason: string): void {
    if (this.state === 'failed' || this.state === 'closed') return;
    this.setState('failed', reason);
    this.teardown();
    this.events.onClosed(reason);
  }

  close(reason: string): void {
    if (this.state === 'closed') return;
    this.setState('closed', reason);
    this.teardown();
    this.events.onClosed(reason);
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    if (this.handshakeTimer !== null) clearTimeout(this.handshakeTimer);
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.openTimer = this.handshakeTimer = this.pingTimer = null;
    try {
      this.channel?.close();
    } catch {
      /* already closed */
    }
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    this.channel = null;
  }

  private setState(state: PeerState, detail?: string): void {
    this.state = state;
    this.events.onState(state, detail);
  }

  private localDtlsFingerprint(): string | null {
    const sdp = this.pc.localDescription?.sdp;
    return sdp ? fingerprintFromSdp(sdp) : null;
  }

  private remoteDtlsFingerprint(): string | null {
    const sdp = this.pc.remoteDescription?.sdp;
    return sdp ? fingerprintFromSdp(sdp) : null;
  }

  /** Candidate type actually in use, for honest "direct vs relay" reporting. */
  async connectionPath(): Promise<{ direct: boolean; type: string; protocol: string } | null> {
    try {
      const stats = await this.pc.getStats();
      let selectedPairId: string | null = null;
      let transport: RTCStats | undefined;
      stats.forEach((report) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId as string;
          transport = report;
        }
      });
      void transport;
      if (!selectedPairId) return null;
      const pair = stats.get(selectedPairId!);
      if (!pair) return null;
      const local = stats.get(pair.localCandidateId as string);
      const type = (local?.candidateType as string) ?? 'unknown';
      return {
        direct: type === 'host' || type === 'srflx' || type === 'prflx',
        type,
        protocol: (local?.protocol as string) ?? 'unknown',
      };
    } catch {
      return null;
    }
  }
}

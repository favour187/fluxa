/**
 * Signalling client.
 *
 * State machine: connecting -> challenge -> hello -> ready.
 * The server proves nothing to the client except that it accepted a signature;
 * all trust decisions happen in PeerSession via pinned public keys and the
 * out-of-band 6-digit code.
 */
import {
  deriveDeviceId,
  randomToken,
  signalingHelloSignInput,
  signWithIdentity,
  verifySignature,
} from '../shared/crypto.js';
import type { Identity } from './identity.js';

export type ServerEvent =
  | { t: 'challenge'; nonce: string; protocolVersion: number }
  | { t: 'ready'; connId: string; iceServers: RTCIceServer[]; limits: unknown; chunkSize: number; publicUrl: string | null }
  | { t: 'code'; code: string; expiresAt: number; link: string | null }
  | { t: 'codeCancelled' }
  | { t: 'profileUpdated'; name: string }
  | { t: 'claimed'; peer: PeerLink }
  | { t: 'codeClaimed'; peer: PeerLink }
  | { t: 'verified'; peer: PeerLink }
  | { t: 'verifyFailed'; peer: { connId: string; deviceId: string } }
  | { t: 'relay'; from: string; fromDeviceId: string; type: string; payload: unknown }
  | { t: 'peerLeft'; peer: { connId: string; deviceId: string | null } }
  | { t: 'error'; code: string; message: string }
  | { t: 'pong'; ts: number }
  | { t: 'status'; status: SignalStatus; detail?: string };

export interface PeerLink {
  connId: string;
  deviceId: string;
  publicKey: string;
  fingerprint: string;
  name: string;
  platform: string;
  sessionNonce: string;
  confirmed: boolean;
}

export type SignalStatus = 'offline' | 'connecting' | 'verifying' | 'online';

type Listener = (event: ServerEvent) => void;

export class SignalClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private reconnectAttempts = 0;
  /** True once this client has completed a handshake with a server at least once. */
  private wasReady = false;
  private reconnectTimer: number | null = null;
  private closedByUser = false;
  private url: string;
  status: SignalStatus = 'offline';
  connId: string | null = null;
  iceServers: RTCIceServer[] = [];
  chunkSize = 64 * 1024;
  publicUrl: string | null = null;

  constructor(
    private readonly identity: Identity,
    url?: string,
  ) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.url = url ?? `${proto}//${location.host}/ws`;
  }

  get currentUrl(): string {
    return this.url;
  }

  /**
   * Point this client at a different signalling server (used for nearby devices
   * discovered over mDNS). The page origin never changes, so device identity and
   * the trust store survive the switch.
   */
  setUrl(url: string): void {
    if (this.url === url) {
      this.connect();
      return;
    }
    this.url = url;
    this.resetConnectionState();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* already closing */
      }
      this.socket = null;
    }
    this.connect();
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ServerEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private setStatus(status: SignalStatus, detail?: string): void {
    this.status = status;
    this.emit({ t: 'status', status, detail });
  }

  connect(): void {
    this.closedByUser = false;
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
    this.setStatus('connecting');
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.setStatus('verifying');
    });

    socket.addEventListener('message', (event) => {
      let msg: ServerEvent;
      try {
        msg = JSON.parse(String(event.data)) as ServerEvent;
      } catch {
        return;
      }
      if (msg.t === 'challenge') {
        void this.sendHello(msg.nonce);
        return;
      }
      if (msg.t === 'ready') {
        this.connId = msg.connId;
        this.iceServers = msg.iceServers ?? [];
        if (typeof msg.chunkSize === 'number') this.chunkSize = msg.chunkSize;
        this.publicUrl = msg.publicUrl ?? null;
        this.wasReady = true;
        this.setStatus('online');
      }
      this.emit(msg);
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      this.connId = null;
      if (this.closedByUser) {
        this.setStatus('offline');
        return;
      }
      // Never reached the server at all (no server on this device/network):
      // report that plainly instead of spinning on "connecting" forever, and
      // keep retrying in the background so a server that appears later is
      // picked up on its own.
      if (!this.wasReady) this.setStatus('offline', 'no signalling server reachable');
      else this.setStatus('connecting', 'connection lost, reconnecting');
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      /* close handler drives reconnection */
    });
  }

  /** Forget a previous server so status reflects the new one honestly. */
  resetConnectionState(): void {
    this.wasReady = false;
    this.reconnectAttempts = 0;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempts) + Math.random() * 250;
    this.reconnectAttempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async sendHello(challenge: string): Promise<void> {
    const nonce = challenge;
    const sig = await signWithIdentity(
      this.identity.privateKey,
      signalingHelloSignInput(nonce, this.identity.deviceId),
    );
    this.raw({
      t: 'hello',
      deviceId: this.identity.deviceId,
      publicKey: this.identity.publicKey,
      fingerprint: this.identity.fingerprint,
      name: this.identity.name,
      platform: this.identity.platform,
      nonce,
      sig,
    });
  }

  private raw(payload: unknown): void {
    if (this.socket && this.socket.readyState === 1) this.socket.send(JSON.stringify(payload));
  }

  updateProfile(name: string): void {
    this.raw({ t: 'profile', name });
  }

  createCode(): void {
    this.raw({ t: 'createCode' });
  }

  cancelCode(): void {
    this.raw({ t: 'cancelCode' });
  }

  claimCode(code: string): void {
    this.raw({ t: 'claimCode', code });
  }

  verify(targetConnId: string, ok: boolean): void {
    this.raw({ t: 'verify', targetConnId, ok });
  }

  relay(to: string, type: string, payload: unknown): void {
    this.raw({ t: 'relay', to, type, payload });
  }

  bye(to: string): void {
    this.raw({ t: 'bye', to });
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.setStatus('offline');
  }
}

/**
 * Verify a `hello` received over the *signalling* channel from a third party.
 * Exposed so the peer session can re-check the claimed identity rather than
 * trusting the server to have done it.
 */
export async function verifyPeerIdentity(publicKey: string, deviceId: string): Promise<boolean> {
  return (await deriveDeviceId(publicKey)) === deviceId;
}

export { randomToken, verifySignature };

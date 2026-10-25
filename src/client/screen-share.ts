/**
 * User-picked screen capture across an already SAS-verified WebRTC connection.
 * The signalling server sees neither screen pixels nor media SDP: offers and
 * answers travel in the authenticated data channel. Media is DTLS-SRTP, with a
 * DTLS certificate pinned to the verified session. Each session needs fresh
 * consent from BOTH devices; stop/reload/disconnect releases the capture track.
 */
import { randomBytes, toHex } from '../shared/crypto.js';
import type { ScreenShareControl, ScreenSignal } from '../shared/protocol.js';
import type { PeerSession } from './peer.js';

type ScreenMessage = ScreenShareControl | ScreenSignal;
export type ScreenState = 'off' | 'requesting' | 'incoming' | 'starting' | 'sharing' | 'viewing' | 'error';
export interface ScreenView {
  state: ScreenState;
  peerName: string;
  stream: MediaStream | null;
  error?: string;
}
export interface ScreenEvents {
  onChange(): void;
  onInvitation(name: string): void;
  onError(message: string): void;
}

export class ScreenShare {
  private stateValue: ScreenState = 'off';
  private id: string | null = null;
  private capture: MediaStream | null = null;
  private remote: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private error?: string;

  constructor(private readonly session: PeerSession, private readonly events: ScreenEvents) {}

  get view(): ScreenView {
    return { state: this.stateValue, peerName: this.session.peer.name, stream: this.remote, error: this.error };
  }
  private get ready(): boolean { return this.session.state === 'connected' && this.session.verified; }

  async request(): Promise<void> {
    if (!this.ready || !['off', 'error'].includes(this.stateValue)) return;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.fail('Screen capture is not available here. Try a current desktop browser or supported desktop app.');
      return;
    }
    this.reset(false);
    const id = toHex(randomBytes(16));
    this.id = id;
    try {
      // This must run directly inside the button's gesture; never choose a
      // screen automatically or request microphone/system audio.
      const capture = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      if (this.id !== id || !this.ready) {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = capture.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') {
        capture.getTracks().forEach((item) => item.stop());
        throw new Error('No live screen was selected');
      }
      this.capture = capture;
      track.addEventListener('ended', () => this.stop(), { once: true });
      this.stateValue = 'requesting';
      this.events.onChange();
      this.session.sendControl({ t: 'screenShare', id, action: 'request' });
      this.startTimeout(id);
    } catch (err) {
      this.fail(`Screen capture was not started: ${(err as Error).message}`);
    }
  }

  respond(accept: boolean): void {
    if (!this.ready || this.stateValue !== 'incoming' || !this.id) return;
    const id = this.id;
    if (!accept) {
      this.session.sendControl({ t: 'screenShare', id, action: 'decline' });
      this.reset(false);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stateValue = 'viewing';
    this.remote = this.session.remoteScreenStream;
    this.events.onChange();
    this.session.sendControl({ t: 'screenShare', id, action: 'accept' });
  }

  handle(msg: ScreenMessage): void {
    if (!this.ready) return;
    if (msg.t === 'screenSignal') {
      if (msg.id === this.id && ((msg.action === 'offer' && this.stateValue === 'viewing') ||
          (msg.action === 'answer' && ['starting', 'sharing'].includes(this.stateValue)))) {
        void this.session.handleScreenSignal(msg).catch((err: Error) => {
          if (this.id === msg.id) this.fail(`Screen connection failed: ${err.message}`);
        });
      }
      return;
    }
    if (msg.action === 'request') {
      if (!['off', 'error'].includes(this.stateValue)) {
        if (msg.id !== this.id) this.session.sendControl({ t: 'screenShare', id: msg.id, action: 'decline', reason: 'Already sharing a screen' });
        return;
      }
      this.reset(false);
      this.id = msg.id;
      this.stateValue = 'incoming';
      this.events.onChange();
      this.events.onInvitation(this.session.peer.name);
      this.startTimeout(msg.id);
      return;
    }
    if (msg.id !== this.id) return;
    if (msg.action === 'accept' && this.stateValue === 'requesting') {
      this.stateValue = 'starting';
      this.events.onChange();
      const track = this.capture?.getVideoTracks()[0];
      if (!track || track.readyState !== 'live') { this.fail('Screen capture ended before the other device accepted'); return; }
      void this.session.sendScreenTrack(track, msg.id).then(() => {
        if (this.id === msg.id && this.stateValue === 'starting') {
          this.stateValue = 'sharing';
          if (this.timer) clearTimeout(this.timer);
          this.timer = null;
          this.events.onChange();
        }
      }).catch((err: Error) => {
        if (this.id === msg.id) this.fail(`Screen connection failed: ${err.message}`);
      });
    } else if (msg.action === 'decline' && this.stateValue === 'requesting') {
      this.fail('The other device declined screen sharing.');
    } else if (msg.action === 'stop') {
      this.reset(false);
      this.events.onError('The other device stopped screen sharing.');
    }
  }

  /** Keep the media track private until this instance has explicitly consented. */
  onTrack(stream: MediaStream): void {
    if (this.stateValue !== 'viewing' || !this.id || !this.ready) return;
    this.remote = stream;
    this.events.onChange();
  }

  stop(): void { this.reset(true); }
  close(): void { this.reset(false); }

  private startTimeout(id: string): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.id === id && ['requesting', 'incoming', 'starting'].includes(this.stateValue)) {
        this.fail('Screen sharing request timed out. Try again.');
      }
    }, 60_000);
  }

  private fail(message: string): void {
    this.reset(true);
    this.stateValue = 'error';
    this.error = message;
    this.events.onError(message);
    this.events.onChange();
  }

  private reset(notify: boolean): void {
    const id = this.id;
    const state = this.stateValue;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.id = null;
    this.stateValue = 'off';
    const capture = this.capture;
    this.capture = null;
    this.remote = null;
    this.error = undefined;
    if (capture) {
      capture.getTracks().forEach((track) => track.stop());
      void this.session.stopScreenTrack();
    } else if (id && state === 'viewing') {
      // A viewer may stop while an offer is still being answered. Roll back
      // that unconsented remote offer before accepting a future share.
      void this.session.stopScreenTrack();
    }
    if (notify && id && this.ready) this.session.sendControl({
      t: 'screenShare', id, action: state === 'incoming' ? 'decline' : 'stop',
    });
    this.events.onChange();
  }
}

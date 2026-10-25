/**
 * Explicit two-device clipboard mirroring. The encrypted, SAS-verified channel
 * carries bounded plain text only; clipboard data is never sent to signalling,
 * saved to history or captured before the user enables a session. The initial
 * clipboard is NOT sent: only changes made after both people accept are synced.
 * Browser tabs may poll only while focused. Desktop apps can poll while open;
 * packaged mobile apps poll while in the foreground (subject to OS paste rules).
 */
import { Capacitor } from '@capacitor/core';
import { randomBytes, toHex } from '../shared/crypto.js';
import type { ClipboardSyncControl, ClipboardUpdate, ControlMessage } from '../shared/protocol.js';
import { desktopBridge } from './desktop.js';
import type { PeerSession } from './peer.js';

type ClipboardMessage = ClipboardSyncControl | ClipboardUpdate;
type Session = Pick<PeerSession, 'state' | 'verified' | 'peer' | 'sendControl'>;

export interface ClipboardPort {
  enable(enabled: boolean): Promise<void>;
  read(): Promise<string>;
  write(text: string): Promise<void>;
  /** Browser permissions require a focused tab; native platforms do not. */
  requiresFocus?: boolean;
  requiresVisible?: boolean;
}

const LIMIT = 16_384;
const PENDING_MS = 60_000;
const textBytes = (text: string) => new TextEncoder().encode(text).byteLength;

/** The OS/permission boundary is outside the message handler, and mockable. */
export function clipboardPort(): ClipboardPort {
  const desktop = desktopBridge();
  if (desktop) return {
    enable: async (enabled) => {
      const result = await desktop.clipboardConsent(enabled);
      if (!result.ok) throw new Error(result.error || 'Desktop clipboard access was denied');
    },
    read: async () => {
      const result = await desktop.clipboardRead();
      if (!result.ok || typeof result.text !== 'string') throw new Error(result.error || 'Could not read desktop clipboard');
      return result.text;
    },
    write: async (text) => {
      const result = await desktop.clipboardWrite(text);
      if (!result.ok) throw new Error(result.error || 'Could not write desktop clipboard');
    },
  };
  if (Capacitor.isNativePlatform()) return {
    requiresVisible: true,
    enable: async () => {},
    read: async () => (await (await import('@capacitor/clipboard')).Clipboard.read()).value,
    write: async (text) => { await (await import('@capacitor/clipboard')).Clipboard.write({ string: text }); },
  };
  return {
    requiresFocus: true,
    enable: async () => {
      if (!navigator.clipboard?.readText || !navigator.clipboard?.writeText) {
        throw new Error('This browser does not permit clipboard access. Try the desktop app or share text manually.');
      }
    },
    read: () => navigator.clipboard.readText(),
    write: (text) => navigator.clipboard.writeText(text),
  };
}

export type ClipboardState = 'off' | 'requesting' | 'incoming' | 'active' | 'error';
export interface ClipboardView {
  state: ClipboardState;
  peerName: string;
  lastSyncedAt?: number;
  error?: string;
}
export interface ClipboardEvents {
  onChange(): void;
  onInvitation(peerName: string): void;
  onError(message: string): void;
}

export class ClipboardSync {
  private stateValue: ClipboardState = 'off';
  private id: string | null = null;
  private lastLocal: string | null = null;
  private lastVersion: { counter: number; origin: string } | null = null;
  private counter = 0;
  private busy = false;
  private queuedUpdate: ClipboardUpdate | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private pending: ReturnType<typeof setTimeout> | null = null;
  private lastSyncedAt?: number;
  private error?: string;

  constructor(
    private readonly session: Session,
    private readonly deviceId: string,
    private readonly port: ClipboardPort,
    private readonly events: ClipboardEvents,
  ) {}

  get view(): ClipboardView {
    return { state: this.stateValue, peerName: this.session.peer.name, lastSyncedAt: this.lastSyncedAt, error: this.error };
  }

  private get ready(): boolean {
    return this.session.state === 'connected' && this.session.verified;
  }

  async request(): Promise<void> {
    if (!this.ready || (this.stateValue !== 'off' && this.stateValue !== 'error')) return;
    this.reset(false);
    const id = toHex(randomBytes(16));
    this.id = id;
    try {
      await this.port.enable(true);
      const baseline = await this.port.read(); // prompts for browser clipboard permission from this click
      if (this.id !== id) return;
      if (!this.ready) throw new Error('The verified device disconnected');
      this.lastLocal = baseline;
      this.stateValue = 'requesting';
      this.events.onChange();
      this.session.sendControl({ t: 'clipboardSync', id, action: 'request' });
      this.startTimeout(id);
    } catch (err) {
      this.fail(`Could not start clipboard sync: ${(err as Error).message}`);
    }
  }

  async respond(accept: boolean): Promise<void> {
    if (this.stateValue !== 'incoming' || !this.id) return;
    const id = this.id;
    if (!accept) {
      if (this.ready) this.session.sendControl({ t: 'clipboardSync', id, action: 'decline' });
      this.reset(false);
      return;
    }
    try {
      if (!this.ready) throw new Error('The verified device disconnected');
      await this.port.enable(true);
      const baseline = await this.port.read();
      if (this.id !== id || this.stateValue !== 'incoming') return;
      this.lastLocal = baseline;
      this.session.sendControl({ t: 'clipboardSync', id, action: 'accept' });
      this.activate();
    } catch (err) {
      if (this.ready) this.session.sendControl({ t: 'clipboardSync', id, action: 'decline' });
      this.fail(`Could not enable clipboard sync: ${(err as Error).message}`);
    }
  }

  handle(msg: ClipboardMessage): void {
    if (!this.ready) return;
    if (msg.t === 'clipboardUpdate') {
      void this.receiveUpdate(msg);
      return;
    }
    if (msg.action === 'request') {
      if (this.stateValue !== 'off' && this.stateValue !== 'error') {
        if (msg.id !== this.id) this.session.sendControl({ t: 'clipboardSync', id: msg.id, action: 'decline', reason: 'Already in a clipboard session' });
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
      this.activate();
    } else if (msg.action === 'decline' && this.stateValue === 'requesting') {
      this.fail('The other device declined clipboard sync.');
    } else if (msg.action === 'stop') {
      this.reset(false);
      this.events.onError('Clipboard sync stopped on the other device.');
    }
  }

  /** Stop on one device also revokes the other device's consent. */
  stop(): void { this.reset(true); }
  /** Peer disconnection/reload: revoke OS permissions without sending a frame. */
  close(): void { this.reset(false); }

  private startTimeout(id: string): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      if (this.id === id && (this.stateValue === 'incoming' || this.stateValue === 'requesting')) {
        this.fail('Clipboard sync request expired. Try again.');
      }
    }, PENDING_MS);
  }

  private activate(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
    this.stateValue = 'active';
    this.error = undefined;
    this.events.onChange();
    this.interval = setInterval(() => { void this.pollOnce(); }, 1_000);
  }

  /** Public for deterministic tests; the interval invokes the same operation. */
  async pollOnce(): Promise<void> {
    if (!this.ready || this.stateValue !== 'active' || !this.id || this.busy) return;
    if (this.port.requiresVisible && typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (this.port.requiresFocus && typeof document !== 'undefined' &&
        (document.visibilityState !== 'visible' || !document.hasFocus())) return;
    this.busy = true;
    try {
      const text = await this.port.read();
      if (this.stateValue !== 'active' || !this.id || !this.ready || text === this.lastLocal) return;
      this.lastLocal = text;
      if (textBytes(text) > LIMIT) {
        this.events.onError('Clipboard text is larger than 16 KiB; it was not synced.');
        return;
      }
      this.counter = Math.min(this.counter + 1, 1_000_000_000);
      this.lastVersion = { counter: this.counter, origin: this.deviceId };
      this.session.sendControl({ t: 'clipboardUpdate', id: this.id, text, counter: this.counter, origin: this.deviceId });
      this.lastSyncedAt = Date.now();
      this.events.onChange();
    } catch (err) {
      this.fail(`Clipboard read failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
      this.flushQueuedUpdate();
    }
  }

  private async receiveUpdate(msg: ClipboardUpdate): Promise<void> {
    if (!this.ready || this.stateValue !== 'active' || !this.id || msg.id !== this.id ||
        msg.origin !== this.session.peer.deviceId || textBytes(msg.text) > LIMIT) return;
    if (this.busy) {
      if (!this.queuedUpdate || msg.counter >= this.queuedUpdate.counter) this.queuedUpdate = msg;
      return;
    }
    const previous = this.lastVersion;
    if (previous && (msg.counter < previous.counter ||
        (msg.counter === previous.counter && msg.origin <= previous.origin))) return;
    this.busy = true;
    try {
      await this.port.write(msg.text);
      if (this.stateValue !== 'active' || this.id !== msg.id) return;
      this.lastLocal = msg.text; // avoid echoing the OS write on the next poll
      this.counter = Math.max(this.counter, msg.counter);
      this.lastVersion = { counter: msg.counter, origin: msg.origin };
      this.lastSyncedAt = Date.now();
      this.events.onChange();
    } catch (err) {
      this.fail(`Clipboard write failed: ${(err as Error).message}`);
    } finally {
      this.busy = false;
      this.flushQueuedUpdate();
    }
  }

  private flushQueuedUpdate(): void {
    const queued = this.queuedUpdate;
    this.queuedUpdate = null;
    if (queued) void this.receiveUpdate(queued);
  }

  private fail(message: string): void {
    this.reset(true);
    this.stateValue = 'error';
    this.error = message;
    this.events.onError(message);
    this.events.onChange();
  }

  private reset(notifyPeer: boolean): void {
    const id = this.id;
    const state = this.stateValue;
    if (this.interval) clearInterval(this.interval);
    if (this.pending) clearTimeout(this.pending);
    this.interval = null;
    this.pending = null;
    this.id = null;
    this.stateValue = 'off';
    this.queuedUpdate = null;
    this.lastLocal = null;
    this.lastVersion = null;
    this.counter = 0;
    this.lastSyncedAt = undefined;
    this.error = undefined;
    if (notifyPeer && id && this.ready && state !== 'off' && state !== 'incoming') {
      this.session.sendControl({ t: 'clipboardSync', id, action: 'stop' });
    }
    if (id) void this.port.enable(false).catch(() => {});
    this.events.onChange();
  }
}

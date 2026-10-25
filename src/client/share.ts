/** Optional, isolated user-initiated content sharing over an already verified
 * DTLS DataChannel. No polling/monitoring of the clipboard or browser tabs.
 * Nothing is copied or opened at the receiver without TWO actions: approve the
 * incoming item, then explicitly press Copy or Open.
 */
import { randomBytes, toHex } from '../shared/crypto.js';
import { validateSharedContent, type ControlMessage, type SharedContent } from '../shared/protocol.js';
import type { PeerSession } from './peer.js';

export interface ReceivedShare extends SharedContent {
  peerDeviceId: string;
  peerName: string;
  receivedAt: number;
}

const TIMEOUT = 120_000;

export class ShareManager {
  private incoming = new Map<string, { item: ReceivedShare; timer: number }>();
  private outgoing = new Map<string, number>();
  private seen = new Set<string>();

  constructor(private readonly session: PeerSession, private readonly events: {
    onIncoming: (share: ReceivedShare) => void;
    onResult: (id: string, ok: boolean, reason?: string) => void;
    onExpired: (id: string) => void;
  }) {}

  send(kind: SharedContent['kind'], text: string, url?: string, title?: string): string {
    if (!this.session.verified || this.session.state !== 'connected') throw new Error('Device is not verified');
    const item: SharedContent = { t: 'share', id: toHex(randomBytes(16)), kind, text, ...(url ? { url } : {}), ...(title ? { title } : {}) };
    const valid = validateSharedContent(item);
    if (!valid.ok) throw new Error(valid.reason ?? 'Unsupported content');
    const timer = window.setTimeout(() => {
      this.outgoing.delete(item.id);
      this.events.onResult(item.id, false, 'The receiving device did not respond');
    }, TIMEOUT);
    this.outgoing.set(item.id, timer);
    this.session.sendControl(item);
    return item.id;
  }

  handle(msg: ControlMessage): void {
    if (msg.t === 'shareResult') {
      const timer = this.outgoing.get(msg.id);
      if (timer === undefined) return;
      clearTimeout(timer);
      this.outgoing.delete(msg.id);
      this.events.onResult(msg.id, msg.ok, msg.reason);
      return;
    }
    if (msg.t !== 'share' || !this.session.verified || this.session.state !== 'connected') return;
    const validation = validateSharedContent(msg);
    if (!validation.ok || this.incoming.size >= 5 || this.seen.has(msg.id)) {
      this.session.sendControl({ t: 'shareResult', id: msg.id, ok: false, reason: 'Item rejected or duplicate' });
      return;
    }
    this.seen.add(msg.id);
    const item: ReceivedShare = {
      ...msg, peerDeviceId: this.session.peer.deviceId,
      peerName: this.session.peer.name, receivedAt: Date.now(),
    };
    const timer = window.setTimeout(() => {
      this.incoming.delete(item.id);
      this.session.sendControl({ t: 'shareResult', id: item.id, ok: false, reason: 'Approval timed out' });
      this.events.onExpired(item.id);
    }, TIMEOUT);
    this.incoming.set(item.id, { item, timer });
    this.events.onIncoming(item);
  }

  approve(id: string, yes: boolean): ReceivedShare | null {
    const pending = this.incoming.get(id);
    if (!pending) return null;
    clearTimeout(pending.timer);
    this.incoming.delete(id);
    this.session.sendControl({ t: 'shareResult', id, ok: yes, ...(!yes ? { reason: 'The recipient declined' } : {}) });
    return yes ? pending.item : null;
  }

  close(): void {
    for (const { timer } of this.incoming.values()) clearTimeout(timer);
    for (const [id, timer] of this.outgoing) {
      clearTimeout(timer);
      this.events.onResult(id, false, 'Connection closed before approval');
    }
    this.incoming.clear();
    this.outgoing.clear();
    this.seen.clear();
  }
}

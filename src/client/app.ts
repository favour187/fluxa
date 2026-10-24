/**
 * FluxaApp — application state and orchestration.
 *
 * Owns: device identity, signalling connection, one live PeerSession per paired
 * device, and the TransferManager attached to each verified session. The UI is a
 * pure projection of `snapshot()`; it never mutates protocol state directly.
 */
import {
  getTrusted,
  listTrusted,
  loadIdentity,
  revokeDevice,
  setDeviceName,
  trustDevice,
  type Identity,
  type TrustedDevice,
} from './identity.js';
import { PeerSession, type PeerState } from './peer.js';
import { SignalClient, type PeerLink, type ServerEvent, type SignalStatus } from './signal.js';
import { TransferManager } from './transfer/manager.js';
import type { ReceiveTask } from './transfer/receiver.js';
import type { SendTask } from './transfer/sender.js';
import type { ReceivedFile } from './transfer/sink.js';
import { clearReceivedFiles } from './transfer/sink.js';
import { formatBytes } from '../shared/protocol.js';

export interface SessionView {
  deviceId: string;
  name: string;
  platform: string;
  fingerprint: string;
  connId: string;
  state: PeerState;
  verified: boolean;
  sas: string | null;
  connection: { direct: boolean; type: string } | null;
  error: string | null;
}

export interface PairingView {
  code: string;
  expiresAt: number;
  link: string | null;
}

export interface TransferView {
  id: string;
  role: 'send' | 'receive';
  state: string;
  peerName: string;
  files: { name: string; size: number; status: string; verified: boolean; error?: string }[];
  totalBytes: number;
  transferredBytes: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  saveable: boolean;
}

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  message: string;
}

export interface AppSnapshot {
  ready: boolean;
  status: SignalStatus;
  identity: { name: string; platform: string; deviceId: string; fingerprint: string } | null;
  devices: (TrustedDevice & { online: boolean; state: PeerState | null; pending: boolean })[];
  sessions: SessionView[];
  pairing: PairingView | null;
  transfers: TransferView[];
  incoming: TransferView | null;
  verification: SessionView | null;
  toasts: Toast[];
  iceConfigured: boolean;
}

interface SessionEntry {
  link: PeerLink;
  session: PeerSession;
  manager: TransferManager | null;
  connection: { direct: boolean; type: string } | null;
  error: string | null;
}

type Listener = (snapshot: AppSnapshot) => void;

export class FluxaApp {
  identity: Identity | null = null;
  signal: SignalClient | null = null;
  private sessions = new Map<string, SessionEntry>();
  private trusted: TrustedDevice[] = [];
  private transfers = new Map<string, TransferView>();
  private received = new Map<string, ReceivedFile[]>();
  private pendingPairing: PairingView | null = null;
  private incoming: { task: ReceiveTask } | null = null;
  private toasts: Toast[] = [];
  private toastSeq = 1;
  private listeners = new Set<Listener>();
  private status: SignalStatus = 'offline';
  private userClosed = new Set<string>();
  private pendingRender = false;
  private ready = false;
  private iceConfigured = false;

  async init(): Promise<void> {
    this.identity = await loadIdentity();
    this.trusted = await listTrusted();
    this.signal = new SignalClient(this.identity);
    this.signal.on((event) => void this.onSignalEvent(event));
    this.signal.connect();
    this.ready = true;
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  /**
   * Progress fires many times per second; coalesce to one paint per frame so the
   * UI stays smooth (and so buttons are not re-created under the pointer).
   */
  private emitSoon(): void {
    if (this.pendingRender) return;
    this.pendingRender = true;
    requestAnimationFrame(() => {
      this.pendingRender = false;
      this.emit();
    });
  }

  snapshot(): AppSnapshot {
    const sessions = [...this.sessions.values()].map((entry) => this.sessionView(entry));
    const incomingTask = this.incoming?.task;
    return {
      ready: this.ready,
      status: this.status,
      identity: this.identity
        ? {
            name: this.identity.name,
            platform: this.identity.platform,
            deviceId: this.identity.deviceId,
            fingerprint: this.identity.fingerprint,
          }
        : null,
      devices: this.deviceList(),
      sessions,
      pairing: this.pendingPairing,
      transfers: [...this.transfers.values()].sort((a, b) => b.startedAt - a.startedAt),
      incoming: incomingTask ? this.transferViewFromReceive(incomingTask) : null,
      verification: sessions.find((s) => s.state === 'awaiting-verification') ?? null,
      toasts: [...this.toasts],
      iceConfigured: this.iceConfigured,
    };
  }

  /**
   * Trusted devices plus any *unverified* peer that is currently mid-handshake,
   * so a deferred pairing can still be found and verified.
   */
  private deviceList(): AppSnapshot['devices'] {
    const live = (deviceId: string) => {
      const entry = this.sessions.get(deviceId);
      if (!entry) return null;
      const dead = entry.session.state === 'closed' || entry.session.state === 'failed';
      return dead ? null : entry;
    };
    const devices = this.trusted.map((device) => {
      const entry = live(device.deviceId);
      return {
        ...device,
        online: Boolean(entry),
        state: entry?.session.state ?? null,
        pending: false,
      };
    });
    const known = new Set(this.trusted.map((d) => d.deviceId));
    for (const entry of this.sessions.values()) {
      if (known.has(entry.link.deviceId)) continue;
      const dead = entry.session.state === 'closed' || entry.session.state === 'failed';
      if (dead) continue;
      devices.push({
        deviceId: entry.link.deviceId,
        publicKey: entry.link.publicKey,
        fingerprint: entry.link.fingerprint,
        name: entry.link.name,
        platform: entry.link.platform,
        trustedAt: 0,
        lastSeen: Date.now(),
        online: true,
        state: entry.session.state,
        pending: true,
      });
    }
    return devices;
  }

  private sessionView(entry: SessionEntry): SessionView {
    return {
      deviceId: entry.link.deviceId,
      name: entry.link.name,
      platform: entry.link.platform,
      fingerprint: entry.link.fingerprint,
      connId: entry.link.connId,
      state: entry.session.state,
      verified: entry.session.verified,
      sas: entry.session.sas,
      connection: entry.connection,
      error: entry.error,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Signalling                                                        */
  /* ---------------------------------------------------------------- */

  private async onSignalEvent(event: ServerEvent): Promise<void> {
    switch (event.t) {
      case 'status':
        this.status = event.status;
        if (event.status === 'connecting' && event.detail) this.toast('info', `Signalling: ${event.detail}`);
        break;
      case 'ready': {
        this.iceConfigured = (this.signal?.iceServers?.length ?? 0) > 0;
        break;
      }
      case 'code':
        this.pendingPairing = { code: event.code, expiresAt: event.expiresAt, link: event.link };
        break;
      case 'codeCancelled':
        this.pendingPairing = null;
        break;
      case 'codeClaimed':
        this.pendingPairing = null;
        await this.openSession(event.peer, 'responder');
        break;
      case 'claimed':
        this.pendingPairing = null;
        await this.openSession(event.peer, 'initiator');
        break;
      case 'relay': {
        const entry = this.findByConn(event.from);
        if (entry) await entry.session.handleRelay(event.type, event.payload);
        break;
      }
      case 'verified': {
        const entry = this.findByConn(event.peer.connId);
        if (entry) {
          entry.link.confirmed = true;
          void this.refreshConnectionPath(entry);
        }
        break;
      }
      case 'verifyFailed':
        this.toast('error', 'Device verification was rejected');
        break;
      case 'peerLeft': {
        const entry = this.findByConn(event.peer.connId);
        if (entry) entry.session.close('the other device disconnected');
        break;
      }
      case 'error':
        this.toast('error', event.message);
        if (event.code === 'pairing_failed') this.pendingPairing = null;
        break;
      default:
        break;
    }
    this.emit();
  }

  private findByConn(connId: string): SessionEntry | undefined {
    for (const entry of this.sessions.values()) if (entry.link.connId === connId) return entry;
    return undefined;
  }

  private async openSession(peer: PeerLink, role: 'initiator' | 'responder'): Promise<void> {
    if (!this.identity || !this.signal) return;
    const existing = this.sessions.get(peer.deviceId);
    if (existing) existing.session.close('replaced by a new pairing');

    const session = new PeerSession({
      identity: this.identity,
      peer,
      role,
      signal: this.signal,
      iceServers: this.signal.iceServers,
      events: {
        onState: (state, detail) => {
          const entry = this.sessions.get(peer.deviceId);
          if (entry?.error && state !== 'failed') entry.error = null;
          if (state === 'failed' && detail) {
            if (entry) entry.error = detail;
            this.toast('error', `Connection to ${peer.name}: ${detail}`);
          }
          if (state === 'awaiting-verification') {
            this.toast('info', `Compare the code shown on ${peer.name}`);
          }
          this.emit();
        },
        onControl: (msg) => this.sessions.get(peer.deviceId)?.manager?.handleControl(msg),
        onChunk: (streamId, offset, data) =>
          this.sessions.get(peer.deviceId)?.manager?.handleChunk(streamId, offset, data),
        onVerified: () => {
          const entry = this.sessions.get(peer.deviceId);
          if (entry) void this.refreshConnectionPath(entry);
          void this.rememberPeer(peer);
          this.toast('success', `Verified connection with ${peer.name}`);
          this.emit();
        },
        onClosed: (reason) => this.onSessionClosed(peer.deviceId, reason),
      },
    });

    const manager = new TransferManager(session, this.identity.name, this.signal.chunkSize, false, {
      onUpdate: (task) => this.onTransferUpdate(task),
      onIncoming: (task) => {
        this.incoming = { task };
        this.emit();
      },
      onFinished: (task, files) => this.onTransferFinished(task, files),
      onProtocolError: (message, fatal) => this.toast(fatal ? 'error' : 'info', message),
    });

    const entry: SessionEntry = { link: peer, session, manager, connection: null, error: null };
    this.sessions.set(peer.deviceId, entry);
    this.emit();
    await session.start();
  }

  /** TransferManager signature is (name, session, chunkSize, preferMemory, events). */
  private async rememberPeer(peer: PeerLink): Promise<void> {
    try {
      const existing = await getTrusted(peer.deviceId);
      if (existing && existing.publicKey !== peer.publicKey) {
        this.toast('error', `${peer.name} presented a different key than the one you trusted — connection blocked`);
        return;
      }
      await trustDevice({
        deviceId: peer.deviceId,
        publicKey: peer.publicKey,
        fingerprint: peer.fingerprint,
        name: peer.name,
        platform: peer.platform,
      });
      this.trusted = await listTrusted();
    } catch (err) {
      this.toast('error', (err as Error).message);
    }
  }

  private async refreshConnectionPath(entry: SessionEntry): Promise<void> {
    const path = await entry.session.connectionPath();
    if (path) entry.connection = { direct: path.direct, type: path.type };
    this.emit();
  }

  private onSessionClosed(deviceId: string, reason: string): void {
    const entry = this.sessions.get(deviceId);
    if (!entry) return;
    entry.manager?.handleSessionClosed(reason);
    if (!this.userClosed.has(deviceId) && reason !== 'replaced by a new pairing') {
      this.toast('info', `${entry.link.name} disconnected`);
    }
    this.emit();
  }

  /* ---------------------------------------------------------------- */
  /* Transfers                                                         */
  /* ---------------------------------------------------------------- */

  private toTransferView(task: SendTask | ReceiveTask): TransferView {
    return {
      id: task.id,
      role: task.role,
      state: task.state,
      peerName: task.peerName,
      files: task.files.map((f) => ({
        name: f.descriptor.name,
        size: f.descriptor.size,
        status: f.status,
        verified: f.verified,
        ...(f.error ? { error: f.error } : {}),
      })),
      totalBytes: task.totalBytes,
      transferredBytes: task.role === 'send' ? task.ackedBytes : task.receivedBytes,
      bytesPerSecond: task.bytesPerSecond,
      etaSeconds: task.etaSeconds,
      error: task.error,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      saveable: this.received.get(task.id)?.length ? true : false,
    };
  }

  private transferViewFromReceive(task: ReceiveTask): TransferView {
    return this.toTransferView(task);
  }

  private onTransferUpdate(task: SendTask | ReceiveTask): void {
    this.transfers.set(task.id, this.toTransferView(task));
    if (this.incoming?.task.id === task.id && task.state !== 'incoming') this.incoming = null;
    this.emitSoon();
  }

  private onTransferFinished(task: SendTask | ReceiveTask, files: ReceivedFile[]): void {
    if (files.length > 0) this.received.set(task.id, files);
    this.transfers.set(task.id, this.toTransferView(task));
    if (this.incoming?.task.id === task.id) this.incoming = null;
    if (task.state === 'complete') {
      const direction = task.role === 'send' ? 'Sent' : 'Received';
      this.toast('success', `${direction} ${task.files.length} file${task.files.length === 1 ? '' : 's'} (${formatBytes(task.totalBytes)})`);
    } else if (task.state === 'failed') {
      this.toast('error', task.error ?? 'Transfer failed');
    }
    this.emit();
  }

  /* ---------------------------------------------------------------- */
  /* Public actions                                                    */
  /* ---------------------------------------------------------------- */

  requestPairingCode(): void {
    this.signal?.createCode();
  }

  cancelPairing(): void {
    this.signal?.cancelCode();
    this.pendingPairing = null;
    this.emit();
  }

  joinWithCode(code: string): boolean {
    const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned.length !== 6) {
      this.toast('error', 'Pairing codes are 6 characters');
      return false;
    }
    this.signal?.claimCode(cleaned);
    return true;
  }

  confirmVerification(deviceId: string, matches: boolean): void {
    const entry = this.sessions.get(deviceId);
    if (!entry) return;
    entry.session.confirmVerification(matches);
    if (!matches) {
      entry.error = 'You rejected the verification code';
      this.toast('error', 'Verification rejected — the connection was closed');
    }
    this.emit();
  }

  sendFiles(deviceId: string, files: File[]): void {
    const entry = this.sessions.get(deviceId);
    if (!entry) {
      this.toast('error', 'Select a connected device first');
      return;
    }
    if (!entry.session.verified || entry.session.state !== 'connected') {
      this.toast('error', 'Verify the connection with the other device first');
      return;
    }
    if (!entry.manager) return;
    if (files.length === 0) return;
    entry.manager.send(files);
    this.emit();
  }

  acceptTransfer(transferId: string): void {
    const task = this.incoming?.task.id === transferId ? this.incoming.task : this.findReceive(transferId);
    if (!task) return;
    void task.accept();
    this.emit();
  }

  declineTransfer(transferId: string): void {
    this.findReceive(transferId)?.decline();
    if (this.incoming?.task.id === transferId) this.incoming = null;
    this.emit();
  }

  cancelTransfer(transferId: string): void {
    for (const entry of this.sessions.values()) {
      const send = entry.manager?.getSend(transferId);
      if (send) {
        void send.cancel();
        return;
      }
      const receive = entry.manager?.getReceive(transferId);
      if (receive) {
        receive.cancel();
        return;
      }
    }
  }

  private findReceive(transferId: string): ReceiveTask | undefined {
    for (const entry of this.sessions.values()) {
      const task = entry.manager?.getReceive(transferId);
      if (task) return task;
    }
    return undefined;
  }

  disconnectDevice(deviceId: string): void {
    const entry = this.sessions.get(deviceId);
    if (!entry) return;
    this.userClosed.add(deviceId);
    this.signal?.bye(entry.link.connId);
    entry.session.close('disconnected by you');
    this.sessions.delete(deviceId);
    this.toast('info', `Disconnected from ${entry.link.name}`);
    this.emit();
  }

  async revoke(deviceId: string): Promise<void> {
    this.disconnectDevice(deviceId);
    await revokeDevice(deviceId);
    this.trusted = await listTrusted();
    this.toast('info', 'Device removed from trusted devices');
    this.emit();
  }

  async rename(name: string): Promise<void> {
    if (!this.identity) return;
    const clean = name.trim().slice(0, 48);
    if (!clean) return;
    await setDeviceName(clean);
    this.identity = { ...this.identity, name: clean };
    this.signal?.updateProfile(clean);
    this.emit();
  }

  async saveReceived(transferId: string): Promise<void> {
    const files = this.received.get(transferId);
    if (!files?.length) return;
    for (const file of files) {
      const blob = file.blob;
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.descriptor.name;
      anchor.rel = 'noopener';
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  receivedFiles(transferId: string): ReceivedFile[] {
    return this.received.get(transferId) ?? [];
  }

  async clearReceivedStorage(): Promise<void> {
    await clearReceivedFiles();
    this.toast('info', 'Cleared received files stored by this browser');
    this.emit();
  }

  dismissToast(id: number): void {
    this.toasts = this.toasts.filter((t) => t.id !== id);
    this.emit();
  }

  toast(kind: Toast['kind'], message: string): void {
    const toast: Toast = { id: this.toastSeq++, kind, message };
    this.toasts = [...this.toasts.slice(-3), toast];
    setTimeout(() => this.dismissToast(toast.id), 6000);
    this.emit();
  }
}

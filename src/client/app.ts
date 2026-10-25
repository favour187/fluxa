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
import { clearReceivedFiles, readPartial, opfsAvailable } from './transfer/sink.js';
import { directoryPickerAvailable, exportToDirectory } from './transfer/export.js';
import { Sha256, sha256OfBlob } from './sha256.js';
import {
  clearHistory, deletePending, getPending, listHistory, listPending, saveHistory,
  type HistoryEntry, type PendingTransfer,
} from './transfer/journal.js';
import { formatBytes, PROTOCOL_VERSION } from '../shared/protocol.js';
import { isLocalNetworkHost } from '../shared/network.js';
import { desktopBridge, hasFilePicker, type DesktopBridge, type DesktopInfo, type NearbyPeer } from './desktop.js';
import {
  ManualRelay,
  decodeTicket,
  encodeTicket,
  ticketCandidates,
  waitForIceGathering,
  type DirectTicket,
  type Relay,
} from './direct.js';
import { randomToken } from '../shared/crypto.js';
import { nativeAvailability, saveFileNative } from './native.js';
import { ShareManager, type ReceivedShare } from './share.js';
import type { SharedContent } from '../shared/protocol.js';

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
  peerDeviceId: string;
  files: { name: string; relPath: string; size: number; status: string; verified: boolean; error?: string }[];
  totalBytes: number;
  transferredBytes: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
  saveable: boolean;
}

export interface ChatEntry { id: string; deviceId: string; peerName: string; direction: 'sent' | 'received'; text: string; sentAt: number; status: 'sending' | 'delivered' | 'received' | 'failed' }

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
  desktop: DesktopInfo | null;
  nearby: NearbyPeer[];
  signalUrl: string | null;
  /** Direct (server-less) pairing state, when the user is in that flow. */
  direct: DirectView | null;
  incomingShares: ReceivedShare[];
  receivedShares: ReceivedShare[];
  messages: ChatEntry[];
}

export interface DirectView {
  role: 'host' | 'guest';
  step: 'offer' | 'reply' | 'connecting';
  /** The ticket this device wants the other device to read (null while working). */
  ticket: string | null;
  error: string | null;
}

interface SessionEntry {
  link: PeerLink;
  session: PeerSession;
  manager: TransferManager | null;
  shares: ShareManager | null;
  connection: { direct: boolean; type: string } | null;
  error: string | null;
}

type Listener = (snapshot: AppSnapshot) => void;

const SIGNAL_URL_KEY = 'fluxa:signal-url';
const TURN_ACCESS_KEY = 'fluxa:turn-access-key'; // per-origin; never copied into pairing links

/** Accept "host:port", "http://host:port", "ws://host/ws" and normalise to a ws URL. */
export function normaliseSignalUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return null;
  if (!parsed.hostname || parsed.username || parsed.password || parsed.hash || parsed.search) return null;
  const secure = parsed.protocol === 'https:' || parsed.protocol === 'wss:';
  if (!secure && !isLocalNetworkHost(parsed.hostname)) return null;
  return `${secure ? 'wss' : 'ws'}://${parsed.host}${parsed.pathname === '/' || !parsed.pathname ? '/ws' : parsed.pathname}`;
}

function defaultSignalUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function readSavedSignalUrl(): string | null {
  try {
    const saved = localStorage.getItem(SIGNAL_URL_KEY);
    return saved && normaliseSignalUrl(saved) ? normaliseSignalUrl(saved) : null;
  } catch {
    return null;
  }
}

export class FluxaApp {
  identity: Identity | null = null;
  signal: SignalClient | null = null;
  private sessions = new Map<string, SessionEntry>();
  private trusted: TrustedDevice[] = [];
  private transfers = new Map<string, TransferView>();
  private received = new Map<string, ReceivedFile[]>();
  private pendingTransfers = new Map<string, PendingTransfer>();
  private history = new Map<string, HistoryEntry>();
  private pendingShares = new Map<string, ReceivedShare>();
  private receivedShares: ReceivedShare[] = [];
  private messages: ChatEntry[] = [];
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
  private desktop: DesktopBridge | null = desktopBridge();
  private desktopInfo: DesktopInfo | null = null;
  private nearby: NearbyPeer[] = [];
  private nearbyInbound: NearbyPeer[] = [];
  private direct: DirectView | null = null;
  private directSession: PeerSession | null = null;
  private directRelay: ManualRelay | null = null;
  private directKey: string | null = null;
  private directNonce: string | null = null;
  private native = false;
  /** Where received files were written on this device, by transfer id. */
  private savedLocations = new Map<string, string>();

  async init(): Promise<void> {
    this.identity = await loadIdentity();
    this.trusted = await listTrusted();
    // A restart cannot retain browser File objects. Show durable metadata, ask
    // the sender to reselect sources, and re-hash disk data at the receiver.
    try {
      for (const entry of await listHistory()) {
        this.history.set(entry.id, entry);
        this.transfers.set(entry.id, this.viewFromHistory(entry));
      }
      for (const entry of await listPending()) {
        this.pendingTransfers.set(entry.id, entry);
        if (entry.state === 'pending') this.transfers.set(entry.id, this.viewFromPending(entry));
        else if (entry.role === 'receive') {
          const existing = this.transfers.get(entry.id);
          if (existing?.state === 'complete') existing.saveable = opfsAvailable();
        }
      }
    } catch {
      // Storage may be blocked in private browsing; the current session can
      // still pair, but durable recovery/history must not be claimed.
    }
    // Signalling endpoint precedence:
    //   1. a URL the user saved (desktop/mobile instances with no server of their own)
    //   2. the desktop shell's embedded server or an explicit --fluxa-signal-url
    //   3. same-origin (the browser build served by `npm start`)
    const saved = readSavedSignalUrl();
    const external = this.desktop ? (await this.desktop.info().catch(() => null))?.signalUrl : null;
    this.signal = new SignalClient(this.identity, saved ?? external ?? undefined, this.readTurnAccessKey());
    this.signal.on((event) => void this.onSignalEvent(event));
    this.signal.connect();
    this.native = (await nativeAvailability()).available;
    await this.initDesktop();
    this.ready = true;
    this.emit();
  }

  private async initDesktop(): Promise<void> {
    const bridge = this.desktop;
    if (!bridge || !this.identity) return;
    try {
      this.desktopInfo = await bridge.info();
      await bridge.setIdentity({
        deviceId: this.identity.deviceId,
        name: this.identity.name,
        platform: this.identity.platform,
      });
      bridge.onNearby((peers) => {
        this.nearby = peers;
        this.emit();
      });
    } catch (err) {
      this.toast('error', `Desktop integration unavailable: ${(err as Error).message}`);
    }
  }

  private readTurnAccessKey(): string | null {
    try { return localStorage.getItem(TURN_ACCESS_KEY); } catch { return null; }
  }

  hasTurnAccessKey(): boolean { return Boolean(this.readTurnAccessKey()); }

  /** Only sent to a wss:// endpoint after a signed challenge; never in QR links. */
  setTurnAccessKey(input: string): boolean {
    const value = input.trim();
    if (value && !/^[\x21-\x7e]{32,128}$/.test(value)) {
      this.toast('error', 'Relay access key must have 32–128 non-space characters');
      return false;
    }
    try {
      if (value) localStorage.setItem(TURN_ACCESS_KEY, value);
      else localStorage.removeItem(TURN_ACCESS_KEY);
    } catch { this.toast('error', 'Could not securely retain the relay access key on this device'); return false; }
    this.signal?.setTurnAccessKey(value || null);
    this.toast('info', value ? 'Relay access key saved. Re-pair to use the new signalling session.' : 'Relay access key removed');
    return true;
  }

  /** Persist and apply a signalling endpoint (e.g. this PC's address for a phone). */
  setSignalUrl(input: string): boolean {
    const url = normaliseSignalUrl(input);
    if (!url) {
      this.toast('error', 'Use wss:// for public servers, or a private-LAN address like 192.168.1.20:8787');
      return false;
    }
    try {
      localStorage.setItem(SIGNAL_URL_KEY, url);
    } catch {
      /* storage unavailable: the setting applies for this session only */
    }
    this.signal?.setUrl(url);
    this.toast('info', `Signalling server set to ${url.replace(/^wss?:\/\//, '').replace(/\/ws$/, '')}`);
    this.emit();
    return true;
  }

  resetSignalUrl(): void {
    try {
      localStorage.removeItem(SIGNAL_URL_KEY);
    } catch {
      /* ignore */
    }
    const fallback = this.desktopInfo?.localUrl
      ? `${this.desktopInfo.localUrl.replace(/^http/, 'ws')}/ws`
      : undefined;
    this.signal?.setUrl(fallback ?? defaultSignalUrl());
    this.emit();
  }

  /** Point signalling at a nearby device's embedded server. */
  useNearbyServer(peer: NearbyPeer): void {
    if (!this.signal) return;
    this.signal.setUrl(peer.url);
    this.toast('info', `Using ${peer.name} as the pairing server`);
    this.emit();
  }

  /** Switch back to this device's own embedded server. */
  useLocalServer(): void {
    if (!this.signal || !this.desktopInfo) return;
    const url = this.desktopInfo.localUrl.replace(/^http/, 'ws');
    this.signal.setUrl(`${url}/ws`);
    this.toast('info', 'Using this device as the pairing server');
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
      desktop: this.desktopInfo,
      nearby: this.nearby,
      signalUrl: this.signal?.currentUrl ?? null,
      direct: this.direct,
      incomingShares: [...this.pendingShares.values()],
      receivedShares: [...this.receivedShares],
      messages: [...this.messages].slice(-100),
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
        if (event.turnRequired) this.toast('info', 'Remote relay needs a valid access key in Settings over wss://; local/direct pairing still works');
        break;
      }
      case 'code': {
        const fallback = this.signal?.currentUrl;
        let link = event.link;
        if (!link && fallback) {
          try {
            const server = new URL(fallback);
            if (isLocalNetworkHost(server.hostname)) link = `${server.protocol === 'wss:' ? 'https:' : 'http:'}//${server.host}/?pair=${event.code}`;
          } catch { /* manual entry still works */ }
        }
        this.pendingPairing = {
          code: event.code, expiresAt: event.expiresAt,
          link: this.native ? `fluxa://pair?code=${event.code}` : link,
        };
        break;
      }
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
    const entry = this.createSession(peer, role, this.signal, this.signal.iceServers);
    this.sessions.set(peer.deviceId, entry);
    this.emit();
    await entry.session.start();
  }

  /**
   * Builds a session and its transfer manager. Event handlers resolve the entry
   * through a box rather than through the map key, because a direct session is
   * registered under a provisional key until the peer's identity is known.
   */
  private createSession(
    peer: PeerLink,
    role: 'initiator' | 'responder',
    relay: Relay & { verify?: (connId: string, ok: boolean) => void },
    iceServers: RTCIceServer[],
  ): SessionEntry {
    const box: { entry: SessionEntry | null } = { entry: null };
    const session = new PeerSession({
      identity: this.identity!,
      peer,
      role,
      signal: relay,
      iceServers,
      events: {
        onState: (state, detail) => {
          const entry = box.entry;
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
        onControl: (msg) => {
          if (msg.t === 'chat') {
            if (!this.messages.some((item) => item.id === msg.id && item.deviceId === peer.deviceId)) this.messages = [...this.messages, { id: msg.id, deviceId: peer.deviceId, peerName: peer.name, direction: 'received', text: msg.text, sentAt: msg.sentAt, status: 'received' }].slice(-100);
            box.entry?.session.sendControl({ t: 'chatAck', id: msg.id, ok: true, receivedAt: Date.now() });
            this.emit();
          } else if (msg.t === 'chatAck') {
            this.messages = this.messages.map((item) => item.id === msg.id && item.deviceId === peer.deviceId ? { ...item, status: msg.ok ? 'delivered' : 'failed' } : item);
            if (!msg.ok) this.toast('error', msg.reason ?? 'Message was not delivered');
            this.emit();
          } else if (msg.t === 'share' || msg.t === 'shareResult') box.entry?.shares?.handle(msg);
          else box.entry?.manager?.handleControl(msg);
        },
        onChunk: (streamId, offset, data) => box.entry?.manager?.handleChunk(streamId, offset, data),
        onVerified: () => {
          const entry = box.entry;
          if (entry) void this.refreshConnectionPath(entry);
          void this.rememberPeer(peer);
          this.toast('success', `Verified connection with ${peer.name}`);
          this.emit();
        },
        onClosed: (reason) => this.onSessionClosed(peer.deviceId, reason),
      },
    });

    const manager = new TransferManager(session, this.identity!.name, 64 * 1024, false, {
      onUpdate: (task) => this.onTransferUpdate(task),
      onIncoming: (task) => {
        this.incoming = { task };
        void this.desktop?.notify(
          `Incoming from ${task.peerName}`,
          `${task.files.length} file${task.files.length === 1 ? '' : 's'} · ${formatBytes(task.totalBytes)}`,
        );
        this.emit();
      },
      onFinished: (task, files) => this.onTransferFinished(task, files),
      onProtocolError: (message, fatal) => this.toast(fatal ? 'error' : 'info', message),
    });

    const shares = new ShareManager(session, {
      onIncoming: (item) => {
        this.pendingShares.set(item.id, item);
        void this.desktop?.notify(`Shared by ${item.peerName}`, `Approve ${item.kind} on this device`);
        this.emit();
      },
      onResult: (_id, ok, reason) => this.toast(ok ? 'success' : 'error', ok ? 'The other device approved the shared item' : reason ?? 'Item declined'),
      onExpired: (id) => {
        this.pendingShares.delete(id);
        this.emit();
      },
    });
    const entry: SessionEntry = { link: peer, session, manager, shares, connection: null, error: null };
    box.entry = entry;
    return entry;
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
    entry.shares?.close();
    for (const [id, item] of this.pendingShares) {
      if (item.peerDeviceId === deviceId) this.pendingShares.delete(id);
    }
    if (!this.userClosed.has(deviceId) && reason !== 'replaced by a new pairing') {
      this.toast('info', `${entry.link.name} disconnected`);
    }
    this.emit();
  }

  /* ---------------------------------------------------------------- */
  /* Transfers                                                         */
  /* ---------------------------------------------------------------- */

  private viewFromHistory(entry: HistoryEntry): TransferView {
    return {
      ...entry,
      files: entry.files.map((f) => ({ name: f.name, relPath: f.relPath, size: f.size,
        status: entry.state === 'complete' ? 'complete' : 'pending', verified: entry.state === 'complete' })),
      bytesPerSecond: 0, etaSeconds: null,
      saveable: entry.role === 'receive' && entry.state === 'complete' &&
        this.pendingTransfers.get(entry.id)?.state === 'complete' && opfsAvailable(),
    };
  }

  private viewFromPending(entry: PendingTransfer): TransferView {
    const past = this.history.get(entry.id);
    return {
      id: entry.id, role: entry.role, state: 'paused',
      peerName: past?.peerName ?? (entry.role === 'receive' ? entry.manifest.senderName :
        this.trusted.find((d) => d.deviceId === entry.peerDeviceId)?.name ?? 'Paired device'),
      peerDeviceId: entry.peerDeviceId,
      files: entry.manifest.files.map((f) => ({ name: f.name, relPath: f.relPath, size: f.size, status: 'pending', verified: false })),
      totalBytes: entry.manifest.totalBytes, transferredBytes: 0,
      bytesPerSecond: 0, etaSeconds: null, startedAt: entry.manifest.createdAt,
      finishedAt: null, saveable: false,
      error: entry.role === 'send'
        ? 'Interrupted. Reconnect and reselect the same files or folder to resume.'
        : 'Interrupted. Reconnect; approve the sender’s retry to resume from verified partial data.',
    };
  }

  private toTransferView(task: SendTask | ReceiveTask): TransferView {
    return {
      id: task.id,
      role: task.role,
      state: task.state,
      peerName: task.peerName,
      peerDeviceId: task.peerDeviceId,
      files: task.files.map((f) => ({
        name: f.descriptor.name,
        relPath: f.descriptor.relPath,
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
    const entry: HistoryEntry = {
      id: task.id, role: task.role, state: task.state, peerName: task.peerName,
      peerDeviceId: task.peerDeviceId,
      files: task.files.map((f) => ({ name: f.descriptor.name, relPath: f.descriptor.relPath,
        size: f.descriptor.size, ...(f.descriptor.sha256 ? { sha256: f.descriptor.sha256 } : {}) })),
      totalBytes: task.totalBytes, transferredBytes: task.role === 'send' ? task.ackedBytes : task.receivedBytes,
      startedAt: task.startedAt, finishedAt: task.finishedAt, error: task.error,
    };
    this.history.set(task.id, entry);
    void saveHistory(entry).catch(() => this.toast('error', 'Could not save transfer history on this device'));
    if (task.state === 'complete' && task.role === 'receive') {
      void getPending(task.id).then((pending) => {
        if (pending) this.pendingTransfers.set(task.id, pending);
      }).catch(() => undefined);
    }
    if (this.incoming?.task.id === task.id) this.incoming = null;
    if (task.state === 'complete') {
      const direction = task.role === 'send' ? 'Sent' : 'Received';
      this.toast('success', `${direction} ${task.files.length} file${task.files.length === 1 ? '' : 's'} (${formatBytes(task.totalBytes)})`);
      void this.desktop?.notify(`${direction} ${task.files.length} file${task.files.length === 1 ? '' : 's'}`, `${formatBytes(task.totalBytes)} · verified`);
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

  /* ---------------------------------------------------------------- */
  /* Direct pairing (no signalling server at all)                      */
  /* ---------------------------------------------------------------- */

  /**
   * Creates an offer ticket. Works with no server, no network name resolution
   * and no permission beyond the browser's own — this is what makes Fluxa
   * usable on a phone that has nothing else running.
   */
  async startDirectPairing(): Promise<void> {
    if (!this.identity) return;
    this.cancelDirect(false);
    const nonce = randomToken(16);
    const key = `direct:${nonce}`;
    const peer: PeerLink = {
      connId: key,
      deviceId: '',
      publicKey: '',
      fingerprint: '',
      name: 'the other device',
      platform: 'unknown',
      sessionNonce: nonce,
      confirmed: false,
    };
    const relay = new ManualRelay();
    const entry = this.createSession(peer, 'initiator', relay, []);
    this.direct = { role: 'host', step: 'offer', ticket: null, error: null };
    this.directSession = entry.session;
    this.directRelay = relay;
    this.directKey = key;
    this.directNonce = nonce;
    this.sessions.set(key, entry);
    this.emit();

    try {
      await entry.session.start();
      await waitForIceGathering(entry.session.pc);
      const ticket = await encodeTicket({
        v: 1,
        protocolVersion: PROTOCOL_VERSION,
        kind: 'offer',
        nonce,
        sdp: entry.session.pc.localDescription as { type: 'offer'; sdp: string },
        identity: this.selfTicketIdentity(),
        candidates: ticketCandidates(relay),
      });
      this.direct = { role: 'host', step: 'offer', ticket, error: null };
    } catch (err) {
      this.direct = { role: 'host', step: 'offer', ticket: null, error: (err as Error).message };
      this.toast('error', `Could not create a pairing code: ${(err as Error).message}`);
    }
    this.emit();
  }

  /** Guest side: reads the host's ticket and produces the reply ticket. */
  async joinDirectPairing(text: string): Promise<boolean> {
    if (!this.identity) return false;
    let ticket: DirectTicket;
    try {
      ticket = await decodeTicket(text);
    } catch (err) {
      this.toast('error', (err as Error).message);
      return false;
    }
    if (ticket.kind !== 'offer') {
      this.toast('error', 'That code is a reply, not an invitation — the other device needs to start the pairing');
      return false;
    }
    this.cancelDirect(false);
    const key = `direct:${ticket.nonce}`;
    const peer: PeerLink = {
      connId: key,
      deviceId: ticket.identity.deviceId,
      publicKey: ticket.identity.publicKey,
      fingerprint: ticket.identity.fingerprint,
      name: ticket.identity.name,
      platform: ticket.identity.platform,
      sessionNonce: ticket.nonce,
      confirmed: false,
    };
    const relay = new ManualRelay();
    const entry = this.createSession(peer, 'responder', relay, []);
    this.direct = { role: 'guest', step: 'reply', ticket: null, error: null };
    this.directSession = entry.session;
    this.directRelay = relay;
    // The guest already knows the host's identity from the ticket, so the session
    // is registered under the real device id: verification, device selection and
    // transfers all look sessions up by device id.
    this.directKey = ticket.identity.deviceId;
    this.directNonce = ticket.nonce;
    this.sessions.set(ticket.identity.deviceId, entry);
    this.emit();

    try {
      await entry.session.handleRelay('offer', { sdp: ticket.sdp });
      for (const candidate of ticket.candidates) {
        await entry.session.handleRelay('ice', { candidate });
      }
      await waitForIceGathering(entry.session.pc);
      const reply = await encodeTicket({
        v: 1,
        protocolVersion: PROTOCOL_VERSION,
        kind: 'answer',
        nonce: ticket.nonce,
        sdp: entry.session.pc.localDescription as { type: 'answer'; sdp: string },
        identity: this.selfTicketIdentity(),
        candidates: ticketCandidates(relay),
      });
      this.direct = { role: 'guest', step: 'reply', ticket: reply, error: null };
      this.emit();
      return true;
    } catch (err) {
      this.direct = { role: 'guest', step: 'reply', ticket: null, error: (err as Error).message };
      this.toast('error', `Could not answer that pairing code: ${(err as Error).message}`);
      this.emit();
      return false;
    }
  }

  /** Host side: reads the guest's reply ticket and finishes the negotiation. */
  async completeDirectPairing(text: string): Promise<boolean> {
    const session = this.directSession;
    if (!session || this.direct?.role !== 'host') return false;
    let ticket: DirectTicket;
    try {
      ticket = await decodeTicket(text);
    } catch (err) {
      this.toast('error', (err as Error).message);
      return false;
    }
    if (ticket.kind !== 'answer') {
      this.toast('error', 'That is an invitation code; paste the reply code from the other device');
      return false;
    }
    if (this.directNonce && ticket.nonce !== this.directNonce) {
      this.toast('error', 'That reply belongs to a different pairing — start again');
      return false;
    }
    try {
      // Pin the guest's identity before any hello can arrive, then negotiate.
      session.setPeerIdentity({
        deviceId: ticket.identity.deviceId,
        publicKey: ticket.identity.publicKey,
        fingerprint: ticket.identity.fingerprint,
        name: ticket.identity.name,
        platform: ticket.identity.platform,
      });
      this.rekeyDirectSession(ticket.identity.deviceId);
      await session.handleRelay('answer', { sdp: ticket.sdp });
      for (const candidate of ticket.candidates) {
        await session.handleRelay('ice', { candidate });
      }
      this.direct = { role: 'host', step: 'connecting', ticket: null, error: null };
      this.emit();
      void this.rememberPeer({
        connId: this.directKey ?? '',
        deviceId: ticket.identity.deviceId,
        publicKey: ticket.identity.publicKey,
        fingerprint: ticket.identity.fingerprint,
        name: ticket.identity.name,
        platform: ticket.identity.platform,
        sessionNonce: this.directNonce ?? '',
        confirmed: true,
      });
      return true;
    } catch (err) {
      this.direct = { role: 'host', step: 'offer', ticket: this.direct.ticket, error: (err as Error).message };
      this.toast('error', `Could not connect: ${(err as Error).message}`);
      this.emit();
      return false;
    }
  }

  /**
   * Ends the direct-pairing UI once the connection is up, without touching the
   * session: the dialog has done its job and must get out of the way of the
   * verification step and the device list.
   */
  finishDirectPairing(): void {
    this.direct = null;
    this.directSession = null;
    this.directRelay = null;
    this.emit();
  }

  cancelDirect(notify = true): void {
    if (this.directSession) this.directSession.close('pairing cancelled');
    if (this.directKey) this.sessions.delete(this.directKey);
    this.directSession = null;
    this.directRelay = null;
    this.directKey = null;
    this.directNonce = null;
    const wasActive = this.direct !== null;
    this.direct = null;
    if (notify && wasActive) this.emit();
    else this.emit();
  }

  /** Moves the provisional `direct:<nonce>` entry under the real device id. */
  private rekeyDirectSession(deviceId: string): void {
    const key = this.directKey;
    if (!key || !this.sessions.has(key) || key === deviceId) return;
    const entry = this.sessions.get(key)!;
    this.sessions.delete(key);
    this.sessions.set(deviceId, entry);
    this.directKey = deviceId;
  }

  private selfTicketIdentity(): DirectTicket['identity'] {
    return {
      deviceId: this.identity!.deviceId,
      name: this.identity!.name,
      platform: this.identity!.platform,
      publicKey: this.identity!.publicKey,
      fingerprint: this.identity!.fingerprint,
    };
  }

  confirmVerification(deviceId: string, matches: boolean): void {
    // Accept a device id or a connection id: a direct pairing knows both, and a
    // stale view must never silently swallow the user's confirmation.
    const entry =
      this.sessions.get(deviceId) ??
      [...this.sessions.values()].find((e) => e.link.connId === deviceId || e.link.deviceId === deviceId);
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

  sendChatMessage(deviceId: string, text: string): void {
    const clean = text.trim();
    if (!clean || clean.length > 4000) { this.toast('error', 'Messages must be between 1 and 4,000 characters'); return; }
    const entry = this.sessions.get(deviceId);
    if (!entry?.session.verified || entry.session.state !== 'connected') { this.toast('error', 'Verify a connected device before messaging'); return; }
    const id = randomToken(16), sentAt = Date.now();
    this.messages = [...this.messages, { id, deviceId, peerName: entry.link.name, direction: 'sent', text: clean, sentAt, status: 'sending' }].slice(-100);
    entry.session.sendControl({ t: 'chat', id, text: clean, sentAt });
    this.emit();
  }

  sendSharedContent(deviceId: string, kind: SharedContent['kind'], text: string, url?: string, title?: string): void {
    const entry = this.sessions.get(deviceId);
    try {
      if (!entry?.shares) throw new Error('Select and verify a connected device first');
      entry.shares.send(kind, text, url, title);
      this.toast('info', 'Waiting for the recipient to approve the shared item');
    } catch (err) { this.toast('error', (err as Error).message); }
  }

  approveSharedContent(id: string, yes: boolean): void {
    const pending = this.pendingShares.get(id);
    if (!pending) return;
    this.pendingShares.delete(id);
    const item = this.sessions.get(pending.peerDeviceId)?.shares?.approve(id, yes);
    if (item) this.receivedShares = [item, ...this.receivedShares].slice(0, 20);
    this.emit();
  }

  clearReceivedShares(): void {
    this.receivedShares = [];
    this.emit();
  }

  async resumeTransfer(transferId: string, files: File[]): Promise<void> {
    const pending = await getPending(transferId).catch(() => undefined);
    if (!pending || pending.role !== 'send' || !files.length) {
      this.toast('error', 'No recoverable send was found; select the files for a new transfer');
      return;
    }
    const entry = this.sessions.get(pending.peerDeviceId);
    if (!entry || !entry.session.verified || entry.session.state !== 'connected' || !entry.manager) {
      this.toast('error', 'Reconnect and verify that device before resuming');
      return;
    }
    entry.manager.send(files, pending.manifest);
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
    void this.desktop?.setIdentity({
      deviceId: this.identity.deviceId,
      name: this.identity.name,
      platform: this.identity.platform,
    });
    this.emit();
  }

  async saveReceived(transferId: string): Promise<void> {
    let files = this.received.get(transferId);
    if (!files?.length) {
      const pending = await getPending(transferId).catch(() => undefined);
      if (pending?.role !== 'receive' || pending.state !== 'complete') {
        this.toast('error', 'The received files are no longer available on this device');
        return;
      }
      const recovered: ReceivedFile[] = [];
      try {
        for (const descriptor of pending.manifest.files) {
          const blob = await readPartial(transferId, descriptor);
          if (!blob || blob.size !== descriptor.size || !descriptor.sha256 ||
              await sha256OfBlob(blob) !== descriptor.sha256) {
            throw new Error(`Stored data for ${descriptor.relPath} is missing or failed SHA-256`);
          }
          recovered.push({ descriptor, blob, opfsPath: null, sha256: descriptor.sha256, size: blob.size });
        }
        files = recovered;
        this.received.set(transferId, recovered);
      } catch (err) {
        this.toast('error', (err as Error).message);
        return;
      }
    }
    if (!this.native && (files.length > 1 || files.some((f) => f.descriptor.relPath.includes('/'))) &&
        directoryPickerAvailable()) {
      try {
        const picker = window as unknown as Window & { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> };
        const directory = await picker.showDirectoryPicker();
        const paths = await exportToDirectory(files, directory);
        this.toast('success', `Saved ${paths.length} verified file${paths.length === 1 ? '' : 's'} with folders preserved`);
        return;
      } catch (err) {
        if ((err as Error).name !== 'AbortError') this.toast('error', `Could not save folder: ${(err as Error).message}`);
        return;
      }
    }
    for (const file of files) {
      if (!file.blob) continue;
      const saved = await this.saveBlob(file.descriptor.name, file.blob, file.descriptor.relPath, transferId, file.sha256);
      if (saved === 'picker') this.toast('success', `Saved ${file.descriptor.name}`);
    }
  }

  /**
   * Prefer the File System Access API (real destination, streamed to disk, no
   * second copy in memory). Fall back to a normal download where it is not
   * available, which is still a genuine save — just to the browser's folder.
   */
  private async saveBlob(name: string, blob: Blob, relPath: string, transferId: string, hash: string): Promise<'picker' | 'download' | 'desktop' | 'native' | 'cancelled'> {
    // Capacitor: bounded chunks to a unique export directory in app Documents,
    // followed by the OS share sheet / Files picker. Never overwrite a prior save.
    if (this.native) {
      const result = await saveFileNative(relPath, blob, transferId, { sha256: hash });
      if (result.ok) {
        this.savedLocations.set(name, result.path ?? name);
        this.toast('success', `Saved ${name} to Documents${result.shared ? ' (shared)' : ''}`);
        return 'native';
      }
      this.toast('error', `Could not save ${name}: ${result.error ?? 'unknown error'}`);
      return 'cancelled';
    }
    // Desktop app: the user picks a real destination in a native dialog and the
    // main process writes the bytes (no browser download directory involved).
    const bridge = desktopBridge();
    if (bridge) {
      const choice = await bridge.saveDialog(name);
      if (choice.canceled || !choice.filePath) return 'cancelled';
      const begun = await bridge.beginSave(choice.filePath, blob.size);
      if (!begun.ok || !begun.token) {
        this.toast('error', `Could not save ${name}: ${begun.error ?? 'destination unavailable'}`);
        return 'cancelled';
      }
      const token = begun.token;
      const reader = blob.stream().getReader();
      const hasher = new Sha256();
      let offset = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          for (let at = 0; at < value.byteLength; at += 64 * 1024) {
            const bytes = value.subarray(at, at + 64 * 1024);
            hasher.update(bytes);
            const written = await bridge.writeSave(token, offset, bytes);
            if (!written.ok || written.bytes !== offset + bytes.byteLength) throw new Error(written.error ?? 'disk write failed');
            offset += bytes.byteLength;
          }
        }
        if (offset !== blob.size || hasher.digestHex() !== hash) throw new Error('Export failed SHA-256 verification');
        const committed = await bridge.commitSave(token, hash);
        if (!committed.ok) throw new Error(committed.error ?? 'Could not commit export');
        this.toast('success', `Saved ${name} to ${choice.filePath}`);
        return 'desktop';
      } catch (err) {
        await bridge.abortSave(token).catch(() => undefined);
        this.toast('error', `Could not save ${name}: ${(err as Error).message}`);
        return 'cancelled';
      } finally { reader.releaseLock(); }
    }
    if (hasFilePicker()) {
      try {
        const picker = window as unknown as {
          showSaveFilePicker: (o: unknown) => Promise<{
            createWritable: () => Promise<{ write: (d: Blob) => Promise<void>; close: () => Promise<void> }>;
          }>;
        };
        const handle = await picker.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'File', accept: { [blob.type || 'application/octet-stream']: [`.${name.split('.').pop() ?? 'bin'}`] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return 'picker';
      } catch (err) {
        if ((err as Error).name === 'AbortError') return 'cancelled';
        // Any other failure falls through to a download rather than losing the file.
      }
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return 'download';
  }

  receivedFiles(transferId: string): ReceivedFile[] {
    return this.received.get(transferId) ?? [];
  }

  async clearReceivedStorage(): Promise<void> {
    await clearReceivedFiles();
    for (const pending of await listPending()) {
      if (pending.role === 'receive') {
        await deletePending(pending.id);
        this.pendingTransfers.delete(pending.id);
      }
    }
    this.received.clear();
    for (const transfer of this.transfers.values()) if (transfer.role === 'receive') transfer.saveable = false;
    this.toast('info', 'Cleared received and partial files stored by this device');
    this.emit();
  }

  async clearTransferHistory(): Promise<void> {
    await clearHistory();
    this.history.clear();
    for (const [id, transfer] of this.transfers) {
      if (!['preparing', 'waiting-approval', 'incoming', 'transferring', 'verifying', 'paused'].includes(transfer.state)) {
        this.transfers.delete(id);
      }
    }
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

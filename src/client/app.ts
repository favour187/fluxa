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
  clearHistory, deletePending, getPending, journalAvailable, listHistory, listPending, saveHistory,
  type HistoryEntry, type PendingTransfer,
} from './transfer/journal.js';
import { DEFAULT_RULE, decideIncoming, parseTransferRule, type TransferRule } from './transfer/rules.js';
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
import { randomBytes, randomToken, toHex } from '../shared/crypto.js';
import { nativeAvailability, saveFileNative } from './native.js';
import { ShareManager, type ReceivedShare } from './share.js';
import { ClipboardSync, clipboardPort, type ClipboardView } from './clipboard-sync.js';
import { ScreenShare, type ScreenView } from './screen-share.js';
import { androidSharePlugin, AndroidInboxFile, classifyAndroidText, validAndroidShare,
  type AndroidSharedItem, type AndroidSharePlugin } from './android-share.js';
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

export interface HandoffDraft { url: string; title: string }

export interface AndroidInboxView extends AndroidSharedItem {
  sending: boolean;
  delivered: boolean;
  error: string | null;
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
  /** At most one clipboard session per local OS clipboard. Nothing persists. */
  clipboard: (ClipboardView & { peerDeviceId: string }) | null;
  /** One live screen session per device, never recorded or persisted. */
  screen: (ScreenView & { peerDeviceId: string }) | null;
  /** A browser/extension link waiting for the user to review and choose a peer. */
  handoffDraft: HandoffDraft | null;
  /** Explicit Android Share intents, staged locally until receiver confirms. */
  androidInbox: AndroidInboxView[];
  messages: ChatEntry[];
}

export interface DirectView {
  role: 'host' | 'guest';
  step: 'offer' | 'reply' | 'connecting';
  /** The ticket this device wants the other device to read (null while working). */
  ticket: string | null;
  error: string | null;
  /** Only the pairing currently shown, never an unrelated already-live peer. */
  sessionState?: PeerState | null;
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
const TRANSFER_RULES_KEY = 'fluxa:transfer-rules:v1';

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
  private clipboard: ClipboardSync | null = null;
  private clipboardPeerId: string | null = null;
  private screen: ScreenShare | null = null;
  private screenPeerId: string | null = null;
  private handoffDraft: HandoffDraft | null = null;
  private transferRules = new Map<string, TransferRule>();
  private messages: ChatEntry[] = [];
  private chatTimers = new Map<string, number>();
  private pendingPairing: PairingView | null = null;
  private wantsPairingCode = false;
  private pendingClaim: { code: string; signalUrl: string } | null = null;
  private pendingClaimTimer: ReturnType<typeof setTimeout> | null = null;
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
  private androidShare: AndroidSharePlugin | null = null;
  private androidInbox: AndroidSharedItem[] = [];
  private androidSending = new Set<string>();
  private androidDelivered = new Set<string>();
  private androidErrors = new Map<string, string>();
  private androidTransfers = new Map<string, string>();
  private androidShares = new Map<string, string>();

  async init(): Promise<void> {
    this.identity = await loadIdentity();
    this.trusted = await listTrusted();
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(TRANSFER_RULES_KEY) ?? '{}');
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        for (const [id, value] of Object.entries(stored)) {
          if (!this.trusted.some((device) => device.deviceId === id)) continue;
          const rule = parseTransferRule(value);
          if (rule) this.transferRules.set(id, rule);
        }
      }
    } catch { /* private browsing: defaults remain ask, never auto-accept */ }
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
    if (this.native) await this.initAndroidInbox();
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
      bridge.onHandoff((draft) => this.prepareHandoff(draft.url, draft.title));
    } catch (err) {
      this.toast('error', `Desktop integration unavailable: ${(err as Error).message}`);
    }
  }

  private async initAndroidInbox(): Promise<void> {
    const plugin = androidSharePlugin();
    if (!plugin) return;
    this.androidShare = plugin;
    try {
      // Registration first, then list: an import finishing during boot cannot
      // slip between the initial snapshot and the native event listener.
      await plugin.addListener('shareReceived', () => void this.refreshAndroidInbox());
      await this.refreshAndroidInbox();
    } catch (error) {
      this.toast('error', `Android Share target unavailable: ${(error as Error).message}`);
      this.androidShare = null;
    }
  }

  private async refreshAndroidInbox(): Promise<void> {
    if (!this.androidShare) return;
    try {
      const { items, error } = await this.androidShare.list();
      this.androidInbox = items.filter(validAndroidShare).sort((a, b) => a.createdAt - b.createdAt);
      if (error) this.toast('error', `Android share was not staged: ${error}`);
      this.emit();
    } catch (error) {
      this.toast('error', `Could not load Android shares: ${(error as Error).message}`);
    }
  }

  /** An item stays on this phone until its receiver confirms delivery. */
  async deliverAndroidShare(itemId: string, deviceId: string): Promise<void> {
    const item = this.androidInbox.find((entry) => entry.id === itemId);
    const peer = this.sessions.get(deviceId);
    if (!item || !this.androidShare || this.androidSending.has(itemId) || this.androidDelivered.has(itemId)) return;
    if (!peer?.session.verified || peer.session.state !== 'connected') {
      this.toast('error', 'Open Fluxa on both devices and verify a live connection first. This item stays on your phone.');
      return;
    }
    this.androidErrors.delete(itemId);
    try {
      if (item.files.length) {
        if (!peer.manager) throw new Error('File transfer is not ready');
        this.androidSending.add(itemId);
        this.emit();
        const files = item.files.map((file) => new AndroidInboxFile(this.androidShare!, item.id, file));
        const task = peer.manager.send(files);
        this.androidTransfers.set(task.id, itemId);
        this.toast('info', 'Sending staged files. Keep Fluxa open until the receiver confirms them.');
      } else {
        if (!peer.shares) throw new Error('Content sharing is not ready');
        const content = classifyAndroidText(item.text, item.title);
        this.androidSending.add(itemId);
        this.emit();
        const shareId = peer.shares.send(content.kind, content.text, content.url, content.title);
        this.androidShares.set(shareId, itemId);
        this.toast('info', 'Waiting for the other device to approve the shared text or link');
      }
    } catch (error) {
      this.androidSending.delete(itemId);
      this.androidErrors.set(itemId, (error as Error).message);
      this.toast('error', `Share not sent: ${(error as Error).message}`);
      this.emit();
    }
  }

  async discardAndroidShare(itemId: string): Promise<void> {
    if (!this.androidShare || this.androidSending.has(itemId)) return;
    if (!this.androidInbox.some((entry) => entry.id === itemId)) return;
    this.androidSending.add(itemId);
    this.emit();
    await this.removeAndroidShare(itemId, false);
  }

  private async removeAndroidShare(itemId: string, delivered: boolean): Promise<void> {
    try {
      if (!this.androidShare) throw new Error('Android Share plugin is unavailable');
      await this.androidShare.discard({ id: itemId });
      this.androidInbox = this.androidInbox.filter((entry) => entry.id !== itemId);
      this.androidErrors.delete(itemId);
      this.androidDelivered.delete(itemId);
    } catch (error) {
      if (delivered) this.androidDelivered.add(itemId);
      const message = delivered ? 'Delivered, but could not clear the local copy' : 'Could not discard the local share';
      this.androidErrors.set(itemId, `${message}: ${(error as Error).message}`);
      this.toast('error', `${message}: ${(error as Error).message}`);
    } finally {
      this.androidSending.delete(itemId);
      this.emit();
    }
  }

  private onAndroidShareResult(id: string, ok: boolean, reason?: string): void {
    const itemId = this.androidShares.get(id);
    if (!itemId) return;
    this.androidShares.delete(id);
    if (ok) void this.removeAndroidShare(itemId, true);
    else {
      this.androidSending.delete(itemId);
      this.androidErrors.set(itemId, reason ?? 'The recipient did not approve this item');
      this.emit();
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
    if (this.signal?.currentUrl !== url) {
      this.pendingClaim = null;
      if (this.pendingClaimTimer) clearTimeout(this.pendingClaimTimer);
      this.pendingClaimTimer = null;
      this.wantsPairingCode = false;
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
      direct: this.direct ? { ...this.direct, sessionState: this.directSession?.state ?? null } : null,
      incomingShares: [...this.pendingShares.values()],
      receivedShares: [...this.receivedShares],
      clipboard: this.clipboard && this.clipboardPeerId ? { peerDeviceId: this.clipboardPeerId, ...this.clipboard.view } : null,
      screen: this.screen && this.screenPeerId ? { peerDeviceId: this.screenPeerId, ...this.screen.view } : null,
      handoffDraft: this.handoffDraft,
      androidInbox: this.androidInbox.map((item) => ({ ...item,
        sending: this.androidSending.has(item.id), delivered: this.androidDelivered.has(item.id),
        error: this.androidErrors.get(item.id) ?? null,
      })),
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
        if (this.wantsPairingCode) {
          this.wantsPairingCode = false;
          this.signal?.createCode();
        }
        const claim = this.pendingClaim;
        if (claim && claim.signalUrl === this.signal?.currentUrl) {
          this.pendingClaim = null;
          if (this.pendingClaimTimer) clearTimeout(this.pendingClaimTimer);
          this.pendingClaimTimer = null;
          this.signal.claimCode(claim.code);
        }
        break;
      }
      case 'code': {
        const endpoint = this.signal?.currentUrl;
        let link = event.link;
        if (endpoint) {
          try {
            const server = new URL(endpoint);
            const local = this.desktopInfo?.localUrl.replace(/^http/, 'ws');
            const ownServer = local && server.origin === new URL(local).origin;
            if (ownServer) {
              // A desktop renderer uses loopback, but a phone must dial the LAN
              // interface. Never put 127.0.0.1 in a cross-device pairing QR.
              const lan = this.desktopInfo?.lanUrls[0];
              link = lan ? `fluxa://pair?code=${event.code}&server=${encodeURIComponent(lan.replace(/^http/, 'ws') + '/ws')}` : null;
            } else if (this.native) {
              // Installed mobile apps may use different signalling origins.
              // Carry only the endpoint and single-use code; never credentials.
              link = `fluxa://pair?code=${event.code}&server=${encodeURIComponent(endpoint)}`;
            } else if (!link && isLocalNetworkHost(server.hostname)) {
              link = `${server.protocol === 'wss:' ? 'https:' : 'http:'}//${server.host}/?pair=${event.code}`;
            }
          } catch { link = null; }
        }
        this.pendingPairing = { code: event.code, expiresAt: event.expiresAt, link: link ?? null };
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
          if (entry && (state === 'failed' || state === 'closed')) {
            entry.error = detail ?? 'The connection ended without a reason';
            if (detail && detail !== 'replaced by a new pairing' && detail !== 'pairing cancelled') {
              this.toast(state === 'failed' ? 'error' : 'info', `Connection to ${peer.name}: ${detail}`);
            }
          } else if (entry && state === 'connecting') entry.error = null;
          if (state === 'awaiting-verification') {
            this.toast('info', `Compare the code shown on ${peer.name}`);
          }
          this.emit();
        },
        onControl: (msg) => {
          if (msg.t === 'screenShare' || msg.t === 'screenSignal') {
            if (msg.t === 'screenShare' && msg.action === 'request' &&
                (this.screenPeerId !== peer.deviceId || !this.screen)) {
              if (this.screen && !['off', 'error'].includes(this.screen.view.state)) {
                session.sendControl({ t: 'screenShare', id: msg.id, action: 'decline', reason: 'Already sharing a screen' });
                return;
              }
              this.screen?.close();
              this.screen = this.newScreenShare(session);
              this.screenPeerId = peer.deviceId;
            }
            if (this.screenPeerId === peer.deviceId) this.screen?.handle(msg);
            return;
          }
          if (msg.t === 'clipboardSync' || msg.t === 'clipboardUpdate') {
            if (msg.t === 'clipboardSync' && msg.action === 'request' &&
                (this.clipboardPeerId !== peer.deviceId || !this.clipboard)) {
              if (this.clipboard && !['off', 'error'].includes(this.clipboard.view.state)) {
                session.sendControl({ t: 'clipboardSync', id: msg.id, action: 'decline', reason: 'Clipboard is syncing with another device' });
                return;
              }
              this.clipboard?.close();
              this.clipboard = this.newClipboardSync(session, peer.deviceId);
              this.clipboardPeerId = peer.deviceId;
            }
            if (this.clipboardPeerId === peer.deviceId) this.clipboard?.handle(msg);
            return;
          }
          if (msg.t === 'chat') {
            const activeEntry = box.entry;
            if (!activeEntry?.session.verified || activeEntry.session.state !== 'connected') {
              try { activeEntry?.session.sendControl({ t: 'chatAck', id: msg.id, ok: false, reason: 'Device is not verified' }); } catch { /* disconnected */ }
              return;
            }
            if (!this.messages.some((item) => item.id === msg.id && item.deviceId === peer.deviceId)) {
              const received: ChatEntry = {
                id: msg.id, deviceId: peer.deviceId, peerName: peer.name,
                direction: 'received', text: msg.text, sentAt: msg.sentAt, status: 'received',
              };
              this.messages = [...this.messages, received].slice(-100);
              this.emit();
            }
            // A retransmitted message is acknowledged again but never shown twice.
            try { activeEntry.session.sendControl({ t: 'chatAck', id: msg.id, ok: true, receivedAt: Date.now() }); } catch { /* disconnected */ }
          } else if (msg.t === 'chatAck') {
            if (!this.messages.some((item) => item.id === msg.id && item.deviceId === peer.deviceId && item.direction === 'sent' && item.status === 'sending')) return;
            clearTimeout(this.chatTimers.get(msg.id));
            this.chatTimers.delete(msg.id);
            this.messages = this.messages.map((item): ChatEntry =>
              item.id === msg.id && item.deviceId === peer.deviceId
                ? { ...item, status: msg.ok ? 'delivered' : 'failed' }
                : item,
            );
            if (!msg.ok) this.toast('error', msg.reason ?? 'Message was not delivered');
            this.emit();
          } else if (msg.t === 'share' || msg.t === 'shareResult') box.entry?.shares?.handle(msg);
          else box.entry?.manager?.handleControl(msg);
        },
        onChunk: (streamId, offset, data) => box.entry?.manager?.handleChunk(streamId, offset, data),
        onScreenTrack: (stream) => {
          if (this.screenPeerId === peer.deviceId) this.screen?.onTrack(stream);
        },
        onVerified: () => {
          const entry = box.entry;
          if (entry) void this.refreshConnectionPath(entry);
          // The UI normally finishes Direct at handshake time. If another
          // modal hid it, never leave a verified connection bound to a stale
          // ticket that a later Cancel/new pairing could close by mistake.
          if (this.directSession === session) this.finishDirectPairing();
          void this.rememberPeer(peer);
          this.toast('success', `Verified connection with ${peer.name}`);
          this.emit();
        },
        onClosed: (reason) => {
          if (box.entry) this.onSessionClosed(box.entry, reason);
        },
      },
    });

    const manager = new TransferManager(session, this.identity!.name, 64 * 1024, false, {
      onUpdate: (task) => this.onTransferUpdate(task),
      onIncoming: (task) => {
        const decision = decideIncoming(this.transferRule(peer.deviceId), task.manifest, {
          verified: session.verified && session.state === 'connected',
          privateStorage: opfsAvailable() && journalAvailable(),
          visible: document.visibilityState === 'visible',
          desktop: Boolean(this.desktop),
        });
        if (decision === 'block') {
          task.decline('Blocked by this device’s transfer rule');
          this.toast('info', `Blocked a transfer from ${task.peerName} under your rule`);
          return;
        }
        if (decision === 'auto') {
          this.toast('info', `Auto-accepting ${task.files.length} allowed file${task.files.length === 1 ? '' : 's'} from ${task.peerName} into private storage`);
          void task.accept();
          return;
        }
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
      onResult: (id, ok, reason) => {
        this.onAndroidShareResult(id, ok, reason);
        this.toast(ok ? 'success' : 'error', ok ? 'The other device approved the shared item' : reason ?? 'Item declined');
      },
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

  private onSessionClosed(entry: SessionEntry, reason: string): void {
    // Async events from an old connection must not stop the replacement's
    // transfers, clipboard, or approval queue under the same device id.
    if (![...this.sessions.values()].includes(entry)) return;
    const deviceId = entry.link.deviceId;
    for (const item of this.messages) {
      if (item.deviceId !== deviceId || item.direction !== 'sent' || item.status !== 'sending') continue;
      clearTimeout(this.chatTimers.get(item.id));
      this.chatTimers.delete(item.id);
    }
    this.messages = this.messages.map((item): ChatEntry =>
      item.deviceId === deviceId && item.direction === 'sent' && item.status === 'sending'
        ? { ...item, status: 'failed' }
        : item,
    );
    entry.manager?.handleSessionClosed(reason);
    entry.shares?.close();
    if (this.clipboardPeerId === deviceId) {
      this.clipboard?.close();
      this.clipboard = null;
      this.clipboardPeerId = null;
    }
    if (this.screenPeerId === deviceId) {
      this.screen?.close();
      this.screen = null;
      this.screenPeerId = null;
    }
    for (const [id, item] of this.pendingShares) {
      if (item.peerDeviceId === deviceId) this.pendingShares.delete(id);
    }
    // onState already retains and toasts the first, actionable reason. Do not
    // replace it with a second generic "disconnected" message on teardown.
    if (!this.userClosed.has(deviceId) && !entry.error && reason !== 'replaced by a new pairing') {
      this.toast('info', `${entry.link.name} disconnected: ${reason}`);
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
    const androidItemId = task.role === 'send' ? this.androidTransfers.get(task.id) : undefined;
    if (androidItemId) {
      this.androidTransfers.delete(task.id);
      if (task.state === 'complete') void this.removeAndroidShare(androidItemId, true);
      else {
        this.androidSending.delete(androidItemId);
        this.androidErrors.set(androidItemId,
          task.error ?? 'File transfer was interrupted. The staged files remain on this phone; reconnect and retry.');
      }
    }
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
    if (this.signal?.status === 'online') this.signal.createCode();
    else {
      this.wantsPairingCode = true;
      this.signal?.connect();
    }
  }

  cancelPairing(): void {
    this.wantsPairingCode = false;
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
    if (!this.signal) {
      this.toast('error', 'A pairing server is not configured; use Direct code instead');
      return false;
    }
    if (this.signal.status === 'online') {
      this.signal.claimCode(cleaned);
    } else {
      // raw() drops sends until WebSocket authentication completes. Retain just
      // this single-use code and submit it only after the chosen server is ready.
      this.pendingClaim = { code: cleaned, signalUrl: this.signal.currentUrl };
      if (this.pendingClaimTimer) clearTimeout(this.pendingClaimTimer);
      this.pendingClaimTimer = setTimeout(() => {
        if (!this.pendingClaim || this.pendingClaim.code !== cleaned) return;
        this.pendingClaim = null;
        this.pendingClaimTimer = null;
        this.toast('error', 'Could not reach the pairing server. Check the address or try Direct code.');
      }, 20_000);
      this.signal.connect();
      this.toast('info', 'Connecting to the pairing server before claiming this code…');
    }
    return true;
  }

  /** QR/deep links may contain the broker endpoint, never an access credential. */
  joinPairingLink(raw: string): boolean {
    let url: URL;
    try { url = new URL(raw); } catch { return false; }
    const nativeLink = url.protocol === 'fluxa:' && url.host === 'pair';
    const webLink = (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.pathname === '/' || url.pathname === '/index.html') && !url.username && !url.password;
    if (!nativeLink && !webLink) return false;
    const code = nativeLink ? url.searchParams.get('code') : url.searchParams.get('pair');
    if (!code || !/^[a-z0-9]{6}$/i.test(code)) return false;
    const endpoint = nativeLink
      ? url.searchParams.get('server')
      : `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}/ws`;
    if (endpoint) {
      const normalised = normaliseSignalUrl(endpoint);
      if (!normalised) {
        this.toast('error', 'The QR pairing server address is invalid');
        return false;
      }
      if (normalised !== this.signal?.currentUrl) {
        const target = new URL(normalised);
        if (/^(?:127\.|localhost$|\[::1\]$)/i.test(target.hostname)) {
          this.toast('error', 'That QR points to localhost on the other device. Use its LAN address or a shared server.');
          return false;
        }
        if (!window.confirm(`Connect to pairing server ${target.host}? Only continue if you trust the QR source. You will still compare a verification code.`)) return false;
        if (!this.setSignalUrl(normalised)) return false;
      }
    }
    return this.joinWithCode(code);
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
      await entry.session.start({ manualTicket: true });
      if (this.directSession !== entry.session) return; // cancelled during offer creation
      await waitForIceGathering(entry.session.pc);
      if (this.directSession !== entry.session) return;
      const ticket = await encodeTicket({
        v: 1,
        protocolVersion: PROTOCOL_VERSION,
        kind: 'offer',
        nonce,
        sdp: entry.session.pc.localDescription as { type: 'offer'; sdp: string },
        identity: this.selfTicketIdentity(),
        candidates: ticketCandidates(relay),
      });
      if (this.directSession !== entry.session) return;
      this.direct = { role: 'host', step: 'offer', ticket, error: null };
    } catch (err) {
      if (this.directSession !== entry.session) return;
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
    const previous = this.sessions.get(ticket.identity.deviceId);
    if (previous) previous.session.close('replaced by a new pairing');
    this.sessions.set(ticket.identity.deviceId, entry);
    this.emit();

    try {
      await entry.session.handleRelay('offer', { sdp: ticket.sdp });
      if (this.directSession !== entry.session) return false;
      for (const candidate of ticket.candidates) {
        await entry.session.handleRelay('ice', { candidate });
        if (this.directSession !== entry.session) return false;
      }
      await waitForIceGathering(entry.session.pc);
      if (this.directSession !== entry.session) return false;
      const reply = await encodeTicket({
        v: 1,
        protocolVersion: PROTOCOL_VERSION,
        kind: 'answer',
        nonce: ticket.nonce,
        sdp: entry.session.pc.localDescription as { type: 'answer'; sdp: string },
        identity: this.selfTicketIdentity(),
        candidates: ticketCandidates(relay),
      });
      if (this.directSession !== entry.session) return false;
      this.direct = { role: 'guest', step: 'reply', ticket: reply, error: null };
      this.emit();
      return true;
    } catch (err) {
      if (this.directSession !== entry.session) return false;
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
    if (this.directSession !== session || this.direct?.role !== 'host') return false;
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
      if (this.directSession !== session) return ['awaiting-verification', 'connected'].includes(session.state);
      for (const candidate of ticket.candidates) {
        await session.handleRelay('ice', { candidate });
        if (this.directSession !== session) return ['awaiting-verification', 'connected'].includes(session.state);
      }
      // A fast peer can reach SAS while await addIceCandidate is pending. The
      // UI then finishes this pairing and clears the ticket. Never resurrect a
      // stale "connecting" ticket after the verified session has taken over.
      if (this.directSession !== session) return ['awaiting-verification', 'connected'].includes(session.state);
      this.direct = { role: 'host', step: 'connecting', ticket: null, error: null };
      this.emit();
      // Do not persist trust just because a QR reply was scanned. Only the
      // onVerified callback after this device's explicit SAS approval may do so.
      return true;
    } catch (err) {
      if (this.directSession !== session) return false;
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
    // This ticket is no longer an in-progress pairing. A future Cancel/Start
    // must never delete the already established session from the device list.
    this.directKey = null;
    this.directNonce = null;
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
    const previous = this.sessions.get(deviceId);
    if (previous && previous !== entry) previous.session.close('replaced by a new pairing');
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

  transferRule(deviceId: string): TransferRule {
    const rule = this.transferRules.get(deviceId) ?? DEFAULT_RULE;
    return { ...rule, extensions: [...rule.extensions] };
  }

  setTransferRule(deviceId: string, input: unknown): boolean {
    if (!this.trusted.some((device) => device.deviceId === deviceId) && !this.sessions.get(deviceId)?.session.verified) {
      this.toast('error', 'Only verified devices can have transfer preferences');
      return false;
    }
    const rule = parseTransferRule(input);
    if (!rule || (rule.allowBackground && !this.desktop)) {
      this.toast('error', 'Invalid transfer rule. Background auto-accept is available only in the desktop app.');
      return false;
    }
    try {
      const copy = new Map(this.transferRules);
      copy.set(deviceId, rule);
      localStorage.setItem(TRANSFER_RULES_KEY, JSON.stringify(Object.fromEntries(copy)));
      this.transferRules = copy;
      this.toast('success', 'Transfer preferences saved on this device');
      this.emit();
      return true;
    } catch {
      this.toast('error', 'Could not save transfer preferences on this device; nothing changed');
      return false;
    }
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

  sendChatMessage(deviceId: string, text: string): boolean {
    const clean = text.trim();
    // Control frames are limited to 4,000 UTF-8 bytes, not 4,000 JS code units.
    if (!clean || new TextEncoder().encode(clean).byteLength > 4000) {
      this.toast('error', 'Messages must be between 1 and 4,000 UTF-8 bytes');
      return false;
    }
    const entry = this.sessions.get(deviceId);
    if (!entry?.session.verified || entry.session.state !== 'connected') {
      this.toast('error', 'Verify a connected device before messaging');
      return false;
    }
    const id = toHex(randomBytes(16));
    const sentAt = Date.now();
    const sent: ChatEntry = { id, deviceId, peerName: entry.link.name, direction: 'sent', text: clean, sentAt, status: 'sending' };
    this.messages = [...this.messages, sent].slice(-100);
    try {
      entry.session.sendControl({ t: 'chat', id, text: clean, sentAt });
      this.chatTimers.set(id, window.setTimeout(() => {
        this.chatTimers.delete(id);
        if (!this.messages.some((item) => item.id === id && item.status === 'sending')) return;
        this.messages = this.messages.map((item): ChatEntry => item.id === id ? { ...item, status: 'failed' } : item);
        this.toast('error', 'Message delivery timed out');
        this.emit();
      }, 30_000));
    } catch (err) {
      this.messages = this.messages.map((item): ChatEntry => item.id === id ? { ...item, status: 'failed' } : item);
      this.toast('error', `Message could not be sent: ${(err as Error).message}`);
      this.emit();
      return false;
    }
    this.emit();
    return true;
  }

  private newClipboardSync(session: PeerSession, peerDeviceId: string): ClipboardSync {
    return new ClipboardSync(session, this.identity!.deviceId, clipboardPort(), {
      onChange: () => this.emit(),
      onInvitation: (name) => {
        this.toast('info', `${name} wants to sync text copied to your clipboard. Accept only if you trust this device.`);
        void this.desktop?.notify('Clipboard sync request', `Approve text sync with ${name} in Fluxa`);
      },
      onError: (message) => this.toast('error', message),
    });
  }

  async startClipboardSync(deviceId: string): Promise<void> {
    const entry = this.sessions.get(deviceId);
    if (!entry?.session.verified || entry.session.state !== 'connected') {
      this.toast('error', 'Verify and connect this device before enabling clipboard sync');
      return;
    }
    if (this.clipboard && !['off', 'error'].includes(this.clipboard.view.state)) {
      this.toast('error', 'Stop your current clipboard session before starting another one');
      return;
    }
    this.clipboard?.close();
    this.clipboardPeerId = deviceId;
    this.clipboard = this.newClipboardSync(entry.session, deviceId);
    await this.clipboard.request();
  }

  async respondClipboardSync(accept: boolean): Promise<void> {
    await this.clipboard?.respond(accept);
  }

  stopClipboardSync(): void {
    this.clipboard?.stop();
  }

  private newScreenShare(session: PeerSession): ScreenShare {
    return new ScreenShare(session, {
      onChange: () => this.emit(),
      onInvitation: (name) => {
        this.toast('info', `${name} wants to show their screen. You must approve to view it.`);
        void this.desktop?.notify('Screen sharing request', `Approve screen viewing from ${name} in Fluxa`);
      },
      onError: (message) => this.toast('error', message),
    });
  }

  async startScreenShare(deviceId: string): Promise<void> {
    const entry = this.sessions.get(deviceId);
    if (!entry?.session.verified || entry.session.state !== 'connected') {
      this.toast('error', 'Verify a connected device before sharing your screen');
      return;
    }
    if (this.screen && !['off', 'error'].includes(this.screen.view.state)) {
      this.toast('error', 'Stop your current screen session before starting another one');
      return;
    }
    this.screen?.close();
    this.screenPeerId = deviceId;
    this.screen = this.newScreenShare(entry.session);
    await this.screen.request();
  }

  respondScreenShare(accept: boolean): void { this.screen?.respond(accept); }
  stopScreenShare(): void { this.screen?.stop(); }

  prepareHandoff(rawUrl: string, rawTitle: string): boolean {
    try {
      const url = new URL(rawUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          url.href.length > 2048 || rawUrl.length > 2048) throw new Error('Only HTTP(S) tabs without embedded credentials can be handed off (up to 2,048 characters)');
      const title = rawTitle.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 160) || url.hostname;
      this.handoffDraft = { url: url.href, title };
      this.toast('info', 'Tab ready. Review the link and choose a verified device to hand it off.');
      this.emit();
      return true;
    } catch (err) {
      this.toast('error', (err as Error).message || 'Invalid browser handoff link');
      return false;
    }
  }

  clearHandoffDraft(): void {
    this.handoffDraft = null;
    this.emit();
  }

  sendSharedContent(deviceId: string, kind: SharedContent['kind'], text: string, url?: string, title?: string): boolean {
    const entry = this.sessions.get(deviceId);
    try {
      if (!entry?.shares) throw new Error('Select and verify a connected device first');
      entry.shares.send(kind, text, url, title);
      this.toast('info', 'Waiting for the recipient to approve the shared item');
      return true;
    } catch (err) {
      this.toast('error', (err as Error).message);
      return false;
    }
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
    if (this.transferRules.delete(deviceId)) {
      try { localStorage.setItem(TRANSFER_RULES_KEY, JSON.stringify(Object.fromEntries(this.transferRules))); }
      catch { /* the rule is removed from this running session */ }
    }
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

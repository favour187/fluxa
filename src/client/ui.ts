/**
 * Fluxa UI — a projection of AppSnapshot.
 *
 * All text that originates from another device goes through textContent or the
 * `esc()` helper: a peer must never be able to inject markup into this page.
 */
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';
import { formatBytes, formatDuration } from '../shared/protocol.js';
import type { AppSnapshot, FluxaApp, HandoffDraft, SessionView, TransferView } from './app.js';
import type { SharedContent } from '../shared/protocol.js';

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const esc = (value: string): string =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const ICONS: Record<string, string> = {
  image: 'M4 16l4.6-4.6a2 2 0 012.8 0L20 20M14 8h.01M6 3h12a3 3 0 013 3v12a3 3 0 01-3 3H6a3 3 0 01-3-3V6a3 3 0 013-3z',
  video: 'M15 10l4.5-2.6A1 1 0 0121 8.3v7.4a1 1 0 01-1.5.9L15 14M4 6h9a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V8a2 2 0 012-2z',
  audio: 'M9 18V6l10-2v12M9 18a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm10-2a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0z',
  archive: 'M4 7h16M6 7v12a2 2 0 002 2h8a2 2 0 002-2V7M9 3h6l1 4H8l1-4zm3 8v5',
  code: 'M8 8l-4 4 4 4m8-8l4 4-4 4M13 5l-2 14',
  file: 'M7 3h7l5 5v13H7a2 2 0 01-2-2V5a2 2 0 012-2zm7 0v6h5',
};

function iconFor(mime: string, name: string): string {
  const lower = name.toLowerCase();
  if (mime.startsWith('image/')) return ICONS.image!;
  if (mime.startsWith('video/')) return ICONS.video!;
  if (mime.startsWith('audio/')) return ICONS.audio!;
  if (/\.(zip|tar|gz|rar|7z|bz2|xz)$/.test(lower)) return ICONS.archive!;
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|h|json|md|html|css|sh|yml|yaml|toml)$/.test(lower)) return ICONS.code!;
  return ICONS.file!;
}

function svgIcon(path: string, size = 18): SVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

const stateLabel: Record<string, string> = {
  preparing: 'Preparing',
  'waiting-approval': 'Waiting for approval',
  incoming: 'Incoming',
  transferring: 'Transferring',
  verifying: 'Verifying',
  complete: 'Complete',
  declined: 'Declined',
  cancelled: 'Cancelled',
  failed: 'Failed',
  paused: 'Paused · resumable',
};

const sessionLabel: Record<string, string> = {
  idle: 'Starting',
  connecting: 'Connecting',
  handshaking: 'Securing',
  'awaiting-verification': 'Verify code',
  connected: 'Connected',
  closed: 'Disconnected',
  failed: 'Unavailable',
};

interface TransferRow {
  node: HTMLElement;
  primary: HTMLElement;
  detail: HTMLElement;
  stateTag: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  stats: HTMLElement;
  error: HTMLElement;
  actions: HTMLElement;
  cancel: HTMLButtonElement;
  save: HTMLButtonElement;
  resume: HTMLButtonElement;
}

export class FluxaUI {
  private selectedDeviceId: string | null = null;
  private snapshot: AppSnapshot | null = null;
  private lastVerificationKey = '';
  private deferredVerifications = new Set<string>();
  private pairingModal: HTMLElement | null = null;
  private sawPairingCode = false;
  /** Whether this dialog has already jumped to the Direct code tab by itself. */
  private autoSwitchedDirect = false;
  private verifyModal: HTMLElement | null = null;
  private settingsModal: HTMLElement | null = null;
  private transferRows = new Map<string, TransferRow>();
  private fileInput: HTMLInputElement;
  private folderInput: HTMLInputElement;
  private stagedFiles: File[] = [];
  private stagedForDeviceId: string | null = null;
  private stagedRevision = 0;
  private stageSignature = '';
  private displayedStageDeviceId: string | null = null;
  private chatDrafts = new Map<string, string>();
  private handoffTargetId: string | null = null;
  private qrScanStream: MediaStream | null = null;
  private qrScanFrame: number | null = null;
  private qrScanModal: HTMLElement | null = null;
  private qrScanReturnFocus: HTMLElement | null = null;

  constructor(
    private readonly app: FluxaApp,
    private readonly root: HTMLElement,
  ) {
    this.fileInput = el('input');
    this.fileInput.type = 'file';
    this.fileInput.multiple = true;
    this.fileInput.hidden = true;
    this.fileInput.setAttribute('data-testid', 'file-input');
    this.fileInput.addEventListener('change', () => this.onFilesPicked(this.fileInput.files));

    this.folderInput = el('input');
    this.folderInput.type = 'file';
    this.folderInput.multiple = true;
    this.folderInput.hidden = true;
    this.folderInput.setAttribute('data-testid', 'folder-input');
    this.folderInput.setAttribute('webkitdirectory', '');
    this.folderInput.addEventListener('change', () => this.onFilesPicked(this.folderInput.files));

    this.root.append(this.fileInput, this.folderInput);
  }

  mount(): void {
    this.buildSkeleton();
    this.app.subscribe((snapshot) => this.render(snapshot));
  }

  /* ---------------------------------------------------------------- */
  /* Skeleton                                                          */
  /* ---------------------------------------------------------------- */

  private buildSkeleton(): void {
    const header = el('header', 'topbar');
    const brand = el('div', 'brand');
    brand.innerHTML = `
      <div class="logo" aria-hidden="true">
        <svg viewBox="0 0 40 40" width="34" height="34" fill="none">
          <defs>
            <linearGradient id="fluxaGrad" x1="0" y1="0" x2="40" y2="40">
              <stop offset="0%" stop-color="#8B7CFF"/>
              <stop offset="55%" stop-color="#4FD1FF"/>
              <stop offset="100%" stop-color="#5AF2C6"/>
            </linearGradient>
          </defs>
          <rect x="1.5" y="1.5" width="37" height="37" rx="12" stroke="url(#fluxaGrad)" stroke-width="1.6" opacity=".55"/>
          <path d="M13 26.5c3.2 0 5.4-2.1 6.6-5.6 1.3-3.8 3-5.4 7.4-5.4" stroke="url(#fluxaGrad)" stroke-width="2.4" stroke-linecap="round"/>
          <circle cx="27.5" cy="15.5" r="2.4" fill="url(#fluxaGrad)"/>
        </svg>
      </div>
      <div class="brand-text">
        <h1>FLUXA</h1>
        <p>Move anything. Anywhere.</p>
      </div>`;
    const cluster = el('div', 'status-cluster');
    cluster.innerHTML = `
      <span class="pill" id="signal-pill" data-testid="signal-status"><span class="dot"></span><span class="label">Connecting</span></span>
      <button class="device-chip" id="this-device" type="button" data-testid="this-device"></button>`;
    header.append(brand, cluster);

    const clipboardBanner = el('section', 'clipboard-banner');
    clipboardBanner.id = 'clipboard-banner';
    clipboardBanner.dataset.testid = 'clipboard-banner';
    clipboardBanner.setAttribute('role', 'status');
    clipboardBanner.hidden = true;
    const screenBanner = el('section', 'clipboard-banner screen-banner');
    screenBanner.id = 'screen-banner';
    screenBanner.dataset.testid = 'screen-banner';
    screenBanner.setAttribute('role', 'status');
    screenBanner.hidden = true;
    const handoffBanner = el('section', 'clipboard-banner handoff-banner');
    handoffBanner.id = 'handoff-banner';
    handoffBanner.dataset.testid = 'handoff-banner';
    handoffBanner.hidden = true;

    const main = el('main', 'grid');

    // Devices
    const devicesPanel = el('section', 'panel devices-panel');
    devicesPanel.innerHTML = `
      <div class="panel-head">
        <div>
          <h2>Devices</h2>
          <p class="muted" id="device-count">No devices yet</p>
        </div>
        <button class="btn btn-primary btn-sm" id="pair-btn" type="button" data-testid="pair-button">
          <span class="plus">+</span> Pair device
        </button>
      </div>
      <ul class="device-list" id="device-list" data-testid="device-list"></ul>
      <div class="nearby-section" id="nearby-section" hidden>
        <div class="nearby-head">
          <span class="eyebrow">Nearby on this network</span>
          <button class="btn btn-ghost btn-xs" id="use-local-server" type="button" data-testid="use-local-server" hidden>Use my server</button>
        </div>
        <ul class="nearby-list" id="nearby-list" data-testid="nearby-list"></ul>
        <p class="muted tiny" id="nearby-empty">Looking for other Fluxa apps on this network…</p>
        <p class="nearby-address muted tiny">This device: <code id="local-address"></code></p>
      </div>
      <div class="empty" id="device-empty">
        <div class="empty-orb" aria-hidden="true"></div>
        <p><strong>No paired devices yet</strong></p>
        <p class="muted small">Open Fluxa on another device and pair with a 6-character code. Connections are end-to-end between your devices — files never touch the server.</p>
      </div>`;

    // Stage
    const stagePanel = el('section', 'panel stage-panel');
    stagePanel.innerHTML = `<div id="stage" class="stage"></div>`;

    // Activity
    const activityPanel = el('aside', 'panel activity-panel');
    activityPanel.innerHTML = `
      <div class="panel-head"><div><h2>Activity</h2><p class="muted" id="activity-sub">Nothing transferred yet</p></div></div>
      <ul class="transfer-list" id="transfer-list" data-testid="transfer-list"></ul>
      <div id="shared-section" class="shared-section" hidden><div class="panel-head"><h3>Shared with you</h3><button type="button" id="clear-shares" class="btn btn-ghost btn-xs">Clear</button></div><ul id="shared-items" class="shared-items"></ul></div>`;

    main.append(devicesPanel, stagePanel, activityPanel);

    const overlay = el('div', 'overlay-root');
    overlay.id = 'overlay';

    const toasts = el('div', 'toast-stack');
    toasts.id = 'toasts';
    toasts.setAttribute('aria-live', 'polite');

    const sr = el('div', 'sr-only');
    sr.id = 'sr-status';
    sr.setAttribute('role', 'status');
    sr.setAttribute('aria-live', 'polite');

    this.root.append(header, clipboardBanner, screenBanner, handoffBanner, main, overlay, toasts, sr);

    this.q('#pair-btn').addEventListener('click', () => this.openPairing());
    this.q('#this-device').addEventListener('click', () => this.openSettings());
    this.q('#clear-shares').addEventListener('click', () => this.app.clearReceivedShares());
  }

  private q<T extends HTMLElement = HTMLElement>(selector: string): T {
    const node = this.root.querySelector<T>(selector);
    if (!node) throw new Error(`missing element ${selector}`);
    return node;
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                           */
  /* ---------------------------------------------------------------- */

  private render(snapshot: AppSnapshot): void {
    this.snapshot = snapshot;
    this.renderStatus(snapshot);
    this.renderDevices(snapshot);
    this.renderNearby(snapshot);
    this.renderClipboardBanner(snapshot);
    this.renderScreenBanner(snapshot);
    this.renderHandoffBanner(snapshot);
    this.renderStage(snapshot);
    this.renderTransfers(snapshot);
    this.renderReceivedShares(snapshot);
    this.syncPairingModal(snapshot);
    this.renderDirectPanel(snapshot);
    this.renderIncoming(snapshot);
    this.renderVerification(snapshot);
    this.renderIncomingShare(snapshot);
    this.renderToasts(snapshot);
  }

  private renderStatus(snapshot: AppSnapshot): void {
    const pill = this.q('#signal-pill');
    const label = pill.querySelector('.label')!;
    const map: Record<string, string> = {
      online: 'Signalling online',
      connecting: 'Reconnecting',
      verifying: 'Authenticating',
      offline: 'Offline',
    };
    pill.dataset.state = snapshot.status;
    label.textContent = map[snapshot.status] ?? snapshot.status;

    const chip = this.q<HTMLButtonElement>('#this-device');
    chip.replaceChildren();
    const dot = el('span', 'avatar-dot');
    dot.textContent = (snapshot.identity?.name ?? 'D').slice(0, 1).toUpperCase();
    const text = el('span', 'chip-text');
    text.append(el('strong', undefined, snapshot.identity?.name ?? 'Loading device'));
    text.append(el('span', 'muted small', snapshot.identity?.platform ?? ''));
    chip.append(dot, text, svgIcon('M9 12l2 2 4-4M12 3l7 4v5c0 4.3-2.9 7.7-7 9-4.1-1.3-7-4.7-7-9V7l7-4z', 16));
    chip.title = 'Device settings';
  }

  private renderDevices(snapshot: AppSnapshot): void {
    const list = this.q('#device-list');
    const empty = this.q('#device-empty');
    const count = this.q('#device-count');
    list.replaceChildren();
    list.hidden = snapshot.devices.length === 0;
    empty.hidden = snapshot.devices.length > 0;
    count.textContent =
      snapshot.devices.length === 0
        ? 'No devices yet'
        : `${snapshot.devices.length} paired device${snapshot.devices.length === 1 ? '' : 's'}`;

    for (const device of snapshot.devices) {
      const session = snapshot.sessions.find((s) => s.deviceId === device.deviceId);
      const online = Boolean(session && session.state !== 'closed' && session.state !== 'failed');
      const selected = this.selectedDeviceId === device.deviceId;
      const item = el('li', `device-item${selected ? ' selected' : ''}`);
      item.dataset.deviceId = device.deviceId;

      // The whole row is a real <button> so it is keyboard operable and the
      // "remove" control next to it is not nested inside another control.
      const selectBtn = el('button', 'device-select');
      selectBtn.type = 'button';
      selectBtn.dataset.testid = 'device-item';
      selectBtn.setAttribute(
        'aria-label',
        `${device.name}, ${device.platform}, ${online ? 'connected' : 'offline'}`,
      );
      selectBtn.setAttribute('aria-pressed', selected ? 'true' : 'false');

      const avatar = el('div', 'avatar', device.name.slice(0, 1).toUpperCase());
      avatar.dataset.platform = device.platform.toLowerCase();

      const body = el('div', 'device-body');
      const title = el('div', 'device-title');
      title.append(el('strong', undefined, device.name));
      if (session?.verified && online) {
        const badge = el('span', 'badge verified');
        badge.append(svgIcon('M5 13l4 4L19 7', 12), el('span', undefined, 'Verified'));
        title.append(badge);
      } else if (device.pending) {
        const badge = el('span', 'badge pending', 'Not verified');
        title.append(badge);
      }
      const meta = el('div', 'device-meta');
      meta.append(el('span', undefined, device.platform));
      meta.append(el('span', 'sep', '·'));
      meta.append(
        el(
          'span',
          undefined,
          session && session.state !== 'closed' && session.state !== 'failed'
            ? (sessionLabel[session.state] ?? session.state)
            : device.pending
              ? 'Awaiting verification'
              : 'Last seen ' + new Date(device.lastSeen).toLocaleDateString(),
        ),
      );
      if (session?.connection) {
        meta.append(el('span', 'sep', '·'));
        meta.append(
          el(
            'span',
            `path ${session.connection.direct ? 'direct' : 'relay'}`,
            session.connection.direct
              ? session.connection.type === 'host'
                ? 'Direct'
                : `Direct (${session.connection.type})`
              : 'Relayed',
          ),
        );
      }
      body.append(title, meta);
      selectBtn.append(avatar, body);
      selectBtn.addEventListener('click', () => {
        this.selectedDeviceId = device.deviceId;
        this.render(this.snapshot!);
      });

      const actions = el('div', 'device-actions');
      if (session?.state === 'awaiting-verification') {
        const verify = el('button', 'btn btn-ghost btn-xs', 'Verify');
        verify.type = 'button';
        verify.dataset.testid = 'verify-device';
        verify.addEventListener('click', (e) => {
          e.stopPropagation();
          this.openVerification(session);
        });
        actions.append(verify);
      }
      const forget = el('button', 'icon-btn', '×');
      forget.title = `Remove ${device.name}`;
      forget.setAttribute('aria-label', `Remove ${device.name} from trusted devices`);
      forget.type = 'button';
      forget.addEventListener('click', () => void this.app.revoke(device.deviceId));
      actions.append(forget);

      item.append(selectBtn, actions);
      list.append(item);
    }

    if (this.selectedDeviceId && !snapshot.devices.some((d) => d.deviceId === this.selectedDeviceId)) {
      this.selectedDeviceId = null;
    }
  }

  private renderNearby(snapshot: AppSnapshot): void {
    const section = this.q('#nearby-section');
    if (!snapshot.desktop) {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    const address = this.q('#local-address');
    address.textContent = snapshot.desktop.lanUrls.length
      ? snapshot.desktop.lanUrls.map((url) => url.replace(/^http:\/\//, '')).join(' · ')
      : `${snapshot.desktop.localUrl.replace(/^http:\/\//, '')} (this device only)`;

    const list = this.q('#nearby-list');
    const empty = this.q('#nearby-empty');
    list.replaceChildren();
    empty.hidden = snapshot.nearby.length > 0;

    for (const peer of snapshot.nearby) {
      const item = el('li', 'nearby-item');
      item.dataset.testid = 'nearby-item';
      const body = el('div', 'nearby-body');
      body.append(el('strong', undefined, peer.name), el('span', 'muted tiny', `${peer.platform} · ${peer.host}:${peer.port}`));
      const use = el('button', 'btn btn-ghost btn-xs', 'Connect');
      use.type = 'button';
      use.dataset.testid = 'use-nearby';
      use.addEventListener('click', () => this.app.useNearbyServer(peer));
      item.append(body, use);
      list.append(item);
    }

    // Offer the way back when signalling has been pointed at another device.
    const usingOwn = snapshot.signalUrl?.includes(snapshot.desktop.localUrl.replace(/^http:\/\//, '')) ?? false;
    const back = this.q<HTMLButtonElement>('#use-local-server');
    back.hidden = usingOwn || snapshot.nearby.length === 0;
    if (!back.dataset.bound) {
      back.dataset.bound = '1';
      back.addEventListener('click', () => this.app.useLocalServer());
    }
  }

  private renderClipboardBanner(snapshot: AppSnapshot): void {
    const banner = this.q('#clipboard-banner');
    const sync = snapshot.clipboard;
    banner.hidden = !sync || !['incoming', 'active', 'requesting'].includes(sync.state);
    if (banner.hidden || !sync) {
      banner.replaceChildren();
      return;
    }
    banner.replaceChildren();
    const copy = el('div');
    copy.append(el('strong', undefined, sync.state === 'incoming'
      ? `${sync.peerName} wants to sync your text clipboard`
      : sync.state === 'active' ? `Live clipboard sync with ${sync.peerName}` : `Asking ${sync.peerName} to sync clipboards…`));
    copy.append(el('p', 'muted small', sync.state === 'incoming'
      ? 'Both people must agree. Future copied text, including passwords, can reach the other device. No existing text is sent.'
      : 'Text only, up to 16 KiB. No existing text is sent; stop at any time.'));
    const actions = el('div', 'clipboard-actions');
    if (sync.state === 'incoming') {
      const accept = el('button', 'btn btn-primary btn-sm', 'Accept sync');
      accept.type = 'button'; accept.dataset.testid = 'clipboard-accept';
      accept.addEventListener('click', () => void this.app.respondClipboardSync(true));
      const decline = el('button', 'btn btn-ghost btn-sm', 'Decline');
      decline.type = 'button'; decline.dataset.testid = 'clipboard-decline';
      decline.addEventListener('click', () => void this.app.respondClipboardSync(false));
      actions.append(accept, decline);
    } else {
      const stop = el('button', 'btn btn-ghost btn-sm', sync.state === 'active' ? 'Stop sync' : 'Cancel request');
      stop.type = 'button'; stop.dataset.testid = 'clipboard-stop';
      stop.addEventListener('click', () => this.app.stopClipboardSync());
      actions.append(stop);
    }
    banner.append(copy, actions);
  }

  private renderScreenBanner(snapshot: AppSnapshot): void {
    const banner = this.q('#screen-banner');
    const share = snapshot.screen;
    banner.hidden = !share || !['incoming', 'requesting', 'starting', 'sharing', 'viewing'].includes(share.state);
    if (!share || banner.hidden) { banner.replaceChildren(); return; }
    banner.replaceChildren();
    const copy = el('div');
    copy.append(el('strong', undefined, share.state === 'incoming'
      ? `${share.peerName} wants to show their screen`
      : share.state === 'viewing' ? `Viewing ${share.peerName}'s screen`
        : share.state === 'sharing' ? `Your screen is visible to ${share.peerName}`
          : share.state === 'starting' ? 'Starting encrypted screen video…'
            : `Asking ${share.peerName} to view your screen…`));
    copy.append(el('p', 'muted small', share.state === 'incoming'
      ? 'Accept to view a live screen. Fluxa cannot control, record, or access the other device.'
      : 'Live video only, no audio, recording, or remote control. Stop at any time.'));
    const actions = el('div', 'clipboard-actions');
    if (share.state === 'incoming') {
      const yes = el('button', 'btn btn-primary btn-sm', 'View screen');
      yes.type = 'button'; yes.dataset.testid = 'screen-accept';
      yes.addEventListener('click', () => this.app.respondScreenShare(true));
      const no = el('button', 'btn btn-ghost btn-sm', 'Decline');
      no.type = 'button'; no.dataset.testid = 'screen-decline';
      no.addEventListener('click', () => this.app.respondScreenShare(false));
      actions.append(yes, no);
    } else {
      const stop = el('button', 'btn btn-ghost btn-sm', share.state === 'requesting' ? 'Cancel request' : 'Stop screen');
      stop.type = 'button'; stop.dataset.testid = 'screen-stop';
      stop.addEventListener('click', () => this.app.stopScreenShare());
      actions.append(stop);
    }
    banner.append(copy, actions);
  }

  private renderHandoffBanner(snapshot: AppSnapshot): void {
    const banner = this.q('#handoff-banner');
    const draft = snapshot.handoffDraft;
    banner.hidden = !draft;
    if (!draft) { banner.replaceChildren(); return; }
    banner.replaceChildren();
    const copy = el('div');
    copy.append(el('strong', undefined, `Continue “${draft.title}” on another device`));
    copy.append(el('p', 'muted small', `${new URL(draft.url).host} · Review the FULL link before sending; URLs may contain private tokens. Sign in on the receiving device separately.`));
    const actions = el('div', 'clipboard-actions');
    const connected = snapshot.sessions.filter((session) => session.verified && session.state === 'connected');
    const target = el('select');
    target.dataset.testid = 'handoff-target';
    target.setAttribute('aria-label', 'Device for browser tab');
    for (const session of connected) {
      const option = el('option', undefined, session.name);
      option.value = session.deviceId;
      target.append(option);
    }
    const preferred = this.handoffTargetId ?? this.selectedDeviceId;
    if (preferred && connected.some((session) => session.deviceId === preferred)) target.value = preferred;
    target.addEventListener('change', () => { this.handoffTargetId = target.value; });
    const review = el('button', 'btn btn-primary btn-sm', 'Review & send');
    review.type = 'button'; review.dataset.testid = 'handoff-review';
    review.disabled = connected.length === 0;
    review.addEventListener('click', () => this.openShareComposer('session', target.value, draft));
    const discard = el('button', 'btn btn-ghost btn-sm', 'Discard');
    discard.type = 'button'; discard.dataset.testid = 'handoff-discard';
    discard.addEventListener('click', () => this.app.clearHandoffDraft());
    if (connected.length) actions.append(target, review);
    else actions.append(el('span', 'muted small', 'Pair and verify a device first.'));
    actions.append(discard);
    banner.append(copy, actions);
  }

  private selectedSession(snapshot: AppSnapshot): SessionView | null {
    if (!this.selectedDeviceId) return null;
    return snapshot.sessions.find((s) => s.deviceId === this.selectedDeviceId) ?? null;
  }

  private renderStage(snapshot: AppSnapshot): void {
    const stage = this.q('#stage');
    // Progress changes many times per second. Keep the swipe card and message
    // input mounted unless their own content changes, so typing is not lost.
    stage.classList.toggle('transfer-rippling', snapshot.transfers.some((transfer) => transfer.state === 'transferring'));
    const session = this.selectedSession(snapshot);
    const messageSignature = snapshot.messages.filter((m) => m.deviceId === session?.deviceId)
      .slice(-12).map((m) => `${m.id}:${m.status}`).join('|');
    const signature = JSON.stringify([
      session?.deviceId, session?.connId, session?.name, session?.platform,
      session?.state, session?.verified, session?.error,
      session?.connection?.direct, session?.connection?.type,
      snapshot.iceConfigured, this.stagedForDeviceId, this.stagedRevision, messageSignature,
      snapshot.clipboard?.peerDeviceId, snapshot.clipboard?.state,
      snapshot.screen?.peerDeviceId, snapshot.screen?.state, snapshot.screen?.stream?.id,
      session ? this.app.transferRule(session.deviceId) : null,
    ]);
    if (signature === this.stageSignature) return;
    this.stageSignature = signature;
    const previousInput = stage.querySelector<HTMLInputElement>('.chat-input');
    const restoreFocus = previousInput === document.activeElement && this.displayedStageDeviceId === session?.deviceId;
    const caret = previousInput?.selectionStart ?? 0;
    stage.replaceChildren();
    this.displayedStageDeviceId = session?.deviceId ?? null;

    if (!session) {
      stage.innerHTML = `
        <div class="stage-empty">
          <div class="pulse-ring" aria-hidden="true"></div>
          <h2>Select a device to send</h2>
          <p class="muted">Pair once, then drop files, folders, photos or links. Transfers run device-to-device with SHA-256 verification.</p>
          <button class="btn btn-primary" id="stage-pair" type="button">Pair a device</button>
        </div>`;
      this.q('#stage-pair').addEventListener('click', () => this.openPairing());
      return;
    }

    const live = session.verified && session.state === 'connected';
    const header = el('div', 'stage-head');
    const title = el('div');
    title.append(el('p', 'eyebrow', live ? 'Ready to send' : 'Connection in progress'));
    const h = el('h2', undefined, session.name);
    title.append(h);
    const metaLine = el('p', 'muted small');
    const route = session.connection ? (session.connection.type === 'host'
      ? ' · local/direct (internet not needed on the same LAN)'
      : session.connection.direct ? ' · direct via internet' : ' · TURN relay (internet needed)') : '';
    metaLine.textContent = `${session.platform} · ${sessionLabel[session.state] ?? session.state}${route}`;
    title.append(metaLine);
    header.append(title);

    const verified = el('div', live ? 'verify-badge ok' : 'verify-badge pending');
    verified.append(
      svgIcon(live ? 'M9 12l2 2 4-4M12 3l7 4v5c0 4.3-2.9 7.7-7 9-4.1-1.3-7-4.7-7-9V7l7-4z' : 'M12 8v4m0 4h.01M12 3l9 16H3l9-16z', 16),
    );
    verified.append(el('span', undefined, live ? 'Verified' : session.verified ? 'Disconnected' : 'Not verified'));
    header.append(verified);
    stage.append(header);

    if (!live) {
      const waiting = el('div', 'verify-wait');
      const unavailable = session.state === 'closed' || session.state === 'failed' || session.verified;
      waiting.innerHTML = unavailable
        ? `<p><strong>Connection unavailable</strong></p>
           <p class="muted small">This session has ended. Ask the other device to pair again — trusted devices stay in your list.</p>`
        : `<p><strong>Waiting for verification</strong></p>
           <p class="muted small">Both devices must show the same 6-digit code before any file can be sent.</p>`;
      if (session.state === 'awaiting-verification') {
        const btn = el('button', 'btn btn-primary', 'Compare code');
        btn.type = 'button';
        btn.dataset.testid = 'open-verify';
        btn.addEventListener('click', () => this.openVerification(session));
        waiting.append(btn);
      }
      if (session.error) waiting.append(el('p', 'error-text', session.error));
      stage.append(waiting);
      return;
    }

    const rule = this.app.transferRule(session.deviceId);
    const drop = el('div', 'dropzone');
    drop.id = 'dropzone';
    drop.dataset.testid = 'dropzone';
    drop.tabIndex = 0;
    drop.setAttribute('role', 'button');
    drop.setAttribute('aria-label', 'Drop files here or press Enter to choose files');
    drop.innerHTML = `
      <div class="drop-icon" aria-hidden="true"></div>
      <p><strong>Drop anything here</strong></p>
      <p class="muted small">Files, folders, photos, video, archives, installers</p>`;
    const buttons = el('div', 'stage-actions');
    const pick = el('button', 'btn btn-primary', rule.sendImmediately ? 'Choose & send files' : 'Choose files');
    pick.type = 'button';
    pick.dataset.testid = 'choose-files';
    pick.addEventListener('click', () => this.fileInput.click());
    const folder = el('button', 'btn btn-ghost', rule.sendImmediately ? 'Choose & send folder' : 'Choose folder');
    folder.type = 'button';
    folder.dataset.testid = 'choose-folder';
    folder.addEventListener('click', () => this.folderInput.click());
    buttons.append(pick, folder);
    for (const [kind, label] of [
      ['clipboard', 'Share text / clipboard'], ['link', 'Share link'], ['session', 'Handoff work link'],
    ] as [SharedContent['kind'], string][]) {
      const button = el('button', 'btn btn-ghost', label);
      button.type = 'button';
      button.dataset.testid = `share-${kind}`;
      button.addEventListener('click', () => this.openShareComposer(kind, session.deviceId));
      buttons.append(button);
    }
    const currentSync = snapshot.clipboard;
    if (!currentSync || ['off', 'error'].includes(currentSync.state)) {
      const enable = el('button', 'btn btn-ghost', 'Sync text clipboard');
      enable.type = 'button'; enable.dataset.testid = 'clipboard-start';
      enable.addEventListener('click', () => void this.app.startClipboardSync(session.deviceId));
      buttons.append(enable);
    } else if (currentSync.peerDeviceId === session.deviceId && currentSync.state === 'active') {
      const stop = el('button', 'btn btn-ghost', 'Stop clipboard sync');
      stop.type = 'button'; stop.addEventListener('click', () => this.app.stopClipboardSync());
      buttons.append(stop);
    }
    if (!snapshot.screen || ['off', 'error'].includes(snapshot.screen.state)) {
      const share = el('button', 'btn btn-ghost', 'Share screen');
      share.type = 'button'; share.dataset.testid = 'screen-start';
      if (!navigator.mediaDevices?.getDisplayMedia) {
        share.disabled = true;
        share.title = 'Screen capture is unavailable on this device; receiving a screen may still work';
      }
      share.addEventListener('click', () => void this.app.startScreenShare(session.deviceId));
      buttons.append(share);
    }
    const preferences = el('button', 'btn btn-ghost', 'Transfer rules');
    preferences.type = 'button'; preferences.dataset.testid = 'transfer-rules';
    preferences.addEventListener('click', () => this.openTransferRules(session));
    buttons.append(preferences);

    drop.addEventListener('click', () => this.fileInput.click());
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.fileInput.click();
      }
    });
    for (const type of ['dragenter', 'dragover']) {
      drop.addEventListener(type, (e) => {
        e.preventDefault();
        drop.classList.add('dragging');
      });
    }
    for (const type of ['dragleave', 'dragend']) {
      drop.addEventListener(type, () => drop.classList.remove('dragging'));
    }
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('dragging');
      const files = e.dataTransfer?.files;
      if (files) this.send(Array.from(files));
    });

    stage.append(drop, buttons);
    stage.append(el('p', 'muted tiny', rule.incoming === 'auto'
      ? `Incoming: auto-accept only ${rule.extensions.join(', ')} up to ${rule.maxMiB} MiB into private storage.`
      : rule.incoming === 'block' ? 'Incoming: blocked by your rule.' : 'Incoming: you approve each transfer.'));

    if (snapshot.screen?.peerDeviceId === session.deviceId && snapshot.screen.state === 'viewing') {
      const preview = el('section', 'screen-preview');
      preview.dataset.testid = 'screen-preview';
      preview.append(el('strong', undefined, `${session.name}'s live screen`));
      if (snapshot.screen.stream) {
        const video = el('video');
        video.dataset.testid = 'screen-video';
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.controls = true;
        video.setAttribute('aria-label', `${session.name}'s shared screen`);
        video.srcObject = snapshot.screen.stream;
        preview.append(video);
        void video.play().catch(() => { /* the user can press the native Play control */ });
      } else preview.append(el('p', 'muted small', 'Waiting for the other device to begin streaming…'));
      stage.append(preview);
    }

    if (this.stagedFiles.length && this.stagedForDeviceId === session.deviceId) {
      const swipe = el('section', 'edge-send-card');
      const summary = el('div');
      summary.append(el('p', 'eyebrow', 'Ready to move'));
      summary.append(el('strong', undefined, this.stagedFiles.length === 1 ? this.stagedFiles[0]!.name : this.stagedFiles.length + ' selected items'));
      summary.append(el('p', 'muted tiny', `To ${session.name} · Swipe this card to the right edge to send, or tap Send now.`));
      const actions = el('div', 'edge-send-actions');
      const clear = el('button', 'btn btn-ghost btn-xs', 'Clear'); clear.type = 'button';
      clear.dataset.testid = 'clear-staged';
      clear.addEventListener('click', () => {
        this.stagedFiles = []; this.stagedForDeviceId = null;
        this.stagedRevision++; this.renderStage(this.snapshot!);
      });
      const sendNow = el('button', 'btn btn-primary btn-sm', 'Send now'); sendNow.type = 'button';
      sendNow.dataset.testid = 'send-staged';
      sendNow.addEventListener('click', () => this.sendStaged());
      actions.append(clear, sendNow); swipe.append(summary, actions);
      let startX = 0, startY = 0, startRight = 0, dragging = false;
      const resetSwipe = () => { dragging = false; swipe.style.transform = ''; swipe.classList.remove('is-dragging', 'edge-ready'); };
      swipe.addEventListener('pointerdown', (event) => {
        // Pointer capture on the parent would otherwise swallow the buttons' clicks.
        if ((event.target as Element).closest('button, input, a')) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        startX = event.clientX; startY = event.clientY; startRight = swipe.getBoundingClientRect().right; dragging = true;
        try { swipe.setPointerCapture(event.pointerId); } catch { /* capture can fail if the pointer is already cancelled */ }
      });
      swipe.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        const dx = Math.max(0, event.clientX - startX);
        if (dx > 8 && Math.abs(event.clientY - startY) < 70) {
          swipe.classList.add('is-dragging');
          swipe.style.transform = `translateX(${Math.min(dx, Math.max(0, window.innerWidth - startRight))}px)`;
          swipe.classList.toggle('edge-ready', event.clientX >= window.innerWidth - 48);
        }
      });
      swipe.addEventListener('pointerup', (event) => {
        const shouldSend = dragging && event.clientX - startX > 90 && Math.abs(event.clientY - startY) < 70 && event.clientX >= window.innerWidth - 48;
        resetSwipe();
        if (shouldSend) this.sendStaged();
      });
      swipe.addEventListener('pointercancel', resetSwipe);
      swipe.addEventListener('lostpointercapture', resetSwipe);
      swipe.tabIndex = 0; swipe.setAttribute('role', 'group');
      swipe.setAttribute('aria-label', 'Swipe selected files to the right edge to send');
      swipe.dataset.testid = 'edge-send-card';
      stage.append(swipe);
    }

    const chat = el('section', 'chat-panel');
    chat.setAttribute('aria-label', 'Messages with ' + session.name);
    const head = el('div', 'chat-head'); head.append(el('h3', undefined, 'Quick messages'), el('span', 'muted tiny', 'Encrypted peer channel'));
    const list = el('div', 'chat-messages'); list.setAttribute('aria-live', 'polite');
    const messages = snapshot.messages.filter((m) => m.deviceId === session.deviceId);
    if (!messages.length) list.append(el('p', 'muted small chat-empty', 'Message this device without leaving your transfer screen.'));
    for (const m of messages.slice(-12)) {
      const bubble = el('article', 'chat-bubble ' + m.direction); bubble.append(el('p', undefined, m.text));
      bubble.append(el('span', 'chat-meta', new Date(m.sentAt).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) + ' · ' + m.status)); list.append(bubble);
    }
    const form = el('form', 'chat-form'); const input = el('input', 'chat-input');
    input.type = 'text'; input.maxLength = 4000; input.autocomplete = 'off'; input.placeholder = 'Write a message…'; input.setAttribute('aria-label', 'Message');
    input.value = this.chatDrafts.get(session.deviceId) ?? '';
    input.addEventListener('input', () => this.chatDrafts.set(session.deviceId, input.value));
    const send = el('button', 'btn btn-primary btn-sm', 'Send'); send.type = 'submit'; form.append(input, send);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value;
      if (!text.trim()) return;
      // sendChatMessage emits synchronously: clear the draft before it re-renders.
      this.chatDrafts.delete(session.deviceId);
      input.value = '';
      if (!this.app.sendChatMessage(session.deviceId, text)) {
        this.chatDrafts.set(session.deviceId, text);
        const current = stage.querySelector<HTMLInputElement>('.chat-input');
        if (current) { current.value = text; current.focus(); }
      }
    });
    chat.append(head, list, form); stage.append(chat);
    if (restoreFocus) { input.focus(); input.setSelectionRange(caret, caret); }

    const note = el('p', 'small muted stage-note');
    note.textContent = snapshot.iceConfigured
      ? 'Encrypted peer-to-peer (DTLS). No file data passes through this server.'
      : 'Encrypted device-to-device on your network. Configure STUN/TURN for remote networks (see docs/NETWORKING.md).';
    stage.append(note);
  }

  private send(files: File[]): void {
    if (!this.selectedDeviceId || files.length === 0) return;
    this.app.sendFiles(this.selectedDeviceId, files);
  }

  private onFilesPicked(list: FileList | null): void {
    if (!list?.length || !this.selectedDeviceId) return;
    const files = Array.from(list);
    this.fileInput.value = '';
    this.folderInput.value = '';
    const selected = this.selectedDeviceId;
    const session = this.snapshot?.sessions.find((peer) => peer.deviceId === selected);
    if (session?.verified && session.state === 'connected' && this.app.transferRule(selected).sendImmediately) {
      this.stagedFiles = [];
      this.stagedForDeviceId = null;
      this.stagedRevision++;
      this.send(files); // selection itself is the explicit send gesture for this preference
    } else {
      this.stagedFiles = files;
      this.stagedForDeviceId = selected;
      this.stagedRevision++;
    }
    if (this.snapshot) this.renderStage(this.snapshot);
  }

  private sendStaged(): void {
    if (!this.stagedFiles.length || this.stagedForDeviceId !== this.selectedDeviceId) return;
    const files = this.stagedFiles;
    this.stagedFiles = [];
    this.stagedForDeviceId = null;
    this.stagedRevision++;
    this.send(files);
    if (this.snapshot) this.renderStage(this.snapshot);
  }

  private renderTransfers(snapshot: AppSnapshot): void {
    const list = this.q('#transfer-list');
    const sub = this.q('#activity-sub');
    const transfers = snapshot.transfers.filter((t) => t.state !== 'incoming');
    sub.textContent =
      transfers.length === 0
        ? 'Nothing transferred yet'
        : `${transfers.filter((t) => t.state === 'complete').length} completed · ${transfers.length} total`;

    const seen = new Set<string>();
    for (const transfer of transfers) {
      seen.add(transfer.id);
      let entry = this.transferRows.get(transfer.id);
      if (!entry) {
        entry = this.buildTransferRow(transfer);
        this.transferRows.set(transfer.id, entry);
      }
      this.updateTransferRow(entry, transfer);
      list.append(entry.node);
    }
    for (const [id, entry] of [...this.transferRows]) {
      if (seen.has(id)) continue;
      entry.node.remove();
      this.transferRows.delete(id);
    }
  }

  /** Attach or detach an action button so irrelevant controls are not in the DOM. */
  private toggleAction(container: HTMLElement, button: HTMLButtonElement, show: boolean): void {
    if (show && !button.isConnected) container.append(button);
    if (!show && button.isConnected) button.remove();
  }

  /**
   * Rows are built once and then patched in place. Re-creating them on every
   * progress frame would destroy focus and make the Cancel button un-clickable.
   */
  private buildTransferRow(transfer: TransferView): TransferRow {
    const node = el('li', `transfer-item state-${transfer.state}`);
    node.dataset.testid = 'transfer-item';
    node.dataset.transferId = transfer.id;

    const head = el('div', 'transfer-head');
    const icon = el('div', 'file-icon');
    icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${iconFor(
      '',
      transfer.files[0]?.name ?? '',
    )}"/></svg>`;
    const titles = el('div', 'transfer-titles');
    const primary = el('strong');
    const detail = el('span', 'muted small');
    titles.append(primary, detail);
    const stateTag = el('span', 'state-tag');
    stateTag.dataset.testid = 'transfer-state';
    head.append(icon, titles, stateTag);

    const bar = el('div', 'progress');
    bar.dataset.testid = 'progress-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    const fill = el('div', 'progress-fill');
    bar.append(fill);

    const stats = el('div', 'transfer-stats');
    stats.dataset.testid = 'transfer-stats';
    const error = el('p', 'error-text small');

    const actions = el('div', 'transfer-actions');
    const cancel = el('button', 'btn btn-ghost btn-xs', 'Cancel');
    cancel.type = 'button';
    cancel.dataset.testid = 'cancel-transfer';
    cancel.addEventListener('click', () => this.app.cancelTransfer(transfer.id));
    const save = el('button', 'btn btn-primary btn-xs', 'Save');
    save.type = 'button';
    save.dataset.testid = 'save-received';
    save.addEventListener('click', () => void this.app.saveReceived(transfer.id));
    const resume = el('button', 'btn btn-primary btn-xs', 'Reselect to resume');
    resume.type = 'button';
    resume.dataset.testid = 'resume-transfer';
    resume.addEventListener('click', () => {
      const current = this.snapshot?.transfers.find((t) => t.id === transfer.id);
      if (!current) return;
      const input = el('input');
      input.type = 'file';
      input.multiple = true;
      if (current.files.some((f) => f.relPath.includes('/'))) input.setAttribute('webkitdirectory', '');
      input.addEventListener('change', () => {
        if (input.files?.length) void this.app.resumeTransfer(transfer.id, Array.from(input.files));
        input.remove();
      }, { once: true });
      input.hidden = true;
      this.root.append(input);
      input.click();
    });
    actions.append(cancel, save, resume);

    node.append(head, bar, stats, error, actions);
    return { node, primary, detail, stateTag, bar, fill, stats, error, actions, cancel, save, resume };
  }

  private updateTransferRow(row: TransferRow, transfer: TransferView): void {
    row.node.className = `transfer-item state-${transfer.state}`;
    row.node.dataset.state = transfer.state;

    row.primary.textContent = transfer.files.length === 1 ? transfer.files[0]!.name : `${transfer.files.length} files`;
    const verb = transfer.role === 'send' ? `to ${transfer.peerName}` : `from ${transfer.peerName}`;
    row.detail.textContent = `${verb} · ${formatBytes(transfer.totalBytes)}`;
    row.stateTag.textContent = stateLabel[transfer.state] ?? transfer.state;
    row.stateTag.className = `state-tag ${transfer.state}`;

    const ratio =
      transfer.totalBytes > 0
        ? Math.min(1, transfer.transferredBytes / transfer.totalBytes)
        : transfer.state === 'complete'
          ? 1
          : 0;
    const shown = transfer.state === 'complete' ? 1 : ratio;
    const percent = Math.round(shown * 100);
    row.fill.style.width = `${shown * 100}%`;
    row.bar.setAttribute('aria-valuenow', String(percent));

    const parts = [`${formatBytes(transfer.transferredBytes)} / ${formatBytes(transfer.totalBytes)}`, `${percent}%`];
    if (transfer.state === 'transferring' && transfer.bytesPerSecond > 0) {
      parts.push(`${formatBytes(transfer.bytesPerSecond)}/s`);
    }
    if (transfer.state === 'transferring' && transfer.etaSeconds !== null) {
      parts.push(`${formatDuration(transfer.etaSeconds)} left`);
    }
    if (transfer.state === 'verifying') parts.push('verifying SHA-256');
    row.stats.textContent = parts.join(' · ');

    const showProgress = ['preparing', 'waiting-approval', 'transferring', 'verifying', 'complete'].includes(
      transfer.state,
    );
    row.bar.hidden = !showProgress;
    row.stats.hidden = !showProgress;

    row.error.textContent = transfer.error ?? '';
    row.error.hidden = !transfer.error;

    const cancellable = ['preparing', 'waiting-approval', 'transferring', 'incoming'].includes(transfer.state);
    const saveable = transfer.state === 'complete' && transfer.role === 'receive' && transfer.saveable;
    const resumable = transfer.state === 'paused' && transfer.role === 'send';
    this.toggleAction(row.actions, row.cancel, cancellable);
    this.toggleAction(row.actions, row.save, saveable);
    this.toggleAction(row.actions, row.resume, resumable);
    row.actions.hidden = !cancellable && !saveable && !resumable;
  }

  /** Rules are local to this device and one fingerprint-pinned peer. */
  private openTransferRules(session: SessionView): void {
    const rule = this.app.transferRule(session.deviceId);
    const overlay = this.openOverlay();
    const modal = el('div', 'modal modal-share');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', `Transfer rules for ${session.name}`);
    modal.dataset.testid = 'transfer-rules-modal';
    modal.innerHTML = `<button type="button" class="modal-close" aria-label="Close">×</button>
      <h2>Transfer rules · ${esc(session.name)}</h2>
      <p class="muted small">Only for this verified device. Nothing can auto-open or save to a public folder. Clear rules by removing the trusted device.</p>
      <form id="transfer-rules-form" class="rule-form">
        <label for="incoming-rule">When files arrive</label>
        <select id="incoming-rule" data-testid="incoming-rule">
          <option value="ask">Ask every time (recommended)</option>
          <option value="auto">Auto-accept small allowlisted files</option>
          <option value="block">Block incoming files</option>
        </select>
        <label for="auto-max">Auto-accept batch limit · MiB (1–100)</label>
        <input id="auto-max" type="number" min="1" max="100" step="1" data-testid="auto-max" />
        <label for="allowed-extensions">Allowed file extensions (comma-separated, maximum 12)</label>
        <input id="allowed-extensions" placeholder=".jpg, .png, .pdf, .txt" spellcheck="false" data-testid="allowed-extensions" />
        <label class="switch-row"><input type="checkbox" id="send-immediately" data-testid="send-immediately" />
          <span>Send as soon as I select files (skip the staged swipe/Send step)</span></label>
        <label class="switch-row"><input type="checkbox" id="allow-background" data-testid="allow-background"
          ${this.snapshot?.desktop ? '' : 'disabled'} />
          <span>Auto-accept while the desktop app window is not visible (desktop only)</span></label>
        <p class="muted tiny">Automation runs only over a verified connection and stores received bytes in private app storage. It falls back to Ask if the batch exceeds your rule, lacks durable storage, or uses another extension. Browser and phone background processing is not guaranteed.</p>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" id="rules-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" data-testid="save-transfer-rules">Save rules</button></div>
      </form>`;
    modal.querySelector<HTMLSelectElement>('#incoming-rule')!.value = rule.incoming;
    modal.querySelector<HTMLInputElement>('#auto-max')!.value = String(rule.maxMiB);
    modal.querySelector<HTMLInputElement>('#allowed-extensions')!.value = rule.extensions.join(', ');
    modal.querySelector<HTMLInputElement>('#send-immediately')!.checked = rule.sendImmediately;
    modal.querySelector<HTMLInputElement>('#allow-background')!.checked = rule.allowBackground;
    modal.querySelector('.modal-close')!.addEventListener('click', () => this.closeModal(modal));
    modal.querySelector('#rules-cancel')!.addEventListener('click', () => this.closeModal(modal));
    modal.querySelector<HTMLFormElement>('#transfer-rules-form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      const incoming = modal.querySelector<HTMLSelectElement>('#incoming-rule')!.value;
      const maxMiB = Number(modal.querySelector<HTMLInputElement>('#auto-max')!.value);
      const extensions = modal.querySelector<HTMLInputElement>('#allowed-extensions')!.value
        .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
      const sendImmediately = modal.querySelector<HTMLInputElement>('#send-immediately')!.checked;
      const allowBackground = modal.querySelector<HTMLInputElement>('#allow-background')!.checked;
      if (this.app.setTransferRule(session.deviceId, { incoming, maxMiB, extensions, sendImmediately, allowBackground })) {
        this.closeModal(modal);
      }
    });
    overlay.append(modal);
    modal.querySelector<HTMLSelectElement>('#incoming-rule')!.focus();
  }

  /** No passive clipboard access: this is only called from a visible button. */
  private openShareComposer(kind: SharedContent['kind'], deviceId: string, draft?: HandoffDraft): void {
    const overlay = this.openOverlay();
    const modal = el('div', 'modal modal-share');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Share with paired device');
    modal.dataset.testid = 'share-composer';
    const heading = kind === 'clipboard' ? 'Share text / clipboard' : kind === 'link' ? 'Share a link' : 'Handoff a work link';
    modal.innerHTML = `<button type="button" class="modal-close" aria-label="Close">×</button>
      <h2>${heading}</h2>
      <p class="muted small">Review the full link, including its query and fragment: they may contain private tokens. No cookies, passwords or sign-in session is moved. The other device must approve it.</p>
      ${kind === 'clipboard' ? '' : '<label for="shared-url">HTTP(S) URL</label><input id="shared-url" type="url" maxlength="2048" placeholder="https://example.com" data-testid="shared-url" />'}
      ${kind === 'session' ? '<label for="shared-title">Title</label><input id="shared-title" maxlength="256" placeholder="Continue reading" data-testid="shared-title" />' : ''}
      <label for="shared-text">${kind === 'clipboard' ? 'Text to share' : 'Note (optional)'}</label>
      <textarea id="shared-text" rows="4" maxlength="16000" data-testid="shared-text"></textarea>
      ${kind === 'clipboard' ? '<button type="button" class="btn btn-ghost btn-xs" id="paste-clipboard">Paste clipboard (permission required)</button>' : ''}
      <div class="modal-actions"><button type="button" class="btn btn-ghost" id="share-cancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="share-send" data-testid="send-shared">Request approval</button></div>`;
    if (draft) {
      const urlInput = modal.querySelector<HTMLInputElement>('#shared-url');
      const titleInput = modal.querySelector<HTMLInputElement>('#shared-title');
      if (urlInput) urlInput.value = draft.url;
      if (titleInput) titleInput.value = draft.title;
    }
    modal.querySelector('.modal-close')!.addEventListener('click', () => this.closeModal(modal));
    modal.querySelector('#share-cancel')!.addEventListener('click', () => this.closeModal(modal));
    modal.querySelector('#paste-clipboard')?.addEventListener('click', () => {
      void navigator.clipboard.readText().then((text) => {
        modal.querySelector<HTMLTextAreaElement>('#shared-text')!.value = text.slice(0, 16000);
      }).catch(() => this.app.toast('error', 'Clipboard access denied; paste text manually'));
    });
    modal.querySelector('#share-send')!.addEventListener('click', () => {
      const text = modal.querySelector<HTMLTextAreaElement>('#shared-text')!.value;
      const url = modal.querySelector<HTMLInputElement>('#shared-url')?.value.trim();
      const title = modal.querySelector<HTMLInputElement>('#shared-title')?.value.trim();
      if (kind === 'clipboard' && !text) { this.app.toast('error', 'Enter or paste some text first'); return; }
      if (kind !== 'clipboard') {
        try {
          const parsed = new URL(url ?? '');
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw Error();
        } catch { this.app.toast('error', 'Only HTTP(S) links without embedded credentials are allowed'); return; }
      }
      if (this.app.sendSharedContent(deviceId, kind, text, url, title)) {
        if (draft) this.app.clearHandoffDraft();
        this.closeModal(modal);
      }
    });
    overlay.append(modal);
    (modal.querySelector<HTMLInputElement>('#shared-url') ?? modal.querySelector<HTMLTextAreaElement>('#shared-text'))?.focus();
  }

  private renderIncomingShare(snapshot: AppSnapshot): void {
    const overlay = this.q('#overlay');
    const existing = overlay.querySelector<HTMLElement>('[data-testid="shared-approval"]');
    const pending = snapshot.incomingShares[0];
    if (!pending) {
      if (existing) this.closeModal(existing);
      return;
    }
    if (existing?.dataset.id === pending.id) return;
    if (existing) this.closeModal(existing);
    // A file-transfer or SAS dialog has priority. No automatic acceptance.
    if (snapshot.incoming || snapshot.verification || overlay.querySelector('.modal')) return;
    overlay.classList.add('active');
    const modal = el('div', 'modal modal-share');
    modal.dataset.testid = 'shared-approval';
    modal.dataset.id = pending.id;
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Incoming shared content');
    modal.append(el('h2', undefined, `Shared ${pending.kind} from ${pending.peerName}`));
    modal.append(el('p', 'muted small', 'Nothing is copied or opened until you approve, then choose an action.'));
    if (pending.url) modal.append(el('p', 'share-preview', pending.url));
    if (pending.title) modal.append(el('p', 'share-preview', pending.title));
    if (pending.text) modal.append(el('p', 'share-preview', pending.text.slice(0, 500)));
    const actions = el('div', 'modal-actions');
    const decline = el('button', 'btn btn-ghost', 'Decline');
    decline.type = 'button';
    decline.dataset.testid = 'decline-shared';
    decline.addEventListener('click', () => { this.app.approveSharedContent(pending.id, false); this.closeModal(modal); });
    const approve = el('button', 'btn btn-primary', 'Approve');
    approve.type = 'button';
    approve.dataset.testid = 'accept-shared';
    approve.addEventListener('click', () => { this.app.approveSharedContent(pending.id, true); this.closeModal(modal); });
    actions.append(decline, approve);
    modal.append(actions);
    overlay.append(modal);
    approve.focus();
  }

  private renderReceivedShares(snapshot: AppSnapshot): void {
    const section = this.q('#shared-section');
    section.hidden = snapshot.receivedShares.length === 0;
    const list = this.q('#shared-items');
    list.replaceChildren();
    for (const item of snapshot.receivedShares) {
      const row = el('li', 'shared-item');
      row.append(el('strong', undefined, item.title || (item.kind === 'clipboard' ? 'Text from ' + item.peerName : 'Link from ' + item.peerName)));
      row.append(el('p', 'muted tiny', item.url || item.text.slice(0, 220)));
      if (item.kind === 'session' && item.text) row.append(el('p', 'share-preview', item.text.slice(0, 220)));
      const actions = el('div', 'transfer-actions');
      const copy = el('button', 'btn btn-ghost btn-xs', 'Copy');
      copy.type = 'button';
      copy.dataset.testid = 'copy-shared';
      copy.addEventListener('click', () => void this.copyText(item.url || item.text));
      actions.append(copy);
      if (item.url) {
        const open = el('a', 'btn btn-ghost btn-xs', 'Open link');
        open.href = item.url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        open.dataset.testid = 'open-shared';
        actions.append(open);
      }
      row.append(actions);
      list.append(row);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Modals                                                            */
  /* ---------------------------------------------------------------- */

  private openOverlay(): HTMLElement {
    const overlay = this.q('#overlay');
    overlay.classList.add('active');
    if (!overlay.dataset.bound) {
      overlay.dataset.bound = '1';
      overlay.addEventListener('keydown', (event) => this.onOverlayKeydown(event as KeyboardEvent));
    }
    return overlay;
  }

  private onOverlayKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    // An incoming transfer needs an explicit decision, so Escape never dismisses it.
    if (this.q('#overlay').querySelector('[data-testid="incoming-modal"], [data-testid="shared-approval"]')) return;
    event.preventDefault();
    const open = this.qrScanModal ?? this.q('#overlay').querySelector<HTMLElement>('.modal:not([hidden])');
    if (!open) return;
    if (open === this.verifyModal) {
      const session = this.snapshot?.verification;
      if (session?.sas) this.deferredVerifications.add(`${session.deviceId}:${session.sas}`);
    }
    if (open === this.pairingModal) this.app.cancelPairing();
    this.closeModal(open);
    const focusTarget = this.root.querySelector<HTMLElement>(open.dataset.returnFocus ?? '#pair-btn');
    focusTarget?.focus();
  }

  /** Remove a single dialog, leaving any other open dialog untouched. */
  private closeModal(modal: HTMLElement | null): void {
    modal?.remove();
    if (modal === this.qrScanModal) {
      this.stopQrScanner();
      if (this.pairingModal) this.pairingModal.hidden = false;
    }
    if (modal === this.pairingModal) this.pairingModal = null;
    if (modal === this.verifyModal) {
      this.verifyModal = null;
      this.lastVerificationKey = '';
    }
    if (modal === this.settingsModal) this.settingsModal = null;
    const overlay = this.q('#overlay');
    if (!overlay.querySelector('.modal')) {
      overlay.classList.remove('active');
      overlay.replaceChildren();
      if (this.snapshot?.incomingShares.length) queueMicrotask(() => this.renderIncomingShare(this.app.snapshot()));
    }
  }

  private closeOverlay(): void {
    const overlay = this.q('#overlay');
    this.stopQrScanner();
    overlay.classList.remove('active');
    overlay.replaceChildren();
    this.pairingModal = null;
    this.verifyModal = null;
    this.settingsModal = null;
  }

  private openPairing(): void {
    const overlay = this.openOverlay();
    const modal = el('div', 'modal modal-pair');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Pair a device');
    modal.dataset.testid = 'pairing-modal';
    modal.innerHTML = `
      <button class="modal-close" aria-label="Close" type="button">×</button>
      <h2>Pair a device</h2>
      <div class="tabs" role="tablist">
        <button class="tab is-active" role="tab" type="button" data-pair-tab="code" data-testid="pair-tab-code">Same network</button>
        <button class="tab" role="tab" type="button" data-pair-tab="direct" data-testid="pair-tab-direct">Direct code</button>
      </div>
      <div class="pair-panel" data-panel="code">
        <div class="pair-intro">
          <span class="eyebrow">QUICK PAIRING · 01</span>
          <p class="pair-lead">Connect these two devices.</p>
          <p class="muted small">On the other device, tap Scan QR in Fluxa, or enter the short code while connected to the same server. Both devices must compare the verification code.</p>
        </div>
        <div class="pair-hero">
          <div class="pair-code" data-testid="pair-code">······</div>
          <div class="qr-wrap"><div class="qr" data-testid="pair-qr"></div><p class="muted tiny">Open the link shown after scanning</p></div>
        </div>
        <p class="muted small" id="qr-unavailable" hidden>No phone-reachable server address is available. Connect both devices to the same server in Settings or use Direct code.</p>
        <div class="join-card">
          <label for="join-code">Got a code from the other device?</label>
          <form class="join-form" id="join-form">
            <input id="join-code" class="code-input" inputmode="latin" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="Enter 6-character code" aria-label="6-character pairing code" data-testid="join-code"/>
            <button class="btn btn-primary" type="submit" data-testid="join-submit">Connect</button>
          </form>
          <button class="btn btn-ghost scan-launch" type="button" data-testid="scan-qr">Scan QR with this camera</button>
          <p class="muted tiny">No copying is needed when scanning opens the Fluxa link automatically.</p>
        </div>
        <p class="notice small" id="offline-notice" hidden data-testid="offline-notice">
          No signalling server is reachable from this device. Use <strong>Direct code</strong> instead — it needs no server at all.
        </p>
        <p class="error-text small" id="pair-error" hidden></p>
      </div>
      <div class="pair-panel" data-panel="direct" hidden>
        <div class="pair-intro">
          <span class="eyebrow">DIRECT PAIRING · NO SIGNAL SERVER</span>
          <p class="pair-lead">Connect privately, device to device.</p>
          <p class="muted small">This fallback uses a longer one-time ticket. Scan it with Fluxa's camera scanner or use Copy/Share. Both devices must exchange a ticket before the secure connection starts.</p>
        </div>
        <div class="direct-idle" data-testid="direct-idle">
          <button class="btn btn-primary" type="button" data-testid="direct-start">Create a code on this device</button>
          <div class="divider"><span>or paste a ticket from the other device</span></div>
          <textarea class="ticket-input" rows="3" placeholder="Paste the FLX1 ticket here" aria-label="Pairing ticket from the other device" data-testid="direct-join-input"></textarea>
          <div class="direct-actions">
            <button class="btn btn-primary" type="button" data-testid="direct-join-submit">Continue with ticket</button>
            <button class="btn btn-ghost" type="button" data-testid="scan-qr-direct">Scan QR</button>
          </div>
        </div>
        <div class="direct-ticket" data-testid="direct-ticket-view" hidden>
          <label class="muted tiny" data-testid="direct-ticket-label">Give this code to the other device</label>
          <textarea class="ticket-input" rows="3" readonly data-testid="direct-ticket"></textarea>
          <div class="direct-actions">
            <button class="btn btn-ghost btn-sm" type="button" data-testid="direct-copy">Copy code</button>
            <button class="btn btn-ghost btn-sm" type="button" data-testid="direct-share">Share…</button>
            <button class="btn btn-ghost btn-sm" type="button" data-testid="scan-qr-reply">Scan reply QR</button>
            <button class="btn btn-ghost btn-sm" type="button" data-testid="direct-cancel">Cancel</button>
          </div>
          <div class="qr-wrap" data-testid="direct-qr-wrap"><div class="qr" data-testid="direct-qr"></div><p class="muted tiny">Other device: scan this QR. Then scan their reply QR here.</p></div>
        </div>
        <div class="direct-reply" data-testid="direct-reply-view" hidden>
          <div class="divider"><span>paste the reply from the other device</span></div>
          <textarea class="ticket-input" rows="3" placeholder="FLX1z…" aria-label="Reply code from the other device" data-testid="direct-reply-input"></textarea>
          <button class="btn btn-primary" type="button" data-testid="direct-complete">Connect</button>
        </div>
        <p class="error-text small" data-testid="direct-error" hidden></p>
      </div>`;
    modal.querySelector('.modal-close')!.addEventListener('click', () => {
      this.app.cancelPairing();
      this.app.cancelDirect();
      this.closeOverlay();
    });
    const joinInput = modal.querySelector<HTMLInputElement>('#join-code')!;
    joinInput.addEventListener('input', () => {
      joinInput.value = joinInput.value.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
      modal.querySelector<HTMLElement>('#pair-error')!.hidden = true;
    });
    const form = modal.querySelector<HTMLFormElement>('#join-form')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = modal.querySelector<HTMLInputElement>('#join-code')!;
      input.value = input.value.replace(/[^a-z0-9]/gi, '').slice(0, 6).toUpperCase();
      const ok = this.app.joinWithCode(input.value);
      if (!ok) {
        const err = modal.querySelector<HTMLElement>('#pair-error')!;
        err.textContent = 'Enter the 6-character code shown on the other device';
        err.hidden = false;
        return;
      }
      this.closeModal(modal);
    });

    // Tabs
    const selectTab = (name: string) => {
      for (const tab of modal.querySelectorAll<HTMLElement>('[data-pair-tab]')) {
        tab.classList.toggle('is-active', tab.dataset.pairTab === name);
      }
      for (const panel of modal.querySelectorAll<HTMLElement>('[data-panel]')) {
        panel.hidden = panel.dataset.panel !== name;
      }
      if (name === 'code') this.app.requestPairingCode();
      this.renderDirectPanel(this.snapshot!);
    };
    for (const tab of modal.querySelectorAll<HTMLElement>('[data-pair-tab]')) {
      tab.addEventListener('click', () => selectTab(tab.dataset.pairTab!));
    }

    modal.querySelector('[data-testid="scan-qr"]')!.addEventListener('click', () => void this.startQrScanner());
    modal.querySelector('[data-testid="scan-qr-direct"]')!.addEventListener('click', () => void this.startQrScanner());
    modal.querySelector('[data-testid="scan-qr-reply"]')!.addEventListener('click', () => void this.startQrScanner());
    modal.querySelector('[data-testid="direct-start"]')!.addEventListener('click', () => {
      void this.app.startDirectPairing();
    });
    modal.querySelector('[data-testid="direct-join-submit"]')!.addEventListener('click', () => {
      const input = modal.querySelector<HTMLTextAreaElement>('[data-testid="direct-join-input"]')!;
      void this.app.joinDirectPairing(input.value);
    });
    modal.querySelector('[data-testid="direct-complete"]')!.addEventListener('click', () => {
      const input = modal.querySelector<HTMLTextAreaElement>('[data-testid="direct-reply-input"]')!;
      void this.app.completeDirectPairing(input.value);
    });
    modal.querySelector('[data-testid="direct-copy"]')!.addEventListener('click', () => {
      const value = modal.querySelector<HTMLTextAreaElement>('[data-testid="direct-ticket"]')?.value ?? '';
      void this.copyText(value);
    });
    modal.querySelector('[data-testid="direct-share"]')!.addEventListener('click', () => {
      const value = modal.querySelector<HTMLTextAreaElement>('[data-testid="direct-ticket"]')?.value ?? '';
      void this.shareText(value);
    });
    modal.querySelector('[data-testid="direct-cancel"]')!.addEventListener('click', () => this.app.cancelDirect());

    overlay.append(modal);
    this.pairingModal = modal;
    this.autoSwitchedDirect = false;
    // If there is no signalling server, open straight into the mode that works.
    if (this.snapshot?.status === 'offline') selectTab('direct');
    else this.app.requestPairingCode();
    this.syncPairingModal(this.snapshot!);
  }

  /** Read a camera QR locally. BarcodeDetector is an optimization, not a requirement. */
  private async startQrScanner(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.app.toast('info', 'Camera access needs HTTPS or localhost. Use a phone camera to open the pairing link, or enter the code manually.');
      return;
    }
    if (this.qrScanModal) return;
    this.qrScanReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = this.openOverlay();
    const modal = el('div', 'modal modal-qr-scanner');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Scan a Fluxa pairing QR code');
    modal.dataset.testid = 'qr-scanner-modal';
    modal.innerHTML = `
      <button class="modal-close" type="button" aria-label="Close QR scanner">×</button>
      <span class="eyebrow">FLUXA SCANNER</span>
      <h2>Point at the other screen</h2>
      <p class="muted small">Keep the whole QR inside the frame. Fluxa will read it on this device.</p>
      <div class="scanner-frame"><video autoplay muted playsinline data-testid="qr-scanner-video"></video>
        <span class="scanner-corner tl"></span><span class="scanner-corner tr"></span>
        <span class="scanner-corner bl"></span><span class="scanner-corner br"></span>
      </div>
      <p class="scanner-status muted small" data-testid="qr-scanner-status" aria-live="polite">Starting camera…</p>
      <button class="btn btn-ghost" type="button" data-testid="qr-scanner-cancel">Cancel scan</button>`;
    if (this.pairingModal) this.pairingModal.hidden = true;
    overlay.append(modal);
    this.qrScanModal = modal;
    const close = () => this.closeModal(modal);
    modal.querySelector('.modal-close')!.addEventListener('click', close);
    modal.querySelector('[data-testid="qr-scanner-cancel"]')!.addEventListener('click', close);
    modal.querySelector<HTMLButtonElement>('[data-testid="qr-scanner-cancel"]')!.focus();
    const video = modal.querySelector<HTMLVideoElement>('video')!;
    const status = modal.querySelector<HTMLElement>('[data-testid="qr-scanner-status"]')!;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (this.qrScanModal !== modal) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.qrScanStream = stream;
      video.srcObject = stream;
      await video.play();
      // Firefox/Safari and many mobile WebViews do not expose BarcodeDetector.
      type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };
      const DetectorCtor = (window as unknown as {
        BarcodeDetector?: new(options: { formats: string[] }) => Detector;
      }).BarcodeDetector;
      let detector: Detector | null = null;
      try { if (DetectorCtor) detector = new DetectorCtor({ formats: ['qr_code'] }); } catch { /* use local decoder */ }
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context && !detector) throw new Error('Cannot read camera frames on this device');
      status.textContent = 'Camera ready — searching for a Fluxa QR…';
      let lastScan = 0;
      let lastValue = '';
      const scan = async (now: number): Promise<void> => {
        if (this.qrScanModal !== modal) return;
        if (now - lastScan >= 140 && video.readyState >= 2) {
          lastScan = now;
          let value: string | null = null;
          if (detector) {
            try { value = (await detector.detect(video))[0]?.rawValue ?? null; }
            catch { detector = null; /* decode locally if the native API fails */ }
          }
          if (this.qrScanModal !== modal) return;
          if (!value && context && video.videoWidth && video.videoHeight) {
            const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
            const width = Math.max(1, Math.round(video.videoWidth * scale));
            const height = Math.max(1, Math.round(video.videoHeight * scale));
            if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
            context.drawImage(video, 0, 0, width, height);
            const pixels = context.getImageData(0, 0, width, height);
            // jsqr's CommonJS declaration is a namespace under NodeNext, but its runtime default is callable.
            const decode = jsQR as unknown as (data: Uint8ClampedArray, w: number, h: number,
              options: { inversionAttempts: 'attemptBoth' }) => { data: string } | null;
            value = decode(pixels.data, width, height, { inversionAttempts: 'attemptBoth' })?.data ?? null;
          }
          if (value && value !== lastValue) {
            lastValue = value;
            const accepted = await this.consumeScannedQr(value);
            if (this.qrScanModal !== modal) return;
            if (accepted) { this.closeModal(modal); return; }
            status.textContent = 'Not a valid Fluxa code for this connection. Try another QR, or enter it manually.';
          }
        }
        if (this.qrScanModal === modal) this.qrScanFrame = requestAnimationFrame((time) => void scan(time));
      };
      this.qrScanFrame = requestAnimationFrame((time) => void scan(time));
    } catch (err) {
      if (this.qrScanModal !== modal) return;
      this.qrScanStream?.getTracks().forEach((track) => track.stop());
      this.qrScanStream = null;
      status.textContent = 'Could not start this camera. Check browser permission, then enter the code manually or use Copy/Share.';
      this.app.toast('error', `QR camera unavailable: ${(err as Error).message}`);
    }
  }

  private stopQrScanner(): void {
    if (this.qrScanFrame !== null) cancelAnimationFrame(this.qrScanFrame);
    this.qrScanFrame = null;
    this.qrScanStream?.getTracks().forEach((track) => track.stop());
    this.qrScanStream = null;
    this.qrScanModal = null;
    const focus = this.qrScanReturnFocus;
    this.qrScanReturnFocus = null;
    if (focus?.isConnected) queueMicrotask(() => focus.focus());
  }

  /** Never follow arbitrary QR URLs. Interpret only a pairing code or full direct ticket. */
  private async consumeScannedQr(rawValue: string): Promise<boolean> {
    const value = rawValue.trim();
    if (value.length > 8000) return false;
    let code = value;
    let isLink = false;
    try {
      const url = new URL(value);
      if (['http:', 'https:', 'fluxa:'].includes(url.protocol)) {
        code = url.searchParams.get('pair') ?? url.searchParams.get('code') ?? value;
        isLink = true;
      }
    } catch { /* plain code or ticket */ }
    if (/^[a-z0-9]{6}$/i.test(code)) {
      const input = this.pairingModal?.querySelector<HTMLInputElement>('#join-code');
      if (input) input.value = code.toUpperCase();
      const ok = isLink ? this.app.joinPairingLink(value) : this.app.joinWithCode(code.toUpperCase());
      if (ok && this.pairingModal) this.closeModal(this.pairingModal);
      return ok;
    }
    if (value.replace(/\s+/g, '').startsWith('FLX1')) {
      const direct = this.snapshot?.direct;
      if (direct?.role === 'host' && direct.step === 'offer') {
        const reply = this.pairingModal?.querySelector<HTMLTextAreaElement>('[data-testid="direct-reply-input"]');
        if (reply) reply.value = value;
        return this.app.completeDirectPairing(value);
      }
      this.pairingModal?.querySelector<HTMLElement>('[data-pair-tab="direct"]')?.click();
      const input = this.pairingModal?.querySelector<HTMLTextAreaElement>('[data-testid="direct-join-input"]');
      if (input) input.value = value;
      return this.app.joinDirectPairing(value);
    }
    return false;
  }

  /** Copies text, falling back to the old execCommand path inside sandboxed WebViews. */
  private async copyText(value: string): Promise<void> {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      this.app.toast('success', 'Code copied');
      return;
    } catch {
      /* clipboard permission denied — fall through to selection */
    }
    const area = el('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    try {
      document.execCommand('copy');
      this.app.toast('success', 'Code copied');
    } catch {
      this.app.toast('info', 'Select the code and copy it manually');
    }
    area.remove();
  }

  /** Hands the ticket to the OS share sheet when the platform provides one. */
  private async shareText(value: string): Promise<void> {
    if (!value) return;
    const nav = navigator as Navigator & { share?: (data: { text: string; title?: string }) => Promise<void> };
    if (typeof nav.share === 'function') {
      try {
        await nav.share({ title: 'Fluxa pairing code', text: value });
        return;
      } catch {
        /* user dismissed the sheet */
        return;
      }
    }
    await this.copyText(value);
  }

  /** Renders the direct-pairing panel from app state. Called on every snapshot. */
  private renderDirectPanel(snapshot: AppSnapshot): void {
    const modal = this.pairingModal;
    if (!modal) return;
    const idle = modal.querySelector<HTMLElement>('[data-testid="direct-idle"]')!;
    const ticketView = modal.querySelector<HTMLElement>('[data-testid="direct-ticket-view"]')!;
    const replyView = modal.querySelector<HTMLElement>('[data-testid="direct-reply-view"]')!;
    const errorNode = modal.querySelector<HTMLElement>('[data-testid="direct-error"]')!;
    const ticketArea = modal.querySelector<HTMLTextAreaElement>('[data-testid="direct-ticket"]')!;
    const label = modal.querySelector<HTMLElement>('[data-testid="direct-ticket-label"]')!;
    const qrWrap = modal.querySelector<HTMLElement>('[data-testid="direct-qr-wrap"]')!;
    const qrNode = modal.querySelector<HTMLElement>('[data-testid="direct-qr"]')!;
    const direct = snapshot.direct;

    const offline = snapshot.status === 'offline';
    const offlineNotice = modal.querySelector<HTMLElement>('#offline-notice')!;
    offlineNotice.hidden = !offline;

    if (direct && (direct.step === 'connecting' || snapshot.sessions.some((s) => s.state === 'awaiting-verification' || s.state === 'connected'))) {
      // The handshake (or a live session) is up: hand over to the normal
      // verification / device UI instead of leaving this dialog in the way.
      this.closeModal(modal);
      this.app.finishDirectPairing();
      return;
    }

    if (!direct) {
      idle.hidden = false;
      ticketView.hidden = true;
      replyView.hidden = true;
      errorNode.hidden = true;
      qrWrap.hidden = true;
      return;
    }
    idle.hidden = true;
    errorNode.hidden = !direct.error;
    if (direct.error) errorNode.textContent = direct.error;

    if (direct.ticket) {
      ticketView.hidden = false;
      // Group characters for easier reading aloud or entering on another device.
      // decodeTicket deliberately ignores whitespace, so pasted grouped codes work too.
      ticketArea.value = direct.ticket.replace(/(.{8})/g, '$1 ').trim();
      label.textContent =
        direct.role === 'host'
          ? 'Step 1 — scan the QR or enter the grouped code on the other device'
          : 'Step 2 — scan the QR or enter the grouped reply code on the other device';
      // A pairing ticket carries a full SDP and is far beyond what a QR code can
      // hold; only draw one when it genuinely fits, otherwise offer copy/share.
      const qrFits = direct.ticket.length <= 1800;
      qrWrap.hidden = !qrFits;
      if (qrFits && qrNode.dataset.code !== direct.ticket) {
        qrNode.dataset.code = direct.ticket;
        try {
          qrNode.replaceChildren(this.renderQr(direct.ticket));
        } catch {
          qrWrap.hidden = true;
        }
      }
    } else {
      ticketView.hidden = true;
      qrWrap.hidden = true;
    }

    const hostWaiting = direct.role === 'host' && direct.step === 'offer' && Boolean(direct.ticket);
    replyView.hidden = !hostWaiting;
  }

  /**
   * Moves the pairing dialog to the Direct code tab the first time we learn the
   * server is unreachable. It only ever does this once per dialog: after that the
   * user can look at the other tab without being bounced back.
   */
  private switchToDirectTab(): void {
    const modal = this.pairingModal;
    if (!modal || this.snapshot?.status !== 'offline' || this.autoSwitchedDirect) return;
    this.autoSwitchedDirect = true;
    if (this.snapshot?.direct) return;
    const directTab = modal.querySelector<HTMLElement>('[data-pair-tab="direct"]');
    if (directTab && !directTab.classList.contains('is-active')) directTab.click();
  }

  private syncPairingModal(snapshot: AppSnapshot): void {
    if (!this.pairingModal) {
      this.sawPairingCode = false;
      return;
    }
    const codeNode = this.pairingModal.querySelector<HTMLElement>('[data-testid="pair-code"]');
    const qrNode = this.pairingModal.querySelector<HTMLElement>('.qr');
    const qrWrap = this.pairingModal.querySelector<HTMLElement>('.qr-wrap');
    if (!codeNode || !qrNode) return;
    const pairing = snapshot.pairing;
    if (!pairing) {
      codeNode.textContent = '------';
      codeNode.classList.add('is-pending');
      qrNode.replaceChildren();
      if (qrWrap) qrWrap.hidden = !snapshot.status || snapshot.status !== 'online';
      // The code disappeared after being issued: the peer claimed it (or it was
      // cancelled), so this dialog has done its job. Remove only this dialog —
      // another one (e.g. verification) may already be on screen.
      if (this.sawPairingCode) this.closeModal(this.pairingModal);
      // The server may have been unreachable from the start or only gave up a
      // moment ago; either way, switch to the mode that needs no server.
      this.switchToDirectTab();
      return;
    }
    this.sawPairingCode = true;
    codeNode.classList.remove('is-pending');
    const payload = pairing.link ?? (snapshot.desktop ? null : `${location.origin}/?pair=${pairing.code}`);
    if (qrWrap) qrWrap.hidden = !payload;
    const unavailable = this.pairingModal.querySelector<HTMLElement>('#qr-unavailable');
    if (unavailable) unavailable.hidden = Boolean(payload);
    codeNode.textContent = pairing.code.split('').join(' ');
    if (payload && qrNode.dataset.payload !== payload) {
      qrNode.dataset.payload = payload;
      qrNode.replaceChildren(this.renderQr(payload));
      const hint = qrWrap?.querySelector('p');
      if (hint) hint.textContent = payload.startsWith('fluxa:')
        ? 'On the other device, open Fluxa and tap Scan QR. Both people still verify the code.'
        : 'Open the link on the other device, then compare the verification codes.';
    }
  }

  /**
   * Render a QR code with the required four-module quiet zone. The explicit
   * payload ceiling avoids allocating an enormous canvas for malformed input;
   * callers keep Copy/Share available whenever QR rendering is unavailable.
   */
  private renderQr(text: string): HTMLElement {
    try {
      if (!text || text.length > 1800) {
        return el('div', 'qr-fallback', 'QR unavailable — use Copy or Share');
      }
      const qr = qrcode(0, 'L');
      qr.addData(text);
      qr.make();
      const count = qr.getModuleCount();
      const quietZone = 4;
      // Keep a useful pixel size for both short codes and longer direct tickets.
      const cell = Math.max(2, Math.min(6, Math.floor(600 / (count + quietZone * 2))));
      const side = (count + quietZone * 2) * cell;
      const canvas = document.createElement('canvas');
      canvas.width = side;
      canvas.height = side;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', 'QR code for Fluxa device pairing');
      canvas.dataset.testid = 'rendered-pairing-qr';
      const ctx = canvas.getContext('2d');
      if (!ctx) return el('div', 'qr-fallback', 'QR unavailable — use Copy or Share');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, side, side);
      ctx.fillStyle = '#08090d';
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (qr.isDark(row, col)) {
            ctx.fillRect((col + quietZone) * cell, (row + quietZone) * cell, cell, cell);
          }
        }
      }
      return canvas;
    } catch {
      return el('div', 'qr-fallback', 'QR unavailable — use Copy or Share');
    }
  }

  private openVerification(session: SessionView): void {
    const overlay = this.openOverlay();
    if (session.sas) this.deferredVerifications.delete(`${session.deviceId}:${session.sas}`);
    const modal = el('div', 'modal modal-verify');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Verify device');
    modal.dataset.testid = 'verify-modal';
    const digits = (session.sas ?? '------').split('');
    modal.innerHTML = `
      <button class="modal-close" aria-label="Verify later" type="button" data-testid="verify-later">×</button>
      <h2>Verify ${esc(session.name)}</h2>
      <p class="muted small">Both screens must show the same code. Compare them in person or over a call you trust — never over the same chat you are using to pair.</p>
      <div class="sas" data-testid="sas-code">${digits
        .map((d, i) => `<span class="sas-digit">${esc(d)}</span>${i === 2 ? '<span class="sas-gap"></span>' : ''}`)
        .join('')}</div>
      <p class="muted tiny">Derived from both device keys and the DTLS fingerprints of this connection.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="verify-no" type="button" data-testid="verify-mismatch">They don't match</button>
        <button class="btn btn-primary" id="verify-yes" type="button" data-testid="verify-match">Codes match</button>
      </div>`;
    modal.querySelector('[data-testid="verify-later"]')!.addEventListener('click', () => {
      // Deferring keeps the session alive but nothing can be sent until the
      // codes are compared — the device list offers "Verify" again.
      if (session.sas) this.deferredVerifications.add(`${session.deviceId}:${session.sas}`);
      this.closeModal(modal);
    });
    modal.querySelector('#verify-yes')!.addEventListener('click', () => {
      this.app.confirmVerification(session.deviceId, true);
      this.closeModal(modal);
    });
    modal.querySelector('#verify-no')!.addEventListener('click', () => {
      this.app.confirmVerification(session.deviceId, false);
      this.closeModal(modal);
    });
    overlay.append(modal);
    this.verifyModal = modal;
    modal.querySelector<HTMLButtonElement>('#verify-yes')!.focus();
  }

  private renderVerification(snapshot: AppSnapshot): void {
    const pending = snapshot.verification;
    if (!pending) {
      if (this.verifyModal) this.closeModal(this.verifyModal);
      this.lastVerificationKey = '';
      return;
    }
    const key = `${pending.deviceId}:${pending.sas}`;
    if (this.verifyModal && this.lastVerificationKey === key) return;
    if (this.deferredVerifications.has(key)) return;
    this.lastVerificationKey = key;
    this.openVerification(pending);
  }

  private renderIncoming(snapshot: AppSnapshot): void {
    const overlay = this.q('#overlay');
    const existing = overlay.querySelector('[data-testid="incoming-modal"]');
    if (!snapshot.incoming) {
      existing?.remove();
      if (!overlay.querySelector('.modal')) overlay.classList.remove('active');
      return;
    }
    const transfer = snapshot.incoming;
    if (existing) {
      const stats = existing.querySelector('[data-testid="incoming-size"]');
      if (stats) stats.textContent = `${formatBytes(transfer.totalBytes)} · ${transfer.files.length} file${transfer.files.length === 1 ? '' : 's'}`;
      return;
    }
    overlay.classList.add('active');
    const modal = el('div', 'modal modal-incoming');
    modal.dataset.testid = 'incoming-modal';
    modal.setAttribute('role', 'alertdialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Incoming transfer');

    const head = el('div', 'incoming-head');
    const orb = el('div', 'incoming-orb');
    orb.setAttribute('aria-hidden', 'true');
    const headText = el('div');
    headText.append(el('p', 'eyebrow', 'Incoming transfer'));
    headText.append(el('h2', undefined, transfer.peerName));
    headText.append(el('p', 'muted small', `${formatBytes(transfer.totalBytes)} · ${transfer.files.length} file${transfer.files.length === 1 ? '' : 's'}`));
    headText.querySelector('.muted')!.setAttribute('data-testid', 'incoming-size');
    head.append(orb, headText);

    const list = el('ul', 'incoming-files');
    list.dataset.testid = 'incoming-files';
    for (const file of transfer.files.slice(0, 6)) {
      const li = el('li');
      li.append(el('span', 'file-name', file.relPath), el('span', 'muted small', formatBytes(file.size)));
      list.append(li);
    }
    if (transfer.files.length > 6) list.append(el('li', 'muted small', `+${transfer.files.length - 6} more`));

    const actions = el('div', 'modal-actions');
    const decline = el('button', 'btn btn-ghost', 'Decline');
    decline.type = 'button';
    decline.dataset.testid = 'decline-transfer';
    decline.addEventListener('click', () => {
      this.app.declineTransfer(transfer.id);
      modal.remove();
      if (!overlay.querySelector('.modal')) overlay.classList.remove('active');
    });
    const accept = el('button', 'btn btn-primary', 'Accept');
    accept.type = 'button';
    accept.dataset.testid = 'accept-transfer';
    accept.addEventListener('click', () => {
      this.app.acceptTransfer(transfer.id);
      modal.remove();
      if (!overlay.querySelector('.modal')) overlay.classList.remove('active');
    });
    actions.append(decline, accept);
    modal.append(head, list, actions);
    overlay.append(modal);
    accept.focus();
  }

  private openSettings(): void {
    const overlay = this.openOverlay();
    const identity = this.snapshot?.identity;
    const modal = el('div', 'modal modal-settings');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Device settings');
    modal.dataset.testid = 'settings-modal';
    modal.innerHTML = `
      <button class="modal-close" aria-label="Close" type="button">×</button>
      <h2>This device</h2>
      <form class="settings-form" id="name-form">
        <label for="device-name">Device name</label>
        <div class="inline">
          <input id="device-name" maxlength="48" value="${esc(identity?.name ?? '')}" data-testid="device-name-input"/>
          <button class="btn btn-ghost" type="submit" data-testid="save-name">Save</button>
        </div>
      </form>
      <div class="kv"><span>Platform</span><strong>${esc(identity?.platform ?? '')}</strong></div>
      <div class="kv"><span>Device ID</span><code data-testid="device-id">${esc(identity?.deviceId.slice(0, 22) ?? '')}…</code></div>
      <div class="kv column"><span>Identity fingerprint (SHA-256)</span><code class="fingerprint">${esc(identity?.fingerprint ?? '')}</code></div>
      <p class="muted tiny">Paired devices pin this key. If the key ever changes, the pairing is refused — clear site data only if you intentionally reinstall Fluxa.</p>
      <form class="settings-form" id="signal-form">
        <label for="signal-url">Signalling server</label>
        <div class="inline">
          <input id="signal-url" placeholder="192.168.1.20:8787" data-testid="signal-url-input" value="${esc(
            (this.snapshot?.signalUrl ?? '').replace(/^wss?:\/\//, '').replace(/\/ws$/, ''),
          )}"/>
          <button class="btn btn-ghost" type="submit" data-testid="save-signal-url">Save</button>
        </div>
        <p class="muted tiny">Both devices must reach the same pairing server. A phone cannot reach your computer's 127.0.0.1; enter a Wi-Fi/LAN address or a public wss:// server.</p>
        ${this.snapshot?.desktop ? `<p class="muted tiny">This computer's LAN address${this.snapshot.desktop.lanUrls.length === 1 ? '' : 'es'}: ${this.snapshot.desktop.lanUrls.length
          ? this.snapshot.desktop.lanUrls.map((url) => `<code>${esc(url)}</code>`).join(' · ')
          : 'unavailable (broker is not listening on your LAN)'}</p>` : ''}
      </form>
      <form class="settings-form" id="turn-access-form">
        <label for="turn-access-input">Remote relay access key</label>
        <div class="inline">
          <input id="turn-access-input" type="password" autocomplete="off" maxlength="128"
            placeholder="${this.app.hasTurnAccessKey() ? 'Key saved on this device' : 'Paste the operator-issued key'}" data-testid="turn-access-input"/>
          <button class="btn btn-ghost" type="submit" data-testid="save-turn-access">Save key</button>
          <button class="btn btn-ghost" type="button" id="clear-turn-access">Clear</button>
        </div>
        <p class="muted tiny">Only sent over wss:// to a server that requires it. Never place this key in a pairing link; re-pair after changing it.</p>
      </form>
      <label class="switch-row">
        <input type="checkbox" id="reduce-motion" data-testid="reduce-motion" ${document.documentElement.dataset.reducedMotion === 'true' ? 'checked' : ''}/>
        <span>Reduce motion (disables ambient and progress animations)</span>
      </label>
      <div class="modal-actions column-actions">
        <button class="btn btn-ghost" id="clear-received" type="button">Delete received and partial files on this device</button>
        <button class="btn btn-ghost" id="clear-history" type="button">Clear transfer history</button>
        <p class="muted tiny">Transfers are only resumable while private storage persists. Restart requires re-pairing, approving again, and reselecting the original source files. Clearing files removes recovery data.</p>
      </div>`;
    modal.querySelector('.modal-close')!.addEventListener('click', () => this.closeOverlay());
    const form = modal.querySelector<HTMLFormElement>('#name-form')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = modal.querySelector<HTMLInputElement>('#device-name')!;
      void this.app.rename(input.value);
      this.closeOverlay();
    });
    modal.querySelector('#clear-received')!.addEventListener('click', () => {
      if (confirm('Delete all received and partial files from this device? Interrupted transfers cannot resume.')) {
        void this.app.clearReceivedStorage();
        this.closeOverlay();
      }
    });
    modal.querySelector('#clear-history')!.addEventListener('click', () => {
      if (confirm('Clear the transfer history on this device?')) {
        void this.app.clearTransferHistory();
        this.closeOverlay();
      }
    });
    const signalForm = modal.querySelector<HTMLFormElement>('#signal-form')!;
    signalForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = modal.querySelector<HTMLInputElement>('#signal-url')!;
      if (this.app.setSignalUrl(input.value)) this.closeOverlay();
    });

    modal.querySelector<HTMLFormElement>('#turn-access-form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      const input = modal.querySelector<HTMLInputElement>('#turn-access-input')!;
      if (!input.value) { this.app.toast('error', 'Paste a key, or use Clear to remove the existing key'); return; }
      if (this.app.setTurnAccessKey(input.value)) this.closeOverlay();
    });
    modal.querySelector('#clear-turn-access')!.addEventListener('click', () => {
      if (this.app.setTurnAccessKey('')) this.closeOverlay();
    });

    const reduceMotion = modal.querySelector<HTMLInputElement>('#reduce-motion')!;
    reduceMotion.addEventListener('change', () => {
      document.documentElement.dataset.reducedMotion = reduceMotion.checked ? 'true' : 'false';
      try {
        localStorage.setItem('fluxa:reduced-motion', reduceMotion.checked ? 'true' : 'false');
      } catch {
        /* storage may be unavailable; the setting simply does not persist */
      }
    });
    overlay.append(modal);
    this.settingsModal = modal;
  }

  private renderToasts(snapshot: AppSnapshot): void {
    const stack = this.q('#toasts');
    stack.replaceChildren();
    for (const toast of snapshot.toasts) {
      const node = el('div', `toast ${toast.kind}`);
      node.dataset.testid = 'toast';
      node.append(el('span', undefined, toast.message));
      const close = el('button', 'toast-close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Dismiss');
      close.addEventListener('click', () => this.app.dismissToast(toast.id));
      node.append(close);
      stack.append(node);
    }
    const sr = this.q('#sr-status');
    sr.textContent = snapshot.transfers[0]
      ? `${snapshot.transfers[0].files.length} file transfer ${snapshot.transfers[0].state}`
      : '';
  }
}

/**
 * Fluxa UI — a projection of AppSnapshot.
 *
 * All text that originates from another device goes through textContent or the
 * `esc()` helper: a peer must never be able to inject markup into this page.
 */
import qrcode from 'qrcode-generator';
import { formatBytes, formatDuration } from '../shared/protocol.js';
import type { AppSnapshot, FluxaApp, SessionView, TransferView } from './app.js';

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
}

export class FluxaUI {
  private selectedDeviceId: string | null = null;
  private snapshot: AppSnapshot | null = null;
  private lastVerificationKey = '';
  private deferredVerifications = new Set<string>();
  private pairingModal: HTMLElement | null = null;
  private sawPairingCode = false;
  private verifyModal: HTMLElement | null = null;
  private settingsModal: HTMLElement | null = null;
  private transferRows = new Map<string, TransferRow>();
  private fileInput: HTMLInputElement;
  private folderInput: HTMLInputElement;

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
      <ul class="transfer-list" id="transfer-list" data-testid="transfer-list"></ul>`;

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

    this.root.append(header, main, overlay, toasts, sr);

    this.q('#pair-btn').addEventListener('click', () => this.openPairing());
    this.q('#this-device').addEventListener('click', () => this.openSettings());
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
    this.renderStage(snapshot);
    this.renderTransfers(snapshot);
    this.syncPairingModal(snapshot);
    this.renderIncoming(snapshot);
    this.renderVerification(snapshot);
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
            session.connection.direct ? `Direct ${session.connection.type}` : 'Relayed',
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

  private selectedSession(snapshot: AppSnapshot): SessionView | null {
    if (!this.selectedDeviceId) return null;
    return snapshot.sessions.find((s) => s.deviceId === this.selectedDeviceId) ?? null;
  }

  private renderStage(snapshot: AppSnapshot): void {
    const stage = this.q('#stage');
    stage.replaceChildren();
    const session = this.selectedSession(snapshot);

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
    metaLine.textContent = `${session.platform} · ${sessionLabel[session.state] ?? session.state}${
      session.connection ? (session.connection.direct ? ' · direct path' : ' · relayed path') : ''
    }`;
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
    const pick = el('button', 'btn btn-primary', 'Choose files');
    pick.type = 'button';
    pick.dataset.testid = 'choose-files';
    pick.addEventListener('click', () => this.fileInput.click());
    const folder = el('button', 'btn btn-ghost', 'Choose folder');
    folder.type = 'button';
    folder.dataset.testid = 'choose-folder';
    folder.addEventListener('click', () => this.folderInput.click());
    buttons.append(pick, folder);

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
    if (!list) return;
    this.send(Array.from(list));
    this.fileInput.value = '';
    this.folderInput.value = '';
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
    actions.append(cancel, save);

    node.append(head, bar, stats, error, actions);
    return { node, primary, detail, stateTag, bar, fill, stats, error, actions, cancel, save };
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
    this.toggleAction(row.actions, row.cancel, cancellable);
    this.toggleAction(row.actions, row.save, saveable);
    row.actions.hidden = !cancellable && !saveable;
  }

  /* ---------------------------------------------------------------- */
  /* Modals                                                            */
  /* ---------------------------------------------------------------- */

  private openOverlay(): HTMLElement {
    const overlay = this.q('#overlay');
    overlay.classList.add('active');
    return overlay;
  }

  /** Remove a single dialog, leaving any other open dialog untouched. */
  private closeModal(modal: HTMLElement | null): void {
    modal?.remove();
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
    }
  }

  private closeOverlay(): void {
    const overlay = this.q('#overlay');
    overlay.classList.remove('active');
    overlay.replaceChildren();
    this.pairingModal = null;
    this.verifyModal = null;
    this.settingsModal = null;
  }

  private openPairing(): void {
    const overlay = this.openOverlay();
    const modal = el('div', 'modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Pair a device');
    modal.dataset.testid = 'pairing-modal';
    modal.innerHTML = `
      <button class="modal-close" aria-label="Close" type="button">×</button>
      <h2>Pair a device</h2>
      <p class="muted small">Open Fluxa on the other device, choose <em>Pair device</em> and enter this code. It expires in two minutes.</p>
      <div class="pair-code" data-testid="pair-code">······</div>
      <div class="qr-wrap"><div class="qr" data-testid="pair-qr"></div><p class="muted tiny">Scan to open a pairing link</p></div>
      <div class="divider"><span>or join with a code</span></div>
      <form class="join-form" id="join-form">
        <input id="join-code" class="code-input" inputmode="latin" autocomplete="off" spellcheck="false" maxlength="6" placeholder="ABC123" aria-label="Pairing code" data-testid="join-code"/>
        <button class="btn btn-primary" type="submit" data-testid="join-submit">Join</button>
      </form>
      <p class="error-text small" id="pair-error" hidden></p>`;
    modal.querySelector('.modal-close')!.addEventListener('click', () => {
      this.app.cancelPairing();
      this.closeOverlay();
    });
    const form = modal.querySelector<HTMLFormElement>('#join-form')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = modal.querySelector<HTMLInputElement>('#join-code')!;
      const ok = this.app.joinWithCode(input.value);
      if (!ok) {
        const err = modal.querySelector<HTMLElement>('#pair-error')!;
        err.textContent = 'Enter the 6-character code shown on the other device';
        err.hidden = false;
        return;
      }
      // The claim is in flight; failures surface as a toast so the next dialog
      // (verification) is never blocked by a stale overlay.
      this.closeModal(modal);
    });
    overlay.append(modal);
    this.pairingModal = modal;
    this.app.requestPairingCode();
    this.syncPairingModal(this.snapshot!);
  }

  private syncPairingModal(snapshot: AppSnapshot): void {
    if (!this.pairingModal) {
      this.sawPairingCode = false;
      return;
    }
    const codeNode = this.pairingModal.querySelector<HTMLElement>('[data-testid="pair-code"]');
    const qrNode = this.pairingModal.querySelector<HTMLElement>('.qr');
    if (!codeNode || !qrNode) return;
    const pairing = snapshot.pairing;
    if (!pairing) {
      codeNode.textContent = '······';
      qrNode.replaceChildren();
      // The code disappeared after being issued: the peer claimed it (or it was
      // cancelled), so this dialog has done its job. Remove only this dialog —
      // another one (e.g. verification) may already be on screen.
      if (this.sawPairingCode) this.closeModal(this.pairingModal);
      return;
    }
    this.sawPairingCode = true;
    codeNode.textContent = pairing.code.split('').join(' ');
    if (!qrNode.dataset.code || qrNode.dataset.code !== pairing.code) {
      qrNode.dataset.code = pairing.code;
      qrNode.replaceChildren(this.renderQr(pairing.link ?? `${location.origin}/?pair=${pairing.code}`));
    }
  }

  private renderQr(text: string): HTMLElement {
    const size = 29;
    try {
      const qr = qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      const count = qr.getModuleCount();
      const cell = Math.floor(size * 3);
      const canvas = document.createElement('canvas');
      canvas.width = count * cell;
      canvas.height = count * cell;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#08090d';
      for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
          if (qr.isDark(row, col)) ctx.fillRect(col * cell, row * cell, cell, cell);
        }
      }
      return canvas;
    } catch {
      return el('div', 'qr-fallback', 'QR unavailable');
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
      li.append(el('span', 'file-name', file.name), el('span', 'muted small', formatBytes(file.size)));
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
      <div class="modal-actions column-actions">
        <button class="btn btn-ghost" id="clear-received" type="button">Clear received files stored by this browser</button>
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
      void this.app.clearReceivedStorage();
      this.closeOverlay();
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

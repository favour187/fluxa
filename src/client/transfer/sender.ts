/** Bounded-memory sender. A SHA-256 commitment is made before offering files;
 * a retry re-selects and re-hashes the original source. A receiver-advertised
 * offset is never trusted until its prefix digest matches local bytes. Success
 * requires fileResult for EVERY file AND the receiver's final doneAck.
 */
import {
  ACK_INTERVAL_BYTES, LIMITS, MAX_UNACKED_BYTES, PROTOCOL_VERSION,
  SEND_HIGH_WATER, SEND_LOW_WATER,
  type ControlMessage, type FileDescriptor, type ManifestMsg, type ResumeOffset,
} from '../../shared/protocol.js';
import { dedupeName, sanitizeRelPath } from '../../shared/filename.js';
import { randomBytes, toHex } from '../../shared/crypto.js';
import { Sha256, sha256OfBlob } from '../sha256.js';
import type { PeerSession } from '../peer.js';
import { deletePending, journalAvailable, savePending } from './journal.js';
import type { FileProgress, TransferState } from './types.js';

export interface SendTaskOptions {
  files: File[];
  peerName: string;
  peerDeviceId: string;
  senderName: string;
  chunkSize: number;
  resume?: ManifestMsg;
  onUpdate: (task: SendTask) => void;
  onFinished: (task: SendTask) => void;
}

const ACCEPT_TIMEOUT_MS = 120_000;
const FILE_RESULT_TIMEOUT_MS = 180_000;
const STALL_TIMEOUT_MS = 45_000;

export class SendTask {
  readonly id: string;
  readonly role = 'send' as const;
  readonly startedAt = Date.now();
  finishedAt: number | null = null;
  state: TransferState = 'preparing';
  error: string | null = null;
  verified = false;
  descriptors: FileDescriptor[] = [];
  progress: FileProgress[] = [];
  totalBytes = 0;
  ackedBytes = 0;
  enqueuedBytes = 0;
  bytesPerSecond = 0;
  etaSeconds: number | null = null;
  currentFile: string | null = null;

  private acks = new Map<number, number>();
  private enqueuedFor = new Map<number, number>();
  private prefixHashers = new Map<number, Sha256>();
  private ackWaiters: (() => void)[] = [];
  private acceptResolve: ((result: { ok: boolean; reason?: string; resume?: ResumeOffset[] }) => void) | null = null;
  private resultResolve: ((result: { ok: boolean; error?: string }) => void) | null = null;
  private expectedResultStream: number | null = null;
  private doneResolve: ((result: { ok: boolean; error?: string }) => void) | null = null;
  private abort: AbortController | null = null;
  private lastActivity = Date.now();
  private declinedByPeer = false;
  private lastSample = { at: Date.now(), bytes: 0 };
  private watchdog: number | null = null;
  private timers: number[] = [];
  private done = false;
  private persisted = false;

  constructor(private readonly session: PeerSession, private readonly opts: SendTaskOptions) {
    this.id = opts.resume?.transferId ?? toHex(randomBytes(16));
    this.totalBytes = opts.files.reduce((sum, f) => sum + f.size, 0);
    opts.onUpdate(this);
  }

  get files(): FileProgress[] { return this.progress; }
  get peerName(): string { return this.opts.peerName; }
  get peerDeviceId(): string { return this.opts.peerDeviceId; }
  get sourceFiles(): File[] { return this.opts.files; }

  private manifest(): ManifestMsg {
    return this.opts.resume ?? {
      t: 'manifest', v: PROTOCOL_VERSION, transferId: this.id,
      files: this.descriptors, totalBytes: this.totalBytes,
      senderName: this.opts.senderName, createdAt: this.startedAt,
    };
  }

  async run(): Promise<void> {
    if (this.done) return;
    try {
      await this.buildManifest();
      if (this.done) return;
      const manifest = this.manifest();
      if (!this.opts.resume) {
        await savePending({ id: this.id, role: 'send', peerDeviceId: this.peerDeviceId, manifest, state: 'pending', updatedAt: Date.now() });
      }
      this.persisted = journalAvailable();
      if (this.done) return;
      this.setState('waiting-approval');
      const wait = this.waitForAccept(); // register listener BEFORE sending
      this.session.sendControl(manifest);
      this.startWatchdog();
      const accepted = await wait;
      if (this.done) return;
      if (!accepted.ok) {
        this.fail(accepted.reason ?? 'The receiving device declined the transfer', this.declinedByPeer ? 'declined' : 'failed');
        return;
      }
      await this.validateResume(accepted.resume ?? []);
      if (this.done) return;
      this.setState('transferring');
      for (let i = 0; i < this.opts.files.length; i++) {
        if (this.done) return;
        const file = this.opts.files[i]!;
        const descriptor = this.descriptors[i]!;
        const result = await this.sendFile(file, descriptor);
        if (this.done) return;
        if (!result.ok) {
          this.progressFor(descriptor.streamId).error = result.error ?? 'receiver rejected file';
          this.fail(`File rejected by the receiver: ${result.error ?? 'unknown reason'}`);
          return;
        }
        this.progressFor(descriptor.streamId).status = 'complete';
        this.progressFor(descriptor.streamId).verified = true;
        this.opts.onUpdate(this);
      }
      if (this.done) return;
      this.setState('verifying');
      const waitDone = this.waitForDone();
      this.session.sendControl({ t: 'done', transferId: this.id });
      const receipt = await waitDone;
      if (this.done) return;
      if (!receipt.ok) throw new Error(receipt.error ?? 'Receiver did not confirm completion');
      this.verified = true;
      this.complete();
    } catch (err) {
      // A wrong re-selection must not erase the only recovery journal. The
      // receiver has seen no new manifest yet; let the user pick the right file.
      if (this.opts.resume && this.state === 'preparing' && !this.done) {
        this.done = true;
        this.state = 'paused';
        this.error = (err as Error).message;
        this.finishedAt = Date.now();
        this.opts.onUpdate(this);
        this.opts.onFinished(this);
      } else this.fail((err as Error).message);
    }
  }

  private async buildManifest(): Promise<void> {
    if (this.opts.files.length === 0 || this.opts.files.length > LIMITS.maxFilesPerTransfer) throw new Error('Invalid number of files');
    if (this.totalBytes > LIMITS.maxTransferBytes) throw new Error('Transfer exceeds the size limit');
    const used = new Set<string>();
    const descriptors: FileDescriptor[] = [];
    for (const [index, file] of this.opts.files.entries()) {
      if (this.done) return;
      if (file.size > LIMITS.maxFileBytes) throw new Error(`${file.name} exceeds the size limit`);
      const path = relPathOf(file);
      const name = path.split('/').at(-1) ?? file.name;
      const safe = sanitizeRelPath(name, path);
      if (!safe) throw new Error(`The file name "${file.name}" is not supported`);
      const folder = safe.relPath.slice(0, safe.relPath.length - safe.name.length);
      const inFolder = new Set([...used].filter((p) => p.startsWith(folder.toLowerCase())).map((p) => p.slice(folder.length)));
      const uniqueName = dedupeName(safe.name, inFolder);
      const unique = folder + uniqueName;
      used.add(unique.toLowerCase());
      descriptors.push({
        streamId: index + 1, name: uniqueName, relPath: unique, size: file.size,
        mime: (file.type || 'application/octet-stream').slice(0, 255),
        sha256: await sha256OfBlob(file),
      });
    }
    if (this.opts.resume) {
      if (this.opts.resume.v !== PROTOCOL_VERSION || this.opts.resume.totalBytes !== this.totalBytes ||
          this.opts.resume.files.length !== descriptors.length ||
          descriptors.some((f, i) => {
            const saved = this.opts.resume!.files[i]!;
            return f.streamId !== saved.streamId || f.name !== saved.name || f.relPath !== saved.relPath ||
              f.size !== saved.size || f.sha256 !== saved.sha256;
          })) {
        throw new Error('Selected files do not match the original transfer; select the same files/folder in the same order');
      }
      this.descriptors = this.opts.resume.files;
    } else this.descriptors = descriptors;
    this.progress = this.descriptors.map((descriptor) => ({ descriptor, sent: 0, verified: false, status: 'pending' as const }));
    this.opts.onUpdate(this);
  }

  private waitForAccept(): Promise<{ ok: boolean; reason?: string; resume?: ResumeOffset[] }> {
    return new Promise((resolve) => {
      this.acceptResolve = resolve;
      this.timers.push(window.setTimeout(() => {
        this.acceptResolve?.({ ok: false, reason: 'The receiving device did not respond in time' });
        this.acceptResolve = null;
      }, ACCEPT_TIMEOUT_MS));
    });
  }

  handleAccept(resume?: ResumeOffset[]): void {
    if (this.state !== 'waiting-approval') return;
    this.acceptResolve?.({ ok: true, resume });
    this.acceptResolve = null;
    this.lastActivity = Date.now();
  }

  handleDecline(reason?: string): void {
    this.declinedByPeer = true;
    this.acceptResolve?.({ ok: false, reason: reason ?? 'The receiving device declined the transfer' });
    this.acceptResolve = null;
  }

  private async validateResume(plan: ResumeOffset[]): Promise<void> {
    const seen = new Set<number>();
    for (const part of plan) {
      const descriptor = this.descriptors.find((f) => f.streamId === part.streamId);
      if (!descriptor || seen.has(part.streamId) || !Number.isSafeInteger(part.offset) ||
          part.offset < 0 || part.offset > descriptor.size || !/^[0-9a-f]{64}$/.test(part.prefixSha256)) {
        throw new Error('Receiver offered an invalid resume offset');
      }
      seen.add(part.streamId);
      const hasher = new Sha256();
      const reader = this.opts.files[part.streamId - 1]!.slice(0, part.offset).stream().getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) hasher.update(value);
          if (this.done) throw new Error('transfer stopped');
        }
      } finally { reader.releaseLock(); }
      if (hasher.clone().digestHex() !== part.prefixSha256) throw new Error('Resume prefix SHA-256 does not match source; no data was appended');
      this.prefixHashers.set(part.streamId, hasher);
      this.acks.set(part.streamId, part.offset);
      this.enqueuedFor.set(part.streamId, part.offset);
      this.ackedBytes += part.offset;
      this.enqueuedBytes += part.offset;
      this.progressFor(part.streamId).sent = part.offset;
    }
    this.updateProgress();
    this.opts.onUpdate(this);
  }

  handleChunkAck(streamId: number, bytes: number): void {
    if (this.done || (this.state !== 'transferring' && this.state !== 'verifying')) return;
    const descriptor = this.descriptors.find((f) => f.streamId === streamId);
    if (!descriptor || !Number.isSafeInteger(bytes) || bytes > descriptor.size || bytes > (this.enqueuedFor.get(streamId) ?? 0)) {
      this.fail('Receiver sent an impossible acknowledgement');
      return;
    }
    const previous = this.acks.get(streamId) ?? 0;
    if (bytes <= previous) return;
    this.acks.set(streamId, bytes);
    this.ackedBytes += bytes - previous;
    this.lastActivity = Date.now();
    this.sampleThroughput();
    this.updateProgress();
    this.wakeAckWaiters();
    this.opts.onUpdate(this);
  }

  handleFileResult(streamId: number, ok: boolean, hash?: string, error?: string): void {
    if (this.done || !this.resultResolve) return;
    const expected = this.descriptors.find((f) => f.streamId === streamId);
    if (streamId !== this.expectedResultStream || !expected || (ok && hash !== expected.sha256)) {
      this.fail('Receiver returned a result for the wrong file or hash');
      return;
    }
    this.resultResolve({ ok, error });
    this.resultResolve = null;
    this.expectedResultStream = null;
    this.lastActivity = Date.now();
  }

  handleDoneAck(ok: boolean, error?: string): void {
    if (this.state !== 'verifying' || !this.doneResolve) return;
    this.doneResolve({ ok, error });
    this.doneResolve = null;
    this.lastActivity = Date.now();
  }

  handleRemoteError(message: string): void {
    this.acceptResolve?.({ ok: false, reason: message });
    this.resultResolve?.({ ok: false, error: message });
    this.doneResolve?.({ ok: false, error: message });
    this.acceptResolve = this.resultResolve = this.doneResolve = null;
    this.fail(message);
  }

  async cancel(reason = 'Cancelled by sender'): Promise<void> {
    if (this.done) return;
    this.fail(reason, 'cancelled');
  }

  private async sendFile(file: File, descriptor: FileDescriptor): Promise<{ ok: boolean; error?: string }> {
    const progress = this.progressFor(descriptor.streamId);
    progress.status = 'sending';
    this.currentFile = descriptor.relPath;
    this.opts.onUpdate(this);
    const hasher = this.prefixHashers.get(descriptor.streamId) ?? new Sha256();
    let offset = this.acks.get(descriptor.streamId) ?? 0;
    const reader = file.slice(offset).stream().getReader();
    const buffer = new Uint8Array(this.opts.chunkSize);
    let fill = 0;
    this.abort = new AbortController();
    try {
      for (;;) {
        if (this.abort.signal.aborted || this.done) {
          await reader.cancel().catch(() => undefined);
          throw new Error('transfer stopped');
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        let src = value;
        while (src.byteLength > 0) {
          const take = Math.min(buffer.byteLength - fill, src.byteLength);
          buffer.set(src.subarray(0, take), fill);
          fill += take;
          src = src.subarray(take);
          if (fill === buffer.byteLength) {
            await this.pushChunk(descriptor.streamId, offset, buffer, hasher);
            offset += fill;
            fill = 0;
            progress.sent = offset;
          }
        }
      }
      if (fill) {
        await this.pushChunk(descriptor.streamId, offset, buffer.subarray(0, fill), hasher);
        offset += fill;
        progress.sent = offset;
      }
    } finally { reader.releaseLock(); }
    if (this.done) return { ok: false, error: 'transfer stopped' };
    if (offset !== descriptor.size) throw new Error(`file changed while sending (${offset} of ${descriptor.size} bytes)`);
    const hash = hasher.digestHex();
    if (hash !== descriptor.sha256) throw new Error('source file changed since its SHA-256 commitment');
    progress.status = 'verifying';
    this.opts.onUpdate(this);
    const wait = this.waitForResult(descriptor.streamId);
    this.session.sendControl({ t: 'fileEnd', transferId: this.id, streamId: descriptor.streamId, sha256: hash, size: offset });
    return wait;
  }

  private async pushChunk(streamId: number, offset: number, chunk: Uint8Array, hasher: Sha256): Promise<void> {
    if (this.done || this.state !== 'transferring') throw new Error('transfer is no longer active');
    if (this.session.bufferedAmount > SEND_HIGH_WATER) await this.session.waitForDrain(SEND_LOW_WATER);
    if (this.done || this.state !== 'transferring') throw new Error('transfer is no longer active');
    hasher.update(chunk);
    if (!this.session.sendChunk(streamId, offset, chunk)) throw new Error('the connection closed while sending');
    this.enqueuedBytes += chunk.byteLength;
    this.enqueuedFor.set(streamId, offset + chunk.byteLength);
    this.lastActivity = Date.now();
    if (this.enqueuedBytes - this.ackedBytes >= MAX_UNACKED_BYTES) await this.applyAckWindow();
  }

  private async applyAckWindow(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => { cleanup(); reject(new Error('receiving device stopped acknowledging data')); }, STALL_TIMEOUT_MS);
      const waiter = () => {
        if (!this.done && this.enqueuedBytes - this.ackedBytes >= MAX_UNACKED_BYTES) return;
        cleanup(); resolve();
      };
      const cleanup = () => { clearTimeout(timer); this.ackWaiters = this.ackWaiters.filter((w) => w !== waiter); };
      this.ackWaiters.push(waiter);
    });
  }

  private wakeAckWaiters(): void {
    const waiters = this.ackWaiters;
    this.ackWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private waitForResult(streamId: number): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      this.expectedResultStream = streamId;
      this.resultResolve = resolve;
      this.timers.push(window.setTimeout(() => {
        this.resultResolve?.({ ok: false, error: 'Receiving device did not confirm the file' });
        this.resultResolve = null;
      }, FILE_RESULT_TIMEOUT_MS));
    });
  }

  private waitForDone(): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      this.doneResolve = resolve;
      this.timers.push(window.setTimeout(() => {
        this.doneResolve?.({ ok: false, error: 'Receiving device did not confirm that all data was verified' });
        this.doneResolve = null;
      }, FILE_RESULT_TIMEOUT_MS));
    });
  }

  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = window.setInterval(() => {
      if (this.state !== 'transferring' && this.state !== 'waiting-approval') return;
      if (Date.now() - this.lastActivity > STALL_TIMEOUT_MS && this.state === 'transferring') {
        this.fail('The connection stalled and the transfer was stopped');
      }
    }, 5000);
  }

  private sampleThroughput(): void {
    const now = Date.now();
    const elapsed = (now - this.lastSample.at) / 1000;
    if (elapsed < 0.25) return;
    const instant = (this.ackedBytes - this.lastSample.bytes) / elapsed;
    this.bytesPerSecond = this.bytesPerSecond === 0 ? instant : this.bytesPerSecond * 0.75 + instant * 0.25;
    this.lastSample = { at: now, bytes: this.ackedBytes };
  }

  private updateProgress(): void {
    const remaining = this.totalBytes - this.ackedBytes;
    this.etaSeconds = this.bytesPerSecond > 1024 ? Math.max(0, remaining / this.bytesPerSecond) : null;
  }

  private progressFor(streamId: number): FileProgress {
    const found = this.progress.find((p) => p.descriptor.streamId === streamId);
    if (!found) throw new Error('internal: unknown stream');
    return found;
  }

  private setState(state: TransferState): void {
    this.state = state;
    this.lastActivity = Date.now();
    this.opts.onUpdate(this);
  }

  private complete(): void {
    if (this.done) return;
    this.done = true;
    this.finishedAt = Date.now();
    this.cleanupTimers();
    this.state = 'complete';
    this.etaSeconds = 0;
    void deletePending(this.id).catch(() => undefined);
    this.opts.onUpdate(this);
    this.opts.onFinished(this);
  }

  private fail(message: string, state: 'failed' | 'cancelled' | 'declined' = 'failed'): void {
    if (this.done) return;
    this.done = true;
    this.abort?.abort();
    this.finishedAt = Date.now();
    this.error = message;
    this.state = state;
    if (state === 'cancelled') this.session.sendControl({ t: 'cancel', transferId: this.id, reason: message.slice(0, 512) });
    else if (state === 'failed') this.session.sendControl({ t: 'error', transferId: this.id,
      code: 'send_failed', message: message.slice(0, 512) });
    for (const p of this.progress) if (p.status !== 'complete') p.status = 'failed';
    this.acceptResolve?.({ ok: false, reason: message });
    this.resultResolve?.({ ok: false, error: message });
    this.doneResolve?.({ ok: false, error: message });
    this.acceptResolve = this.resultResolve = this.doneResolve = null;
    this.cleanupTimers();
    void deletePending(this.id).catch(() => undefined);
    this.opts.onUpdate(this);
    this.opts.onFinished(this);
  }

  private cleanupTimers(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.wakeAckWaiters();
  }

  handleSessionClosed(reason: string): void {
    if (this.done) return;
    if (!this.persisted || this.state === 'preparing') {
      this.fail(`Connection lost: ${reason}`); // no durable offer/journal yet
      return;
    }
    this.done = true;
    this.abort?.abort();
    this.acceptResolve?.({ ok: false, reason });
    this.resultResolve?.({ ok: false, error: reason });
    this.doneResolve?.({ ok: false, error: reason });
    this.acceptResolve = this.resultResolve = this.doneResolve = null;
    this.state = 'paused';
    this.error = `Connection lost: ${reason}. Reconnect and reselect the original files to resume.`;
    this.finishedAt = Date.now();
    this.cleanupTimers();
    this.opts.onUpdate(this);
    this.opts.onFinished(this);
  }
}

export function relPathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative && relative.length > 0 ? relative : file.name;
}

export const SENDER_CONSTANTS = { ACK_INTERVAL_BYTES, MAX_UNACKED_BYTES, SEND_HIGH_WATER, SEND_LOW_WATER };
export type { ControlMessage };

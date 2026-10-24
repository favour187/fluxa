/**
 * Send side of a transfer.
 *
 * Guarantees:
 *  - never reads a whole file into memory (streams in fixed-size chunks)
 *  - never outruns the receiver: bounded by both the transport buffer and an
 *    explicit acknowledgement window, so memory stays flat for huge files
 *  - progress is reported from *acknowledged* bytes, not from bytes handed to
 *    the transport, so the bar cannot run ahead of reality
 *  - completion requires a verified fileResult for every file
 */
import {
  ACK_INTERVAL_BYTES,
  MAX_UNACKED_BYTES,
  SEND_HIGH_WATER,
  SEND_LOW_WATER,
  type ControlMessage,
  type FileDescriptor,
  type ManifestMsg,
} from '../../shared/protocol.js';
import { sanitizeRelPath } from '../../shared/filename.js';
import { randomBytes, toHex } from '../../shared/crypto.js';
import { Sha256 } from '../sha256.js';
import type { PeerSession } from '../peer.js';
import type { FileProgress, TransferState } from './types.js';

export interface SendTaskOptions {
  files: File[];
  peerName: string;
  peerDeviceId: string;
  senderName: string;
  chunkSize: number;
  onUpdate: (task: SendTask) => void;
  onFinished: (task: SendTask) => void;
}

const ACCEPT_TIMEOUT_MS = 120_000;
const FILE_RESULT_TIMEOUT_MS = 180_000;
const STALL_TIMEOUT_MS = 45_000;

export class SendTask {
  readonly id: string = toHex(randomBytes(16));
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
  private ackWaiters: (() => void)[] = [];
  private acceptResolve: ((ok: boolean, reason?: string) => void) | null = null;
  private resultResolve: ((result: { ok: boolean; error?: string }) => void) | null = null;
  private abort: AbortController | null = null;
  private lastActivity = Date.now();
  private declinedByPeer = false;
  private lastSample = { at: Date.now(), bytes: 0 };
  private watchdog: number | null = null;
  private timers: number[] = [];
  private done = false;

  constructor(
    private readonly session: PeerSession,
    private readonly opts: SendTaskOptions,
  ) {
    this.totalBytes = opts.files.reduce((sum, f) => sum + f.size, 0);
  }

  /** Uniform shape with ReceiveTask so the app/UI can treat both generically. */
  get files(): FileProgress[] {
    return this.progress;
  }

  get peerName(): string {
    return this.opts.peerName;
  }
  get peerDeviceId(): string {
    return this.opts.peerDeviceId;
  }

  snapshot() {
    return {
      id: this.id,
      role: this.role,
      state: this.state,
      peerName: this.peerName,
      peerDeviceId: this.peerDeviceId,
      directionLabel: 'Sending',
      files: this.progress,
      totalBytes: this.totalBytes,
      transferredBytes: this.ackedBytes,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      bytesPerSecond: this.bytesPerSecond,
      etaSeconds: this.etaSeconds,
      error: this.error,
      verified: this.verified,
    };
  }

  async run(): Promise<void> {
    try {
      this.buildManifest();
      this.setState('waiting-approval');
      this.session.sendControl(this.manifest());
      this.startWatchdog();

      const accepted = await this.waitForAccept();
      if (!accepted.ok) {
        this.fail(
          accepted.reason ?? 'The receiving device declined the transfer',
          this.declinedByPeer ? 'declined' : 'failed',
        );
        return;
      }
      this.setState('transferring');

      for (const file of this.opts.files) {
        if (this.done || this.state !== 'transferring') return;
        const descriptor = this.descriptors.find((d) => d.relPath === relPathOf(file));
        if (!descriptor) throw new Error('internal: descriptor missing for file');
        const result = await this.sendFile(file, descriptor);
        if (!result.ok) {
          this.progressFor(descriptor.streamId).error = result.error ?? 'receiver rejected the file';
          this.fail(`File rejected by the receiver: ${result.error ?? 'unknown reason'}`);
          return;
        }
        this.progressFor(descriptor.streamId).status = 'complete';
        this.progressFor(descriptor.streamId).verified = true;
      }

      this.setState('verifying');
      this.session.sendControl({ t: 'done', transferId: this.id });
      this.verified = true;
      this.complete();
    } catch (err) {
      this.fail((err as Error).message);
    }
  }

  private buildManifest(): void {
    if (this.opts.files.length === 0) throw new Error('No files selected');
    const used = new Set<string>();
    this.descriptors = this.opts.files.map((file, index) => {
      let relPath = relPathOf(file);
      const parts = relPath.split('/');
      const name = parts[parts.length - 1] ?? file.name;
      const safe = sanitizeRelPath(name, relPath);
      if (!safe) throw new Error(`The file name "${file.name}" is not supported`);
      relPath = safe.relPath;
      let unique = relPath;
      let n = 1;
      while (used.has(unique.toLowerCase())) {
        unique = `${relPath} (${n++})`;
      }
      used.add(unique.toLowerCase());
      return {
        streamId: index + 1,
        name: safe.name,
        relPath: unique,
        size: file.size,
        mime: file.type || 'application/octet-stream',
      };
    });
    this.progress = this.descriptors.map((descriptor) => ({
      descriptor,
      sent: 0,
      verified: false,
      status: 'pending' as const,
    }));
  }

  private manifest(): ManifestMsg {
    return {
      t: 'manifest',
      v: 1,
      transferId: this.id,
      files: this.descriptors,
      totalBytes: this.totalBytes,
      senderName: this.opts.senderName,
      createdAt: Date.now(),
    };
  }

  private waitForAccept(): Promise<{ ok: boolean; reason?: string }> {
    return new Promise((resolve) => {
      this.acceptResolve = (ok, reason) => resolve({ ok, reason });
      this.timers.push(
        window.setTimeout(() => {
          if (this.acceptResolve) {
            this.acceptResolve(false, 'The receiving device did not respond in time');
            this.acceptResolve = null;
          }
        }, ACCEPT_TIMEOUT_MS),
      );
    });
  }

  handleAccept(): void {
    this.acceptResolve?.(true);
    this.acceptResolve = null;
    this.lastActivity = Date.now();
  }

  handleDecline(reason?: string): void {
    this.declinedByPeer = true;
    this.acceptResolve?.(false, reason ?? 'The receiving device declined the transfer');
    this.acceptResolve = null;
  }

  handleChunkAck(streamId: number, bytes: number): void {
    const previous = this.acks.get(streamId) ?? 0;
    if (bytes <= previous) return;
    const delta = bytes - previous;
    this.acks.set(streamId, bytes);
    this.ackedBytes += delta;
    this.lastActivity = Date.now();
    this.sampleThroughput();
    this.updateProgress();
    this.wakeAckWaiters();
    this.opts.onUpdate(this);
  }

  handleFileResult(streamId: number, ok: boolean, error?: string): void {
    if (!this.resultResolve) return;
    if (!ok) this.progressFor(streamId).status = 'failed';
    this.resultResolve({ ok, error });
    this.resultResolve = null;
  }

  handleRemoteError(message: string): void {
    this.acceptResolve?.(false, message);
    this.acceptResolve = null;
    this.resultResolve?.({ ok: false, error: message });
    this.resultResolve = null;
    this.fail(message);
  }

  async cancel(reason = 'Cancelled by sender'): Promise<void> {
    if (this.done) return;
    this.abort?.abort();
    this.session.sendControl({ t: 'cancel', transferId: this.id, reason });
    this.acceptResolve?.(false, reason);
    this.acceptResolve = null;
    this.resultResolve?.({ ok: false, error: reason });
    this.resultResolve = null;
    this.fail(reason, 'cancelled');
  }

  private async sendFile(file: File, descriptor: FileDescriptor): Promise<{ ok: boolean; error?: string }> {
    const progress = this.progressFor(descriptor.streamId);
    progress.status = 'sending';
    this.currentFile = descriptor.relPath;
    this.opts.onUpdate(this);

    const hasher = new Sha256();
    const reader = (file as File).stream().getReader();
    const buffer = new Uint8Array(this.opts.chunkSize);
    let bufferFill = 0;
    let offset = 0;
    this.abort = new AbortController();
    const signal = this.abort.signal;

    try {
      for (;;) {
        if (signal.aborted || this.done) {
          await reader.cancel().catch(() => undefined);
          throw new Error('transfer stopped');
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        let src = value;
        while (src.byteLength > 0) {
          const room = buffer.byteLength - bufferFill;
          const take = Math.min(room, src.byteLength);
          buffer.set(src.subarray(0, take), bufferFill);
          bufferFill += take;
          src = src.subarray(take);
          if (bufferFill === buffer.byteLength) {
            await this.pushChunk(descriptor.streamId, offset, buffer.subarray(0, bufferFill), hasher);
            offset += bufferFill;
            bufferFill = 0;
            progress.sent = offset;
          }
        }
      }
      if (bufferFill > 0) {
        await this.pushChunk(descriptor.streamId, offset, buffer.subarray(0, bufferFill), hasher);
        offset += bufferFill;
        progress.sent = offset;
      }
    } finally {
      reader.releaseLock();
    }

    if (offset !== descriptor.size) {
      throw new Error(`file changed while sending (${offset} of ${descriptor.size} bytes)`);
    }
    progress.status = 'verifying';
    this.opts.onUpdate(this);
    this.session.sendControl({
      t: 'fileEnd',
      transferId: this.id,
      streamId: descriptor.streamId,
      sha256: hasher.digestHex(),
      size: offset,
    });
    return this.waitForResult();
  }

  private async pushChunk(
    streamId: number,
    offset: number,
    chunk: Uint8Array,
    hasher: Sha256,
  ): Promise<void> {
    if (this.done || this.state !== 'transferring') throw new Error('transfer is no longer active');
    await this.applyBackpressure();
    if (this.done || this.state !== 'transferring') throw new Error('transfer is no longer active');
    hasher.update(chunk);
    const ok = this.session.sendChunk(streamId, offset, chunk);
    if (!ok) throw new Error('the connection closed while sending');
    this.enqueuedBytes += chunk.byteLength;
    this.lastActivity = Date.now();
    await this.applyAckWindow();
  }

  private async applyBackpressure(): Promise<void> {
    if (this.session.bufferedAmount > SEND_HIGH_WATER) {
      await this.session.waitForDrain(SEND_LOW_WATER);
    }
  }

  private async applyAckWindow(): Promise<void> {
    if (this.done || this.state !== 'transferring') return;
    if (this.enqueuedBytes - this.ackedBytes < MAX_UNACKED_BYTES) return;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error('the receiving device stopped acknowledging data'));
      }, STALL_TIMEOUT_MS);
      const waiter = () => {
        if (this.enqueuedBytes - this.ackedBytes >= MAX_UNACKED_BYTES) return;
        cleanup();
        resolve();
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.ackWaiters = this.ackWaiters.filter((w) => w !== waiter);
      };
      this.ackWaiters.push(waiter);
    });
  }

  private wakeAckWaiters(): void {
    const waiters = this.ackWaiters;
    this.ackWaiters = [];
    for (const waiter of waiters) waiter();
  }

  private waitForResult(): Promise<{ ok: boolean; error?: string }> {
    if (this.done) return Promise.resolve({ ok: false, error: this.error ?? 'transfer stopped' });
    return new Promise((resolve) => {
      this.resultResolve = (result) => resolve(result);
      this.timers.push(
        window.setTimeout(() => {
          if (this.resultResolve) {
            this.resultResolve({ ok: false, error: 'the receiving device did not confirm the file' });
            this.resultResolve = null;
          }
        }, FILE_RESULT_TIMEOUT_MS),
      );
    });
  }

  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = window.setInterval(() => {
      if (this.state !== 'transferring' && this.state !== 'waiting-approval') return;
      if (Date.now() - this.lastActivity > STALL_TIMEOUT_MS) {
        this.fail('The connection stalled and the transfer was stopped');
      }
    }, 5000);
  }

  private sampleThroughput(): void {
    const now = Date.now();
    const elapsed = (now - this.lastSample.at) / 1000;
    if (elapsed < 0.25) return;
    const instantaneous = (this.ackedBytes - this.lastSample.bytes) / elapsed;
    // Exponential moving average keeps the readout stable and the ETA honest.
    this.bytesPerSecond =
      this.bytesPerSecond === 0 ? instantaneous : this.bytesPerSecond * 0.75 + instantaneous * 0.25;
    this.lastSample = { at: now, bytes: this.ackedBytes };
  }

  private updateProgress(): void {
    const remaining = this.totalBytes - this.ackedBytes;
    this.etaSeconds =
      this.bytesPerSecond > 1024 && remaining > 0 ? remaining / this.bytesPerSecond : this.bytesPerSecond > 0 && remaining === 0 ? 0 : null;
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
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    this.finishedAt = Date.now();
    this.cleanupTimers();
    this.state = 'complete';
    this.etaSeconds = 0;
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
    for (const p of this.progress) {
      if (p.status !== 'complete') p.status = 'failed';
    }
    this.cleanupTimers();
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

  /** Called by the manager when the peer connection goes away. */
  handleSessionClosed(reason: string): void {
    if (this.done) return;
    this.acceptResolve?.(false, reason);
    this.resultResolve?.({ ok: false, error: reason });
    this.fail(`Connection lost: ${reason}`);
  }
}

export function relPathOf(file: File): string {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (relative && relative.length > 0) return relative;
  return file.name;
}

export const SENDER_CONSTANTS = { ACK_INTERVAL_BYTES, MAX_UNACKED_BYTES, SEND_HIGH_WATER, SEND_LOW_WATER };
export type { ControlMessage };

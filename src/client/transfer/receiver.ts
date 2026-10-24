/**
 * Receive side of a transfer.
 *
 * Guarantees:
 *  - nothing is written outside the sanitised destination path
 *  - chunks are applied strictly in order; an out-of-order or unknown chunk is a
 *    hard failure rather than silent corruption
 *  - per-file SHA-256 is computed over the exact received bytes and compared
 *    with the sender's digest before the file is reported as received
 *  - a transfer only reaches `complete` when *every* file verified
 *  - cancelling, disconnecting or a hash mismatch removes the partial file and
 *    leaves the transfer in an explicit failed/cancelled state
 */
import {
  ACK_INTERVAL_BYTES,
  ACK_INTERVAL_MS,
  PROTOCOL_VERSION,
  validateManifest,
  type FileDescriptor,
  type ManifestMsg,
} from '../../shared/protocol.js';
import { sanitizeRelPath } from '../../shared/filename.js';
import { Sha256 } from '../sha256.js';
import type { PeerSession } from '../peer.js';
import { checkStorage, createSink, type ReceivedFile, type Sink } from './sink.js';
import type { FileProgress, TransferState } from './types.js';

interface StreamState {
  descriptor: FileDescriptor;
  sink: Sink | null;
  hasher: Sha256;
  received: number;
  acked: number;
  lastAckAt: number;
  finalized: boolean;
  sha256: string | null;
}

const STALL_TIMEOUT_MS = 90_000;
const INCOMING_TIMEOUT_MS = 5 * 60_000;

export class ReceiveTask {
  readonly role = 'receive' as const;
  state: TransferState = 'incoming';
  error: string | null = null;
  verified = false;
  files: FileProgress[];
  totalBytes: number;
  receivedBytes = 0;
  bytesPerSecond = 0;
  etaSeconds: number | null = null;
  startedAt = Date.now();
  finishedAt: number | null = null;
  currentFile: string | null = null;

  private streams = new Map<number, StreamState>();
  private writeChain: Promise<void> = Promise.resolve();
  private lastSample = { at: Date.now(), bytes: 0 };
  private lastActivity = Date.now();
  private watchdog: number | null = null;
  private ackTimer: number | null = null;
  private incomingTimer: number | null = null;
  private finished = false;

  constructor(
    readonly manifest: ManifestMsg,
    private readonly session: PeerSession,
    private readonly preferMemory: boolean,
    private readonly opts: {
      onUpdate: (task: ReceiveTask) => void;
      onFinished: (task: ReceiveTask, files: ReceivedFile[]) => void;
    },
  ) {
    this.totalBytes = manifest.totalBytes;
    this.files = manifest.files.map((descriptor) => ({
      descriptor,
      sent: 0,
      verified: false,
      status: 'pending',
    }));
    for (const descriptor of manifest.files) {
      this.streams.set(descriptor.streamId, {
        descriptor,
        sink: null,
        hasher: new Sha256(),
        received: 0,
        acked: 0,
        lastAckAt: Date.now(),
        finalized: false,
        sha256: null,
      });
    }
    this.incomingTimer = window.setTimeout(() => {
      if (this.state === 'incoming') this.decline('No response from the receiving device');
    }, INCOMING_TIMEOUT_MS);
  }

  get id(): string {
    return this.manifest.transferId;
  }
  get peerName(): string {
    return this.manifest.senderName || this.session.peer.name;
  }
  get peerDeviceId(): string {
    return this.session.peer.deviceId;
  }

  snapshot() {
    return {
      id: this.id,
      role: this.role,
      state: this.state,
      peerName: this.peerName,
      peerDeviceId: this.peerDeviceId,
      directionLabel: 'Receiving',
      files: this.files,
      totalBytes: this.totalBytes,
      transferredBytes: this.receivedBytes,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      bytesPerSecond: this.bytesPerSecond,
      etaSeconds: this.etaSeconds,
      error: this.error,
      verified: this.verified,
    };
  }

  static parse(msg: ManifestMsg): { ok: true; task: null } | { ok: false; errors: string[] } {
    const check = validateManifest(msg, sanitizeRelPath);
    if (!check.ok || msg.v !== PROTOCOL_VERSION) return { ok: false, errors: check.errors };
    return { ok: true, task: null };
  }

  async accept(): Promise<void> {
    if (this.state !== 'incoming') return;
    if (this.incomingTimer !== null) clearTimeout(this.incomingTimer);
    this.incomingTimer = null;
    const space = await checkStorage(this.totalBytes);
    if (!space.ok) {
      this.fail('Not enough storage space on this device for this transfer');
      this.session.sendControl({ t: 'decline', transferId: this.id, reason: 'not enough storage space' });
      return;
    }
    this.state = 'transferring';
    this.startedAt = Date.now();
    this.lastActivity = Date.now();
    this.session.sendControl({ t: 'accept', transferId: this.id });
    this.startWatchdog();
    // Acknowledge on a timer as well as on byte thresholds: without this, small
    // or fast transfers would finish before a single ack was ever sent, leaving
    // the sender's progress bar at zero until the very end.
    this.ackTimer = window.setInterval(() => this.flushAcks(), ACK_INTERVAL_MS);
    this.opts.onUpdate(this);
  }

  decline(reason = 'Declined by receiver'): void {
    if (this.state !== 'incoming') return;
    if (this.incomingTimer !== null) clearTimeout(this.incomingTimer);
    this.incomingTimer = null;
    this.state = 'declined';
    this.error = reason;
    this.finishedAt = Date.now();
    this.session.sendControl({ t: 'decline', transferId: this.id, reason });
    this.opts.onUpdate(this);
    this.opts.onFinished(this, []);
  }

  cancel(reason = 'Cancelled by receiver'): void {
    if (this.finished) return;
    this.session.sendControl({ t: 'cancel', transferId: this.id, reason });
    this.fail(reason, 'cancelled');
  }

  /** Remote asked us to stop. */
  handleRemoteCancel(reason: string): void {
    this.fail(reason || 'The sender cancelled the transfer', 'cancelled');
  }

  handleChunk(streamId: number, offset: number, data: Uint8Array): void {
    // Chunks are processed through a promise chain so that asynchronous writes
    // can never reorder bytes, even though DataChannel delivery is already ordered.
    this.writeChain = this.writeChain.then(() => this.applyChunk(streamId, offset, data)).catch((err) => {
      this.fail((err as Error).message);
    });
  }

  private async applyChunk(streamId: number, offset: number, data: Uint8Array): Promise<void> {
    if (this.finished) return;
    if (this.state !== 'transferring') {
      throw new Error('received file data outside of an active transfer');
    }
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`data for unknown file stream ${streamId}`);
    if (stream.finalized) throw new Error('data arrived after the file was finalised');
    if (offset !== stream.received) {
      throw new Error(`out-of-order data (expected offset ${stream.received}, received ${offset})`);
    }
    if (stream.received + data.byteLength > stream.descriptor.size) {
      throw new Error('received more data than the declared file size');
    }
    if (!stream.sink) stream.sink = await createSink(stream.descriptor, this.id, this.preferMemory);
    await stream.sink.write(offset, data);
    stream.hasher.update(data);
    stream.received += data.byteLength;
    this.receivedBytes += data.byteLength;
    this.lastActivity = Date.now();
    this.currentFile = stream.descriptor.relPath;
    this.sampleThroughput();

    if (stream.received - stream.acked >= ACK_INTERVAL_BYTES) this.flushAcks();
    this.opts.onUpdate(this);
  }

  /** Send cumulative acknowledgements for every stream with unacknowledged bytes. */
  private flushAcks(): void {
    if (this.state !== 'transferring' && this.state !== 'verifying') return;
    for (const [streamId, stream] of this.streams) {
      if (stream.received <= stream.acked) continue;
      stream.acked = stream.received;
      stream.lastAckAt = Date.now();
      this.session.sendControl({
        t: 'chunkAck',
        transferId: this.id,
        streamId,
        bytes: stream.received,
      });
    }
  }

  handleFileEnd(streamId: number, expectedHash: string, declaredSize: number): void {
    this.writeChain = this.writeChain
      .then(() => this.finalizeFile(streamId, expectedHash, declaredSize))
      .catch((err) => {
        this.session.sendControl({
          t: 'fileResult',
          transferId: this.id,
          streamId,
          ok: false,
          error: (err as Error).message,
        });
        this.fail((err as Error).message);
      });
  }

  private async finalizeFile(streamId: number, expectedHash: string, declaredSize: number): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`end of unknown file stream ${streamId}`);
    if (this.state !== 'transferring' && this.state !== 'verifying') {
      throw new Error('file end received outside of an active transfer');
    }
    stream.finalized = true;
    if (declaredSize !== stream.descriptor.size || stream.received !== stream.descriptor.size) {
      throw new Error(
        `size mismatch for ${stream.descriptor.relPath}: declared ${stream.descriptor.size}, received ${stream.received}`,
      );
    }
    if (!stream.sink) {
      // Zero-byte file: there was never a chunk to create the sink.
      stream.sink = await createSink(stream.descriptor, this.id, this.preferMemory);
    }
    await stream.sink.finalize();
    // Final acknowledgement so the sender's confirmed-progress counter is exact.
    this.flushAcks();
    const computed = stream.hasher.digestHex();
    stream.sha256 = computed;
    if (computed !== expectedHash.toLowerCase()) {
      throw new Error(`integrity check failed for ${stream.descriptor.relPath} (sha-256 mismatch)`);
    }
    const progress = this.files.find((f) => f.descriptor.streamId === streamId)!;
    progress.status = 'complete';
    progress.verified = true;
    progress.sent = stream.received;
    const received = await stream.sink.toReceivedFile(computed);
    this.receivedFiles.set(streamId, received);
    this.session.sendControl({
      t: 'fileResult',
      transferId: this.id,
      streamId,
      ok: true,
      sha256: computed,
    });
    // Only enter the verifying phase once every file is in: a multi-file
    // transfer must keep accepting chunks for the remaining files.
    const remaining = [...this.streams.values()].filter((s) => !s.finalized);
    if (remaining.length === 0) this.state = 'verifying';
    this.opts.onUpdate(this);
  }

  private receivedFiles = new Map<number, ReceivedFile>();

  handleDone(): void {
    this.writeChain = this.writeChain
      .then(() => {
        const missing = [...this.streams.values()].filter((s) => !s.finalized || !s.sha256);
        if (missing.length > 0) {
          throw new Error(
            `${missing.length} file(s) were never received and verified: ${missing
              .map((s) => s.descriptor.name)
              .slice(0, 3)
              .join(', ')}`,
          );
        }
        if (this.state !== 'verifying' && this.state !== 'transferring') {
          throw new Error('completion announced in an unexpected state');
        }
        this.complete();
      })
      .catch((err) => this.fail((err as Error).message));
  }

  private complete(): void {
    if (this.finished) return;
    this.finished = true;
    this.state = 'complete';
    this.verified = true;
    this.finishedAt = Date.now();
    this.etaSeconds = 0;
    this.cleanupTimers();
    this.opts.onUpdate(this);
    this.opts.onFinished(this, [...this.receivedFiles.values()]);
  }

  async fail(message: string, state: 'failed' | 'cancelled' = 'failed'): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.error = message;
    this.state = state;
    this.finishedAt = Date.now();
    this.cleanupTimers();
    for (const stream of this.streams.values()) {
      if (stream.sink && !stream.finalized) await stream.sink.abort(message).catch(() => undefined);
    }
    this.receivedFiles.clear();
    for (const file of this.files) {
      if (file.status !== 'complete') file.status = 'failed';
    }
    this.opts.onUpdate(this);
    this.opts.onFinished(this, []);
  }

  handleSessionClosed(reason: string): void {
    if (this.state === 'complete' || this.state === 'failed' || this.state === 'cancelled') return;
    void this.fail(`Connection lost: ${reason}`);
  }

  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = window.setInterval(() => {
      if (this.state !== 'transferring' && this.state !== 'verifying') return;
      if (Date.now() - this.lastActivity > STALL_TIMEOUT_MS) {
        void this.fail('The sender stopped responding and the transfer was closed');
      }
    }, 5000);
  }

  private sampleThroughput(): void {
    const now = Date.now();
    const elapsed = (now - this.lastSample.at) / 1000;
    if (elapsed < 0.25) return;
    const instantaneous = (this.receivedBytes - this.lastSample.bytes) / elapsed;
    this.bytesPerSecond =
      this.bytesPerSecond === 0 ? instantaneous : this.bytesPerSecond * 0.75 + instantaneous * 0.25;
    this.lastSample = { at: now, bytes: this.receivedBytes };
    const remaining = this.totalBytes - this.receivedBytes;
    this.etaSeconds = this.bytesPerSecond > 1024 ? remaining / this.bytesPerSecond : null;
  }

  private cleanupTimers(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    this.watchdog = null;
    if (this.ackTimer !== null) clearInterval(this.ackTimer);
    this.ackTimer = null;
    if (this.incomingTimer !== null) clearTimeout(this.incomingTimer);
    this.incomingTimer = null;
  }
}

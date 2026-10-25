/** Verified receive path with explicit acceptance and durable OPFS recovery.
 * A journal is created before the first accept; resume re-reads every committed
 * file, rejects a mismatched peer/manifest, and hashes actual prefix bytes. A
 * transfer is complete only AFTER all files are committed and verified, with a
 * final doneAck to prevent premature sender completion.
 */
import {
  ACK_INTERVAL_BYTES, ACK_INTERVAL_MS, LIMITS, PROTOCOL_VERSION, validateManifest,
  type FileDescriptor, type ManifestMsg, type ResumeOffset,
} from '../../shared/protocol.js';
import { sanitizeRelPath } from '../../shared/filename.js';
import { Sha256 } from '../sha256.js';
import type { PeerSession } from '../peer.js';
import {
  checkStorage, clearTransferFiles, createSink, OpfsSink, opfsAvailable, readPartial,
  type ReceivedFile, type Sink,
} from './sink.js';
import { deletePending, getPending, journalAvailable, sameManifest, savePending } from './journal.js';
import type { FileProgress, TransferState } from './types.js';

interface StreamState {
  descriptor: FileDescriptor;
  sink: Sink | null;
  hasher: Sha256;
  received: number;
  acked: number;
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
  private receivedFiles = new Map<number, ReceivedFile>();
  private writeChain: Promise<void> = Promise.resolve();
  private lastSample = { at: Date.now(), bytes: 0 };
  private lastActivity = Date.now();
  private watchdog: number | null = null;
  private ackTimer: number | null = null;
  private incomingTimer: number | null = null;
  private finished = false;
  private persisted = false;

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
    this.files = manifest.files.map((descriptor) => ({ descriptor, sent: 0, verified: false, status: 'pending' }));
    for (const descriptor of manifest.files) this.streams.set(descriptor.streamId, {
      descriptor, sink: null, hasher: new Sha256(), received: 0, acked: 0, finalized: false, sha256: null,
    });
    this.incomingTimer = window.setTimeout(() => {
      if (this.state === 'incoming') this.decline('No response from the receiving device');
    }, INCOMING_TIMEOUT_MS);
  }

  get id(): string { return this.manifest.transferId; }
  get peerName(): string { return this.manifest.senderName || this.session.peer.name; }
  get peerDeviceId(): string { return this.session.peer.deviceId; }

  snapshot() {
    return {
      id: this.id, role: this.role, state: this.state, peerName: this.peerName,
      peerDeviceId: this.peerDeviceId, directionLabel: 'Receiving', files: this.files,
      totalBytes: this.totalBytes, transferredBytes: this.receivedBytes,
      startedAt: this.startedAt, finishedAt: this.finishedAt,
      bytesPerSecond: this.bytesPerSecond, etaSeconds: this.etaSeconds,
      error: this.error, verified: this.verified,
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
    try {
      const old = await getPending(this.id);
      if (old && (old.role !== 'receive' || old.peerDeviceId !== this.peerDeviceId || !sameManifest(old.manifest, this.manifest))) {
        throw new Error('Recovery journal belongs to a different device or file manifest; transfer refused');
      }
      if (old && !opfsAvailable()) throw new Error('Partial files are not accessible on this device');
      const canPersist = opfsAvailable() && journalAvailable() && !this.preferMemory &&
        this.manifest.files.every((f) => Boolean(f.sha256));
      const plan: ResumeOffset[] = [];
      if (old) {
        // No offset is taken from IDB. Even a "complete" journal must prove the
        // data really exists; a browser can evict OPFS independently of IDB.
        for (const descriptor of this.manifest.files) {
          const partial = await readPartial(this.id, descriptor);
          const state = this.streams.get(descriptor.streamId)!;
          if (!partial) {
            if (old.state === 'complete') throw new Error('A previously completed file is missing from storage');
            continue;
          }
          if (partial.size > descriptor.size) throw new Error('Partial file is larger than the manifest');
          const sink = new OpfsSink(descriptor, this.id);
          await sink.recover(partial);
          state.sink = sink;
          const reader = partial.stream().getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) state.hasher.update(value);
              if (this.finished) throw new Error('connection closed during recovery');
            }
          } finally { reader.releaseLock(); }
          const hash = state.hasher.clone().digestHex();
          if (partial.size === descriptor.size && hash !== descriptor.sha256) {
            throw new Error('Stored file SHA-256 does not match the manifest');
          }
          state.received = partial.size;
          state.acked = partial.size;
          this.receivedBytes += partial.size;
          plan.push({ streamId: descriptor.streamId, offset: partial.size, prefixSha256: hash });
          this.files.find((f) => f.descriptor.streamId === descriptor.streamId)!.sent = partial.size;
        }
      }
      const space = await checkStorage(Math.max(0, this.totalBytes - this.receivedBytes));
      if (!space.ok) throw new Error('Not enough storage space on this device for this transfer');
      // The memory-only fallback is deliberately bounded across the whole batch.
      if (!opfsAvailable() && this.totalBytes > LIMITS.memorySinkMaxBytes) {
        throw new Error('This platform cannot receive files this large without disk-backed storage');
      }
      if (canPersist) {
        await savePending({ id: this.id, role: 'receive', peerDeviceId: this.peerDeviceId,
          manifest: this.manifest, state: 'pending', updatedAt: Date.now() });
        this.persisted = true;
      }
      if (this.finished) return;
      this.state = 'transferring';
      this.startedAt = Date.now();
      this.lastActivity = Date.now();
      this.lastSample = { at: Date.now(), bytes: this.receivedBytes };
      this.session.sendControl({ t: 'accept', transferId: this.id, ...(old ? { resume: plan } : {}) });
      this.startWatchdog();
      this.ackTimer = window.setInterval(() => this.flushAcks(), ACK_INTERVAL_MS);
      this.opts.onUpdate(this);
    } catch (err) {
      const reason = (err as Error).message;
      this.session.sendControl({ t: 'decline', transferId: this.id, reason: reason.slice(0, 512) });
      // Do not delete a mismatched/complete journal: it may belong to a legitimate
      // previous transfer. It can be cleared explicitly from Settings instead.
      this.finished = true;
      this.state = 'failed';
      this.error = reason;
      this.finishedAt = Date.now();
      this.cleanupTimers();
      this.opts.onUpdate(this);
      this.opts.onFinished(this, []);
    }
  }

  decline(reason = 'Declined by receiver'): void {
    if (this.state !== 'incoming') return;
    this.finished = true;
    this.state = 'declined';
    this.error = reason;
    this.finishedAt = Date.now();
    this.cleanupTimers();
    this.session.sendControl({ t: 'decline', transferId: this.id, reason });
    this.opts.onUpdate(this);
    this.opts.onFinished(this, []);
  }

  cancel(reason = 'Cancelled by receiver'): void {
    if (this.finished) return;
    this.session.sendControl({ t: 'cancel', transferId: this.id, reason });
    void this.fail(reason, 'cancelled');
  }

  handleRemoteCancel(reason: string): void {
    void this.fail(reason || 'The sender cancelled the transfer', 'cancelled');
  }

  handleChunk(streamId: number, offset: number, data: Uint8Array): void {
    this.writeChain = this.writeChain.then(() => this.applyChunk(streamId, offset, data)).catch((err) => {
      void this.fail((err as Error).message);
    });
  }

  private async applyChunk(streamId: number, offset: number, data: Uint8Array): Promise<void> {
    if (this.finished) return;
    if (this.state !== 'transferring') throw new Error('received file data outside an active transfer');
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`data for unknown file stream ${streamId}`);
    if (stream.finalized) throw new Error('data arrived after the file was finalised');
    if (offset !== stream.received) throw new Error(`out-of-order data (expected offset ${stream.received}, received ${offset})`);
    if (stream.received + data.byteLength > stream.descriptor.size) throw new Error('received more data than declared');
    if (!stream.sink) stream.sink = await createSink(stream.descriptor, this.id, this.preferMemory);
    await stream.sink.write(offset, data);
    if (this.finished) return;
    stream.hasher.update(data);
    stream.received += data.byteLength;
    this.receivedBytes += data.byteLength;
    this.lastActivity = Date.now();
    this.currentFile = stream.descriptor.relPath;
    this.sampleThroughput();
    if (stream.received - stream.acked >= ACK_INTERVAL_BYTES) this.flushAcks();
    this.opts.onUpdate(this);
  }

  private flushAcks(): void {
    if (this.state !== 'transferring' && this.state !== 'verifying') return;
    for (const [streamId, stream] of this.streams) {
      if (stream.received <= stream.acked) continue;
      stream.acked = stream.received;
      this.session.sendControl({ t: 'chunkAck', transferId: this.id, streamId, bytes: stream.received });
    }
  }

  handleFileEnd(streamId: number, expectedHash: string, declaredSize: number): void {
    this.writeChain = this.writeChain.then(() => this.finalizeFile(streamId, expectedHash, declaredSize)).catch((err) => {
      this.session.sendControl({ t: 'fileResult', transferId: this.id, streamId, ok: false, error: (err as Error).message.slice(0, 512) });
      void this.fail((err as Error).message);
    });
  }

  private async finalizeFile(streamId: number, expectedHash: string, declaredSize: number): Promise<void> {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`end of unknown file stream ${streamId}`);
    if (this.finished || (this.state !== 'transferring' && this.state !== 'verifying')) throw new Error('file end outside an active transfer');
    if (stream.finalized) throw new Error('duplicate file end');
    stream.finalized = true;
    if (declaredSize !== stream.descriptor.size || stream.received !== stream.descriptor.size) {
      throw new Error(`size mismatch for ${stream.descriptor.relPath}: expected ${stream.descriptor.size}, received ${stream.received}`);
    }
    if (stream.descriptor.sha256 && stream.descriptor.sha256 !== expectedHash) throw new Error('sender SHA-256 differs from committed manifest');
    if (!stream.sink) stream.sink = await createSink(stream.descriptor, this.id, this.preferMemory);
    await stream.sink.finalize();
    this.flushAcks();
    const computed = stream.hasher.digestHex();
    if (computed !== expectedHash) throw new Error(`integrity check failed for ${stream.descriptor.relPath} (sha-256 mismatch)`);
    const received = await stream.sink.toReceivedFile(computed);
    if (received.size !== stream.descriptor.size) throw new Error('file changed after it was verified');
    stream.sha256 = computed;
    this.receivedFiles.set(streamId, received); // not exposed until ALL streams verified
    const progress = this.files.find((f) => f.descriptor.streamId === streamId)!;
    progress.status = 'complete';
    progress.verified = true;
    progress.sent = stream.received;
    this.session.sendControl({ t: 'fileResult', transferId: this.id, streamId, ok: true, sha256: computed });
    if ([...this.streams.values()].every((s) => s.finalized)) this.state = 'verifying';
    this.opts.onUpdate(this);
  }

  handleDone(): void {
    this.writeChain = this.writeChain.then(async () => {
      if (this.finished || (this.state !== 'verifying' && this.state !== 'transferring')) throw new Error('completion outside an active transfer');
      const missing = [...this.streams.values()].filter((s) => !s.finalized || !s.sha256);
      if (missing.length) throw new Error(`${missing.length} file(s) were never received and verified`);
      // Keep a completed journal for an idempotent replay if doneAck is lost.
      // The sender removes its own journal ONLY after receiving doneAck.
      if (this.persisted) await savePending({ id: this.id, role: 'receive', peerDeviceId: this.peerDeviceId,
        manifest: this.manifest, state: 'complete', updatedAt: Date.now() });
      this.finished = true;
      this.state = 'complete';
      this.verified = true;
      this.finishedAt = Date.now();
      this.etaSeconds = 0;
      this.cleanupTimers();
      this.session.sendControl({ t: 'doneAck', transferId: this.id, ok: true });
      this.opts.onUpdate(this);
      this.opts.onFinished(this, [...this.receivedFiles.values()]);
    }).catch((err) => {
      this.session.sendControl({ t: 'doneAck', transferId: this.id, ok: false, error: (err as Error).message.slice(0, 512) });
      void this.fail((err as Error).message);
    });
  }

  async fail(message: string, state: 'failed' | 'cancelled' = 'failed', notifyPeer = true): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.error = message;
    this.state = state;
    this.finishedAt = Date.now();
    this.cleanupTimers();
    if (state === 'failed' && notifyPeer) this.session.sendControl({ t: 'error', transferId: this.id, code: 'receive_failed', message: message.slice(0, 512) });
    // Wait for an in-flight write before deleting the ENTIRE transfer dir,
    // including files that passed an earlier per-file check in this batch.
    await this.writeChain.catch(() => undefined);
    for (const stream of this.streams.values()) await stream.sink?.abort(message).catch(() => undefined);
    if (this.persisted) await deletePending(this.id).catch(() => undefined);
    await clearTransferFiles(this.id).catch(() => undefined);
    this.receivedFiles.clear();
    for (const file of this.files) file.status = 'failed';
    this.opts.onUpdate(this);
    this.opts.onFinished(this, []);
  }

  handleSessionClosed(reason: string): void {
    if (this.finished) return;
    if (!this.persisted || this.state === 'incoming') {
      void this.fail(`Connection lost: ${reason}`);
      return;
    }
    this.finished = true;
    this.state = 'paused';
    this.error = `Connection lost: ${reason}. Reconnect and approve the matching retry to resume.`;
    this.finishedAt = Date.now();
    this.cleanupTimers();
    void this.writeChain.catch(() => undefined).then(() => {
      this.receivedFiles.clear();
      this.opts.onUpdate(this);
      this.opts.onFinished(this, []);
    });
  }

  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = window.setInterval(() => {
      if (this.state !== 'transferring' && this.state !== 'verifying') return;
      if (Date.now() - this.lastActivity > STALL_TIMEOUT_MS) void this.fail('The sender stopped responding');
    }, 5000);
  }

  private sampleThroughput(): void {
    const now = Date.now();
    const elapsed = (now - this.lastSample.at) / 1000;
    if (elapsed < 0.25) return;
    const instant = (this.receivedBytes - this.lastSample.bytes) / elapsed;
    this.bytesPerSecond = this.bytesPerSecond === 0 ? instant : this.bytesPerSecond * 0.75 + instant * 0.25;
    this.lastSample = { at: now, bytes: this.receivedBytes };
    const remaining = this.totalBytes - this.receivedBytes;
    this.etaSeconds = this.bytesPerSecond > 1024 ? remaining / this.bytesPerSecond : null;
  }

  private cleanupTimers(): void {
    if (this.watchdog !== null) clearInterval(this.watchdog);
    if (this.ackTimer !== null) clearInterval(this.ackTimer);
    if (this.incomingTimer !== null) clearTimeout(this.incomingTimer);
    this.watchdog = this.ackTimer = this.incomingTimer = null;
  }
}

/**
 * TransferManager — routes protocol traffic to the right task.
 *
 * Rules enforced here:
 *  - one outbound and one inbound transfer at a time per session (a second
 *    manifest while one is in flight is rejected with `busy`)
 *  - every inbound manifest is validated & sanitised before a task exists
 *  - chunks are only ever delivered to the task that owns the transferId via the
 *    active inbound task, so two transfers can never interleave bytes
 */
import {
  validateManifest,
  type ControlMessage,
  type ManifestMsg,
} from '../../shared/protocol.js';
import { sanitizeRelPath } from '../../shared/filename.js';
import type { PeerSession } from '../peer.js';
import { ReceiveTask } from './receiver.js';
import { SendTask } from './sender.js';
import type { ReceivedFile } from './sink.js';

export interface TransferManagerEvents {
  onUpdate: (task: SendTask | ReceiveTask) => void;
  onIncoming: (task: ReceiveTask) => void;
  onFinished: (task: SendTask | ReceiveTask, files: ReceivedFile[]) => void;
  onProtocolError: (message: string, fatal: boolean) => void;
}

export class TransferManager {
  private sends = new Map<string, SendTask>();
  private receives = new Map<string, ReceiveTask>();
  private activeReceive: ReceiveTask | null = null;
  private activeSend: SendTask | null = null;
  private queue: File[][] = [];
  private closed = false;

  constructor(
    private readonly session: PeerSession,
    private readonly localDeviceName: string,
    private readonly chunkSize: number,
    private readonly preferMemory: boolean,
    private readonly events: TransferManagerEvents,
  ) {}

  get active(): { send: SendTask | null; receive: ReceiveTask | null } {
    return { send: this.activeSend, receive: this.activeReceive };
  }

  /* ---------------------------------------------------------------- */
  /* Outbound                                                          */
  /* ---------------------------------------------------------------- */

  send(files: File[]): SendTask {
    const task = new SendTask(this.session, {
      files,
      peerName: this.session.peer.name,
      peerDeviceId: this.session.peer.deviceId,
      senderName: this.localDeviceName,
      chunkSize: this.chunkSize,
      onUpdate: (t) => this.events.onUpdate(t),
      onFinished: (t) => {
        if (this.activeSend === t) this.activeSend = null;
        this.events.onFinished(t, []);
        this.startNextQueued();
      },
    });
    this.sends.set(task.id, task);
    if (this.activeSend || !this.session.verified) {
      this.queue.push(files);
      if (!this.session.verified) {
        // Should not happen: the UI gates sending on verification.
        this.events.onUpdate(task);
      }
      return task;
    }
    this.activeSend = task;
    void task.run();
    return task;
  }

  private startNextQueued(): void {
    const next = this.queue.shift();
    if (!next || this.closed || !this.session.verified) return;
    this.send(next);
  }

  /* ---------------------------------------------------------------- */
  /* Inbound                                                           */
  /* ---------------------------------------------------------------- */

  handleControl(msg: ControlMessage): void {
    switch (msg.t) {
      case 'manifest': {
        this.handleManifest(msg);
        return;
      }
      case 'accept':
        this.sends.get(msg.transferId)?.handleAccept();
        return;
      case 'decline':
        this.sends.get(msg.transferId)?.handleDecline(msg.reason ?? 'The receiving device declined the transfer');
        return;
      case 'chunkAck':
        this.sends.get(msg.transferId)?.handleChunkAck(msg.streamId, msg.bytes);
        return;
      case 'fileResult':
        this.sends.get(msg.transferId)?.handleFileResult(msg.streamId, msg.ok, msg.error);
        return;
      case 'fileEnd':
        this.receives.get(msg.transferId)?.handleFileEnd(msg.streamId, msg.sha256, msg.size);
        return;
      case 'done':
        this.receives.get(msg.transferId)?.handleDone();
        return;
      case 'cancel': {
        const receive = this.receives.get(msg.transferId);
        if (receive) receive.handleRemoteCancel(msg.reason);
        const send = this.sends.get(msg.transferId);
        if (send && (send.state === 'transferring' || send.state === 'waiting-approval')) {
          void send.cancel(msg.reason || 'The receiving device cancelled');
        }
        return;
      }
      case 'error': {
        const receive = this.receives.get(msg.transferId ?? '');
        if (msg.code === 'busy') {
          this.events.onProtocolError('The other device is busy with another transfer', false);
          this.activeSend?.handleRemoteError('The other device is busy with another transfer');
        } else if (receive) {
          void receive.fail(msg.message);
        } else {
          this.activeSend?.handleRemoteError(msg.message);
          this.events.onProtocolError(msg.message, false);
        }
        return;
      }
      case 'hello':
      case 'helloAck':
        return; // handled by the peer session
      default:
        this.events.onProtocolError(`Unexpected message: ${(msg as { t: string }).t}`, false);
    }
  }

  private handleManifest(msg: ManifestMsg): void {
    if (this.activeReceive && !['complete', 'failed', 'cancelled', 'declined'].includes(this.activeReceive.state)) {
      this.session.sendControl({
        t: 'error',
        transferId: msg.transferId,
        code: 'busy',
        message: 'The receiving device is already handling another transfer',
      });
      return;
    }
    const check = validateManifest(msg, sanitizeRelPath);
    if (!check.ok) {
      this.session.sendControl({
        t: 'error',
        transferId: typeof msg.transferId === 'string' ? msg.transferId : undefined,
        code: 'invalid_manifest',
        message: `Transfer rejected: ${check.errors.slice(0, 3).join('; ')}`,
      });
      this.events.onProtocolError(`Rejected an invalid manifest: ${check.errors.join('; ')}`, false);
      return;
    }
    const sanitized: ManifestMsg = { ...msg, files: check.files, totalBytes: check.totalBytes };
    const task = new ReceiveTask(sanitized, this.session, this.preferMemory, {
      onUpdate: (t) => this.events.onUpdate(t),
      onFinished: (t, files) => {
        if (this.activeReceive === t) this.activeReceive = null;
        this.events.onFinished(t, files);
      },
    });
    this.receives.set(task.id, task);
    this.activeReceive = task;
    this.events.onIncoming(task);
    this.events.onUpdate(task);
  }

  handleChunk(streamId: number, offset: number, data: Uint8Array): void {
    const task = this.activeReceive;
    if (!task) {
      this.events.onProtocolError('Received file data with no active transfer', false);
      return;
    }
    task.handleChunk(streamId, offset, data);
  }

  getReceive(id: string): ReceiveTask | undefined {
    return this.receives.get(id);
  }

  getSend(id: string): SendTask | undefined {
    return this.sends.get(id);
  }

  /** The peer connection dropped: nothing can continue, so fail everything loudly. */
  handleSessionClosed(reason: string): void {
    this.closed = true;
    this.queue = [];
    for (const task of this.sends.values()) task.handleSessionClosed(reason);
    for (const task of this.receives.values()) task.handleSessionClosed(reason);
  }

  get oneShot(): boolean {
    return this.closed;
  }
}

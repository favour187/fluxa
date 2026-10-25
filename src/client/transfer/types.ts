import type { FileDescriptor } from '../../shared/protocol.js';

export type TransferRole = 'send' | 'receive';

export type TransferState =
  | 'preparing'
  | 'waiting-approval' // sender: manifest sent, receiver has not answered
  | 'incoming' // receiver: approval dialog open
  | 'transferring'
  | 'verifying'
  | 'paused' // durable partial; user re-pairs and re-selects the source to resume
  | 'complete'
  | 'declined'
  | 'cancelled'
  | 'failed';

export interface FileProgress {
  descriptor: FileDescriptor;
  sent: number;
  verified: boolean;
  status: 'pending' | 'sending' | 'verifying' | 'complete' | 'failed';
  error?: string;
}

export interface TransferSnapshot {
  id: string;
  role: TransferRole;
  state: TransferState;
  peerName: string;
  peerDeviceId: string;
  directionLabel: string;
  files: FileProgress[];
  totalBytes: number;
  transferredBytes: number;
  startedAt: number;
  finishedAt: number | null;
  bytesPerSecond: number;
  etaSeconds: number | null;
  error: string | null;
  verified: boolean;
}

export interface TransferProgressEvent {
  id: string;
  transferredBytes: number;
  totalBytes: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  currentFile: string | null;
}

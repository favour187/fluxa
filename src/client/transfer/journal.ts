/** Durable, origin-scoped transfer metadata. Never stores file bytes or keys.
 * File bytes live in OPFS; a journal alone is NOT evidence of a valid prefix.
 * Recovery always re-reads and hashes the actual OPFS file before advertising
 * an offset to the sender. Sender re-selects and re-hashes its source files.
 */
import type { ManifestMsg } from '../../shared/protocol.js';

export interface PendingTransfer {
  id: string;
  role: 'send' | 'receive';
  peerDeviceId: string;
  manifest: ManifestMsg;
  state: 'pending' | 'complete';
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  role: 'send' | 'receive';
  state: string;
  peerName: string;
  peerDeviceId: string;
  files: { name: string; relPath: string; size: number; sha256?: string }[];
  totalBytes: number;
  transferredBytes: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

const DB = 'fluxa-transfers';
const VERSION = 1;

export function journalAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('pending')) request.result.createObjectStore('pending', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('history')) request.result.createObjectStore('history', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function operation<T>(store: 'pending' | 'history', mode: IDBTransactionMode, action: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = action(tx.objectStore(store));
    let result: T;
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => { db.close(); resolve(result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export async function savePending(entry: PendingTransfer): Promise<void> {
  if (!journalAvailable()) return; // Node unit harness; browsers require IDB for recovery.
  await operation('pending', 'readwrite', (s) => s.put(entry));
}

export async function getPending(id: string): Promise<PendingTransfer | undefined> {
  if (!journalAvailable()) return undefined;
  return operation('pending', 'readonly', (s) => s.get(id));
}

export async function listPending(): Promise<PendingTransfer[]> {
  if (!journalAvailable()) return [];
  return operation('pending', 'readonly', (s) => s.getAll());
}

export async function deletePending(id: string): Promise<void> {
  if (!journalAvailable()) return;
  await operation('pending', 'readwrite', (s) => s.delete(id));
}

export async function saveHistory(entry: HistoryEntry): Promise<void> {
  if (!journalAvailable()) return;
  await operation('history', 'readwrite', (s) => s.put(entry));
}

export async function listHistory(): Promise<HistoryEntry[]> {
  if (!journalAvailable()) return [];
  return operation('history', 'readonly', (s) => s.getAll());
}

export async function clearHistory(): Promise<void> {
  if (!journalAvailable()) return;
  await operation('history', 'readwrite', (s) => s.clear());
}

/** Only compare immutable, wire-relevant fields. Names/date are cosmetic. */
export function sameManifest(a: ManifestMsg, b: ManifestMsg): boolean {
  return a.transferId === b.transferId && a.v === b.v && a.totalBytes === b.totalBytes &&
    JSON.stringify(a.files) === JSON.stringify(b.files);
}

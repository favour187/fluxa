/**
 * Device identity + trust store.
 *
 * The identity is an ECDSA P-256 keypair generated once per browser profile.
 * The private key is stored as a non-extractable CryptoKey in IndexedDB, so it
 * can be used by this origin but never read out by JavaScript. The device id is
 * the SHA-256 of the public key, which makes display names cosmetic and lets
 * peers pin real cryptographic identities.
 */
import { deriveDeviceId, exportPublicKeySpki, generateIdentityKeyPair } from '../shared/crypto.js';

const DB_NAME = 'fluxa';
const DB_VERSION = 1;
const KV_STORE = 'kv';
const DEVICE_STORE = 'devices';

export interface TrustedDevice {
  deviceId: string;
  publicKey: string;
  fingerprint: string;
  name: string;
  platform: string;
  trustedAt: number;
  lastSeen: number;
}

export interface Identity {
  deviceId: string;
  publicKey: string;
  fingerprint: string;
  privateKey: CryptoKey;
  name: string;
  platform: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
      if (!db.objectStoreNames.contains(DEVICE_STORE)) db.createObjectStore(DEVICE_STORE, { keyPath: 'deviceId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function idbPut(store: string, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const objectStore = tx.objectStore(store);
    // An in-line key path (e.g. devices.deviceId) makes an explicit key a
    // DataError, so only pass one for out-of-line stores such as `kv`.
    if (key !== undefined && !objectStore.keyPath) objectStore.put(value, key);
    else objectStore.put(value);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

/** Human-comparable short form of a device id: 4 groups of 4 base32-ish chars. */
export function shortId(deviceId: string): string {
  const clean = deviceId.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return [clean.slice(0, 4), clean.slice(4, 8), clean.slice(8, 12), clean.slice(12, 16)].join('-');
}

export function detectPlatform(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Web';
}

function defaultDeviceName(): string {
  const platform = detectPlatform();
  const adjectives = ['Swift', 'Quiet', 'Bright', 'North', 'Rapid', 'Clear', 'Silver', 'Amber'];
  const pick = adjectives[Math.floor(Math.random() * adjectives.length)]!;
  return `${pick} ${platform}`;
}

export async function loadIdentity(): Promise<Identity> {
  let pair = (await idbGet<CryptoKeyPair>(KV_STORE, 'identityKey')) as CryptoKeyPair | undefined;
  if (!pair || !pair.privateKey || !pair.publicKey) {
    pair = await generateIdentityKeyPair();
    await idbPut(KV_STORE, pair, 'identityKey');
  }
  const publicKey = await exportPublicKeySpki(pair.publicKey);
  const deviceId = await deriveDeviceId(publicKey);
  const storedName = await idbGet<string>(KV_STORE, 'deviceName');
  let name = typeof storedName === 'string' && storedName.trim() ? storedName.trim() : defaultDeviceName();
  if (!storedName) await idbPut(KV_STORE, name, 'deviceName');
  return {
    deviceId,
    publicKey,
    fingerprint: await fingerprintOf(publicKey),
    privateKey: pair.privateKey,
    name,
    platform: detectPlatform(),
  };
}

export async function setDeviceName(name: string): Promise<void> {
  await idbPut(KV_STORE, name.trim().slice(0, 48), 'deviceName');
}

/** SHA-256 of the SPKI bytes, formatted as a colon-separated hex fingerprint. */
export async function fingerprintOf(publicKeyB64: string): Promise<string> {
  const { b64urlDecode, sha256, toHex } = await import('../shared/crypto.js');
  const hex = toHex(await sha256(b64urlDecode(publicKeyB64))).toUpperCase();
  return hex.match(/.{2}/g)!.join(':');
}

export async function listTrusted(): Promise<TrustedDevice[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DEVICE_STORE, 'readonly');
    const req = tx.objectStore(DEVICE_STORE).getAll();
    req.onsuccess = () => resolve((req.result as TrustedDevice[]).sort((a, b) => b.lastSeen - a.lastSeen));
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export async function getTrusted(deviceId: string): Promise<TrustedDevice | undefined> {
  return idbGet<TrustedDevice>(DEVICE_STORE, deviceId);
}

/**
 * Record a device after a successful, user-confirmed pairing.
 * If the id already exists we keep the original public key and refuse to
 * overwrite it: a changed key for the same id is a bug or an attack.
 */
export async function trustDevice(device: Omit<TrustedDevice, 'trustedAt' | 'lastSeen'>): Promise<void> {
  const existing = await getTrusted(device.deviceId);
  const now = Date.now();
  if (existing && existing.publicKey !== device.publicKey) {
    throw new Error('device key changed since it was trusted — refusing to overwrite');
  }
  await idbPut(
    DEVICE_STORE,
    {
      ...device,
      trustedAt: existing?.trustedAt ?? now,
      lastSeen: now,
    },
    device.deviceId,
  );
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await idbDelete(DEVICE_STORE, deviceId);
}

export async function touchDevice(deviceId: string): Promise<void> {
  const existing = await getTrusted(deviceId);
  if (!existing) return;
  await idbPut(DEVICE_STORE, { ...existing, lastSeen: Date.now() }, deviceId);
}

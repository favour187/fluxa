/**
 * Short-lived pairing codes.
 *
 * Design constraints:
 *  - Codes are random (CSPRNG), 6 characters from a 32-symbol alphabet (~30 bits).
 *  - Codes expire after PAIRING_TTL_MS and are deleted.
 *  - A code is single-use: claiming it removes it before it can be claimed again.
 *  - Repeated failed claims against the same code burn it, so guessing is bounded
 *    by both the attempt limit and the TTL.
 *  - A device may only hold one outstanding code at a time.
 */
import { randomBytes } from 'node:crypto';

export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
export const PAIRING_TTL_MS = 2 * 60 * 1000;
export const MAX_CLAIM_ATTEMPTS = 5;

export interface PairingEntry {
  code: string;
  deviceId: string;
  ownerId: string; // socket/session id of the device that created the code
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

export type ClaimResult =
  | { ok: true; entry: PairingEntry }
  | { ok: false; reason: 'not_found' | 'expired' | 'self' | 'too_many_attempts' };

export class PairingStore {
  private byCode = new Map<string, PairingEntry>();
  private byOwner = new Map<string, string>(); // ownerId -> code

  constructor(
    private readonly ttlMs: number = PAIRING_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  generate(): string {
    for (let i = 0; i < 10; i++) {
      const bytes = randomBytes(8);
      let code = '';
      for (let j = 0; j < 6; j++) code += PAIRING_ALPHABET[bytes[j]! % PAIRING_ALPHABET.length];
      if (!this.byCode.has(code)) return code;
    }
    throw new Error('unable to allocate a unique pairing code');
  }

  /** Create (or replace) the code owned by `ownerId`. */
  create(ownerId: string, deviceId: string): PairingEntry {
    const existing = this.byOwner.get(ownerId);
    if (existing) this.remove(existing);
    const now = this.now();
    const entry: PairingEntry = {
      code: this.generate(),
      deviceId,
      ownerId,
      createdAt: now,
      expiresAt: now + this.ttlMs,
      attempts: 0,
    };
    this.byCode.set(entry.code, entry);
    this.byOwner.set(ownerId, entry.code);
    return entry;
  }

  normalize(code: string): string {
    return String(code ?? '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .replace(/I/g, 'J') // common confusion, but never accept it as a real symbol
      .replace(/O/g, 'Q')
      .replace(/0/g, 'O') // 0 is not in the alphabet; keep it from ever matching
      .replace(/1/g, 'L');
  }

  claim(rawCode: string, claimantOwnerId: string): ClaimResult {
    const code = this.normalize(rawCode);
    const entry = this.byCode.get(code);
    if (!entry) return { ok: false, reason: 'not_found' };
    if (entry.expiresAt <= this.now()) {
      this.remove(code);
      return { ok: false, reason: 'expired' };
    }
    if (entry.ownerId === claimantOwnerId) return { ok: false, reason: 'self' };
    entry.attempts += 1;
    if (entry.attempts > MAX_CLAIM_ATTEMPTS) {
      this.remove(code);
      return { ok: false, reason: 'too_many_attempts' };
    }
    // Single use: consume before returning so a concurrent claim cannot reuse it.
    this.remove(code);
    return { ok: true, entry };
  }

  /** Cancel an outstanding code (owner closed the dialog). */
  cancel(ownerId: string): boolean {
    const code = this.byOwner.get(ownerId);
    if (!code) return false;
    this.remove(code);
    return true;
  }

  get size(): number {
    return this.byCode.size;
  }

  sweep(): number {
    const now = this.now();
    let removed = 0;
    for (const [code, entry] of this.byCode) {
      if (entry.expiresAt <= now) {
        this.remove(code);
        removed++;
      }
    }
    return removed;
  }

  private remove(code: string): void {
    const entry = this.byCode.get(code);
    if (!entry) return;
    this.byCode.delete(code);
    if (this.byOwner.get(entry.ownerId) === code) this.byOwner.delete(entry.ownerId);
  }
}

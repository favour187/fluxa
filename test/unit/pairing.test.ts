import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CLAIM_ATTEMPTS, PAIRING_ALPHABET, PairingStore } from '../../src/server/pairing.js';
import { RateLimiter } from '../../src/server/ratelimit.js';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

test('codes use an unambiguous alphabet and have the documented length', () => {
  const store = new PairingStore();
  for (let i = 0; i < 50; i++) {
    const entry = store.create(`owner-${i}`, `device-${i}`);
    assert.equal(entry.code.length, 6);
    for (const ch of entry.code) assert.ok(PAIRING_ALPHABET.includes(ch), `unexpected symbol ${ch}`);
    assert.ok(!/[IO01]/.test(entry.code), 'ambiguous characters must never be issued');
  }
});

test('a code can be claimed exactly once', () => {
  const store = new PairingStore();
  const entry = store.create('owner', 'device-a');
  const first = store.claim(entry.code, 'claimant');
  assert.equal(first.ok, true);
  const second = store.claim(entry.code, 'someone-else');
  assert.deepEqual(second, { ok: false, reason: 'not_found' });
  assert.equal(store.size, 0);
});

test('codes are case-insensitive and tolerant of separators', () => {
  const store = new PairingStore();
  const entry = store.create('owner', 'device-a');
  const spaced = `${entry.code.slice(0, 3)} ${entry.code.slice(3).toLowerCase()}`;
  assert.equal(store.claim(spaced, 'claimant').ok, true);
});

test('expired codes cannot be reused', () => {
  const c = clock();
  const store = new PairingStore(1000, c.now);
  const entry = store.create('owner', 'device-a');
  c.advance(1001);
  assert.deepEqual(store.claim(entry.code, 'claimant'), { ok: false, reason: 'expired' });
  assert.equal(store.size, 0);
});

test('a device may only hold one outstanding code', () => {
  const store = new PairingStore();
  const first = store.create('owner', 'device-a');
  const second = store.create('owner', 'device-a');
  assert.notEqual(first.code, second.code);
  assert.deepEqual(store.claim(first.code, 'claimant'), { ok: false, reason: 'not_found' });
  assert.equal(store.claim(second.code, 'claimant').ok, true);
});

test('owners cannot claim their own code', () => {
  const store = new PairingStore();
  const entry = store.create('owner', 'device-a');
  assert.deepEqual(store.claim(entry.code, 'owner'), { ok: false, reason: 'self' });
  // ... and the code is still usable by someone else afterwards.
  assert.equal(store.claim(entry.code, 'someone').ok, true);
});

test('guessing is bounded by the attempt limit', () => {
  const store = new PairingStore();
  const entry = store.create('owner', 'device-a');
  for (let i = 0; i < MAX_CLAIM_ATTEMPTS; i++) {
    assert.deepEqual(store.claim('ZZZZZZ', 'attacker'), { ok: false, reason: 'not_found' });
  }
  // Attempts are tracked per code, so the real code survives wrong guesses made
  // against other (non-existent) codes.
  assert.equal(store.claim(entry.code, 'legit').ok, true);
});

test('cancel removes an outstanding code', () => {
  const store = new PairingStore();
  const entry = store.create('owner', 'device-a');
  assert.equal(store.cancel('owner'), true);
  assert.deepEqual(store.claim(entry.code, 'claimant'), { ok: false, reason: 'not_found' });
  assert.equal(store.cancel('owner'), false);
});

test('sweep removes only expired entries', () => {
  const c = clock();
  const store = new PairingStore(1000, c.now);
  store.create('a', 'device-a');
  c.advance(600);
  store.create('b', 'device-b');
  c.advance(600);
  assert.equal(store.sweep(), 1);
  assert.equal(store.size, 1);
});

test('rate limiter refills over time and isolates keys', () => {
  const c = clock();
  const limiter = new RateLimiter(3, 1, c.now);
  assert.equal(limiter.take('ip-1'), true);
  assert.equal(limiter.take('ip-1'), true);
  assert.equal(limiter.take('ip-1'), true);
  assert.equal(limiter.take('ip-1'), false);
  assert.equal(limiter.take('ip-2'), true, 'other keys are unaffected');
  c.advance(1000);
  assert.equal(limiter.take('ip-1'), true);
});

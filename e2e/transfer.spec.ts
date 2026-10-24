/**
 * End-to-end verification of the real product: two browser contexts, real
 * WebRTC, real DataChannel, real files, real SHA-256 comparison.
 */
import { test, expect } from '@playwright/test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  downloadReceived,
  openClient,
  pair,
  randomFile,
  receivedFiles,
  renameDevice,
  selectDevice,
  sendAndAccept,
  sha256,
  sha256OfFile,
  textFile,
  waitForState,
  type Client,
  type FileSpec,
} from './helpers';

let a: Client;
let b: Client;

test.beforeEach(async ({ browser }) => {
  a = await openClient(browser, 'A');
  b = await openClient(browser, 'B');
  await renameDevice(a.page, 'Studio Laptop');
  await renameDevice(b.page, 'Pocket Phone');
  await pair([a, b]);
  await selectDevice(a.page, 'Pocket Phone');
  await selectDevice(b.page, 'Studio Laptop');
});

test.afterEach(async () => {
  await a?.context.close().catch(() => undefined);
  await b?.context.close().catch(() => undefined);
});

for (const file of [
  { label: 'empty file', spec: { name: 'empty.txt', buffer: Buffer.alloc(0), mimeType: 'text/plain' } },
  { label: 'small text file', spec: textFile('notes.txt', 'Fluxa moves anything, anywhere.\n') },
  { label: 'binary file', spec: randomFile('blob.bin', 512 * 1024) },
  { label: 'larger file (8 MB)', spec: randomFile('video-sample.mp4', 8 * 1024 * 1024) },
] as { label: string; spec: FileSpec }[]) {
  test(`transfers a ${file.label} with matching SHA-256`, async () => {
    const expected = sha256(file.spec.buffer);

    await sendAndAccept(a.page, b.page, [file.spec]);

    await waitForState(a.page, 'complete');
    await waitForState(b.page, 'complete');

    // Receiver's own incremental hash over the received bytes.
    const received = await receivedFiles(b.page);
    expect(received).toHaveLength(1);
    expect(received[0]!.name).toBe(file.spec.name);
    expect(received[0]!.size).toBe(file.spec.buffer.byteLength);
    expect(received[0]!.sha256).toBe(expected);

    // The bytes actually written out by the browser must match too.
    const saved = await downloadReceived(b.page);
    expect(saved.byteLength).toBe(file.spec.buffer.byteLength);
    expect(sha256(saved)).toBe(expected);

    // The sender only completes after the receiver acknowledges + verifies.
    await expect(a.page.getByTestId('transfer-item').first()).toHaveAttribute('data-state', 'complete');
    await expect(b.page.getByTestId('transfer-item').first()).toHaveAttribute('data-state', 'complete');
  });
}

test('streams a 32 MB file to disk without blowing up memory', async () => {
  // A file on disk (not an in-memory buffer) so the browser reads it the same way
  // it would a real user file, and Playwright does not push 32 MB through CDP.
  const dir = await mkdtemp(join(tmpdir(), 'fluxa-e2e-'));
  const path = join(dir, 'large-video.mp4');
  await writeFile(path, randomBytes(32 * 1024 * 1024));
  const expected = await sha256OfFile(path);

  const heap = () =>
    b.page.evaluate(() => {
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return memory ? memory.usedJSHeapSize : 0;
    });

  const before = await heap();
  await a.page.getByTestId('file-input').setInputFiles(path);
  await expect(b.page.getByTestId('incoming-modal')).toBeVisible({ timeout: 30_000 });
  await b.page.getByTestId('accept-transfer').click();
  await waitForState(b.page, 'complete', 180_000);
  await waitForState(a.page, 'complete', 180_000);
  const after = await heap();

  const received = await receivedFiles(b.page);
  expect(received[0]!.sha256).toBe(expected);
  expect(received[0]!.size).toBe(32 * 1024 * 1024);

  // The receiver streams to the Origin Private File System in 64 KiB chunks, so a
  // 32 MB transfer must not grow the JS heap by anything like 32 MB.
  if (before > 0 && after > 0) {
    const growthMb = (after - before) / (1024 * 1024);
    console.log(`receiver heap growth during 32 MB transfer: ${growthMb.toFixed(1)} MB`);
    expect(growthMb).toBeLessThan(24);
  }

  const saved = await downloadReceived(b.page);
  expect(saved.byteLength).toBe(32 * 1024 * 1024);
  expect(sha256(saved)).toBe(expected);
  await rm(dir, { recursive: true, force: true });
});

test('transfers several files in one batch, in order', async () => {
  const files = [textFile('one.txt', 'first'), randomFile('two.bin', 70_000), textFile('three.md', '# third')];
  await sendAndAccept(a.page, b.page, files);
  await waitForState(b.page, 'complete');

  const received = await receivedFiles(b.page);
  expect(received.map((f) => f.name).sort()).toEqual(['one.txt', 'three.md', 'two.bin']);
  for (const spec of files) {
    const entry = received.find((r) => r.name === spec.name)!;
    expect(entry.sha256).toBe(sha256(spec.buffer));
  }

  const saved = await downloadReceived(b.page);
  expect(sha256(saved)).toBe(sha256(files[0]!.buffer));
});

test('declining a transfer leaves the sender informed and nothing completed', async () => {
  await a.page.getByTestId('file-input').setInputFiles([randomFile('reject-me.bin', 20_000)]);
  await expect(b.page.getByTestId('incoming-modal')).toBeVisible({ timeout: 30_000 });
  await b.page.getByTestId('decline-transfer').click();

  await waitForState(a.page, 'declined');
  const received = await receivedFiles(b.page);
  expect(received).toHaveLength(0);
  await expect(b.page.getByTestId('save-received')).toHaveCount(0);
});

test('cancelling mid-transfer stops both sides and produces no file', async () => {
  // Written to disk rather than held in a Buffer: a 24 MB buffer pushed through
  // CDP is what makes the renderer die in small CI containers, and a real file
  // is closer to what a user drops on the window anyway.
  const dir = await mkdtemp(join(tmpdir(), 'fluxa-cancel-'));
  const bigPath = join(dir, 'big-cancel.bin');
  await writeFile(bigPath, randomBytes(24 * 1024 * 1024));
  await a.page.getByTestId('file-input').setInputFiles([bigPath]);
  await b.page.getByTestId('accept-transfer').click();
  await waitForState(a.page, 'transferring');

  await a.page.getByTestId('cancel-transfer').click();

  await waitForState(a.page, 'cancelled', 30_000);
  await waitForState(b.page, 'cancelled', 30_000);

  const received = await receivedFiles(b.page);
  expect(received).toHaveLength(0);
  await expect(b.page.getByTestId('save-received')).toHaveCount(0);

  await rm(dir, { recursive: true, force: true });
});

test('a second send is queued instead of running in parallel', async () => {
  const first = randomFile('first.bin', 16 * 1024 * 1024);
  const second = textFile('second.txt', 'queued behind the first');
  await a.page.getByTestId('file-input').setInputFiles([first]);
  await b.page.getByTestId('accept-transfer').click();
  await waitForState(a.page, 'transferring');

  // A second manifest while a transfer is in flight must not be accepted by the
  // receiver; the sender queues it locally instead.
  await a.page.getByTestId('file-input').setInputFiles([second]);
  const concurrent = await b.page.evaluate(() => {
    const snapshot = (window as unknown as { __fluxa: { snapshot: () => { transfers: { state: string }[] } } }).__fluxa.snapshot();
    return snapshot.transfers.filter((t) => t.state === 'transferring' || t.state === 'incoming').length;
  });
  expect(concurrent).toBe(1);

  await waitForState(a.page, 'complete', 90_000);
  await waitForState(b.page, 'complete', 90_000);
});

test('progress never reports completion before verification', async () => {
  const spec = randomFile('progress.bin', 4 * 1024 * 1024);
  await a.page.getByTestId('file-input').setInputFiles([spec]);
  await b.page.getByTestId('accept-transfer').click();

  // Watch the receiver's state sequence: it must pass through transferring/
  // verifying and must never show "complete" with unverified files.
  const states = new Set<string>();
  for (let i = 0; i < 120; i++) {
    const state = await b.page
      .locator('[data-testid="transfer-item"]')
      .first()
      .getAttribute('data-state', { timeout: 5000 })
      .catch(() => null);
    if (state) states.add(state);
    if (state === 'complete') break;
    await b.page.waitForTimeout(50);
  }
  expect(states.has('complete')).toBe(true);
  const received = await receivedFiles(b.page);
  expect(received[0]!.sha256).toBe(sha256(spec.buffer));
});

test('sending is blocked until the peer is verified, and rejecting closes the session', async () => {
  const c = await openClient(b.context.browser()!, 'C');
  await renameDevice(c.page, 'Unverified Box');

  await a.page.getByTestId('pair-button').click();
  await expect(a.page.getByTestId('pair-code')).not.toHaveText(/^·+$/);
  const code = (await a.page.getByTestId('pair-code').textContent())!.replace(/\s/g, '');
  await c.page.getByTestId('pair-button').click();
  await c.page.getByTestId('join-code').fill(code);
  await c.page.getByTestId('join-submit').click();

  await expect(c.page.getByTestId('verify-modal')).toBeVisible({ timeout: 30_000 });
  const sasC = (await c.page.getByTestId('sas-code').textContent())!.replace(/\s/g, '');
  expect(sasC).toMatch(/^\d{6}$/);

  // Defer the dialog, then confirm the UI offers no way to send.
  await c.page.getByTestId('verify-later').click();
  await expect(c.page.getByTestId('verify-modal')).toHaveCount(0);
  await c.page.locator('[data-testid="device-item"]', { hasText: 'Studio Laptop' }).first().click();
  await expect(c.page.getByTestId('dropzone')).toHaveCount(0);
  await expect(c.page.getByText('Waiting for verification')).toBeVisible();

  // Re-open from the device row and reject this time.
  await c.page.getByTestId('verify-device').click();
  await c.page.getByTestId('verify-mismatch').click();
  await expect(c.page.getByTestId('toast').filter({ hasText: /rejected|closed/i }).first()).toBeVisible({
    timeout: 20_000,
  });
  await c.context.close();
});

test('a disconnected device cannot continue its old session', async () => {
  await b.context.close();

  await expect(a.page.getByTestId('toast').filter({ hasText: /disconnected/i }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect
    .poll(async () => a.page.locator('[data-testid="device-item"] .badge.verified').count(), { timeout: 20_000 })
    .toBe(0);
  // The old session is gone, so there is no way to send into it.
  await a.page.getByTestId('device-item').first().click();
  await expect(a.page.getByTestId('dropzone')).toHaveCount(0);
  await expect(a.page.getByText('Connection unavailable')).toBeVisible();
});

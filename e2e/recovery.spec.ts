/** Real IndexedDB + OPFS recovery across page restarts with two Chromium devices. */
import { test, expect, type Page } from '@playwright/test';
import { copyFile, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { downloadReceived, openClient, pair, renameDevice, selectDevice, stageAndSend, sha256OfFile, waitForState } from './helpers';

async function transfer(page: Page) {
  return page.evaluate(() => (window.__fluxa!.snapshot() as any).transfers[0] as {
    id: string; state: string; transferredBytes: number; files: { relPath: string }[];
  });
}

async function partialSize(page: Page, id: string, name: string): Promise<number> {
  return page.evaluate(async ({ id, name }) => {
    const root = await navigator.storage.getDirectory();
    const directory = await (await root.getDirectoryHandle('fluxa-received')).getDirectoryHandle(id);
    const file = await directory.getFileHandle(name);
    return (await file.getFile()).size;
  }, { id, name });
}

async function pendingExists(page: Page, id: string): Promise<boolean> {
  return page.evaluate((id) => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('fluxa-transfers');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const read = db.transaction('pending').objectStore('pending').get(id);
      read.onsuccess = () => { db.close(); resolve(Boolean(read.result)); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  }), id);
}

test('interrupted send resumes from rehashed OPFS bytes after both browser tabs restart', async ({ browser }) => {
  test.setTimeout(240_000);
  const a = await openClient(browser, 'resuming sender');
  const b = await openClient(browser, 'resuming receiver');
  const dir = await mkdtemp(join(tmpdir(), 'fluxa-resume-'));
  try {
    await renameDevice(a.page, 'Recovery Source');
    await renameDevice(b.page, 'Recovery Destination');
    await pair([a, b]);
    await selectDevice(a.page, 'Recovery Destination');
    const file = join(dir, 'restart.bin');
    await writeFile(file, randomBytes(48 * 1024 * 1024));
    const expected = await sha256OfFile(file);
    await stageAndSend(a.page, file);
    await b.page.getByTestId('accept-transfer').click();
    await expect.poll(async () => (await transfer(b.page)).transferredBytes, { timeout: 30_000 }).toBeGreaterThan(2 * 1024 * 1024);
    const { id, files } = await transfer(b.page);
    // Refreshing the receiver tears down the connection while preserving its
    // origin-scoped IDB + OPFS. Refresh the sender too to lose its File object.
    await b.page.reload();
    await a.page.reload();
    await expect(a.page.getByTestId('signal-status')).toHaveAttribute('data-state', 'online');
    await expect(b.page.getByTestId('signal-status')).toHaveAttribute('data-state', 'online');
    await waitForState(a.page, 'paused');
    await waitForState(b.page, 'paused');
    const committed = await partialSize(b.page, id, files[0]!.relPath);
    expect(committed).toBeGreaterThan(0);
    expect(committed).toBeLessThan(48 * 1024 * 1024);
    expect(await pendingExists(a.page, id)).toBe(true);
    expect(await pendingExists(b.page, id)).toBe(true);

    await pair([a, b]); // Fresh WebRTC session + fresh human SAS approval.

    // Re-selecting a same-name and same-size file with DIFFERENT bytes must
    // fail before any resumed data is offered and must retain the journal.
    const wrongDir = join(dir, 'wrong');
    await mkdir(wrongDir);
    const wrongFile = join(wrongDir, 'restart.bin');
    await copyFile(file, wrongFile);
    const handle = await open(wrongFile, 'r+');
    try {
      const first = Buffer.alloc(1);
      await handle.read(first, 0, 1, 0);
      await handle.write(Buffer.from([first[0]! ^ 0xff]), 0, 1, 0);
    } finally { await handle.close(); }
    const [wrongChooser] = await Promise.all([
      a.page.waitForEvent('filechooser'),
      a.page.getByTestId('resume-transfer').first().click(),
    ]);
    await wrongChooser.setFiles(wrongFile);
    await expect(a.page.getByTestId('transfer-item').first()).toHaveAttribute('data-state', 'paused');
    await expect(a.page.getByTestId('transfer-item').first()).toContainText(/do not match the original transfer/i);
    expect(await pendingExists(a.page, id)).toBe(true);
    expect(await partialSize(b.page, id, files[0]!.relPath)).toBe(committed);

    const [chooser] = await Promise.all([
      a.page.waitForEvent('filechooser'),
      a.page.getByTestId('resume-transfer').first().click(),
    ]);
    await chooser.setFiles(file);
    await expect(b.page.getByTestId('incoming-modal')).toBeVisible({ timeout: 30_000 });
    await b.page.getByTestId('accept-transfer').click();
    await waitForState(b.page, 'complete', 180_000);
    await waitForState(a.page, 'complete', 180_000);
    expect((await transfer(a.page)).id).toBe(id);
    const saved = await downloadReceived(b.page);
    expect(saved.byteLength).toBe(48 * 1024 * 1024);
    expect((await import('node:crypto')).createHash('sha256').update(saved).digest('hex')).toBe(expected);
    await expect.poll(() => pendingExists(a.page, id)).toBe(false);

    // A second restart must still show honest completed history and offer the
    // finished OPFS-backed files again, without asking the sender to retransmit.
    await b.page.reload();
    await waitForState(b.page, 'complete');
    const savedAgain = await downloadReceived(b.page);
    expect(savedAgain.equals(saved)).toBe(true);
  } finally {
    await a.context.close();
    await b.context.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupted stored prefix is refused before any resumed bytes are trusted', async ({ browser }) => {
  test.setTimeout(180_000);
  const a = await openClient(browser, 'integrity sender');
  const b = await openClient(browser, 'integrity receiver');
  const dir = await mkdtemp(join(tmpdir(), 'fluxa-corrupt-'));
  try {
    await renameDevice(a.page, 'Source');
    await renameDevice(b.page, 'Destination');
    await pair([a, b]);
    await selectDevice(a.page, 'Destination');
    const file = join(dir, 'tamper.bin');
    await writeFile(file, randomBytes(32 * 1024 * 1024));
    await stageAndSend(a.page, file);
    await b.page.getByTestId('accept-transfer').click();
    await expect.poll(async () => (await transfer(b.page)).transferredBytes, { timeout: 30_000 }).toBeGreaterThan(2 * 1024 * 1024);
    const { id, files } = await transfer(b.page);
    await b.page.reload();
    await a.page.reload();
    await waitForState(a.page, 'paused');
    await waitForState(b.page, 'paused');
    const committed = await partialSize(b.page, id, files[0]!.relPath);
    expect(committed).toBeGreaterThan(0);

    // Simulate a corrupt/evicted OPFS prefix with the same length and metadata.
    await b.page.evaluate(async ({ id, name }) => {
      const root = await navigator.storage.getDirectory();
      const directory = await (await root.getDirectoryHandle('fluxa-received')).getDirectoryHandle(id);
      const handle = await directory.getFileHandle(name);
      const first = new Uint8Array(await (await handle.getFile()).slice(0, 1).arrayBuffer())[0]!;
      const writable = await handle.createWritable({ keepExistingData: true });
      await writable.write({ type: 'write', position: 0, data: new Uint8Array([first ^ 0xff]) });
      await writable.close();
    }, { id, name: files[0]!.relPath });
    expect(await partialSize(b.page, id, files[0]!.relPath)).toBe(committed);
    await pair([a, b]);
    const [chooser] = await Promise.all([
      a.page.waitForEvent('filechooser'),
      a.page.getByTestId('resume-transfer').first().click(),
    ]);
    await chooser.setFiles(file);
    await expect(b.page.getByTestId('incoming-modal')).toBeVisible();
    await b.page.getByTestId('accept-transfer').click();
    await waitForState(a.page, 'failed');
    await expect(a.page.getByTestId('transfer-item').first()).toContainText(/resume prefix SHA-256 does not match source/i);
    await waitForState(b.page, 'failed'); // sender reports integrity failure; receiver discards corrupt partial
    expect(await b.page.evaluate(() => window.__fluxa!.received())).toEqual([]);
    await expect.poll(() => pendingExists(b.page, id)).toBe(false);
  } finally {
    await a.context.close();
    await b.context.close();
    await rm(dir, { recursive: true, force: true });
  }
});

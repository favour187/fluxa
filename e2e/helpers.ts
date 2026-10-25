import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';

export interface Client {
  context: BrowserContext;
  page: Page;
}

export async function openClient(browser: Browser, label: string): Promise<Client> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[${label}:console] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.log(`[${label}:pageerror] ${err.message}`));
  await page.goto('/');
  await expect(page.getByTestId('signal-status')).toHaveAttribute('data-state', 'online', { timeout: 20_000 });
  await expect(page.getByTestId('this-device')).toContainText(/\w/);
  return { context, page };
}

export async function renameDevice(page: Page, name: string): Promise<void> {
  await page.getByTestId('this-device').click();
  await page.getByTestId('device-name-input').fill(name);
  await page.getByTestId('save-name').click();
  await expect(page.getByTestId('this-device')).toContainText(name);
}

/** Run the full pair + 6-digit verification handshake between two clients. */
export async function pair(clients: Client[]): Promise<void> {
  const [a, b] = clients as [Client, Client];

  await a.page.getByTestId('pair-button').click();
  const codeEl = a.page.getByTestId('pair-code');
  // Wait for a real code, not for the placeholder: the placeholder used to be
  // dots but is now dashes, and matching "not dots" let a placeholder through.
  await expect(codeEl).toHaveText(/^(?:[A-Z0-9] ?){6}$/);
  const code = (await codeEl.textContent())!.replace(/\s/g, '');
  expect(code).toHaveLength(6);

  await b.page.getByTestId('pair-button').click();
  await b.page.getByTestId('join-code').fill(code);
  await b.page.getByTestId('join-submit').click();

  // Both devices must present the same 6-digit short authentication string.
  const sasA = (await a.page.getByTestId('sas-code').textContent({ timeout: 30_000 }))!.replace(/\s/g, '');
  const sasB = (await b.page.getByTestId('sas-code').textContent({ timeout: 30_000 }))!.replace(/\s/g, '');
  expect(sasA).toMatch(/^\d{6}$/);
  expect(sasB).toBe(sasA);

  await a.page.getByTestId('verify-match').click();
  await b.page.getByTestId('verify-match').click();

  await expect(a.page.getByTestId('device-item')).toHaveCount(1);
  await expect(b.page.getByTestId('device-item')).toHaveCount(1);
  await expect(a.page.locator('.badge.verified').first()).toBeVisible();
  await expect(b.page.locator('.badge.verified').first()).toBeVisible();
}

export async function selectDevice(page: Page, name: string): Promise<void> {
  await page.locator('[data-testid="device-item"]', { hasText: name }).first().click();
  await expect(page.getByTestId('dropzone')).toBeVisible();
}

export interface FileSpec {
  name: string;
  buffer: Buffer;
  mimeType?: string;
}

export function randomFile(name: string, bytes: number): FileSpec {
  return { name, buffer: randomBytes(bytes), mimeType: 'application/octet-stream' };
}

export function textFile(name: string, text: string): FileSpec {
  return { name, buffer: Buffer.from(text, 'utf8'), mimeType: 'text/plain' };
}

export const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/** Streaming hash for fixture files that never need to be in memory. */
export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject);
  });
  return hash.digest('hex');
}

/** File selection stages a send; the user must explicitly swipe or press Send now. */
export async function stageAndSend(sender: Page, files: FileSpec[] | string | string[]): Promise<void> {
  await sender.getByTestId('file-input').setInputFiles(files);
  await expect(sender.getByTestId('edge-send-card')).toBeVisible();
  await sender.getByTestId('send-staged').click();
}

/** Sends files through the real file input and accepts them on the receiver. */
export async function sendAndAccept(sender: Page, receiver: Page, files: FileSpec[]): Promise<void> {
  await stageAndSend(sender, files);
  await expect(receiver.getByTestId('incoming-modal')).toBeVisible({ timeout: 30_000 });
  await receiver.getByTestId('accept-transfer').click();
}

export async function waitForState(page: Page, state: string, timeout = 60_000): Promise<void> {
  await expect(page.locator(`[data-testid="transfer-item"][data-state="${state}"]`).first()).toBeVisible({ timeout });
}

export async function receivedFiles(page: Page): Promise<{ name: string; size: number; sha256: string }[]> {
  return page.evaluate(() => (window as unknown as { __fluxa: { received: () => { name: string; size: number; sha256: string }[] } }).__fluxa.received());
}

/** Click Save on the newest completed transfer and return the bytes the browser wrote. */
export async function downloadReceived(page: Page): Promise<Buffer> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.getByTestId('save-received').first().click(),
  ]);
  const path = await download.path();
  if (!path) throw new Error('download did not produce a file');
  return readFile(path);
}

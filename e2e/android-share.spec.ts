/** The Android Activity/ContentResolver is compiled and JUnit-tested separately.
 * This browser test simulates ONLY the Capacitor plugin boundary so the actual
 * Fluxa UI, verification, recipient approval and streaming manager are covered.
 */
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { openClient, pair, renameDevice, waitForState, receivedFiles } from './helpers';

const linkId = 'c'.repeat(32);
const fileId = 'd'.repeat(32);
const fileText = 'Staged by Android Files, never sent before approval.\n';

async function openMockAndroid(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.addInitScript(({ linkId, fileId, fileText }) => {
    const data = new TextEncoder().encode(fileText);
    const state = {
      items: [
        { id: linkId, createdAt: 1_700_000_000_000, text: 'https://example.com/read?q=full#part', title: 'Shared from Chrome', files: [] },
        { id: fileId, createdAt: 1_700_000_000_100, text: '', title: '', files: [
          { index: 0, name: 'document.txt', mime: 'text/plain', size: data.length },
        ] },
      ],
      readCalls: [] as number[],
      discarded: [] as string[],
      listeners: [] as (() => void)[],
    };
    const plugin = {
      addListener: async (_name: string, callback: () => void) => {
        state.listeners.push(callback);
        return { remove: async () => { state.listeners = state.listeners.filter((fn) => fn !== callback); } };
      },
      list: async () => ({ items: state.items, error: '' }),
      readChunk: async ({ id, index, offset, length }: { id: string; index: number; offset: number; length: number }) => {
        if (id !== fileId || index !== 0 || length > 65_536) throw new Error('Invalid mocked native read');
        state.readCalls.push(length);
        return { data: btoa(String.fromCharCode(...data.slice(offset, offset + length))) };
      },
      discard: async ({ id }: { id: string }) => {
        state.items = state.items.filter((item) => item.id !== id);
        state.discarded.push(id);
        state.listeners.forEach((fn) => fn());
      },
    };
    (window as unknown as { __shareTest: typeof state }).__shareTest = state;
    (window as unknown as { CapacitorPlatforms: object }).CapacitorPlatforms = {
      currentPlatform: {
        name: 'android', getPlatform: () => 'android', isNativePlatform: () => true,
        registerPlugin: (name: string) => name === 'FluxaIncomingShare' ? plugin : {
          addListener: async () => ({ remove: async () => undefined }),
          getLaunchUrl: async () => ({ url: null }),
        },
      },
      platforms: new Map(),
    };
  }, { linkId, fileId, fileText });
  page.on('pageerror', (err) => console.log('[mock-android] pageerror:', err.message));
  await page.goto('/');
  await expect(page.getByTestId('signal-status')).toHaveAttribute('data-state', 'online');
  return { context, page };
}

test('Android Share queue waits for a verified peer, then link consent and file receipt clear independent items', async ({ browser }) => {
  const sender = await openMockAndroid(browser);
  const receiver = await openClient(browser, 'browser recipient');
  try {
    await expect(sender.page.getByTestId('android-share-item')).toHaveCount(2);
    await expect(sender.page.getByTestId('android-share-preview')).toContainText(['https://example.com/read?q=full#part']);
    await expect(sender.page.getByTestId('android-share-send').first()).toBeDisabled();
    await sender.page.reload(); // Native staged content survives a WebView reload.
    await expect(sender.page.getByTestId('android-share-item')).toHaveCount(2);

    await renameDevice(sender.page, 'Share Source');
    await renameDevice(receiver.page, 'Share Destination');
    await pair([sender, receiver]);
    await expect(sender.page.getByTestId('android-share-send').first()).toBeEnabled();

    await sender.page.getByTestId('android-share-send').first().click();
    await expect(receiver.page.getByTestId('shared-approval')).toContainText('https://example.com/read?q=full#part');
    await expect(sender.page.getByTestId('android-share-item')).toHaveCount(2, { timeout: 2_000 });
    await receiver.page.getByTestId('accept-shared').click();
    await expect(sender.page.getByTestId('android-share-item')).toHaveCount(1);
    await expect(sender.page.getByTestId('android-share-item')).toContainText('document.txt');

    await sender.page.getByTestId('android-share-send').click();
    await expect(receiver.page.getByTestId('incoming-modal')).toBeVisible();
    await expect(sender.page.getByTestId('android-share-item')).toHaveCount(1);
    await receiver.page.getByTestId('accept-transfer').click();
    await waitForState(receiver.page, 'complete');
    await waitForState(sender.page, 'complete');
    await expect(sender.page.getByTestId('android-share-item')).toHaveCount(0);
    const received = await receivedFiles(receiver.page);
    expect(received.at(-1)?.name).toBe('document.txt');
    expect(received.at(-1)?.sha256).toBe(createHash('sha256').update(fileText).digest('hex'));
    const data = await sender.page.evaluate(() => {
      const state = (window as unknown as { __shareTest: { discarded: string[]; readCalls: number[] } }).__shareTest;
      return { discarded: state.discarded, readCalls: state.readCalls };
    });
    expect(data.discarded).toEqual([linkId, fileId]);
    expect(data.readCalls.length).toBeGreaterThan(0);
    expect(data.readCalls.every((n) => n <= 65_536)).toBe(true);
  } finally {
    await sender.context.close();
    await receiver.context.close();
  }
});

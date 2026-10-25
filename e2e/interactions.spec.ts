/** End-to-end coverage for the staged gesture, quick messages, and QR output. */
import { test, expect } from '@playwright/test';
import qrcode from 'qrcode-generator';
import { openClient, pair, randomFile, renameDevice, selectDevice, stageAndSend, textFile, waitForState, type Client } from './helpers';

test('the pairing QR has an actual four-module white quiet zone', async ({ browser }) => {
  const a = await openClient(browser, 'QR host');
  try {
    await a.page.getByTestId('pair-button').click();
    await expect(a.page.getByTestId('pair-code')).toHaveText(/^(?:[A-Z0-9] ?){6}$/);
    const payload = await a.page.evaluate(() => {
      const pairing = (window as unknown as { __fluxa: { snapshot: () => { pairing: { code: string; link: string | null } } } }).__fluxa.snapshot().pairing;
      return pairing.link ?? `${location.origin}/?pair=${pairing.code}`;
    });
    const qr = qrcode(0, 'L');
    qr.addData(payload);
    qr.make();
    const modules = qr.getModuleCount();
    const canvas = a.page.getByTestId('rendered-pairing-qr');
    await expect(canvas).toHaveAttribute('aria-label', 'QR code for Fluxa device pairing');
    const raster = await canvas.evaluate((element: HTMLCanvasElement, count) => {
      const side = element.width;
      const cell = side / (count + 8);
      const border = 4 * cell;
      const pixels = element.getContext('2d')!.getImageData(0, 0, side, side).data;
      let quietWhite = true;
      let darkInside = 0;
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const offset = (y * side + x) * 4;
          const white = pixels[offset] === 255 && pixels[offset + 1] === 255 && pixels[offset + 2] === 255 && pixels[offset + 3] === 255;
          if (x < border || y < border || x >= side - border || y >= side - border) quietWhite &&= white;
          else if (!white) darkInside++;
        }
      }
      return { cell, quietWhite, darkInside };
    }, modules);
    expect(Number.isInteger(raster.cell)).toBe(true);
    expect(raster.quietWhite).toBe(true);
    expect(raster.darkInside).toBeGreaterThan(0);
  } finally {
    await a.context.close();
  }
});

test.describe('verified device interactions', () => {
  let a: Client;
  let b: Client;

  test.beforeEach(async ({ browser }) => {
    a = await openClient(browser, 'Interaction A');
    b = await openClient(browser, 'Interaction B');
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

  test('choosing a file does not send until swiped to the screen edge; Clear discards it', async () => {
    const file = textFile('swiped.txt', 'A file sent by the edge gesture');
    await a.page.getByTestId('file-input').setInputFiles([file]);
    await expect(a.page.getByTestId('edge-send-card')).toContainText('To Pocket Phone');
    await expect(b.page.getByTestId('incoming-modal')).toHaveCount(0);
    await a.page.getByTestId('clear-staged').click();
    await expect(a.page.getByTestId('edge-send-card')).toHaveCount(0);
    await expect(b.page.getByTestId('incoming-modal')).toHaveCount(0);

    await a.page.getByTestId('file-input').setInputFiles([file]);
    const box = await a.page.getByTestId('edge-send-card').boundingBox();
    const viewport = a.page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    const startX = box!.x + 25;
    const y = box!.y + 25;
    await a.page.mouse.move(startX, y);
    await a.page.mouse.down();
    await a.page.mouse.move(viewport!.width - 24, y, { steps: 12 });
    await a.page.mouse.up();
    await expect(b.page.getByTestId('incoming-modal')).toBeVisible({ timeout: 30_000 });
    await b.page.getByTestId('accept-transfer').click();
    await waitForState(a.page, 'complete');
    await waitForState(b.page, 'complete');
  });

  test('quick messages are acknowledged, while Unicode over 4,000 UTF-8 bytes is rejected locally', async () => {
    const input = a.page.getByRole('textbox', { name: 'Message' });
    await input.fill('Hello from Studio Laptop 👋');
    await a.page.locator('.chat-form button').click();
    await expect(b.page.locator('.chat-bubble.received')).toContainText('Hello from Studio Laptop 👋');
    await expect(a.page.locator('.chat-bubble.sent .chat-meta')).toContainText('delivered');

    const tooLarge = '😀'.repeat(1001); // only 2,002 JS code units, but 4,004 UTF-8 bytes
    await input.fill(tooLarge);
    await a.page.locator('.chat-form button').click();
    await expect(a.page.getByRole('textbox', { name: 'Message' })).toHaveValue(tooLarge);
    await expect(a.page.locator('.chat-bubble.sent')).toHaveCount(1);
    await expect(b.page.locator('.chat-bubble.received')).toHaveCount(1);
    await expect(a.page.locator('#toasts')).toContainText('4,000 UTF-8 bytes');
  });

  test('typing a message is not erased by file staging or transfer progress', async () => {
    const input = a.page.getByRole('textbox', { name: 'Message' });
    await input.fill('draft while transferring');
    await stageAndSend(a.page, [randomFile('active-transfer.bin', 8 * 1024 * 1024)]);
    await expect(b.page.getByTestId('incoming-modal')).toBeVisible();
    await b.page.getByTestId('accept-transfer').click();
    await waitForState(a.page, 'complete', 90_000);
    await expect(a.page.getByRole('textbox', { name: 'Message' })).toHaveValue('draft while transferring');
  });
});

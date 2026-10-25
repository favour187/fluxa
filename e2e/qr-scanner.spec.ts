/** Pair with a simulated camera stream, exercising the real QR decoder and consent. */
import { test, expect } from '@playwright/test';
import { openClient, type Client } from './helpers';

/** Feed a QR image to the scanner as a MediaStream without granting real hardware access. */
async function feedQr(guest: Client, imageDataUrl: string): Promise<void> {
  await guest.page.evaluate(async (dataUrl) => {
    const image = new Image();
    if (dataUrl) { image.src = dataUrl; await image.decode(); }
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d')!;
    const draw = () => {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 640, 480);
      ctx.imageSmoothingEnabled = false;
      if (dataUrl) ctx.drawImage(image, 175, 95, 290, 290);
    };
    draw();
    const stream = canvas.captureStream(12);
    draw();
    (window as unknown as { __qrTestStream: MediaStream }).__qrTestStream = stream;
    Object.defineProperty(window, 'BarcodeDetector', { configurable: true, value: undefined });
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => stream });
  }, imageDataUrl);
}

test('the served app permits its own QR camera but no microphone or geolocation', async ({ request }) => {
  const response = await request.get('/');
  expect(response.ok()).toBe(true);
  const policy = response.headers()['permissions-policy'];
  expect(policy).toContain('camera=(self)');
  expect(policy).toContain('microphone=()');
  expect(policy).toContain('geolocation=()');
});

test('a scanned QR pairs two verified browsers without BarcodeDetector and releases the camera', async ({ browser }) => {
  const host = await openClient(browser, 'QR host');
  const guest = await openClient(browser, 'QR guest');
  try {
    await host.page.getByTestId('pair-button').click();
    await expect(host.page.getByTestId('pair-code')).toHaveText(/^(?:[A-Z0-9] ?){6}$/);
    const image = await host.page.getByTestId('rendered-pairing-qr').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
    await feedQr(guest, image);
    await guest.page.getByTestId('pair-button').click();
    await guest.page.getByTestId('scan-qr').click();
    // A fast QR decode can close the scanner before its "searching" label is
    // ever observed; the verified-pair result below is the stable assertion.
    const sasA = (await host.page.getByTestId('sas-code').textContent({ timeout: 30_000 }))!.replace(/\s/g, '');
    const sasB = (await guest.page.getByTestId('sas-code').textContent({ timeout: 30_000 }))!.replace(/\s/g, '');
    expect(sasA).toBe(sasB);
    await expect(guest.page.getByTestId('qr-scanner-modal')).toHaveCount(0);
    await expect.poll(() => guest.page.evaluate(() =>
      (window as unknown as { __qrTestStream: MediaStream }).__qrTestStream.getVideoTracks()[0]!.readyState,
    )).toBe('ended');
    await host.page.getByTestId('verify-match').click();
    await guest.page.getByTestId('verify-match').click();
    await expect(host.page.locator('.badge.verified')).toBeVisible();
    await expect(guest.page.locator('.badge.verified')).toBeVisible();
  } finally { await host.context.close(); await guest.context.close(); }
});

test('opening a pairing link during boot waits for authenticated signalling before claiming it', async ({ browser }) => {
  const host = await openClient(browser, 'Deep-link host');
  const guest = await browser.newContext();
  try {
    await host.page.getByTestId('pair-button').click();
    await expect(host.page.getByTestId('pair-code')).toHaveText(/^(?:[A-Z0-9] ?){6}$/);
    const code = (await host.page.getByTestId('pair-code').textContent())!.replace(/\s/g, '');
    expect(code).toMatch(/^[A-Z0-9]{6}$/);
    const page = await guest.newPage();
    await page.goto(`/?pair=${code}`);
    const sasHost = (await host.page.getByTestId('sas-code').textContent({ timeout: 30_000 }))!.replace(/\s/g, '');
    const sasGuest = (await page.getByTestId('sas-code').textContent({ timeout: 30_000 }))!.replace(/\s/g, '');
    expect(sasHost).toBe(sasGuest);
    expect(new URL(page.url()).search).toBe('');
    await host.page.getByTestId('verify-match').click();
    await page.getByTestId('verify-match').click();
    await expect(page.locator('.badge.verified')).toBeVisible();
  } finally { await host.context.close(); await guest.close(); }
});

test('Cancel and Escape stop camera capture and restore the pairing dialog', async ({ browser }) => {
  const guest = await openClient(browser, 'QR cancel');
  try {
    await feedQr(guest, '');
    await guest.page.getByTestId('pair-button').click();
    await guest.page.getByTestId('scan-qr').click();
    await expect(guest.page.getByTestId('qr-scanner-modal')).toBeVisible();
    await guest.page.keyboard.press('Escape');
    await expect(guest.page.getByTestId('qr-scanner-modal')).toHaveCount(0);
    await expect(guest.page.getByTestId('pairing-modal')).toBeVisible();
    await expect.poll(() => guest.page.evaluate(() =>
      (window as unknown as { __qrTestStream: MediaStream }).__qrTestStream.getVideoTracks()[0]!.readyState,
    )).toBe('ended');
  } finally { await guest.context.close(); }
});

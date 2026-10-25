/**
 * Direct pairing: Fluxa with no signalling server whatsoever.
 *
 * A plain static file server hosts the built app and has no /ws endpoint, which
 * is exactly the situation on a phone (or any machine) where nothing else is
 * running. The two devices must still be able to pair, verify and transfer —
 * that is the whole point of the ticket exchange.
 */
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

const ROOT = join(import.meta.dirname, '..');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

let server: Server;
let baseUrl = '';
let browser: Browser;

/** Serves public/ + dist/client exactly like a CDN would, and nothing else. */
async function startStaticServer(): Promise<string> {
  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/ws')) {
      res.writeHead(404).end('no signalling server here');
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const candidate = join(ROOT, 'public', rel === '/' ? 'index.html' : rel);
    try {
      const info = await stat(candidate);
      if (!info.isFile()) throw new Error('not a file');
      res.writeHead(200, { 'content-type': TYPES[extname(candidate)] ?? 'application/octet-stream' });
      createReadStream(candidate).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  server = httpServer;
  return `http://127.0.0.1:${port}/`;
}

async function openDevice(name: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 420, height: 860 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('crash', () => console.log(`[${name}] RENDERER CRASH`));
  page.on('pageerror', (e) => console.log(`[${name}] pageerror: ${e.message.slice(0, 300)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('WebSocket')) console.log(`[${name}] console: ${m.text().slice(0, 300)}`);
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as unknown as { __fluxa?: unknown }).__fluxa), null, { timeout: 30_000 });
  // Rename so the two devices are distinguishable during verification.
  await page.getByTestId('this-device').click();
  await page.getByTestId('device-name-input').fill(name);
  await page.getByTestId('save-name').click();
  await expect(page.getByTestId('this-device')).toContainText(name);
  return { context, page };
}

const snapshot = (page: Page) =>
  page.evaluate(() => (window as unknown as {
    __fluxa: { snapshot: () => { status: string; direct: { role: string; ticket: string | null } | null } };
  }).__fluxa.snapshot());

test.beforeAll(async () => {
  baseUrl = await startStaticServer();
  browser = await chromium.launch({
    args: [
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--allow-loopback-in-peer-connection',
      '--disable-dev-shm-usage',
    ],
  });
});

test.afterAll(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
});

test('pairs, verifies and transfers with no signalling server (direct code)', async () => {
  const host = await openDevice('Pocket Phone');
  const guest = await openDevice('Studio Laptop');

  // 1. Both devices are genuinely offline: there is no signalling server at all.
  await expect(host.page.getByTestId('signal-status')).toHaveAttribute('data-state', 'offline', { timeout: 20_000 });
  await expect(guest.page.getByTestId('signal-status')).toHaveAttribute('data-state', 'offline', { timeout: 20_000 });

  // 2. Host creates a ticket. The modal opens on the direct tab automatically
  //    because there is no server to pair through.
  await host.page.getByTestId('pair-button').click();
  // With no server the dialog opens on the tab that actually works; the "same
  // network" tab carries the explanation of why it cannot be used.
  await expect(host.page.getByTestId('direct-start')).toBeVisible();
  await host.page.getByTestId('pair-tab-code').click();
  await expect(host.page.getByTestId('offline-notice')).toBeVisible();
  await host.page.getByTestId('pair-tab-direct').click();
  await host.page.getByTestId('direct-start').click();
  const ticketBox = host.page.getByTestId('direct-ticket');
  await expect(ticketBox).toHaveValue(/^FLX1/, { timeout: 30_000 });
  const offer = await ticketBox.inputValue();
  expect(offer.length).toBeGreaterThan(100);

  // 3. Guest pastes it and gets a reply ticket back.
  await guest.page.getByTestId('pair-button').click();
  await guest.page.getByTestId('direct-join-input').fill(offer);
  await guest.page.getByTestId('direct-join-submit').click();
  const replyBox = guest.page.getByTestId('direct-ticket');
  await expect(replyBox).toHaveValue(/^FLX1/, { timeout: 30_000 });
  const reply = await replyBox.inputValue();

  // 4. Host pastes the reply; the peer identity is pinned from the ticket and the
  //    WebRTC connection is negotiated with no server in the middle.
  await host.page.getByTestId('direct-reply-input').fill(reply);
  await host.page.getByTestId('direct-complete').click();

  // 5. Both sides show the same 6-digit verification code.
  const sasHost = (await host.page.getByTestId('sas-code').textContent({ timeout: 60_000 }))!.replace(/\s/g, '');
  const sasGuest = (await guest.page.getByTestId('sas-code').textContent({ timeout: 60_000 }))!.replace(/\s/g, '');
  expect(sasHost).toMatch(/^\d{6}$/);
  expect(sasGuest).toBe(sasHost);
  await host.page.getByTestId('verify-match').click();
  await guest.page.getByTestId('verify-match').click();

  // 6. The device is remembered and selectable on both sides.
  await expect(host.page.locator('[data-testid="device-item"]').first()).toBeVisible({ timeout: 30_000 });
  await host.page.locator('[data-testid="device-item"]').first().click();
  await guest.page.locator('[data-testid="device-item"]').first().click();

  // 7. A real file moves device-to-device and hashes match on both ends.
  const payload = randomBytes(3 * 1024 * 1024);
  const expected = createHash('sha256').update(payload).digest('hex');
  const dir = await mkdtemp(join(tmpdir(), 'fluxa-direct-'));
  const filePath = join(dir, 'direct-pair.bin');
  await writeFile(filePath, payload);

  await expect(host.page.getByTestId('dropzone')).toBeVisible({ timeout: 30_000 });
  await host.page.getByTestId('file-input').setInputFiles(filePath);
  await expect(guest.page.getByTestId('incoming-modal')).toBeVisible({ timeout: 60_000 });
  await guest.page.getByTestId('accept-transfer').click();

  await expect
    .poll(
      async () =>
        guest.page.evaluate(() =>
          (window as unknown as { __fluxa: { transfers: () => { state: string }[] } }).__fluxa.transfers()[0]?.state,
        ),
      { timeout: 120_000 },
    )
    .toBe('complete');
  await expect
    .poll(
      async () =>
        host.page.evaluate(() =>
          (window as unknown as { __fluxa: { transfers: () => { state: string }[] } }).__fluxa.transfers()[0]?.state,
        ),
      { timeout: 120_000 },
    )
    .toBe('complete');

  const received = await guest.page.evaluate(() =>
    (window as unknown as { __fluxa: { received: () => { name: string; size: number; sha256: string }[] } }).__fluxa.received(),
  );
  expect(received).toHaveLength(1);
  expect(received[0]!.name).toBe('direct-pair.bin');
  expect(received[0]!.sha256).toBe(expected);

  // The server never saw a byte: it has no WebSocket endpoint at all.
  expect((await snapshot(host.page)).status).toBe('offline');

  await rm(dir, { recursive: true, force: true });
  await host.context.close();
  await guest.context.close();
});

test('the whole app fits a phone screen with no sideways scrolling', async () => {
  const context = await browser.newContext({ viewport: { width: 360, height: 640 } });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as unknown as { __fluxa?: unknown }).__fluxa));

  const measure = () =>
    page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      scrollHeight: document.documentElement.scrollHeight,
      clientHeight: document.documentElement.clientHeight,
    }));

  const initial = await measure();
  expect(initial.scrollWidth).toBeLessThanOrEqual(initial.clientWidth);
  // The launcher screen must fit without scrolling; panels may scroll below it.
  expect(initial.scrollHeight).toBeLessThanOrEqual(initial.clientHeight + 2);

  // The pairing dialog has to fit too — it is the screen a new user must get through.
  await page.getByTestId('pair-button').click();
  await expect(page.getByTestId('direct-start')).toBeVisible();
  const modal = await page.getByTestId('pairing-modal').boundingBox();
  expect(modal!.width).toBeLessThanOrEqual(360);
  expect(modal!.height).toBeLessThanOrEqual(640);
  const dialogOverflow = await page.getByTestId('pairing-modal').evaluate((node) => ({
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  expect(dialogOverflow.scrollWidth).toBeLessThanOrEqual(dialogOverflow.clientWidth + 1);

  await context.close();
});

test('on a phone the dialog opens on the code that works, with cards at full width', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean((window as unknown as { __fluxa?: unknown }).__fluxa));

  // Every card must use the full column width; a half-width card was what made
  // the phone layout look broken.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const shell = document.querySelector('.app-shell')!.getBoundingClientRect().width;
        const panels = [...document.querySelectorAll('.panel')].map((n) => n.getBoundingClientRect().width);
        return panels.length > 0 && panels.every((w) => w > shell * 0.85);
      }),
    )
    .toBe(true);

  await page.getByTestId('pair-button').click();
  // No signalling server exists here, so the dialog must land on Direct code
  // instead of a permanently empty "same network" code.
  await expect(page.getByTestId('pair-tab-direct')).toHaveClass(/is-active/);
  await expect(page.getByTestId('pair-code')).toHaveClass(/is-pending/);
  // A blank white QR frame used to sit in the middle of the dialog.
  await expect(page.locator('[data-panel="code"] .qr-wrap')).toBeHidden();

  // Looking at the other tab must not bounce the user back.
  await page.getByTestId('pair-tab-code').click();
  await expect(page.getByTestId('pair-tab-code')).toHaveClass(/is-active/);
  await page.waitForTimeout(400);
  await expect(page.getByTestId('pair-tab-code')).toHaveClass(/is-active/);
  await expect(page.locator('#offline-notice')).toContainText('Direct code');

  // The ticket itself must be short enough to read and copy on a phone.
  await page.getByTestId('pair-tab-direct').click();
  await page.getByTestId('direct-start').click();
  const ticket = page.getByTestId('direct-ticket');
  await expect(ticket).toBeVisible({ timeout: 30_000 });
  const value = await ticket.inputValue();
  expect(value).toMatch(/^FLX1/);
  expect(value.length).toBeLessThan(700);

  await context.close();
});

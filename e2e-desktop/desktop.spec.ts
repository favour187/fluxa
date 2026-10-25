/**
 * Desktop end-to-end tests: two real Electron application instances.
 *
 * Instance A runs on its own embedded signalling server. Instance B is launched
 * with `--fluxa-signal-url` pointing at A, which is exactly how two people pair
 * two machines on the same network with no shared infrastructure.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const APP_DIR = path.resolve(import.meta.dirname, '..');
const b64 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');

interface Instance {
  app: ElectronApplication;
  page: Page;
  port: number;
  profile: string;
}

const launched: Instance[] = [];
const profiles: string[] = [];

async function launch(port: number, signalUrl?: string): Promise<Instance> {
  const profile = await mkdtemp(path.join(tmpdir(), 'fluxa-desktop-'));
  profiles.push(profile);
  const args = ['.', '--no-sandbox', `--fluxa-user-data=${profile}`, `--fluxa-port=${port}`];
  if (signalUrl) args.push(`--fluxa-signal-url=${signalUrl}`);
  const app = await electron.launch({ args, cwd: APP_DIR });
  const page = await app.firstWindow();
  const instance: Instance = { app, page, port, profile };
  launched.push(instance); // also close a failed/partially started instance in afterEach
  await page.waitForFunction(() => Boolean((window as unknown as { __fluxa?: unknown }).__fluxa), null, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('signal-status')).toHaveAttribute('data-state', 'online', { timeout: 30_000 });
  return instance;
}

test.afterEach(async () => {
  for (const instance of launched.splice(0)) {
    await instance.app.close().catch(() => undefined);
  }
  for (const profile of profiles.splice(0)) {
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('the packaged app starts, serves its UI and exposes a minimal bridge', async () => {
  const a = await launch(8901);

  expect(await a.app.evaluate(async ({ app }) => app.getVersion())).toBe('0.2.0');
  expect(await a.app.evaluate(async ({ app }) => app.getName())).toBe('Fluxa');

  const info = await a.page.evaluate(async () => {
    const bridge = (window as unknown as { fluxaDesktop: { info: () => Promise<Record<string, unknown>> } }).fluxaDesktop;
    return bridge.info();
  });
  expect(info.serverPort).toBe(8901);
  expect(info.platform).toBe(process.platform);

  // The renderer is locked down: no Node globals, only the narrow bridge.
  const sandbox = await a.page.evaluate(() => ({
    hasRequire: typeof (window as unknown as { require?: unknown }).require !== 'undefined',
    hasProcess: typeof (window as unknown as { process?: unknown }).process !== 'undefined',
    bridgeKeys: Object.keys((window as unknown as { fluxaDesktop: object }).fluxaDesktop).sort(),
  }));
  expect(sandbox.hasRequire).toBe(false);
  expect(sandbox.hasProcess).toBe(false);
  expect(sandbox.bridgeKeys).toEqual(
    ['info', 'isDesktop', 'logLines', 'nearby', 'notify', 'onNearby', 'saveDialog', 'saveFile', 'setIdentity',
      'beginSave', 'writeSave', 'commitSave', 'abortSave'].sort(),
  );

  // Content-Security-Policy is served by the embedded server.
  const csp = await a.page.evaluate(async () => {
    const response = await fetch('/');
    return response.headers.get('content-security-policy');
  });
  expect(csp).toContain("default-src 'self'");

  await expect(a.page.getByTestId('pair-button')).toBeVisible();
});

test('two desktop instances pair, verify and transfer a real file', async () => {
  const a = await launch(8902);
  const b = await launch(8903, `ws://127.0.0.1:8902/ws`);

  // B must be talking to A's embedded server.
  await expect
    .poll(async () => b.page.evaluate(() => (window as unknown as { __fluxa: { snapshot: () => { signalUrl: string } } }).__fluxa.snapshot().signalUrl), {
      timeout: 30_000,
    })
    .toContain('8902');

  for (const [instance, name] of [
    [a, 'Desktop Alpha'],
    [b, 'Desktop Beta'],
  ] as [Instance, string][]) {
    await instance.page.getByTestId('this-device').click();
    await instance.page.getByTestId('device-name-input').fill(name);
    await instance.page.getByTestId('save-name').click();
    await expect(instance.page.getByTestId('this-device')).toContainText(name);
  }

  // Pair with a code.
  await a.page.getByTestId('pair-button').click();
  const codeNode = a.page.getByTestId('pair-code');
  await expect(codeNode).not.toHaveText(/^·+$/);
  const code = (await codeNode.textContent())!.replace(/\s/g, '');
  await b.page.getByTestId('pair-button').click();
  await b.page.getByTestId('join-code').fill(code);
  await b.page.getByTestId('join-submit').click();

  const sasA = (await a.page.getByTestId('sas-code').textContent({ timeout: 60_000 }))!.replace(/\s/g, '');
  const sasB = (await b.page.getByTestId('sas-code').textContent({ timeout: 60_000 }))!.replace(/\s/g, '');
  expect(sasA).toMatch(/^\d{6}$/);
  expect(sasB).toBe(sasA);
  await a.page.getByTestId('verify-match').click();
  await b.page.getByTestId('verify-match').click();

  await a.page.locator('[data-testid="device-item"]').first().click();
  await b.page.locator('[data-testid="device-item"]').first().click();
  await expect(a.page.getByTestId('dropzone')).toBeVisible({ timeout: 30_000 });

  // A real 1 MB file with known contents.
  const payload = randomBytes(1024 * 1024);
  const expected = b64(payload);
  const dir = await mkdtemp(path.join(tmpdir(), 'fluxa-file-'));
  const filePath = path.join(dir, 'desktop-transfer.bin');
  await (await import('node:fs/promises')).writeFile(filePath, payload);

  await a.page.getByTestId('file-input').setInputFiles(filePath);
  await expect(a.page.getByTestId('edge-send-card')).toBeVisible();
  await a.page.getByTestId('send-staged').click();
  await expect(b.page.getByTestId('incoming-modal')).toBeVisible({ timeout: 60_000 });
  await b.page.getByTestId('accept-transfer').click();

  await expect
    .poll(
      async () =>
        b.page.evaluate(() =>
          (window as unknown as { __fluxa: { transfers: () => { state: string }[] } }).__fluxa.transfers()[0]?.state,
        ),
      { timeout: 120_000 },
    )
    .toBe('complete');

  const received = await b.page.evaluate(() =>
    (window as unknown as { __fluxa: { received: () => { name: string; size: number; sha256: string }[] } }).__fluxa.received(),
  );
  expect(received).toHaveLength(1);
  expect(received[0]!.name).toBe('desktop-transfer.bin');
  expect(received[0]!.size).toBe(payload.byteLength);
  expect(received[0]!.sha256).toBe(expected);

  const senderState = await a.page.evaluate(() =>
    (window as unknown as { __fluxa: { transfers: () => { state: string }[] } }).__fluxa.transfers()[0]?.state,
  );
  expect(senderState).toBe('complete');

  // The verified bytes are retained and offered for saving.
  await expect(b.page.getByTestId('save-received')).toBeVisible();
  const retained = await b.page.evaluate(() =>
    (window as unknown as { __fluxa: { received: () => { size: number }[] } }).__fluxa.received(),
  );
  expect(retained[0]!.size).toBe(payload.byteLength);

  // Saving really writes to disk: stub only the OS file chooser (Playwright
  // cannot drive a native dialog), then let the app's own IPC handler write the
  // bytes and check the file that appears on the filesystem.
  const savePath = path.join(dir, 'saved-by-desktop.bin');
  await b.app.evaluate(({ dialog }, target) => {
    // eslint-disable-next-line no-param-reassign
    (dialog as unknown as { showSaveDialog: unknown }).showSaveDialog = async () => ({
      canceled: false,
      filePath: target,
    });
  }, savePath);
  await b.page.getByTestId('save-received').first().click();
  await expect
    .poll(async () => stat(savePath).then((s) => s.size).catch(() => 0), { timeout: 30_000 })
    .toBe(payload.byteLength);
  const written = await (await import('node:fs/promises')).readFile(savePath);
  expect(b64(written)).toBe(expected);

  // A second user selection of the same name must not overwrite the first
  // export. The IPC commit is exclusive, even if the native dialog returns an
  // existing path and the renderer streams identical bytes again.
  await b.page.getByTestId('save-received').first().click();
  await expect(b.page.getByTestId('toast').filter({ hasText: /already exists/i }).first()).toBeVisible();
  expect(b64(await (await import('node:fs/promises')).readFile(savePath))).toBe(expected);

  await rm(dir, { recursive: true, force: true });
});

test('the app advertises itself over mDNS and can discover a nearby instance', async () => {
  const a = await launch(8904);
  const b = await launch(8905);

  // Both advertise. Discovery depends on multicast being permitted in the
  // environment; the assertion is that the advertisement exists and the UI
  // surfaces it when a peer is seen.
  const advertised = await a.page.evaluate(async () => {
    const bridge = (window as unknown as { fluxaDesktop: { info: () => Promise<{ instanceId: string }> } }).fluxaDesktop;
    return bridge.info();
  });
  expect(advertised.instanceId).toMatch(/^fluxa-/);
  await expect(a.page.getByTestId('nearby-list')).toBeAttached();

  // Give multicast a moment; report rather than fail when the sandbox blocks it.
  const deadline = Date.now() + 12_000;
  let discovered = 0;
  while (Date.now() < deadline) {
    discovered = await b.page.evaluate(
      () => (window as unknown as { __fluxa: { snapshot: () => { nearby: unknown[] } } }).__fluxa.snapshot().nearby.length,
    );
    if (discovered > 0) break;
    await b.page.waitForTimeout(500);
  }
  // Multicast works in this environment, so this is a real assertion rather
  // than a soft signal. If a CI runner blocks multicast the annotated
  // description explains the skip.
  test.info().annotations.push({
    type: 'mdns',
    description: discovered > 0 ? `discovered ${discovered} peer(s)` : 'no peers discovered (multicast blocked)',
  });
  expect(discovered).toBeGreaterThan(0);
  const peerName = await b.page.evaluate(
    () => (window as unknown as { __fluxa: { snapshot: () => { nearby: { name: string }[] } } }).__fluxa.snapshot().nearby[0]?.name,
  );
  expect(peerName).toBeTruthy();
});

test('file metadata and identity survive a restart of the same profile', async () => {
  const a = await launch(8906);
  const deviceId = await a.page.evaluate(
    () => (window as unknown as { __fluxa: { identity: () => { deviceId: string } } }).__fluxa.identity().deviceId,
  );
  expect(deviceId).toHaveLength(43);

  await a.app.close();
  launched.splice(launched.indexOf(a), 1);

  // Same user-data directory => same non-extractable key => same device id.
  const app2 = await electron.launch({
    args: ['.', '--no-sandbox', `--fluxa-user-data=${a.profile}`, '--fluxa-port=8906'],
    cwd: APP_DIR,
  });
  const page2 = await app2.firstWindow();
  await page2.waitForFunction(() => Boolean((window as unknown as { __fluxa?: unknown }).__fluxa), null, {
    timeout: 60_000,
  });
  const deviceId2 = await page2.evaluate(
    () => (window as unknown as { __fluxa: { identity: () => { deviceId: string } } }).__fluxa.identity().deviceId,
  );
  expect(deviceId2).toBe(deviceId);
  await app2.close();

  const onDisk = await stat(path.join(a.profile, 'IndexedDB')).catch(() => null);
  expect(onDisk?.isDirectory()).toBe(true);
});

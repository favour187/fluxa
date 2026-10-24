import { defineConfig } from '@playwright/test';

/**
 * Desktop (Electron) end-to-end tests.
 *
 * These launch the real packaged application shell — not a browser tab — twice,
 * with separate profiles and their own embedded signalling servers, and verify
 * pairing, verification and a real file transfer between the two processes.
 *
 * A virtual display is required on Linux: run through `xvfb-run -a`.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});

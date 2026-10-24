import { defineConfig, devices } from '@playwright/test';

/**
 * Fluxa browser tests.
 *
 * Two independent browser contexts are used as two devices. Chromium's mDNS
 * local-IP obfuscation is disabled so ICE host candidates are directly usable
 * inside the sandbox (this mirrors a normal same-LAN pair).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['json', { outputFile: 'test-results/results.json' }]] : [['list']],
  use: {
    baseURL: process.env.FLUXA_BASE_URL ?? 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    launchOptions: {
      args: [
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--allow-loopback-in-peer-connection',
        '--autoplay-policy=no-user-gesture-required',
        // Lets the large-file test read real JS heap numbers.
        '--enable-precise-memory-info',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node dist/server/index.js',
    url: 'http://127.0.0.1:8787/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { PORT: '8787', HOST: '127.0.0.1' },
  },
});

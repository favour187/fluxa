/** Actual browser WebRTC screen media; mock only the OS's capture picker. */
import { test, expect } from '@playwright/test';
import { openClient, pair, renameDevice, selectDevice } from './helpers';

test('screen sharing needs two consents, plays verified media, and stops the capture on either side', async ({ browser }) => {
  const a = await openClient(browser, 'Screen source');
  const b = await openClient(browser, 'Screen viewer');
  try {
    await renameDevice(a.page, 'Screen source');
    await renameDevice(b.page, 'Screen viewer');
    await pair([a, b]);
    await selectDevice(a.page, 'Screen viewer');
    await selectDevice(b.page, 'Screen source');
    await a.page.evaluate(() => {
      const win = window as typeof window & { __screenStream: MediaStream };
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 320; canvas.height = 180;
          const context = canvas.getContext('2d')!;
          const draw = () => { context.fillStyle = '#da2745'; context.fillRect(0, 0, 320, 180); };
          draw();
          const stream = canvas.captureStream(12);
          const interval = setInterval(() => {
            if (stream.getVideoTracks()[0]?.readyState !== 'live') clearInterval(interval);
            else draw();
          }, 80);
          win.__screenStream = stream;
          return stream;
        },
      });
    });
    await a.page.getByTestId('screen-start').click();
    await expect(b.page.getByTestId('screen-banner')).toContainText('wants to show their screen');
    await expect(b.page.getByTestId('screen-video')).toHaveCount(0);
    await b.page.getByTestId('screen-decline').click();
    await expect(a.page.getByTestId('screen-banner')).toBeHidden();
    await expect.poll(() => a.page.evaluate(() =>
      (window as typeof window & { __screenStream: MediaStream }).__screenStream.getVideoTracks()[0]?.readyState,
    )).toBe('ended');

    await a.page.getByTestId('screen-start').click();
    await b.page.getByTestId('screen-accept').click();
    await expect(b.page.getByTestId('screen-preview')).toBeVisible();
    await expect(a.page.getByTestId('screen-banner')).toContainText('Your screen is visible', { timeout: 30_000 });
    await expect(b.page.getByTestId('screen-video')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => b.page.getByTestId('screen-video').evaluate((element: HTMLVideoElement) =>
      element.videoWidth,
    ), { timeout: 30_000 }).toBeGreaterThan(0);
    await b.page.getByTestId('screen-stop').click();
    await expect(a.page.getByTestId('screen-banner')).toBeHidden();
    await expect(b.page.getByTestId('screen-video')).toHaveCount(0);
    await expect.poll(() => a.page.evaluate(() =>
      (window as typeof window & { __screenStream: MediaStream }).__screenStream.getVideoTracks()[0]?.readyState,
    )).toBe('ended');

    // Reusing the negotiated transceiver must still show frames on a NEW,
    // explicitly accepted sharing session without another initial pairing.
    await a.page.getByTestId('screen-start').click();
    await b.page.getByTestId('screen-accept').click();
    await expect(b.page.getByTestId('screen-video')).toBeVisible();
    await expect.poll(() => b.page.getByTestId('screen-video').evaluate((video: HTMLVideoElement) =>
      video.videoWidth,
    ), { timeout: 30_000 }).toBeGreaterThan(0);
    await a.page.getByTestId('screen-stop').click();
    await expect(b.page.getByTestId('screen-banner')).toBeHidden();
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

// Stop while createOffer is still pending, then retry on the same verified
// connection: a never-answered sender must not be mistaken for a usable track.
test('stopping during media negotiation cannot leak frames or break the next share', async ({ browser }) => {
  const a = await openClient(browser, 'Screen race source');
  const b = await openClient(browser, 'Screen race viewer');
  try {
    await renameDevice(a.page, 'Screen race source');
    await renameDevice(b.page, 'Screen race viewer');
    await pair([a, b]);
    await selectDevice(a.page, 'Screen race viewer');
    await selectDevice(b.page, 'Screen race source');
    await a.page.evaluate(() => {
      const win = window as typeof window & { __releaseScreenOffer?: () => void; __originalScreenOffer?: typeof RTCPeerConnection.prototype.createOffer };
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 64; canvas.height = 64;
          const draw = () => {
            const context = canvas.getContext('2d')!;
            context.fillStyle = '#d5374d'; context.fillRect(0, 0, 64, 64);
          };
          draw();
          const stream = canvas.captureStream(15);
          const timer = setInterval(() => {
            if (stream.getVideoTracks()[0]?.readyState === 'live') draw();
            else clearInterval(timer);
          }, 50);
          return stream;
        },
      });
      const original = RTCPeerConnection.prototype.createOffer;
      win.__originalScreenOffer = original;
      RTCPeerConnection.prototype.createOffer = async function (options?: RTCOfferOptions) {
        if (this.getSenders().some((sender) => sender.track?.kind === 'video')) {
          await new Promise<void>((resolve) => { win.__releaseScreenOffer = resolve; });
        }
        return original.call(this, options);
      };
    });
    await a.page.getByTestId('screen-start').click();
    await b.page.getByTestId('screen-accept').click();
    await a.page.waitForFunction(() => typeof (window as typeof window & { __releaseScreenOffer?: () => void }).__releaseScreenOffer === 'function');
    await a.page.getByTestId('screen-stop').click();
    await a.page.evaluate(() => {
      const win = window as typeof window & { __releaseScreenOffer?: () => void; __originalScreenOffer?: typeof RTCPeerConnection.prototype.createOffer };
      RTCPeerConnection.prototype.createOffer = win.__originalScreenOffer!;
      win.__releaseScreenOffer!();
    });
    await expect(a.page.getByTestId('screen-banner')).toBeHidden();
    await expect(b.page.getByTestId('screen-banner')).toBeHidden();
    await expect(b.page.getByTestId('screen-video')).toHaveCount(0);
    await a.page.getByTestId('screen-start').click();
    await b.page.getByTestId('screen-accept').click();
    await expect(b.page.getByTestId('screen-video')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => b.page.getByTestId('screen-video').evaluate((video: HTMLVideoElement) => video.videoWidth),
      { timeout: 30_000 }).toBeGreaterThan(0);
    await a.page.getByTestId('screen-stop').click();
  } finally { await a.context.close(); await b.context.close(); }
});

// Stop after sending the offer but BEFORE the viewer finishes its answer.
// The sender must not reuse an un-negotiated media sender on the next share.
test('stopping before the first screen answer permits a fresh verified share', async ({ browser }) => {
  const a = await openClient(browser, 'Screen late answer source');
  const b = await openClient(browser, 'Screen late answer viewer');
  try {
    await renameDevice(a.page, 'Screen late answer source');
    await renameDevice(b.page, 'Screen late answer viewer');
    await pair([a, b]);
    await selectDevice(a.page, 'Screen late answer viewer');
    await selectDevice(b.page, 'Screen late answer source');
    await a.page.evaluate(() => {
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
        configurable: true,
        value: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 64; canvas.height = 64;
          const ctx = canvas.getContext('2d')!;
          const draw = () => { ctx.fillStyle = '#48aeff'; ctx.fillRect(0, 0, 64, 64); };
          draw();
          const stream = canvas.captureStream(15);
          const timer = setInterval(() => {
            if (stream.getVideoTracks()[0]?.readyState === 'live') draw(); else clearInterval(timer);
          }, 50);
          return stream;
        },
      });
    });
    await b.page.evaluate(() => {
      const win = window as typeof window & { __releaseScreenAnswer?: () => void; __originalScreenAnswer?: typeof RTCPeerConnection.prototype.createAnswer };
      const original = RTCPeerConnection.prototype.createAnswer;
      win.__originalScreenAnswer = original;
      RTCPeerConnection.prototype.createAnswer = async function (options?: RTCAnswerOptions) {
        if (this.getReceivers().some((receiver) => receiver.track.kind === 'video')) {
          await new Promise<void>((resolve) => { win.__releaseScreenAnswer = resolve; });
        }
        return original.call(this, options);
      };
    });
    await a.page.getByTestId('screen-start').click();
    await b.page.getByTestId('screen-accept').click();
    await b.page.waitForFunction(() => typeof (window as typeof window & { __releaseScreenAnswer?: () => void }).__releaseScreenAnswer === 'function');
    await a.page.getByTestId('screen-stop').click();
    await expect(b.page.getByTestId('screen-banner')).toBeHidden();
    await b.page.evaluate(() => {
      const win = window as typeof window & { __releaseScreenAnswer?: () => void; __originalScreenAnswer?: typeof RTCPeerConnection.prototype.createAnswer };
      RTCPeerConnection.prototype.createAnswer = win.__originalScreenAnswer!;
      win.__releaseScreenAnswer!();
    });
    await a.page.getByTestId('screen-start').click();
    await b.page.getByTestId('screen-accept').click();
    await expect(b.page.getByTestId('screen-video')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => b.page.getByTestId('screen-video').evaluate((video: HTMLVideoElement) => video.videoWidth),
      { timeout: 30_000 }).toBeGreaterThan(0);
    await a.page.getByTestId('screen-stop').click();
  } finally { await a.context.close(); await b.context.close(); }
});

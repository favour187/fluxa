/** Browser-to-browser end-to-end consent and text sync; mock only the OS clipboard. */
import { test, expect, type Page } from '@playwright/test';
import { openClient, pair, renameDevice, selectDevice } from './helpers';

async function simulateClipboard(page: Page, initial: string): Promise<void> {
  await page.evaluate((text) => {
    const win = window as typeof window & { __testClipboard: string };
    win.__testClipboard = text;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => win.__testClipboard,
        writeText: async (value: string) => { win.__testClipboard = value; },
      },
    });
    // The two test tabs represent two separate, foreground devices.
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
  }, initial);
}
const read = (page: Page) => page.evaluate(() =>
  (window as typeof window & { __testClipboard: string }).__testClipboard,
);
const write = (page: Page, text: string) => page.evaluate((value) => {
  (window as typeof window & { __testClipboard: string }).__testClipboard = value;
}, text);

test('clipboard sync needs two approvals, handles decline, mirrors only later text and stops both sides', async ({ browser }) => {
  const a = await openClient(browser, 'Clipboard A');
  const b = await openClient(browser, 'Clipboard B');
  try {
    await renameDevice(a.page, 'Clipboard A');
    await renameDevice(b.page, 'Clipboard B');
    await pair([a, b]);
    await selectDevice(a.page, 'Clipboard B');
    await simulateClipboard(a.page, 'private A');
    await simulateClipboard(b.page, 'private B');

    await a.page.getByTestId('clipboard-start').click();
    await expect(b.page.getByTestId('clipboard-banner')).toContainText('wants to sync your text clipboard');
    await expect(a.page.getByTestId('clipboard-banner')).toContainText('Asking Clipboard B');
    expect(await read(b.page)).toBe('private B');
    await b.page.getByTestId('clipboard-decline').click();
    await expect(a.page.getByTestId('clipboard-banner')).toBeHidden();
    expect(await read(b.page)).toBe('private B');

    await a.page.getByTestId('clipboard-start').click();
    await expect(b.page.getByTestId('clipboard-accept')).toBeVisible();
    await b.page.getByTestId('clipboard-accept').click();
    await expect(a.page.getByTestId('clipboard-banner')).toContainText('Live clipboard sync');
    await expect(b.page.getByTestId('clipboard-banner')).toContainText('Live clipboard sync');
    expect(await read(a.page)).toBe('private A');
    expect(await read(b.page)).toBe('private B');

    await write(a.page, 'Copy this new note');
    await expect.poll(() => read(b.page)).toBe('Copy this new note');
    await write(b.page, 'Reply only after accepting');
    await expect.poll(() => read(a.page)).toBe('Reply only after accepting');
    await b.page.getByTestId('clipboard-stop').click();
    await expect(a.page.getByTestId('clipboard-banner')).toBeHidden();
    await expect(b.page.getByTestId('clipboard-banner')).toBeHidden();
    await write(a.page, 'do not send');
    await a.page.waitForTimeout(1350);
    expect(await read(b.page)).toBe('Reply only after accepting');
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

/** User-initiated sharing is not a clipboard monitor or automatic link opener. */
import { test, expect } from '@playwright/test';
import { openClient, pair, renameDevice, selectDevice } from './helpers';

test('clipboard, link and work handoff require receiving consent and a separate copy/open action', async ({ browser }) => {
  const a = await openClient(browser, 'sharing sender');
  const b = await openClient(browser, 'sharing receiver');
  try {
    await renameDevice(a.page, 'Sharing Source');
    await renameDevice(b.page, 'Sharing Destination');
    await pair([a, b]);
    await selectDevice(a.page, 'Sharing Destination');
    await b.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await b.page.evaluate(() => navigator.clipboard.writeText('keep-private'));

    await a.page.getByTestId('share-clipboard').click();
    await a.page.getByTestId('shared-text').fill('user-entered text');
    await a.page.getByTestId('send-shared').click();
    await expect(b.page.getByTestId('shared-approval')).toBeVisible();
    expect(await b.page.evaluate(() => (window.__fluxa!.snapshot() as any).receivedShares.length)).toBe(0);
    expect(await b.page.evaluate(() => navigator.clipboard.readText())).toBe('keep-private');
    await b.page.getByTestId('decline-shared').click();
    await expect(a.page.getByTestId('toast').filter({ hasText: /declined/i }).first()).toBeVisible();
    expect(await b.page.evaluate(() => (window.__fluxa!.snapshot() as any).receivedShares.length)).toBe(0);

    await a.page.getByTestId('share-link').click();
    await a.page.getByTestId('shared-url').fill('javascript:alert(1)');
    await a.page.getByTestId('send-shared').click();
    await expect(a.page.getByTestId('toast').filter({ hasText: /only HTTP\(S\)/i }).first()).toBeVisible();
    await expect(b.page.getByTestId('shared-approval')).toHaveCount(0);
    await a.page.getByTestId('share-composer').getByRole('button', { name: 'Cancel' }).click();

    await a.page.getByTestId('share-session').click();
    await a.page.getByTestId('shared-url').fill('https://example.com/work/continue');
    await a.page.getByTestId('shared-title').fill('Continue reading');
    await a.page.getByTestId('shared-text').fill('Section five, with no credentials');
    await a.page.getByTestId('send-shared').click();
    await expect(b.page.getByTestId('shared-approval')).toContainText('Continue reading');
    expect(await b.page.evaluate(() => navigator.clipboard.readText())).toBe('keep-private');
    expect(await b.page.evaluate(() => (window.__fluxa!.snapshot() as any).receivedShares.length)).toBe(0);
    await b.page.getByTestId('accept-shared').click();
    await expect(b.page.getByTestId('open-shared')).toHaveAttribute('href', 'https://example.com/work/continue');
    expect(await b.page.evaluate(() => navigator.clipboard.readText())).toBe('keep-private');
    const received = await b.page.evaluate(() => (window.__fluxa!.snapshot() as any).receivedShares[0]);
    expect(received.kind).toBe('session');
    expect(received.text).toBe('Section five, with no credentials');
    await b.page.getByTestId('copy-shared').click();
    await expect.poll(() => b.page.evaluate(() => navigator.clipboard.readText())).toBe('https://example.com/work/continue');
    expect(await b.page.evaluate(() => (window.__fluxa!.snapshot() as any).transfers.length)).toBe(0);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

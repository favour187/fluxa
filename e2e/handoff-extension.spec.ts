/** Extension payload and two-stage verified browser handoff, with no cookies. */
import { test, expect } from '@playwright/test';
import { handoffLink } from '../extension/links.mjs';
import { openClient, pair, renameDevice } from './helpers';

const draft = { url: 'https://example.com/work/continue?section=7#notes', title: 'Continue reading' };

test('extension web link reaches an existing verified Fluxa tab without replacing its connection', async ({ browser }) => {
  const a = await openClient(browser, 'Extension sender');
  const b = await openClient(browser, 'Extension receiver');
  try {
    await renameDevice(a.page, 'Tab source');
    await renameDevice(b.page, 'Tab destination');
    await pair([a, b]);
    const opener = await a.context.newPage();
    const link = handoffLink('web', 'http://127.0.0.1:8787/', draft);
    await opener.goto(link);
    await expect(a.page.getByTestId('handoff-banner')).toContainText('Continue reading');
    await expect(a.page.locator('.badge.verified')).toBeVisible();
    await expect(b.page.locator('.badge.verified')).toBeVisible();
    await a.page.getByTestId('handoff-review').click();
    await expect(a.page.getByTestId('shared-url')).toHaveValue(draft.url);
    await expect(a.page.getByTestId('shared-title')).toHaveValue(draft.title);
    await expect(b.page.getByTestId('shared-approval')).toHaveCount(0);
    await a.page.getByTestId('send-shared').click();
    await expect(b.page.getByTestId('shared-approval')).toContainText(draft.url);
    await expect(b.page.getByTestId('open-shared')).toHaveCount(0);
    await b.page.getByTestId('accept-shared').click();
    await expect(b.page.getByTestId('open-shared')).toHaveAttribute('href', draft.url);
    await expect(a.page.getByTestId('handoff-banner')).toBeHidden();
  } finally { await a.context.close(); await b.context.close(); }
});

test('without an existing Fluxa tab, a handoff opens a review draft, not an automatic send', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(handoffLink('web', 'http://127.0.0.1:8787/', draft));
    await expect(page.getByTestId('handoff-banner')).toContainText('Pair and verify a device first');
    expect(new URL(page.url()).hash).toBe('');
    expect(await page.evaluate(() => (window.__fluxa!.snapshot() as any).receivedShares.length)).toBe(0);
    await page.getByTestId('handoff-discard').click();
    await expect(page.getByTestId('handoff-banner')).toBeHidden();
  } finally { await context.close(); }
});

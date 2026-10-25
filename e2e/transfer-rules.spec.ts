/** Per-peer transfer preferences: safe defaults, bounded automation, block and explicit picker-send. */
import { test, expect } from '@playwright/test';
import { openClient, pair, renameDevice, selectDevice, stageAndSend, textFile, waitForState } from './helpers';

test('auto-accept only approved size/type into private storage; block and immediate-send stay per device', async ({ browser }) => {
  const a = await openClient(browser, 'Rules sender');
  const b = await openClient(browser, 'Rules receiver');
  try {
    await renameDevice(a.page, 'Rules sender');
    await renameDevice(b.page, 'Rules receiver');
    await pair([a, b]);
    await selectDevice(a.page, 'Rules receiver');
    await selectDevice(b.page, 'Rules sender');
    await b.page.getByTestId('transfer-rules').click();
    await expect(b.page.getByTestId('incoming-rule')).toHaveValue('ask');
    await b.page.getByTestId('incoming-rule').selectOption('auto');
    await b.page.getByTestId('auto-max').fill('1');
    await b.page.getByTestId('allowed-extensions').fill('.txt');
    await b.page.getByTestId('save-transfer-rules').click();
    await expect(b.page.getByTestId('transfer-rules-modal')).toHaveCount(0);

    await stageAndSend(a.page, [textFile('allowed.txt', 'auto accept into private storage')]);
    await waitForState(b.page, 'complete');
    await waitForState(a.page, 'complete');
    await expect(b.page.getByTestId('incoming-modal')).toHaveCount(0);
    const saved = await b.page.evaluate(() => (window.__fluxa!.snapshot() as any).transfers[0]);
    expect(saved.role).toBe('receive');
    expect(saved.state).toBe('complete');

    await stageAndSend(a.page, [textFile('unknown.exe', 'explicit approval required')]);
    await expect(b.page.getByTestId('incoming-modal')).toBeVisible();
    await b.page.getByTestId('decline-transfer').click();
    await expect(a.page.getByTestId('transfer-item').filter({ hasText: 'unknown.exe' })).toHaveAttribute('data-state', 'declined');

    await b.page.getByTestId('transfer-rules').click();
    await b.page.getByTestId('incoming-rule').selectOption('block');
    await b.page.getByTestId('save-transfer-rules').click();
    await stageAndSend(a.page, [textFile('blocked.txt', 'should not land')]);
    await expect(a.page.getByTestId('transfer-item').filter({ hasText: 'blocked.txt' })).toHaveAttribute('data-state', 'declined');
    await expect(b.page.getByTestId('incoming-modal')).toHaveCount(0);

    await b.page.getByTestId('transfer-rules').click();
    await b.page.getByTestId('incoming-rule').selectOption('auto');
    await b.page.getByTestId('save-transfer-rules').click();
    await a.page.getByTestId('transfer-rules').click();
    await expect(a.page.getByTestId('incoming-rule')).toHaveValue('ask', { timeout: 10_000 });
    await a.page.getByTestId('send-immediately').check();
    await a.page.getByTestId('save-transfer-rules').click();
    await a.page.getByTestId('file-input').setInputFiles([textFile('direct-from-picker.txt', 'explicit file pick sends immediately')]);
    await expect(a.page.getByTestId('edge-send-card')).toHaveCount(0);
    await expect(a.page.getByTestId('transfer-item').filter({ hasText: 'direct-from-picker.txt' })).toHaveAttribute('data-state', 'complete', { timeout: 45_000 });
  } finally { await a.context.close(); await b.context.close(); }
});

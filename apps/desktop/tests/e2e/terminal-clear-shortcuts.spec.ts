import { test, expect, type Page } from '@playwright/test';
import { Session } from './support/session-harness';

// User decision 13 (2026-11-07): macOS-only Cmd+L (clear screen) and Cmd+Shift+L (clear screen
// and scrollback); Ctrl+L and every other platform stay with the terminal. Stub IPC through the
// production session path in Chrome; the platform is emulated through `navigator.platform`.
// Nothing here covers a native WebView, a real keyboard layout or WindTerm 2.7.0's own bindings.

const SIZE = { cols: 40, rows: 10 };
const HISTORY = Array.from({ length: 30 }, (_, n) => `history ${n}\r\n`).join('');

/** Every row of the normal buffer, scrollback first. */
const rows = (page: Page) => page.evaluate(() => {
  const b = (window as any).qa.terminal.buffer.normal;
  return Array.from({ length: b.length }, (_, y) => b.getLine(y).translateToString(true) as string);
});

test('macOS: Cmd+L clears the screen, Cmd+Shift+L clears screen and scrollback, and nothing is sent', async ({ page }) => {
  const s = await Session.open(page, 'pty', { platform: 'MacIntel', size: SIZE });
  await s.send(`${HISTORY}before\r\nabc`);
  await s.textarea.focus();
  await s.mark();

  await page.keyboard.press('Meta+l');
  await s.send(); // queued behind the local action write: resolves once it was parsed
  const afterScreen = await rows(page);
  expect(afterScreen).toContain('history 0');
  expect(afterScreen.slice(-SIZE.rows)).toEqual(Array(SIZE.rows).fill(''));

  await page.keyboard.press('Meta+Shift+L');
  await s.send();
  expect(await rows(page)).toEqual(Array(SIZE.rows).fill(''));
  expect((await s.written()).text).toBe('');
});

test('macOS: Ctrl+L still reaches the shell and Cmd+L is ignored while a dialog is open', async ({ page }) => {
  const s = await Session.open(page, 'pty', { platform: 'MacIntel', size: SIZE });
  await s.send(`${HISTORY}before\r\nabc`);
  const before = await rows(page);

  await page.locator('#palette-open').click();
  await expect(page.locator('#palette-dialog')).toBeVisible();
  await page.keyboard.press('Meta+l');
  await page.keyboard.press('Escape');
  await s.send();
  expect(await rows(page)).toEqual(before);

  await s.textarea.focus();
  await s.mark();
  await page.keyboard.press('Control+l');
  await s.expectWritten('\x0c');
  expect(await rows(page)).toEqual(before);
});

test('Linux: Meta+L does not clear and Ctrl+L sends 0x0c to the shell', async ({ page }) => {
  const s = await Session.open(page, 'pty', { platform: 'Linux x86_64', size: SIZE });
  await s.send(`${HISTORY}before\r\nabc`);
  const before = await rows(page);
  await s.textarea.focus();

  await page.keyboard.press('Meta+l');
  await s.send();
  expect(await rows(page)).toEqual(before);

  await s.mark();
  await page.keyboard.press('Control+l');
  await s.expectWritten('\x0c');
  expect(await rows(page)).toEqual(before);
});

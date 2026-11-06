import { test, expect } from '@playwright/test';
import { Session, TRANSPORTS } from './support/session-harness';

// P1 slice 4 keyboard regressions through the production input path: Playwright/CDP key events
// in Chrome -> xterm.js -> the session's custom key handler and guards (terminal-input.ts) ->
// queueInput -> the stubbed pty_write / ssh_write / net_write. input-keys.spec.ts already covers
// the demo, pty and ssh key tables with modes set in one chunk. `navigator.platform` stands in for
// macOS / Windows / Linux; OS keyboard layouts, global shortcuts and native WebView accelerators are
// not involved. Expected sequences are xterm.js 6.0.0's; "observed" marks behaviour not compared
// with WindTerm 2.7.0 or other terminals.
const E = '\x1b';
const one = (text: string) => [...Buffer.from(text, 'utf8')].map((b) => [b]);

const NORMAL_CURSOR: Record<string, string> = {
  ArrowUp: `${E}[A`, ArrowDown: `${E}[B`, ArrowRight: `${E}[C`, ArrowLeft: `${E}[D`, Home: `${E}[H`, End: `${E}[F`,
};
const APPLICATION_CURSOR: Record<string, string> = {
  ArrowUp: `${E}OA`, ArrowDown: `${E}OB`, ArrowRight: `${E}OC`, ArrowLeft: `${E}OD`, Home: `${E}OH`, End: `${E}OF`,
};
const MODE_INDEPENDENT: Record<string, string> = {
  F1: `${E}OP`, F2: `${E}OQ`, F3: `${E}OR`, F4: `${E}OS`, F5: `${E}[15~`, F6: `${E}[17~`, F7: `${E}[18~`,
  F8: `${E}[19~`, F9: `${E}[20~`, F10: `${E}[21~`, F11: `${E}[23~`, F12: `${E}[24~`,
  Insert: `${E}[2~`, Delete: `${E}[3~`, PageUp: `${E}[5~`, PageDown: `${E}[6~`,
  Escape: E, Tab: '\t', 'Shift+Tab': `${E}[Z`, Enter: '\r', Backspace: '\x7f', 'Control+Backspace': '\b',
  'Control+ArrowLeft': `${E}[1;5D`, 'Shift+ArrowUp': `${E}[1;2A`, 'Control+Home': `${E}[1;5H`,
  'Control+a': '\x01', 'Control+c': '\x03', 'Control+d': '\x04', 'Control+z': '\x1a', 'Control+Slash': '\x1f',
  'Control+BracketLeft': E, 'Control+Space': '\x00',
};

test('net: the key table reaches net_write in normal and application cursor-key modes', async ({ page }) => {
  test.setTimeout(60_000);
  const s = await Session.open(page, 'net');
  const normal = { ...NORMAL_CURSOR, ...MODE_INDEPENDENT };
  expect(await s.pressEach(Object.keys(normal))).toEqual(normal);
  await s.send(`${E}[?1h`);
  const application = { ...APPLICATION_CURSOR, ...MODE_INDEPENDENT };
  expect(await s.pressEach(Object.keys(application))).toEqual(application);
  await s.mark();
  await page.keyboard.type('中文 é');
  await s.expectWritten('中文 é');
  expect((await s.written()).ids).toHaveLength(1);
});

for (const transport of TRANSPORTS) {
  test(`${transport}: cursor-key and keypad modes switched by one-byte chunks, RIS and DECSTR`, async ({ page }) => {
    const s = await Session.open(page, transport);
    const arrows = ['ArrowUp', 'Home'];
    const expectArrows = async (expected: Record<string, string>) =>
      expect(await s.pressEach(arrows)).toEqual(Object.fromEntries(arrows.map((key) => [key, expected[key]])));
    await s.send(...one(`${E}[?1h`));
    await expectArrows(APPLICATION_CURSOR);
    await s.send(...one(`${E}c`));
    await expectArrows(NORMAL_CURSOR);
    await s.send(...one(`${E}[?1h`), ...one(`${E}[!p`));
    await expectArrows(NORMAL_CURSOR);
    // DECKPAM / DECKPNM: the mode is tracked (DECRQM ?66) though xterm.js 6.0.0 has no keypad encoding.
    const keypad = async () => {
      await s.mark();
      await s.send(`${E}[?66$p`);
      await s.settle();
      return (await s.written()).text;
    };
    await s.send(...one(`${E}=`));
    expect(await keypad()).toBe(`${E}[?66;1$y`);
    await s.send(...one(`${E}c`));
    expect(await keypad()).toBe(`${E}[?66;2$y`);
    await s.send(...one(`${E}=`), ...one(`${E}>`));
    expect(await keypad()).toBe(`${E}[?66;2$y`);
    await s.drained();
  });
}

for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
  test(`${platform}: Ctrl+C is sent as ETX with a selection, with mouse tracking on and after RIS; copy chords send nothing`, async ({ page }) => {
    const s = await Session.open(page, 'pty', { platform });
    await s.send('selected output\r\n');
    await page.evaluate(() => (window as any).qa.terminal.selectAll());
    expect(await page.evaluate(() => (window as any).qa.terminal.getSelection())).toContain('selected output');
    expect(await s.pressEach(['Control+c'])).toEqual({ 'Control+c': '\x03' });
    // Sending input clears the selection; nothing intercepts Ctrl+C as a copy shortcut.
    expect(await page.evaluate(() => (window as any).qa.terminal.hasSelection())).toBe(false);
    await s.send(`${E}[?1000;1006h`);
    expect(await s.pressEach(['Control+c'])).toEqual({ 'Control+c': '\x03' });
    await s.send(`${E}c`);
    expect(await s.pressEach(['Control+c'])).toEqual({ 'Control+c': '\x03' });
    // Observed: xterm.js 6.0.0 binds no terminal copy/paste chords; they send nothing to the host.
    expect(await s.pressEach(['Control+Shift+c', 'Control+Shift+v', 'Control+Insert', 'Shift+Insert', 'Meta+c'])).toEqual({
      'Control+Shift+c': '', 'Control+Shift+v': '', 'Control+Insert': '', 'Shift+Insert': '', 'Meta+c': '',
    });
  });
}

test.describe('platform differences xterm.js 6.0.0 makes from navigator.platform', () => {
  /** Ctrl+Alt+Q as Windows reports AltGr+Q on a German layout: the layout's `@` character. */
  const altGrQ = { key: '@', code: 'KeyQ', keyCode: 81, text: '@', modifiers: 2 | 1 };
  const ctrlAltA = { key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2 | 1 };

  test('Win32: Ctrl+Alt is treated as AltGr, so the layout character is sent and Ctrl+Alt+A sends nothing', async ({ page }) => {
    const s = await Session.open(page, 'pty', { platform: 'Win32' });
    await s.mark();
    await s.cdpKey(altGrQ);
    await s.expectWritten('@');
    await s.mark();
    await s.cdpKey(ctrlAltA);
    await s.settle();
    await s.expectWritten('');
  });

  test('Linux: the same Ctrl+Alt chords are Meta+Ctrl and send ESC with the control character', async ({ page }) => {
    const s = await Session.open(page, 'pty', { platform: 'Linux x86_64' });
    await s.mark();
    await s.cdpKey(altGrQ);
    await s.expectWritten(`${E}\x11`);
    await s.mark();
    await s.cdpKey(ctrlAltA);
    await s.expectWritten(`${E}\x01`);
  });

  test('macOS: Ctrl+Option+A sends nothing; Option+F types ƒ (input-keys.spec.ts)', async ({ page }) => {
    const s = await Session.open(page, 'pty', { platform: 'MacIntel' });
    await s.mark();
    await s.cdpKey(ctrlAltA);
    await s.settle();
    await s.expectWritten('');
  });

  for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
    test(`${platform}: Alt/Option with Backspace, Enter and Escape is Meta; Cmd/Win with Backspace or arrows is ignored`, async ({ page }) => {
      // Observed on macOS too, although macOptionIsMeta is off: Option+Backspace (readline
      // backward-kill-word) sends ESC DEL. Cmd+Backspace sends a plain DEL and Cmd+Left nothing.
      const s = await Session.open(page, 'pty', { platform });
      expect(await s.pressEach(['Alt+Backspace', 'Alt+Enter', 'Alt+Escape', 'Meta+Backspace', 'Meta+ArrowLeft', 'Meta+ArrowRight'])).toEqual({
        'Alt+Backspace': `${E}\x7f`, 'Alt+Enter': `${E}\r`, 'Alt+Escape': `${E}${E}`,
        'Meta+Backspace': '\x7f', 'Meta+ArrowLeft': '', 'Meta+ArrowRight': '',
      });
    });
  }
});

test('modifiers on Enter, Backspace, Delete, Home and End; Shift+PageUp/PageDown scroll history and send nothing', async ({ page }) => {
  const s = await Session.open(page, 'pty');
  expect(await s.pressEach(['Shift+Enter', 'Control+Enter', 'Shift+Backspace', 'Control+Delete', 'Shift+Delete', 'Shift+Home', 'Shift+End'])).toEqual({
    'Shift+Enter': '\r', 'Control+Enter': '\r', 'Shift+Backspace': '\x7f', 'Control+Delete': `${E}[3;5~`,
    'Shift+Delete': `${E}[3;2~`, 'Shift+Home': `${E}[1;2H`, 'Shift+End': `${E}[1;2F`,
  });
  await s.send(Array.from({ length: 200 }, (_, n) => `line ${n}\r\n`).join(''));
  const viewport = () => page.evaluate(() => {
    const b = (window as any).qa.terminal.buffer.active;
    return { viewportY: b.viewportY, baseY: b.baseY };
  });
  const bottom = await viewport();
  expect(bottom.viewportY).toBe(bottom.baseY);
  await s.mark();
  await page.keyboard.press('Shift+PageUp');
  await expect.poll(async () => (await viewport()).viewportY).toBeLessThan(bottom.baseY);
  await page.keyboard.press('Shift+PageDown');
  await expect.poll(async () => (await viewport()).viewportY).toBe(bottom.baseY);
  await s.settle();
  await s.expectWritten('');
  // Typing returns to the bottom too (scrollOnUserInput) and is sent normally.
  await page.keyboard.press('Shift+PageUp');
  await page.keyboard.type('x');
  await s.expectWritten('x');
  await expect.poll(async () => (await viewport()).viewportY).toBe(bottom.baseY);
});

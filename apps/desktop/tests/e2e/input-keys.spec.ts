import { test, expect, type Page } from '@playwright/test';
import { MODES, Term } from './input-harness';

// Key encoding probes. Keys are Playwright/CDP key events in Chrome on this Mac, so the OS keyboard
// layout, macOS system shortcuts (e.g. Ctrl+Space switching input sources) and WKWebView / WebView2
// accelerators are not involved. Expected sequences are xterm.js 6.0.0's, as sent to the transport.
const E = '\x1b';

const CURSOR_KEYS = {
  normal: { ArrowUp: `${E}[A`, ArrowDown: `${E}[B`, ArrowRight: `${E}[C`, ArrowLeft: `${E}[D`, Home: `${E}[H`, End: `${E}[F` },
  application: { ArrowUp: `${E}OA`, ArrowDown: `${E}OB`, ArrowRight: `${E}OC`, ArrowLeft: `${E}OD`, Home: `${E}OH`, End: `${E}OF` },
} as const;

/** Same in both cursor-key modes. */
const MODE_INDEPENDENT: Record<string, string> = {
  F1: `${E}OP`, F2: `${E}OQ`, F3: `${E}OR`, F4: `${E}OS`,
  F5: `${E}[15~`, F6: `${E}[17~`, F7: `${E}[18~`, F8: `${E}[19~`,
  F9: `${E}[20~`, F10: `${E}[21~`, F11: `${E}[23~`, F12: `${E}[24~`,
  Insert: `${E}[2~`, Delete: `${E}[3~`, PageUp: `${E}[5~`, PageDown: `${E}[6~`,
  Escape: E, Tab: '\t', 'Shift+Tab': `${E}[Z`, Enter: '\r', Backspace: '\x7f',
  'Shift+F1': `${E}[1;2P`, 'Control+F5': `${E}[15;5~`, 'Shift+F12': `${E}[24;2~`,
  'Control+ArrowLeft': `${E}[1;5D`, 'Shift+ArrowUp': `${E}[1;2A`, 'Control+Shift+ArrowRight': `${E}[1;6C`,
  'Control+Home': `${E}[1;5H`,
};

const CONTROL_KEYS: Record<string, string> = {
  'Control+a': '\x01', 'Control+c': '\x03', 'Control+d': '\x04', 'Control+e': '\x05',
  'Control+k': '\x0b', 'Control+l': '\x0c', 'Control+r': '\x12', 'Control+u': '\x15',
  'Control+w': '\x17', 'Control+z': '\x1a', 'Control+Space': '\x00', 'Control+BracketLeft': E,
  'Control+Backslash': '\x1c', 'Control+BracketRight': '\x1d', 'Control+3': E, 'Control+4': '\x1c',
  'Control+5': '\x1d', 'Control+6': '\x1e', 'Control+7': '\x1f', 'Control+8': '\x7f',
  'Control+Shift+Minus': '\x1f', 'Control+Slash': '\x1f', 'Control+Backspace': '\b',
};

/** Numpad 1 with Num Lock on (Playwright's `Numpad1` is End). */
async function keypadDigit(t: Term) {
  const key = { key: '1', code: 'Numpad1', windowsVirtualKeyCode: 97, location: 3 };
  await t.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', text: '1', ...key });
  await t.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  await t.settle();
}

/** Ctrl+Shift+2 as a US layout reports it (key `@`); Playwright reports key `2` instead. */
async function controlAt(t: Term) {
  const key = { key: '@', code: 'Digit2', windowsVirtualKeyCode: 50, modifiers: 2 | 8 };
  await t.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
  await t.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  await t.settle();
}

async function pressEach(t: Term, page: Page, keys: Record<string, string>) {
  const sent: Record<string, string[]> = {};
  for (const key of Object.keys(keys)) {
    await t.reset();
    await page.keyboard.press(key);
    await t.settle();
    sent[key] = await t.dataEvents();
  }
  return sent;
}

const once = (keys: Record<string, string>) => Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, [v]]));

for (const mode of MODES) {
  test.describe(`${mode} keys`, () => {
    test('cursor and function keys in normal and application cursor-key mode', async ({ page }) => {
      test.setTimeout(60_000);
      const t = await Term.open(page, mode);
      const normal = { ...CURSOR_KEYS.normal, ...MODE_INDEPENDENT };
      expect(await pressEach(t, page, normal)).toEqual(once(normal));
      await t.output(`${E}[?1h`);
      const application = { ...CURSOR_KEYS.application, ...MODE_INDEPENDENT };
      expect(await pressEach(t, page, application)).toEqual(once(application));
      await t.output(`${E}[?1l`);
      expect(await pressEach(t, page, CURSOR_KEYS.normal)).toEqual(once(CURSOR_KEYS.normal));
      // DECKPAM is accepted but xterm.js 6.0.0 has no application keypad encoding: digits stay digits.
      await t.output(`${E}=`);
      await t.reset();
      await keypadDigit(t);
      expect(await t.dataEvents()).toEqual(['1']);
    });

    test('Ctrl combinations map to C0 controls, including Ctrl+/', async ({ page }) => {
      const t = await Term.open(page, mode);
      expect(await pressEach(t, page, CONTROL_KEYS)).toEqual(once(CONTROL_KEYS));
      await t.reset();
      await controlAt(t);
      expect(await t.dataEvents()).toEqual(['\x00']);
    });
  });
}

test('function keys, Tab and Shift+Tab keep focus and the page; each sequence is sent once', async ({ page }) => {
  // With screenReaderMode xterm.js 6.0.0 sends F-keys and Shift+Tab without cancelling the
  // keydown, so the host's default action (F5 reload, Shift+Tab focus change) would also run.
  // Plain Tab is cancelled and stopped by xterm.js itself, so it never reaches this listener.
  const t = await Term.open(page, 'pty');
  await page.evaluate(() => {
    const log: [string, boolean][] = [];
    (window as any).qaKeys = log;
    window.addEventListener('keydown', (event) => log.push([event.key, event.defaultPrevented]));
  });
  await t.reset();
  for (const key of ['F3', 'F5', 'F7', 'F11', 'F12', 'Tab', 'Shift+Tab', 'Tab']) {
    await page.keyboard.press(key);
    await expect(t.textarea).toBeFocused();
  }
  await t.settle();
  expect(await t.sent()).toBe(`${E}OR${E}[15~${E}[18~${E}[23~${E}[24~\t${E}[Z\t`);
  const log = await page.evaluate(() => (window as any).qaKeys.filter(([key]: [string]) => key !== 'Shift'));
  expect(log).toEqual([['F3', true], ['F5', true], ['F7', true], ['F11', true], ['F12', true], ['Tab', true]]);
});

test('Cmd+K and Ctrl+Shift+K open the command palette and send nothing; Ctrl+K is sent', async ({ page }) => {
  const t = await Term.open(page, 'pty');
  await t.reset();
  await page.keyboard.press('Control+k');
  await t.settle();
  expect(await t.sent()).toBe('\x0b');
  await page.keyboard.press('Meta+k');
  await expect(page.locator('#palette-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await t.textarea.focus();
  await page.keyboard.press('Control+Shift+K');
  await expect(page.locator('#palette-dialog')).toBeVisible();
  expect(await t.sent()).toBe('\x0b');
});

/** One Option/Alt+F press as Chrome on macOS reports it: the layout's third-level character. */
async function optionF(t: Term, key: string) {
  const base = { code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 3, modifiers: 1 };
  await t.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, unmodifiedText: 'f', ...base });
  await t.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, ...base });
  await t.settle();
}

test.describe('Option / Alt as Meta', () => {
  test('macOS default: macOptionIsMeta is off, so Option+F types ƒ rather than ESC f', async ({ page }) => {
    const t = await Term.open(page, 'pty', { platform: 'MacIntel' });
    expect(await page.evaluate(() => (window as any).qa.terminal.options.macOptionIsMeta)).toBe(false);
    await t.reset();
    await optionF(t, 'ƒ');
    expect(await t.sent()).toBe('ƒ');
    // xterm.js 6.0.0 no longer rewrites Option+Left/Right to ESC b / ESC f on macOS; they are
    // CSI 1;3 D / C, which zsh and bash do not bind by default.
    await t.reset();
    await page.keyboard.press('Alt+ArrowLeft');
    await page.keyboard.press('Alt+ArrowRight');
    await t.settle();
    expect(await t.sent()).toBe(`${E}[1;3D${E}[1;3C`);
  });

  test('macOS with macOptionIsMeta on (not shipped): Option+F sends ESC f', async ({ page }) => {
    const t = await Term.open(page, 'pty', { platform: 'MacIntel' });
    await page.evaluate(() => { (window as any).qa.terminal.options.macOptionIsMeta = true; });
    await t.reset();
    await optionF(t, 'ƒ');
    expect(await t.sent()).toBe(`${E}f`);
  });

  for (const platform of ['Win32', 'Linux x86_64']) {
    test(`${platform}: Alt is Meta, Alt+F sends ESC f and Alt+Left sends CSI 1;3 D`, async ({ page }) => {
      const t = await Term.open(page, 'pty', { platform });
      await t.reset();
      await optionF(t, 'f');
      await page.keyboard.press('Alt+ArrowLeft');
      await t.settle();
      expect(await t.sent()).toBe(`${E}f${E}[1;3D`);
    });
  }
});

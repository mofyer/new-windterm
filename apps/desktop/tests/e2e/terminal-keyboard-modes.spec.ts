import { test, expect, type Page } from '@playwright/test';
import { Session, TRANSPORTS, type Transport } from './support/session-harness';
import { observe, openArguments, recordOpenArguments } from './support/encoding-harness';
import { allWrites, chooseKeyboard, fillDialog, openWithKeyboard, submitDialog, type KeyboardChoice } from './support/keyboard-harness';

// T31 part 1, per-session keyboard and initial-mode options (docs/p1/KEYBOARD_MODES_PLAN.zh-CN.md)
// through the production path: the dialogs -> session snapshot -> session-lifecycle.ts ->
// terminal-keyboard.ts -> xterm.js -> queueInput -> the stubbed `*_write`. Keys are Playwright/CDP
// events in Chrome and `navigator.platform` stands in for macOS / Windows / Linux; no OS keyboard
// layout, native input method, native WebView, Rust, PTY, SSH server or TCP peer is involved.
// Expected default sequences are xterm.js 6.0.0's; nothing is claimed about WindTerm 2.7.0.
const E = '\x1b';
const PREFIX: Record<Transport, string> = { pty: 'local', ssh: 'ssh', net: 'net' };
const ALL_CHANGED: KeyboardChoice = { backspace: 'bs', delete: 'del', cursorKeys: 'application' };

/** Keys whose bytes the options may change, plus neighbours that must never change. */
const DEFAULT_KEYS: Record<string, string> = {
  Backspace: '\x7f', 'Shift+Backspace': '\x7f', 'Control+Backspace': '\b', 'Alt+Backspace': `${E}\x7f`,
  'Control+Alt+Backspace': `${E}\b`, 'Meta+Backspace': '\x7f',
  Delete: `${E}[3~`, 'Shift+Delete': `${E}[3;2~`, 'Control+Delete': `${E}[3;5~`, 'Alt+Delete': `${E}[3;3~`,
  ArrowUp: `${E}[A`, ArrowLeft: `${E}[D`, Home: `${E}[H`, End: `${E}[F`, 'Control+ArrowLeft': `${E}[1;5D`,
  Enter: '\r', Tab: '\t', Escape: E, F1: `${E}OP`, Insert: `${E}[2~`, PageUp: `${E}[5~`,
  'Control+c': '\x03', 'Control+h': '\b', 'Control+8': '\x7f', 'Control+l': '\x0c', 'Control+Slash': '\x1f',
  'Control+d': '\x04', 'Control+z': '\x1a',
};
/** The same keys with Backspace BS, Delete DEL and application cursor keys. */
const CHANGED_KEYS: Record<string, string> = {
  ...DEFAULT_KEYS,
  Backspace: '\b', 'Shift+Backspace': '\b', 'Control+Backspace': '\x7f', 'Alt+Backspace': `${E}\b`,
  'Control+Alt+Backspace': `${E}\x7f`, 'Meta+Backspace': '\b', Delete: '\x7f',
  ArrowUp: `${E}OA`, ArrowLeft: `${E}OD`, Home: `${E}OH`, End: `${E}OF`,
};
const NORMAL_ARROWS = { ArrowUp: `${E}[A`, Home: `${E}[H` };
const APPLICATION_ARROWS = { ArrowUp: `${E}OA`, Home: `${E}OH` };

async function expectKeys(s: Session, table: Record<string, string>) {
  for (const [key, expected] of Object.entries(table)) {
    await s.mark();
    await s.page.keyboard.press(key);
    await s.settle();
    const calls = await s.writeCalls();
    // One key press, one write, the expected bytes, on the session's own transport.
    expect({ key, calls }).toEqual({ key, calls: expected ? [expected] : [] });
    if (expected) expect((await s.written()).commands).toEqual([`${s.transport}_write`]);
  }
}
async function decrqm(s: Session, mode: number): Promise<string> {
  await s.mark();
  await s.send(`${E}[?${mode}$p`);
  await s.settle();
  return (await s.written()).text;
}
const macOptionIsMeta = (page: Page) => page.evaluate(() => (window as any).qa.terminal.options.macOptionIsMeta);

/** One Option/Alt+F press as Chrome on macOS reports it: the layout's third-level character. */
async function optionF(s: Session, key: string) {
  const base = { code: 'KeyF', windowsVirtualKeyCode: 70, nativeVirtualKeyCode: 3, modifiers: 1 };
  await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, text: key, unmodifiedText: 'f', ...base });
  await s.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, ...base });
  await s.settle();
}

async function hardReset(s: Session) {
  await s.page.locator('#terminal-actions-open').click();
  await s.page.locator('[data-terminal-action="reset-hard"]').click();
  await s.send(); // an empty write queued behind the action: resolves once it was parsed
}

test.describe('defaults are the behaviour before this option', () => {
  for (const transport of TRANSPORTS) {
    test(`${transport}: the dialog shows the defaults collapsed and the untouched session sends xterm.js's key table`, async ({ page }) => {
      test.setTimeout(60_000);
      const s = await Session.open(page, transport, {}, false);
      await recordOpenArguments(page);
      await fillDialog(page, transport);
      const prefix = PREFIX[transport];
      await expect(page.locator(`#${prefix}-keyboard`)).toHaveJSProperty('open', false);
      await expect(page.locator(`#${prefix}-keyboard-state`)).toHaveText('默认');
      expect(await page.evaluate((prefix) => ['backspace', 'delete', 'option-meta', 'cursor-keys']
        .map((name) => (document.querySelector(`#${prefix}-${name}`) as HTMLSelectElement).value), prefix))
        .toEqual(['del', 'vt220', 'false', 'normal']);
      await submitDialog(page, transport);
      await s.textarea.focus();
      // Nothing reaches the host at start, the terminal options are xterm.js's own defaults.
      expect(await allWrites(page)).toEqual([]);
      expect(await macOptionIsMeta(page)).toBe(false);
      expect(await decrqm(s, 1)).toBe(`${E}[?1;2$y`);
      await expectKeys(s, DEFAULT_KEYS);
    });
  }

  test('the default one-click local terminal is unchanged as well', async ({ page }) => {
    test.setTimeout(60_000);
    const s = await Session.open(page, 'pty');
    expect(await allWrites(page)).toEqual([]);
    expect(await macOptionIsMeta(page)).toBe(false);
    await expectKeys(s, DEFAULT_KEYS);
  });
});

test.describe('Backspace, Delete and initial cursor keys on every transport', () => {
  for (const transport of TRANSPORTS) {
    test(`${transport}: chosen options change only Backspace, Delete and the initial cursor keys`, async ({ page }) => {
      test.setTimeout(60_000);
      const s = await openWithKeyboard(page, transport, ALL_CHANGED);
      // The initial mode is local: nothing was sent, yet DECRQM reports application cursor keys.
      expect(await allWrites(page)).toEqual([]);
      expect(await decrqm(s, 1)).toBe(`${E}[?1;1$y`);
      await expectKeys(s, CHANGED_KEYS);
      await s.drained();
    });
  }

  test('Delete can send BS; modified Delete keeps its CSI 3 ; n ~ sequence', async ({ page }) => {
    const s = await openWithKeyboard(page, 'pty', { delete: 'bs' });
    expect(await s.pressEach(['Delete', 'Shift+Delete', 'Control+Delete', 'Alt+Delete', 'Meta+Delete', 'Backspace'])).toEqual({
      Delete: '\b', 'Shift+Delete': `${E}[3;2~`, 'Control+Delete': `${E}[3;5~`, 'Alt+Delete': `${E}[3;3~`,
      'Meta+Delete': `${E}[3;9~`, Backspace: '\x7f',
    });
  });

  for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
    test(`${platform}: Backspace BS swaps BS and DEL for every Backspace combination and keeps the ESC prefix`, async ({ page }) => {
      const keys = ['Backspace', 'Shift+Backspace', 'Control+Backspace', 'Alt+Backspace', 'Control+Alt+Backspace', 'Meta+Backspace'];
      const defaults = await Session.open(page, 'pty', { platform });
      const before = await defaults.pressEach(keys);
      const other = await page.context().newPage();
      const changed = await openWithKeyboard(other, 'pty', { backspace: 'bs' }, { platform });
      const after = await changed.pressEach(keys);
      const swap = (text: string) => text.replace(/[\b\x7f]$/, (c) => (c === '\b' ? '\x7f' : '\b'));
      expect(after).toEqual(Object.fromEntries(Object.entries(before).map(([key, value]) => [key, swap(value)])));
      expect(before.Backspace).toBe('\x7f');
      expect(after.Backspace).toBe('\b');
    });
  }
});

test.describe('nothing intercepted', () => {
  test('Ctrl+C with a selection, copy chords and the command palette behave as before', async ({ page }) => {
    const s = await openWithKeyboard(page, 'pty', ALL_CHANGED);
    await s.send('selected output\r\n');
    await page.evaluate(() => (window as any).qa.terminal.selectAll());
    expect(await s.pressEach(['Control+c'])).toEqual({ 'Control+c': '\x03' });
    expect(await s.pressEach(['Control+Shift+c', 'Control+Shift+v', 'Control+Insert', 'Meta+c'])).toEqual({
      'Control+Shift+c': '', 'Control+Shift+v': '', 'Control+Insert': '', 'Meta+c': '',
    });
    await s.mark();
    await page.keyboard.press('Meta+k');
    await expect(page.locator('#palette-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await s.textarea.focus();
    await s.settle();
    await s.expectWritten('');
  });

  test('IME: keys the IME consumes send nothing, the commit is sent once, then Backspace sends BS', async ({ page }) => {
    const s = await openWithKeyboard(page, 'pty', ALL_CHANGED);
    const imeKey = async (key: string) => {
      for (const type of ['rawKeyDown', 'keyUp'] as const)
        await s.cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: 229 });
    };
    await s.mark();
    await s.cdp.send('Input.imeSetComposition', { text: 'nih', selectionStart: 3, selectionEnd: 3 });
    await imeKey('Backspace');
    await s.cdp.send('Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    await imeKey('Delete');
    await imeKey('ArrowUp');
    await s.cdp.send('Input.imeSetComposition', { text: '你', selectionStart: 1, selectionEnd: 1 });
    await s.settle();
    await s.expectWritten('');
    await s.cdp.send('Input.insertText', { text: '你' });
    await s.expectWritten('你');
    expect(await s.writeCalls()).toEqual(['你']);
    await s.mark();
    await page.keyboard.press('Backspace');
    await s.expectWritten('\b');
  });

  test('macOS: Backspace after an Option dead key sends nothing, as by default', async ({ page }) => {
    const deadE = { key: 'Dead', code: 'KeyE', keyCode: 69, modifiers: 1 };
    const results: string[] = [];
    for (const choice of [undefined, { backspace: 'bs' } as KeyboardChoice]) {
      const target = choice ? await page.context().newPage() : page;
      const s = choice
        ? await openWithKeyboard(target, 'pty', choice, { platform: 'MacIntel' })
        : await Session.open(target, 'pty', { platform: 'MacIntel' });
      await s.mark();
      await s.cdpKey(deadE);
      await target.keyboard.press('Backspace');
      await s.settle();
      results.push((await s.written()).text);
      await s.mark();
      await target.keyboard.press('Backspace');
      await s.settle();
      results.push((await s.written()).text);
    }
    expect(results).toEqual(['', '\x7f', '', '\b']);
  });
});

test.describe('macOS Option as Meta', () => {
  test('MacIntel: Option sends ESC + key in the session that chose it, and only there', async ({ page }) => {
    const s = await openWithKeyboard(page, 'pty', { optionAsMeta: true }, { platform: 'MacIntel' });
    expect(await macOptionIsMeta(page)).toBe(true);
    await s.mark();
    await optionF(s, 'ƒ');
    await s.expectWritten(`${E}f`);
    expect(await s.pressEach(['Alt+Backspace', 'Alt+ArrowLeft', 'Alt+Enter'])).toEqual({
      'Alt+Backspace': `${E}\x7f`, 'Alt+ArrowLeft': `${E}[1;3D`, 'Alt+Enter': `${E}\r`,
    });
    // A second, default session in the same window still types the layout character.
    await page.locator('#local-open').click();
    await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.pendingOpen)).toBe(true);
    await page.evaluate(() => { const ipc = (window as any).qaIpc; const open = ipc.pendingOpen; ipc.pendingOpen = null; open(); });
    await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
    await observe(page);
    await s.textarea.focus();
    expect(await macOptionIsMeta(page)).toBe(false);
    await s.mark();
    await optionF(s, 'ƒ');
    await s.expectWritten('ƒ');
  });

  for (const platform of ['Win32', 'Linux x86_64']) {
    test(`${platform}: the Option choice is disabled and Alt stays Meta`, async ({ page }) => {
      const s = await Session.open(page, 'pty', { platform }, false);
      await fillDialog(page, 'pty');
      await page.locator('#local-keyboard summary').click();
      await expect(page.locator('#local-option-meta')).toBeDisabled();
      await expect(page.locator('#local-option-meta-hint')).toContainText('仅适用于 macOS');
      await submitDialog(page, 'pty');
      await s.textarea.focus();
      expect(await macOptionIsMeta(page)).toBe(false);
      await s.mark();
      await optionF(s, 'f');
      await s.expectWritten(`${E}f`);
    });
  }
});

test.describe('initial cursor-key mode and the host', () => {
  for (const transport of TRANSPORTS) {
    test(`${transport}: the host's DECCKM, DECSTR and RIS win; the user's hard reset restores the initial mode`, async ({ page }) => {
      test.setTimeout(60_000);
      const s = await openWithKeyboard(page, transport, { cursorKeys: 'application' });
      const arrows = async () => s.pressEach(Object.keys(NORMAL_ARROWS));
      expect(await arrows()).toEqual(APPLICATION_ARROWS);
      // One-byte chunks: the host turns it off and on again.
      await s.send(...[...`${E}[?1l`].map((c) => [c.charCodeAt(0)]));
      expect(await arrows()).toEqual(NORMAL_ARROWS);
      await s.send(`${E}[?1h`);
      expect(await arrows()).toEqual(APPLICATION_ARROWS);
      await s.send(`${E}[!p`);
      expect(await arrows()).toEqual(NORMAL_ARROWS);
      await s.send(`${E}[?1h`);
      await s.send(`${E}c`);
      expect(await arrows()).toEqual(NORMAL_ARROWS);
      expect(await decrqm(s, 1)).toBe(`${E}[?1;2$y`);
      // The application's own hard reset ends like a new session: back in the initial mode.
      await hardReset(s);
      expect(await arrows()).toEqual(APPLICATION_ARROWS);
      expect(await decrqm(s, 1)).toBe(`${E}[?1;1$y`);
      // Host output after the hard reset still decides.
      await s.send(`${E}[?1l`);
      expect(await arrows()).toEqual(NORMAL_ARROWS);
      await s.drained();
    });
  }

  test('a default session keeps the exact T32 hard reset; a chosen initial mode is appended in the same write', async ({ page }) => {
    const record = async (target: Page) => target.evaluate(() => {
      const w = window as any;
      const terminal = w.qa.terminal;
      const write = terminal.write.bind(terminal);
      w.qaLocal = [];
      terminal.write = (data: string | Uint8Array, callback?: () => void) => {
        if (typeof data === 'string' && data.length) w.qaLocal.push(data);
        return write(data, callback);
      };
    });
    const defaults = await Session.open(page, 'pty');
    await record(page);
    await hardReset(defaults);
    expect(await page.evaluate(() => (window as any).qaLocal)).toEqual([`\x18${E}c${E}[?25h${E}[20l`]);
    const other = await page.context().newPage();
    const changed = await openWithKeyboard(other, 'pty', { cursorKeys: 'application', backspace: 'bs' });
    await record(other);
    await hardReset(changed);
    expect(await other.evaluate(() => (window as any).qaLocal)).toEqual([`\x18${E}c${E}[?25h${E}[20l${E}[?1h`]);
    expect(await allWrites(other)).toEqual([]);
  });
});

test.describe('snapshot, reopen and the native open calls', () => {
  test('a local session keeps its options: later form edits do not change it and reopening inherits them', async ({ page }) => {
    test.setTimeout(60_000);
    const s = await openWithKeyboard(page, 'pty', { backspace: 'bs', cursorKeys: 'application' });
    // Editing the form afterwards and cancelling changes nothing for the running session.
    await page.locator('#local-options-open').click();
    await chooseKeyboard(page, 'pty', { backspace: 'del', cursorKeys: 'normal' });
    await page.locator('#local-dialog .dialog-actions .dialog-close').click();
    await s.textarea.focus();
    expect(await s.pressEach(['Backspace', 'ArrowUp'])).toEqual({ Backspace: '\b', ArrowUp: `${E}OA` });
    // The shell exits; editing the ended session's options is pre-filled with its own snapshot.
    await page.evaluate(() => { const ipc = (window as any).qaIpc; ipc.channel.onmessage({ kind: 'exit', id: ipc.id, code: 0 }); });
    await expect(page.locator('#local-edit-cwd')).toBeVisible();
    await page.locator('#local-edit-cwd').click();
    await expect(page.locator('#local-keyboard')).toHaveJSProperty('open', true);
    await expect(page.locator('#local-keyboard-state')).toHaveText('已修改 2 项');
    await expect(page.locator('#local-backspace')).toHaveValue('bs');
    await expect(page.locator('#local-cursor-keys')).toHaveValue('application');
    await page.locator('#local-dialog .dialog-actions .dialog-close').click();
    // Reopen: a new session from the original snapshot, in the initial mode, with nothing sent.
    const before = (await allWrites(page)).length;
    await page.locator('#local-reopen').click();
    await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.pendingOpen)).toBe(true);
    await page.evaluate(() => { const ipc = (window as any).qaIpc; const open = ipc.pendingOpen; ipc.pendingOpen = null; open(); });
    await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
    await observe(page);
    await s.textarea.focus();
    expect((await allWrites(page)).length).toBe(before);
    expect(await s.pressEach(['Backspace', 'ArrowUp', 'Delete'])).toEqual({ Backspace: '\b', ArrowUp: `${E}OA`, Delete: `${E}[3~` });
    const opens = await openArguments(page);
    expect(opens.map((o) => o.command)).toEqual(['pty_open', 'pty_open']);
    expect(opens[1].json).toBe(opens[0].json);
  });

  test('keyboard options never reach pty_open, ssh_open or net_open', async ({ browser }) => {
    test.setTimeout(60_000);
    for (const transport of TRANSPORTS) {
      const plain = await browser.newPage();
      await openWithKeyboard(plain, transport);
      const [defaults] = await openArguments(plain);
      await plain.close();
      const page = await browser.newPage();
      await openWithKeyboard(page, transport, { ...ALL_CHANGED, delete: 'bs' });
      const [chosen] = await openArguments(page);
      await page.close();
      expect(chosen.keys).toEqual(defaults.keys);
      // Identical values apart from the per-connection random IDs.
      const values = (json: string) => {
        const { operationId: _operation, id: _id, ...rest } = JSON.parse(json);
        return rest;
      };
      expect(values(chosen.json)).toEqual(values(defaults.json));
      for (const word of ['keyboard', 'backspace', 'cursorKeys', 'application', 'optionAsMeta', 'vt220'])
        expect(chosen.json).not.toContain(word);
    }
  });

  test('SSH shows the field only for a terminal and resets it with the dialog; Telnet resets it on open', async ({ page }) => {
    await Session.open(page, 'ssh', {}, false);
    await page.locator('#connect-open').click();
    await page.locator('#ssh-verification-open').click();
    await expect(page.locator('#ssh-keyboard')).toBeHidden();
    await page.locator('#ssh-close').click();
    await fillDialog(page, 'ssh', { backspace: 'bs' });
    await expect(page.locator('#ssh-keyboard')).toBeVisible();
    await expect(page.locator('#ssh-keyboard-state')).toHaveText('已修改 1 项');
    await page.locator('#ssh-close').click();
    await page.locator('#connect-open').click();
    await page.locator('#ssh-terminal-open').click();
    await expect(page.locator('#ssh-backspace')).toHaveValue('del');
    await expect(page.locator('#ssh-keyboard')).toHaveJSProperty('open', false);
    await page.locator('#ssh-close').click();
    await fillDialog(page, 'net', { cursorKeys: 'application' });
    await page.locator('#net-cancel').click();
    await page.locator('#connect-open').click();
    await page.locator('#net-terminal-open').click();
    await expect(page.locator('#net-cursor-keys')).toHaveValue('normal');
    await expect(page.locator('#net-keyboard-state')).toHaveText('默认');
  });

  test('the snapshot accepts only the listed values and the remap only touches Backspace and Delete', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
      const k = await import('/src/terminal-keyboard.ts');
      const odd = k.snapshotKeyboard({ backspace: 'ctrl-h', delete: 'esc', optionAsMeta: 'true', cursorKeys: 'app' } as any);
      const chosen = k.snapshotKeyboard({ backspace: 'bs', delete: 'del', optionAsMeta: true, cursorKeys: 'application' });
      const down = (keyCode: number) => ({ type: 'keydown', keyCode });
      return {
        odd, frozen: Object.isFrozen(odd), defaults: k.snapshotKeyboard(), changed: k.changedKeyboardOptions(chosen),
        modes: [k.initialModeSequence(k.DEFAULT_KEYBOARD), k.initialModeSequence(chosen)],
        remaps: [
          k.remapKey(down(8), '\x7f', chosen), k.remapKey(down(8), '\x1b\b', chosen), k.remapKey(down(8), 'x', chosen),
          k.remapKey({ type: 'keypress', keyCode: 8 }, '\x7f', chosen), k.remapKey(down(46), '\x1b[3~', chosen),
          k.remapKey(down(46), '\x1b[3;5~', chosen), k.remapKey(down(72), '\b', chosen), k.remapKey(down(56), '\x7f', chosen),
          k.remapKey(down(8), '\x7f', k.DEFAULT_KEYBOARD), k.remapKey(down(46), '\x1b[3~', k.DEFAULT_KEYBOARD),
        ],
      };
    });
    const defaults = { backspace: 'del', delete: 'vt220', optionAsMeta: false, cursorKeys: 'normal' };
    expect(result.odd).toEqual(defaults);
    expect(result.defaults).toEqual(defaults);
    expect(result.frozen).toBe(true);
    expect(result.changed).toBe(4);
    expect(result.modes).toEqual(['', `${E}[?1h`]);
    expect(result.remaps).toEqual(['\b', `${E}\x7f`, null, null, '\x7f', null, null, null, null, null].map((v) => v ?? undefined));
  });
});

import { test, expect, type Page } from '@playwright/test';
import { Session, TRANSPORTS, type Snapshot } from './support/session-harness';
import { onLive } from './support/history-harness';

// T32 user-triggered clear and reset (docs/p1/CLEAR_RESET_PLAN.zh-CN.md) through the production
// session path: stub IPC -> Channel -> session-lifecycle -> xterm.js + VT adapters -> ordered ACK,
// with the actions started from the tool bar menu or the command palette. Expected values are
// xterm.js 6.0.0 in Chrome. Nothing here reaches Rust, a native PTY, an SSH or Telnet server or a
// native WebView, and nothing is claimed about WindTerm 2.7.0's own results (not measured).
test.setTimeout(60_000);

const E = '\x1b';
const ST = `${E}\\`;
const SIZE = { cols: 40, rows: 10 };
const HISTORY = Array.from({ length: 30 }, (_, n) => `history ${n}\r\n`).join('');
/** 30 history lines, then `before` and `abc` on the cursor row; DECCKM, G0 line drawing, bold red. */
const SETUP = `${HISTORY}before\r\nabc${E}[?1h${E}(0${E}[1;31m`;

type Action = 'clear-scrollback' | 'clear-screen' | 'clear-all' | 'reset-hard' | 'reset-soft' | 'reset-charset';
const LABELS: Record<Action, string> = {
  'clear-scrollback': '清除回滚', 'clear-screen': '清屏', 'clear-all': '全部清除',
  'reset-hard': '硬复位', 'reset-soft': '软复位', 'reset-charset': '重置字符集',
};
/** The local writes the plan documents; pinned here independently of the source. */
const SEQUENCES: Record<Action, string> = {
  'clear-scrollback': `\x18${E}[3J`,
  'clear-screen': `\x18${E}[H${E}[2J`,
  'clear-all': `\x18${E}[H${E}[2J${E}[3J`,
  'reset-hard': `\x18${E}c${E}[?25h${E}[20l`,
  'reset-soft': `\x18${E}[!p`,
  'reset-charset': `\x18${E}(B${E})B${E}*B${E}+B\x0f`,
};

async function viaMenu(page: Page, action: Action) {
  await page.locator('#terminal-actions-open').click();
  await page.locator(`[data-terminal-action="${action}"]`).click();
}
async function viaPalette(page: Page, action: Action) {
  await page.locator('#palette-open').click();
  await page.locator('#command-search').fill(LABELS[action]);
  await expect(page.locator('#command-list .command').first()).toHaveText(new RegExp(`^${LABELS[action]} · `));
  await page.locator('#command-list .command').first().click();
}
/** Runs the action on the active tab and waits until xterm has parsed it. */
async function act(s: Session, action: Action, via: 'menu' | 'palette' = 'menu') {
  await (via === 'menu' ? viaMenu(s.page, action) : viaPalette(s.page, action));
  await s.send(); // an empty write queued behind the action: resolves once it was parsed
}
/** Every row of the normal buffer, scrollback first. */
const normalRows = (page: Page) => page.evaluate(() => {
  const b = (window as any).qa.terminal.buffer.normal;
  return Array.from({ length: b.length }, (_, y) => b.getLine(y).translateToString(true) as string);
});
/** Records every non-empty `Terminal.write` of the session: host chunks as bytes, local writes as text. */
const recordWrites = (page: Page) => page.evaluate(() => {
  const w = window as any;
  const terminal = w.qa.terminal;
  const write = terminal.write.bind(terminal);
  w.qaWrites = [];
  terminal.write = (data: string | Uint8Array, callback?: () => void) => {
    if (data.length) w.qaWrites.push(typeof data === 'string' ? { local: data } : { host: Array.from(data) });
    return write(data, callback);
  };
});
const recordedWrites = (page: Page) => page.evaluate(() => (window as any).qaWrites as ({ local: string } | { host: number[] })[]);
const bytes = (text: string) => [...Buffer.from(text, 'utf8')];
async function expectOrderedAcks(s: Session) {
  await s.drained();
  const sequence = await s.sequence();
  expect(await s.acks()).toEqual(Array.from({ length: sequence }, (_, i) => `${s.transport}_ack:${i + 1}`));
}
async function decrqm(s: Session, request: string) {
  await s.mark();
  await s.send(request);
  await s.settle();
  return (await s.written()).text;
}
const cursor = (page: Page) => page.locator('.terminal-pane:not([hidden]) .xterm-rows .xterm-cursor');

interface ArchiveView { stats: Record<string, number>; lines: string[] }
/** The only live cold archive: statistics and every line it still holds, without SGR. */
const archive = (s: Session) => onLive<ArchiveView>(s.cdp, 'archivePrototype', `async function () {
  if (this.length !== 1) throw new Error('expected one live archive, found ' + this.length);
  const archive = this[0];
  await archive.flush();
  const stats = archive.stats();
  const lines = (await archive.lines(0, stats.archivedLines)).map((line) => line.replace(/\\x1b\\[[0-9;]*m/g, ''));
  return { stats, lines };
}`);
const diagnostics = (page: Page) =>
  page.evaluate(() => (window as any).__WINDTERM_P0_DIAGNOSTICS__.snapshot() as Record<string, number>);
const numbered = (name: string, count: number, from = 0) => Array.from({ length: count }, (_, i) => `${name} ${from + i}`);
const lines = (list: string[]) => list.map((line) => `${line}\r\n`).join('');

test.describe('entry points', () => {
  test('the tool bar menu lists the six actions in upstream order; the palette has one entry for each', async ({ page }) => {
    await page.goto('/');
    const open = page.locator('#terminal-actions-open');
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    await open.click();
    const menu = page.locator('#terminal-actions-menu');
    await expect(menu).toBeVisible();
    await expect(open).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.getByRole('menuitem')).toHaveText(['清除回滚', '清屏', '全部清除', '硬复位', '软复位', '重置字符集']);
    await expect(menu.getByRole('separator')).toHaveCount(1);
    // Focus moves into the menu; arrows wrap; Escape closes and returns focus to the button.
    await expect(menu.getByRole('menuitem', { name: '清除回滚' })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(menu.getByRole('menuitem', { name: '重置字符集' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: '清屏' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(open).toBeFocused();
    await expect(open).toHaveAttribute('aria-expanded', 'false');
    // ArrowDown opens it again; a click outside closes it without running anything.
    await page.keyboard.press('ArrowDown');
    await expect(menu).toBeVisible();
    await page.locator('#session-detail').click();
    await expect(menu).toBeHidden();
    await expect(page.locator('#toast')).not.toHaveClass(/visible/);
    for (const label of Object.values(LABELS)) {
      await page.locator('#palette-open').click();
      await page.locator('#command-search').fill(label);
      await expect(page.locator('#command-list .command')).toHaveCount(1);
      await expect(page.locator('#command-list .command')).toHaveText(new RegExp(`^${label} · 当前会话 · `));
      await page.keyboard.press('Escape');
    }
  });

  test('with no session every action explains itself and does nothing', async ({ page }) => {
    await page.goto('/');
    await page.locator('.tab-close').click();
    await expect(page.getByRole('tab')).toHaveCount(0);
    await page.locator('#terminal-actions-open').click();
    for (const item of await page.locator('#terminal-actions-menu [role="menuitem"]').all()) {
      await expect(item).toBeDisabled();
      await expect(item).toHaveAttribute('title', '没有打开的会话');
    }
    await page.keyboard.press('Escape');
    await viaPalette(page, 'clear-screen');
    await expect(page.locator('#toast')).toHaveText('清屏不可用：没有打开的会话。');
  });
});

/** Runs all six actions in order on a session set up with {@link SETUP}; asserts each one's effect. */
async function sixActions(s: Session) {
  const initial = await s.snapshot();
  await s.send(SETUP);
  const before = await s.snapshot();
  expect(before).toMatchObject({ baseY: 22, cursor: '3,9' });
  expect(before.modes.applicationCursorKeysMode).toBe(true);
  const screen = before.rows;
  await s.mark();

  await act(s, 'clear-scrollback');
  expect(await s.snapshot()).toMatchObject({ baseY: 0, cursor: '3,9', rows: screen, modes: before.modes });
  expect(await normalRows(s.page)).toEqual(screen);

  await act(s, 'clear-screen', 'palette');
  expect(await s.snapshot()).toMatchObject({ baseY: 0, cursor: '0,0', rows: Array(SIZE.rows).fill(''), modes: before.modes });

  await s.send('q'); // G0 line drawing and bold red are still in effect
  let now = await s.snapshot();
  expect(now.rows[0]).toBe('─');
  expect(now.cells[0].split(',')[5]).toBe('1');
  await act(s, 'clear-all');
  expect(await s.snapshot()).toMatchObject({ baseY: 0, cursor: '0,0', rows: Array(SIZE.rows).fill(''), modes: before.modes });

  await act(s, 'reset-charset', 'palette');
  await s.send('q');
  now = await s.snapshot();
  expect(now.rows[0]).toBe('q');
  expect(now.cells[0].split(',')[5]).toBe('1'); // SGR is not part of the character set
  expect(now.modes).toEqual(before.modes);

  await act(s, 'reset-soft');
  await s.send('Z');
  now = await s.snapshot();
  expect(now.rows[0]).toBe('qZ');
  expect(now.cells[1]).toBe('1,0:Z,1,,,0,0,0,0,0,0,0,0,0'); // DECSTR: default rendition
  expect(now.modes).toEqual(initial.modes); // DECCKM was the only mode set

  await s.send(`${E}[?1049halt`);
  await act(s, 'reset-hard', 'palette');
  expect(await s.snapshot()).toMatchObject({
    type: 'normal', baseY: 0, cursor: '0,0', rows: Array(SIZE.rows).fill(''), modes: initial.modes,
  });
  // Nothing went to the host, before or after the actions.
  await s.settle();
  await s.expectWritten('');
  await expectOrderedAcks(s);
}

test.describe('every action, every transport', () => {
  for (const transport of TRANSPORTS) {
    test(`${transport}: the six actions change only local state and send nothing`, async ({ page }) => {
      const s = await Session.open(page, transport, { size: SIZE });
      await sixActions(s);
    });
  }

  test('demo: the six actions work the same way and make no IPC call at all', async ({ page }) => {
    const s = await demo(page, SIZE);
    const calls = () => page.evaluate(() => (window as any).qaIpc.calls.length as number);
    const before = await calls();
    await localWrite(page, SETUP);
    const toasts: Record<Action, string> = {
      'clear-scrollback': '的全部回滚历史，屏幕保留', 'clear-screen': '的屏幕，回滚保留', 'clear-all': '的屏幕与全部回滚历史',
      'reset-hard': '已硬复位', 'reset-soft': '已软复位', 'reset-charset': '的字符集重置为 ASCII',
    };
    for (const action of Object.keys(LABELS) as Action[]) {
      await (action.startsWith('clear') ? viaMenu(page, action) : viaPalette(page, action));
      await expect(page.locator('#toast')).toContainText(toasts[action]);
      await expect(page.locator('#toast')).toContainText('「Getting started」');
    }
    expect(await s.snapshot()).toMatchObject({ type: 'normal', baseY: 0, cursor: '0,0', rows: Array(SIZE.rows).fill('') });
    expect(await calls()).toBe(before);
  });
});

/** The harness view of the browser demo session ("Getting started"), which has no transport. */
async function demo(page: Page, size?: { cols: number; rows: number }): Promise<Session> {
  const s = await Session.open(page, 'pty', {}, false);
  await page.evaluate(async (size) => {
    const { terminal, vt } = ((window as any).__qaSessions as any[])[0];
    if (size) terminal.resize(size.cols, size.rows);
    (window as any).qa = { terminal, vt, titles: [], data: [] };
  }, size);
  await s.textarea.focus();
  return s;
}
/** Writes app-side text to the harness terminal, as the demo itself does, and waits for the parse. */
const localWrite = (page: Page, text: string) =>
  page.evaluate((text) => new Promise<void>(resolve => (window as any).qa.terminal.write(text, resolve)), text);

test.describe('effects in detail (local PTY)', () => {
  test('clear screen erases the visible rows only; scrollback, modes, charset and input encoding stay', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    await s.send(SETUP, `${E}[?2004h`);
    const before = await s.snapshot();
    const scrollback = (await normalRows(page)).slice(0, before.baseY);
    await act(s, 'clear-screen');
    await expect(page.locator('#toast')).toHaveText('已清除「Local 2」的屏幕，回滚保留；只在本地执行，Shell 不会收到通知或重绘提示符。');
    expect(await s.snapshot()).toMatchObject({ baseY: before.baseY, cursor: '0,0', rows: Array(SIZE.rows).fill(''), modes: before.modes });
    expect((await normalRows(page)).slice(0, before.baseY)).toEqual(scrollback);
    await s.mark();
    await expect(s.textarea).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await s.paste('x\ny');
    await s.expectWritten(`${E}OA${E}[200~x\ry${E}[201~`);
    await expectOrderedAcks(s);
  });

  test('hard reset returns to the new-session state, cursor shown and LNM off; a host RIS now ends the same way', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    const initial = await s.snapshot();
    const dirty = `${HISTORY}${E}[?1h${E}=${E}[?2004h${E}[?1000;1006h${E}[?1004h${E}[4h${E}[?7l${E}[2;5r${E}[?6h${E}(0${E}[1;31m${E}[4 q`
      + `${E}[?25l${E}[20h${E}[?1049hALT`;
    await expect(cursor(page)).toHaveCount(1);
    // Host RIS: the RIS repair (ris-repair.ts) shows the cursor and resets LNM that xterm.js 6.0.0's
    // RIS keeps; the host bytes are parsed unchanged.
    await s.send(dirty, `${E}c`);
    await expect(cursor(page)).toHaveCount(1);
    expect(await decrqm(s, `${E}[?25$p${E}[20$p`)).toBe(`${E}[?25;1$y${E}[20;2$y`);
    // The user's hard reset from the same state; its own CSI ? 25 h CSI 20 l are kept.
    await s.send(dirty);
    await expect(cursor(page)).toHaveCount(0);
    await act(s, 'reset-hard');
    await expect(page.locator('#toast')).toContainText('已硬复位「Local 2」');
    const after = await s.snapshot();
    expect(after).toMatchObject({ type: 'normal', baseY: 0, cursor: '0,0', rows: Array(SIZE.rows).fill(''), modes: initial.modes });
    await expect(cursor(page)).toHaveCount(1);
    expect(await decrqm(s, `${E}[?25$p${E}[20$p${E}[?7$p${E}P$qr${ST}${E}P$qm${ST}${E}P$q q${ST}`))
      .toBe(`${E}[?25;1$y${E}[20;2$y${E}[?7;1$y${E}P1$r1;10r${ST}${E}P1$r0m${ST}${E}P1$r1 q${ST}`);
    await s.send('A\nB');
    expect((await s.snapshot()).rows.slice(0, 2)).toEqual(['A', ' B']);
    await expectOrderedAcks(s);
  });

  test('soft reset equals a host DECSTR from the same state, on the alternate screen too', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    const dirty = `${HISTORY}before\r\n${E}[?1h${E}=${E}[?2004h${E}[?1000;1006h${E}[?1004h${E}[4h${E}[?7l`
      + `${E}[2;5r${E}[?6h${E}(0${E}[1;31m${E}[4 q${E}[?25l${E}[?1049hALT`;
    const reports = `${E}[?7$p${E}P$qr${ST}${E}P$qm${ST}${E}P$q q${ST}${E}[?2004$p${E}[?1004$p${E}[?1000$p${E}[?25$p${E}[4$p${E}[?6$p${E}[?1$p`;
    const observe = async () => ({ snapshot: { ...(await s.snapshot()), replies: '' }, reports: await decrqm(s, reports) });
    await s.send(dirty, `${E}[!p`, 'q');
    const host = await observe();
    await s.send(`${E}[?1049l${E}c${E}[?25h`, dirty);
    await act(s, 'reset-soft', 'palette');
    await s.send('q');
    const user = await observe();
    expect(user).toEqual(host);
    expect(user.snapshot).toMatchObject({ type: 'alternate', cursor: '4,1' });
    await expectOrderedAcks(s);
  });

  test('reset character set restores ASCII in G0–G3 and GL; screen, scrollback, SGR and modes stay', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    // G0–G3 all DEC line drawing; q printed through each of them in turn (SI default, SO, LS2, LS3).
    await s.send(`${HISTORY}${E}[1m${E}(0${E})0${E}*0${E}+0q\x0eq${E}nq${E}oq`);
    const before = await s.snapshot();
    expect(before.rows.at(-1)).toBe('────');
    const rows = await normalRows(page);
    await act(s, 'reset-charset');
    await expect(page.locator('#toast')).toHaveText('已将「Local 2」的字符集重置为 ASCII；不发送任何数据。');
    await s.send('q');
    const after = await s.snapshot();
    expect(after.rows.at(-1)).toBe('────q');
    expect(after.cells.at(-1)!.split(',')[5]).toBe('1'); // still bold: SGR is not part of the character set
    expect({ ...after, rows: [], cells: [] }).toEqual({ ...before, rows: [], cells: [], cursor: '5,9' });
    expect((await normalRows(page)).slice(0, -1)).toEqual(rows.slice(0, -1));
    // G1–G3 were reset too: invoking them into GL again prints ASCII.
    await s.send('\x0eq\x0f', `${E}nq${E}oq\x0f`);
    expect((await s.snapshot()).rows.at(-1)).toBe('────qqqq');
  });
});

test.describe('host bytes, partial sequences, input and ACK', () => {
  test('the action is one separate local write; every host chunk reaches xterm unchanged and in order', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    await recordWrites(page);
    const chunks = ['one\r\n', `two ${E}[1`, 'm bold\r\n'];
    await s.send(chunks[0], chunks[1]);
    await act(s, 'clear-scrollback');
    await s.send(chunks[2]);
    for (const action of ['clear-screen', 'clear-all', 'reset-hard', 'reset-soft', 'reset-charset'] as const) await act(s, action);
    await s.send('tail');
    expect(await recordedWrites(page)).toEqual([
      { host: bytes(chunks[0]) }, { host: bytes(chunks[1]) }, { local: SEQUENCES['clear-scrollback'] }, { host: bytes(chunks[2]) },
      ...(['clear-screen', 'clear-all', 'reset-hard', 'reset-soft', 'reset-charset'] as const).map((action) => ({ local: SEQUENCES[action] })),
      { host: bytes('tail') },
    ]);
    await s.settle();
    await s.expectWritten('');
    await expectOrderedAcks(s);
  });

  test('CAN cancels a host sequence left unfinished by the last chunk: no reply, no title, no clipboard write', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    // OSC 52 is allowed for this session, so only the cancellation can keep an unfinished write out.
    await page.locator('#palette-open').click();
    await page.locator('#command-search').fill('OSC 52');
    await page.locator('#command-list .command').first().click();
    await s.mark();
    const payload = Buffer.from('secret clipboard text').toString('base64');
    await s.send(`${E}P$q`);                         // DECRQSS without its request and ST
    await act(s, 'clear-screen');
    await s.send(`m${ST}`, `${E}]0;tit`);            // the rest arrives; then an unfinished title
    await act(s, 'clear-screen');
    await s.send(`le\x07`, `${E}]52;c;${payload.slice(0, 8)}`);
    await act(s, 'clear-screen');
    await s.send(`${payload.slice(8)}\x07`, `${E}[3`);
    await act(s, 'clear-screen');
    await s.send('1mX');
    await s.settle();
    await s.expectWritten('');                       // the DECRQSS was never answered
    expect(await page.evaluate(() => (window as any).qa.titles)).toEqual([]);
    expect(await page.evaluate(() => (window as any).qaIpc.clipboard)).toEqual([]);
    const after = await s.snapshot();
    expect(after.rows[0]).toBe('1mX');               // shown as text after the cancelled CSI
    expect(after.cells.filter((cell) => cell.startsWith('2,0:'))).toEqual(['2,0:X,1,,,0,0,0,0,0,0,0,0,0']); // not red: no SGR 31
    await expectOrderedAcks(s);
  });

  test('input around actions keeps its order, and ACKs held by the backend stay in sequence', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    await s.mark();
    await page.evaluate(() => { const ipc = (window as any).qaIpc; ipc.holdWrite = true; ipc.holdAck = true; });
    await page.keyboard.type('ab');
    await s.send('x\r\n', 'y\r\n');
    await act(s, 'clear-all');
    await page.keyboard.type('c');
    await act(s, 'reset-hard', 'palette');
    await s.paste('d\ne');
    await act(s, 'reset-soft');
    expect(await s.writeCalls()).toEqual(['a']);
    // Only the first ACK is in flight; the others wait in order.
    expect(await s.acks()).toEqual(['pty_ack:1']);
    await page.evaluate(() => {
      const ipc = (window as any).qaIpc;
      ipc.holdWrite = false;
      ipc.holdAck = false;
      for (const resolve of ipc.heldWrites.splice(0)) resolve(null);
      for (const resolve of ipc.heldAcks.splice(0)) resolve(null);
    });
    await expect.poll(() => s.writeCalls()).toEqual(['a', 'b', 'c', 'd\re']);
    await s.send('tail');
    expect((await s.snapshot()).rows[0]).toBe('tail');
    await expectOrderedAcks(s);
  });

  test('while the shell is still starting and after it exited, actions stay local and nothing is queued', async ({ page }) => {
    const s = await Session.open(page, 'pty', {}, false);
    await s.start({ size: SIZE }, false);
    await s.mark();
    await page.evaluate(() => new Promise<void>(resolve => (window as any).qa.terminal.write('starting\r\n', resolve)));
    for (const action of Object.keys(LABELS) as Action[]) await act(s, action);
    await s.resolveOpen();
    await s.settle();
    await s.expectWritten(''); // the early FIFO received no reply from any action
    await page.evaluate(() => {
      const ipc = (window as any).qaIpc;
      ipc.channel.onmessage({ kind: 'exit', id: ipc.id, code: 0 });
    });
    await expect(page.locator('#terminal-state')).toContainText('已退出');
    await s.send(); // nothing more arrives from the host; xterm still parses local writes
    await page.evaluate(() => new Promise<void>(resolve => (window as any).qa.terminal.write(`${'old\r\n'.repeat(20)}`, resolve)));
    await act(s, 'clear-all');
    expect(await s.snapshot()).toMatchObject({ baseY: 0, cursor: '0,0' });
    await s.settle();
    expect(await page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command.endsWith('_write')).length)).toBe(0);
  });
});

test.describe('alternate screen', () => {
  test('clears are not offered on the alternate screen; resets are, and nothing changes when refused', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    await s.send(HISTORY, `${E}[?1049hfull screen`);
    const before = await s.snapshot();
    await page.locator('#terminal-actions-open').click();
    for (const action of ['clear-scrollback', 'clear-screen', 'clear-all'] as const) {
      const item = page.locator(`[data-terminal-action="${action}"]`);
      await expect(item).toBeDisabled();
      await expect(item).toHaveAttribute('title', '全屏程序正在使用备用屏，此时不能清屏或清除回滚');
    }
    for (const action of ['reset-hard', 'reset-soft', 'reset-charset'] as const) {
      await expect(page.locator(`[data-terminal-action="${action}"]`)).toBeEnabled();
    }
    await page.keyboard.press('Escape');
    await viaPalette(page, 'clear-scrollback');
    await expect(page.locator('#toast')).toHaveText('清除回滚不可用：全屏程序正在使用备用屏，此时不能清屏或清除回滚。');
    await s.send();
    expect(await s.snapshot()).toEqual(before);
    await s.send(`${E}[?1049l`);
    expect((await normalRows(page)).slice(0, 30)).toEqual(numbered('history', 30));
  });

  test('output already received may switch to the alternate screen first: the result says so and the archive is kept', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    await s.send(lines(numbered('kept', 40)));
    const held = (await archive(s)).stats;
    await page.locator('#terminal-actions-open').click();
    // The chunk is delivered and the item clicked in one task, before xterm parses the chunk.
    await page.evaluate(() => {
      const ipc = (window as any).qaIpc;
      const data = Array.from(new TextEncoder().encode('\x1b[?1049hfull screen'));
      ipc.channel.onmessage({ kind: 'data', id: ipc.id, sequence: ++ipc.sequence, data });
      (document.querySelector('[data-terminal-action="clear-scrollback"]') as HTMLButtonElement).click();
    });
    await s.send();
    await expect(page.locator('#toast')).toHaveText('「Local 2」在执行前已切换到备用屏，回滚未清除。');
    const after = await archive(s);
    expect(after.stats).toMatchObject({ archivedLines: held.archivedLines, clearedLines: 0, userClears: 0, clears: 0, gaps: 0 });
    await s.send(`${E}[?1049l`);
    expect((await normalRows(page))[0]).toBe('kept 0'); // ED 3 on the alternate screen erased nothing
    await expectOrderedAcks(s);
  });
});

test.describe('cold archive', () => {
  test('clear scrollback empties the archive, counts one clear and no gap, and archives later lines once', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE, query: '?p0Diagnostics' });
    const first = numbered('first', 1200);
    await s.send(...chunked(lines(first)));
    const before = await archive(s);
    // Everything but the 9 lines still on screen above the cursor row has been archived.
    expect(before.lines).toEqual(first.slice(0, 1200 - 9));
    expect(before.stats.blocks).toBeGreaterThan(0);
    await act(s, 'clear-scrollback', 'palette');
    await expect(page.locator('#toast')).toHaveText('已清除「Local 2」的全部回滚历史，屏幕保留；只在本地执行，不发送任何数据。');
    const cleared = await archive(s);
    expect(cleared.lines).toEqual([]);
    expect(cleared.stats).toMatchObject({
      archivedLines: 1191, clearedLines: 1191, userClears: 1, blocks: 0, pendingLines: 0, compressedBytes: 0, rawBytes: 0,
      clears: 1, gaps: 0, droppedLines: 0,
    });
    // The 9 lines that were on screen leave it later and are archived then, exactly once.
    await s.send(lines(numbered('second', 30)));
    const after = await archive(s);
    expect(after.lines).toEqual([...first.slice(-9), ...numbered('second', 30 - 9)]);
    expect(after.stats).toMatchObject({ archivedLines: 1191 + 30, clears: 1, gaps: 0 });
    const d = await diagnostics(page);
    expect(d).toMatchObject({ historyGaps: 0, historyClears: 1, historyUserClears: 1, historyUserClearedLines: 1191 });
    expect(d.historyCompressedBytes).toBe(after.stats.compressedBytes);
    await expectOrderedAcks(s);
  });

  test('clear screen keeps the archive; erased rows are never archived, later lines are, once', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    const first = numbered('first', 40);
    await s.send(lines(first));
    await act(s, 'clear-screen');
    await s.send(lines(numbered('second', 30)));
    const after = await archive(s);
    // first 0–30 had left the screen; 31–39 were erased with it, as a host Ctrl-L would erase them.
    expect(after.lines).toEqual([...first.slice(0, 31), ...numbered('second', 30 - 9)]);
    expect(after.stats).toMatchObject({ clears: 0, gaps: 0, userClears: 0, clearedLines: 0 });
  });

  test('clear all empties the archive and the erased screen rows never reach it', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    await s.send(lines(numbered('first', 40)));
    await act(s, 'clear-all', 'palette');
    await expect(page.locator('#toast')).toContainText('已清除「Local 2」的屏幕与全部回滚历史');
    await s.send(lines(numbered('second', 30)));
    const after = await archive(s);
    expect(after.lines).toEqual(numbered('second', 30 - 9));
    expect(after.stats).toMatchObject({ clearedLines: 31, userClears: 1, clears: 1, gaps: 0 });
  });

  test('hard reset keeps archived lines like a host RIS; soft reset and charset reset leave the archive alone', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    const first = numbered('first', 40);
    await s.send(lines(first));
    const kept = (await archive(s)).lines;
    for (const action of ['reset-soft', 'reset-charset'] as const) {
      await act(s, action);
      expect(await archive(s)).toMatchObject({ lines: kept, stats: { clears: 0, gaps: 0, userClears: 0 } });
    }
    await act(s, 'reset-hard');
    await s.send(lines(numbered('second', 30)));
    const after = await archive(s);
    expect(after.lines).toEqual([...kept, ...numbered('second', 30 - 9)]);
    expect(after.stats).toMatchObject({ clears: 1, gaps: 0, userClears: 0, clearedLines: 0 });
  });

  test('after a clear the line target counts only lines archived since, and the dropped-lines notice is reset', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE, query: '?p0HistoryBudget=lines:1024' });
    const notice = page.locator('#terminal-history');
    // 2,600 lines: 2,591 archived, five 512-line blocks sealed; three are dropped to stay at 1,024.
    await s.send(...chunked(lines(numbered('first', 2600))));
    const trimmed = await archive(s); // waits for every queued compression and the budget after it
    expect(trimmed.stats).toMatchObject({ archivedLines: 2591, droppedLines: 1536, blocks: 2, pendingLines: 31 });
    await expect(notice).toHaveText(/^已丢弃最早 1\D?536 行$/);
    await act(s, 'clear-scrollback');
    await expect(notice).toBeHidden();
    // 1,100 more lines: two new sealed blocks, 1,024 lines, within the target, so nothing is dropped.
    // Counting the 1,055 cleared lines as sealed would drop both.
    await s.send(...chunked(lines(numbered('second', 1100))));
    const after = await archive(s);
    expect(after.stats).toMatchObject({
      archivedLines: 2591 + 1100, droppedLines: 1536, clearedLines: 1055, blocks: 2, pendingLines: 1100 - 1024,
    });
    expect(after.lines).toEqual([...numbered('first', 9, 2591), ...numbered('second', 1100 - 9)]);
    await page.waitForTimeout(150); // the status bar refresh is throttled to 100 ms
    await expect(notice).toBeHidden();
  });
});

test.describe('demo session', () => {
  test('the demo `clear` command is 全部清除 plus a fresh prompt at the top, as in a shell', async ({ page }) => {
    const s = await demo(page, SIZE);
    await recordWrites(page);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.type('ls');
      await page.keyboard.press('Enter');
    }
    expect((await s.snapshot()).baseY).toBeGreaterThan(0);
    await page.keyboard.type('clear');
    await page.keyboard.press('Enter');
    await s.send();
    expect(await s.snapshot()).toMatchObject({
      baseY: 0, cursor: '19,0', rows: ['demo ~/workspace % ', ...Array(SIZE.rows - 1).fill('')],
    });
    expect(await normalRows(page)).toHaveLength(SIZE.rows);
    // The very write 全部清除 makes, directly followed by the prompt (no blank first row).
    const writes = await recordedWrites(page);
    const at = writes.findIndex((w) => 'local' in w && w.local === SEQUENCES['clear-all']);
    expect(at).toBeGreaterThan(0);
    expect(writes[at + 1]).toEqual({ local: `${E}[32mdemo${E}[0m ${E}[34m~/workspace${E}[0m % ` });
    // The line being edited survives a local clear screen, as a shell's line editor would.
    await page.keyboard.type('hel');
    await viaPalette(page, 'clear-screen');
    await expect(page.locator('#toast')).toContainText('已清除「Getting started」的屏幕');
    await s.send();
    expect((await s.snapshot()).rows.every((row) => row === '')).toBe(true);
    await page.keyboard.type('p');
    await page.keyboard.press('Enter');
    await s.send();
    const rows = (await s.snapshot()).rows;
    expect(rows[0]).toBe('p');
    expect(rows.join('')).toContain('演示命令: help'); // the command was "hel" + "p"
  });
});

/** Splits a string into 4,096-byte chunks like the Rust side (ASCII only here). */
function chunked(text: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += 4096) out.push(text.slice(at, at + 4096));
  return out;
}

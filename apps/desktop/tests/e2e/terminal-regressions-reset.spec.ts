import { test, expect, type Page } from '@playwright/test';
import { Session, type Snapshot } from './support/session-harness';
import { installHarness, run } from './support/vt-harness';

// P1 slice 4 reset regressions through the production session path (stub IPC -> Channel ->
// session-lifecycle -> xterm.js + VT adapters -> ordered ACK, and terminal-input -> queueInput ->
// stubbed *_write). RIS (ESC c) and DECSTR (CSI ! p) arrive as host output, split across chunks.
// Expected values are xterm.js 6.0.0's behaviour in Chrome unless a test is marked as a known
// defect; differences from VT manuals are named "observed". Nothing here reaches Rust, a native
// PTY or a native WebView, and no claim is made about WindTerm 2.7.0, xterm or DEC hardware.
const E = '\x1b';
const ST = `${E}\\`;
const SIZE = { cols: 40, rows: 10 };
const HISTORY = Array.from({ length: 30 }, (_, n) => `history ${n}\r\n`).join('');
/** Turns on every mode and state a reset should touch, then enters the alternate screen. */
const DIRTY = `${HISTORY}before\r\n${E}[?1h${E}=${E}[?2004h${E}[?1000;1006h${E}[?1004h${E}[4h${E}[?7l`
  + `${E}[2;5r${E}[?6h${E}(0${E}[1;31m${E}[4 q${E}[?1049hALT`;
/** DECRQM / DECRQSS requests; every reply goes out through the session's own *_write. */
const REPORTS = `${E}[?7$p${E}P$qr${ST}${E}P$qm${ST}${E}P$q q${ST}${E}[?2004$p${E}[?1004$p${E}[?1000$p${E}[?1006$p`
  + `${E}[4$p${E}[?6$p${E}[?1$p${E}[?66$p`;
const one = (text: string) => [...Buffer.from(text, 'utf8')].map((b) => [b]);

async function reports(s: Session): Promise<string> {
  await s.mark();
  await s.send(REPORTS);
  await s.settle();
  return (await s.written()).text;
}
async function expectOrderedAcks(s: Session) {
  await s.drained();
  const sequence = await s.sequence();
  expect(await s.acks()).toEqual(Array.from({ length: sequence }, (_, i) => `${s.transport}_ack:${i + 1}`));
}
async function openPalette(page: Page, name: string) {
  await page.locator('#palette-open').click();
  await page.locator('#command-search').fill(name);
  await page.locator('#command-list .command').first().click();
}

test.describe('RIS (ESC c)', () => {
  for (const transport of ['pty', 'ssh', 'net'] as const) {
    test(`${transport}: split RIS restores modes, buffer, cursor, charset, SGR, margins and tab stops`, async ({ page }) => {
      const s = await Session.open(page, transport, { size: SIZE });
      const initial: Snapshot = await s.snapshot();
      await s.send(DIRTY, `${E}[3g${E}[5G${E}H`);
      expect((await s.snapshot()).type).toBe('alternate');
      await s.send(`${E}`, 'c', 'q\tT');
      const after = await s.snapshot();
      expect(after.modes).toEqual(initial.modes);
      // RIS also drops the 30 lines of history: xterm.js rebuilds both buffers.
      expect(after).toMatchObject({ type: 'normal', baseY: 0, cursor: '9,0' });
      // ASCII again (not ─), the default 8-column tab stop, default attributes.
      expect(after.rows).toEqual(['q       T', ...Array(SIZE.rows - 1).fill('')]);
      expect(after.cells.every((cell) => cell.endsWith(',1,,,0,0,0,0,0,0,0,0,0'))).toBe(true);
      expect(await reports(s)).toBe([
        `${E}[?7;1$y`, `${E}P1$r1;10r${ST}`, `${E}P1$r0m${ST}`, `${E}P1$r1 q${ST}`, `${E}[?2004;2$y`, `${E}[?1004;2$y`,
        `${E}[?1000;2$y`, `${E}[?1006;2$y`, `${E}[4;2$y`, `${E}[?6;2$y`, `${E}[?1;2$y`, `${E}[?66;2$y`,
      ].join(''));
      expect((await s.written()).commands).toEqual([`${transport}_write`]);
      // The Unicode 11 width provider the factory selected survives the reset.
      await s.send('\r🌏|');
      expect((await s.snapshot()).cells[0]).toBe('0,0:🌏,2,,,0,0,0,0,0,0,0,0,0');
      await expectOrderedAcks(s);
    });
  }

  test('after RIS, keys, paste, mouse and focus follow the reset modes and the key guards still work', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    await s.send(DIRTY);
    await s.send(`${E}c`);
    expect(await s.pressEach(['ArrowUp', 'Home', 'End', 'F1', 'F5', 'Control+Slash', 'Control+c'])).toEqual({
      ArrowUp: `${E}[A`, Home: `${E}[H`, End: `${E}[F`, F1: `${E}OP`, F5: `${E}[15~`, 'Control+Slash': '\x1f', 'Control+c': '\x03',
    });
    await expect(s.textarea).toBeFocused(); // F5 was still cancelled: no reload, focus kept
    await s.mark();
    await s.paste('x\ny');
    await s.mouse('mousedown', 2, 2, { button: 0 });
    await s.mouse('mouseup', 2, 2, { button: 0 });
    await s.textarea.evaluate((el) => { (el as HTMLElement).blur(); (el as HTMLElement).focus(); });
    await s.settle();
    await s.expectWritten('x\ry'); // no bracketed paste markers, no mouse or focus reports
    // Cmd+K still reaches the workbench through the custom key handler xterm re-attaches on reset.
    await page.keyboard.press('Meta+k');
    await expect(page.locator('#palette-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await s.expectWritten('x\ry');
  });

  test('input queued around RIS keeps its order and the ACK sequence continues past the reset chunk', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    await s.mark();
    await page.evaluate(() => { (window as any).qaIpc.holdWrite = true; });
    await page.keyboard.type('ab');
    await s.send(`${E}[?2004h${E}`, 'c');
    await page.keyboard.type('c');
    await s.paste('d\ne');
    // One write is in flight; everything else waits in the frontend FIFO.
    expect(await s.writeCalls()).toEqual(['a']);
    await page.evaluate(() => {
      const ipc = (window as any).qaIpc;
      ipc.holdWrite = false;
      for (const resolve of ipc.heldWrites.splice(0)) resolve(null);
    });
    await expect.poll(() => s.writeCalls()).toEqual(['a', 'b', 'c', 'd\re']);
    await s.send('tail');
    expect((await s.snapshot()).rows[0]).toBe('tail');
    await expectOrderedAcks(s);
  });

  test.fail('known defect: RIS leaves a cursor hidden by DECTCEM hidden (xterm.js 6.0.0 core)', async ({ page }) => {
    // VT100 RIS returns to the power-on state, where the text cursor is shown. xterm.js 6.0.0 keeps
    // CoreService.isCursorHidden across Terminal.reset(); only DECSTR clears it. After a program
    // hides the cursor and the host sends a bare RIS, the cursor stays invisible until CSI ? 25 h.
    // Remove test.fail once the raw pin below ("xterm.js 6.0.0 alone keeps ...") starts failing.
    const s = await Session.open(page, 'pty', { size: SIZE });
    const cursor = page.locator('.terminal-pane:not([hidden]) .xterm-rows .xterm-cursor');
    await expect(cursor).toHaveCount(1);
    await s.send(`${E}[?25l`);
    await expect(cursor).toHaveCount(0);
    await s.send(`${E}c`);
    await s.mark();
    await s.send(`${E}[?25$p`);
    await s.expectWritten(`${E}[?25;1$y`);
    await expect(cursor).toHaveCount(1);
  });

  test.fail('known defect: RIS leaves line feed/new line mode (LNM, CSI 20 h) set (xterm.js 6.0.0 core)', async ({ page }) => {
    // xterm.js stores LNM in options.convertEol, which Terminal.reset() does not restore, so after
    // RIS every LF still returns to column 1 and DECRQM 20 still reports "set".
    // Remove test.fail once the raw pin below ("xterm.js 6.0.0 alone keeps ...") starts failing.
    const s = await Session.open(page, 'pty', { size: SIZE });
    await s.send(`${E}[20h`, `${E}c`, 'A\nB');
    await s.mark();
    await s.send(`${E}[20$p`);
    await s.expectWritten(`${E}[20;2$y`);
    expect((await s.snapshot()).rows.slice(0, 2)).toEqual(['A', ' B']);
  });

  test('observed: OSC 4/10/11/12 colour changes survive RIS and DECSTR', async ({ page }) => {
    // Neither reset restores the palette or the dynamic colours in xterm.js 6.0.0; the theme set by
    // the workbench comes back only with OSC 104/110/111/112. xterm's own choice was not compared.
    const s = await Session.open(page, 'pty', { size: SIZE });
    const query = `${E}]4;1;?\x07${E}]10;?\x07${E}]11;?\x07${E}]12;?\x07`;
    const changed = `${E}]4;1;rgb:1212/3434/5656${ST}${E}]10;rgb:0101/0202/0303${ST}`
      + `${E}]11;rgb:0404/0505/0606${ST}${E}]12;rgb:0707/0808/0909${ST}`;
    for (const reset of [`${E}c`, `${E}[!p`]) {
      await s.send(`${E}]4;1;#123456\x07${E}]10;#010203\x07${E}]11;#040506\x07${E}]12;#070809\x07`, reset);
      await s.mark();
      await s.send(query);
      await s.expectWritten(changed);
      await s.send(`${E}]104\x07${E}]110\x07${E}]111\x07${E}]112\x07`);
      await s.mark();
      await s.send(query);
      await expect.poll(async () => (await s.written()).text).not.toBe('');
      expect((await s.written()).text).not.toContain('1212/3434/5656');
    }
  });

  test('xterm.js 6.0.0 alone keeps DECTCEM and LNM across RIS (upstream root cause of the two defects)', async ({ page }) => {
    // Raw @xterm/xterm without the application or its adapters. When this starts failing, the pinned
    // xterm.js resets them itself and the two known-defect tests above should pass.
    await page.goto('/');
    await page.evaluate(installHarness);
    const observed = await run(page, async (h) => {
      await h.write('\x1b[?25l\x1b[20h\x1bc');
      return (await h.query('\x1b[?25$p')) + (await h.query('\x1b[20$p'));
    }, { vt: false });
    expect(observed).toBe(`${E}[?25;2$y${E}[20;1$y`);
  });
});

test.describe('DECSTR (CSI ! p)', () => {
  test('split DECSTR keeps the screen, cursor and alternate buffer and resets the modes it owns', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    const initial = await s.snapshot();
    await s.send(DIRTY, `${E}[?25l`);
    await s.send(...one(`${E}[!p`), 'q');
    const after = await s.snapshot();
    expect(after).toMatchObject({ type: 'alternate', cursor: '4,1' });
    expect(after.rows[1]).toBe('ALTq');
    expect(after.modes).toEqual({
      ...initial.modes,
      // Observed: DECSTR leaves mouse tracking on (xterm.js resets only CoreService modes) and turns
      // autowrap back on (VT510 lists "no autowrap"; matrix X01). It also turns bracketed paste and
      // focus reporting off, which the VT510 DECSTR table does not mention; xterm was not compared.
      mouseTrackingMode: 'vt200',
    });
    expect(await reports(s)).toBe([
      `${E}[?7;1$y`, `${E}P1$r1;10r${ST}`, `${E}P1$r0m${ST}`, `${E}P1$r1 q${ST}`, `${E}[?2004;2$y`, `${E}[?1004;2$y`,
      `${E}[?1000;1$y`, `${E}[?1006;1$y`, `${E}[4;2$y`, `${E}[?6;2$y`, `${E}[?1;2$y`, `${E}[?66;2$y`,
    ].join(''));
    await s.mark();
    await s.send(`${E}[?25$p`);
    await s.expectWritten(`${E}[?25;1$y`);
    // Input after DECSTR: normal cursor keys, no paste markers, mouse reports still sent.
    await s.mark();
    await page.keyboard.press('ArrowUp');
    await s.paste('x\ny');
    await s.mouse('mousedown', 2, 2, { button: 0 });
    await s.mouse('mouseup', 2, 2, { button: 0 });
    await s.settle();
    await s.expectWritten(`${E}[Ax\ry${E}[<0;3;3M${E}[<0;3;3m`);
    // Leaving the alternate screen still restores the main screen and its cursor.
    await s.send(`${E}[?1049l`);
    const main = await s.snapshot();
    expect(main.type).toBe('normal');
    expect(main.rows.slice(-2)).toEqual(['before', '']);
    await expectOrderedAcks(s);
  });

  test('DECSTR resets the DECSC save to home with default rendition; DECRC then reports SGR 0', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    await s.send(`${E}[1;31m${E}[4;4H${E}7${E}[!p${E}8X`);
    const after = await s.snapshot();
    expect(after.cursor).toBe('1,0');
    expect(after.cells[0]).toBe('0,0:X,1,,,0,0,0,0,0,0,0,0,0');
    await s.mark();
    await s.send(`${E}P$qm${ST}`);
    await s.expectWritten(`${E}P1$r0m${ST}`);
  });
});

test.describe('VT adapters across resets', () => {
  test('identity replies are unchanged; DECSCL level survives DECSTR and returns to the type ceiling on RIS', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    const identity = `${E}[c${E}[>c${E}[>0q`;
    const expected = `${E}[?1;2c${E}[>0;276;0c${E}P>|new-windterm(0.0.1)${ST}`;
    for (const reset of ['', `${E}c`, `${E}[!p`]) {
      await s.send(reset);
      await s.mark();
      await s.send(identity);
      await s.expectWritten(expected);
    }
    // No UI selects another type yet; the session's adapters expose it for this check.
    await page.evaluate(() => (window as any).qa.vt.setTerminalType('vt420'));
    const level = `${E}P$q"p${ST}`;
    const steps: string[] = [];
    for (const step of [`${E}[62"p`, `${E}[!p`, `${E}c`]) {
      await s.send(step);
      await s.mark();
      await s.send(level, `${E}[c`);
      await s.settle();
      steps.push((await s.written()).text);
    }
    expect(steps).toEqual([
      `${E}P1$r62;1"p${ST}${E}[?64;6;9;22c`, `${E}P1$r62;1"p${ST}${E}[?64;6;9;22c`, `${E}P1$r64;1"p${ST}${E}[?64;6;9;22c`,
    ]);
  });

  test('CPR under DECOM uses the margins after a reset, never stale ones', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    const cpr = async (setup: string) => {
      await s.send(`${E}c`, setup);
      await s.mark();
      await s.send(`${E}[6n${E}P$qr${ST}`);
      await s.settle();
      return (await s.written()).text;
    };
    // Margins set before RIS are gone: row 2 of the full screen is reported as row 2.
    expect(await cpr(`${E}[3;6r${E}c${E}[?6h${E}[2;1H`)).toBe(`${E}[2;1R${E}P1$r1;10r${ST}`);
    // DECSTR on the alternate screen clears only its margins; the main screen keeps 2;6 and the
    // adapter's CPR agrees with xterm's own DECRQSS report after leaving the alternate screen.
    expect(await cpr(`${E}[2;6r${E}[?1049h${E}[3;5r${E}[!p${E}[?1049l${E}[?6h${E}[2;1H`)).toBe(`${E}[2;1R${E}P1$r2;6r${ST}`);
  });

  test('OSC 52 policy is a user decision that host resets neither grant nor withdraw', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    const toast = page.locator('#toast');
    const write = (text: string) => `${E}]52;c;${Buffer.from(text).toString('base64')}\x07`;
    await s.mark();
    await s.send(`${E}c`, write('blocked one'), `${E}[!p`, write('blocked two'), 'T');
    await expect(toast).toContainText('已拦截 OSC 52 剪贴板写入');
    expect((await s.snapshot()).rows[0]).toBe('T'); // swallowed, never shown
    await openPalette(page, 'OSC 52');
    await expect(page.locator('#session-detail')).toContainText('OSC 52 可写剪贴板');
    await s.send(`${E}c`, `${E}[!p`, write('allowed'));
    await expect.poll(() => page.evaluate(() => (window as any).qaIpc.clipboard)).toEqual(['allowed']);
    await expect(page.locator('#session-detail')).toContainText('OSC 52 可写剪贴板');
    expect(await page.evaluate(() => (window as any).qa.vt.clipboardWrite)).toBe(true);
    // Nothing from OSC 52 is echoed or answered to the host.
    await s.expectWritten('');
    expect(await page.evaluate(() => (window as any).qaIpc.clipboard)).toEqual(['allowed']);
  });

  test('an out-of-band terminal.reset() needs vt.reset() too; without it the SGR shadow is stale', async ({ page }) => {
    // Production code never calls terminal.reset() directly; vt-adapters.ts documents the contract.
    const s = await Session.open(page, 'pty', { size: SIZE });
    const state = `${E}[1;31m${E}[4 q${E}[3;6r`;
    const report = `${E}P$qm${ST}${E}P$q q${ST}${E}[?6h${E}[2;1H${E}[6n`;
    const replies = async (resync: boolean) => {
      await s.send(`${E}c`, state);
      await page.evaluate((resync) => {
        const { terminal, vt } = (window as any).qa;
        terminal.reset();
        if (resync) vt.reset();
      }, resync);
      await s.mark();
      await s.send(report);
      await s.settle();
      return (await s.written()).text;
    };
    await s.send(`${E}c`);
    await s.mark();
    await s.send(report);
    await s.settle();
    const ris = (await s.written()).text;
    expect(ris).toBe(`${E}P1$r0m${ST}${E}P1$r1 q${ST}${E}[2;1R`);
    expect(await replies(true)).toBe(ris);
    // Known drift: the shadow still holds SGR 1;31, DECSCUSR 4 and the 3;6 margins.
    expect(await replies(false)).toBe(`${E}P1$r0;1;31m${ST}${E}P1$r4 q${ST}${E}[1;1R`);
  });
});

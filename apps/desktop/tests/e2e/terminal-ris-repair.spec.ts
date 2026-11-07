import { test, expect, type Page } from '@playwright/test';
import { Session, TRANSPORTS, type Snapshot } from './support/session-harness';
import { openEncoded } from './support/encoding-harness';
import { openWithKeyboard } from './support/keyboard-harness';
import { onLive } from './support/history-harness';
import { installHarness } from './support/vt-harness';

// RIS repair (src/terminal-compat/ris-repair.ts and xterm-private.ts: route R1 = E1 + E2 of
// docs/p1/RIS_ADR_EVALUATION.zh-CN.md, test list in its section 5) through the production session
// path: stub IPC -> Channel -> session-lifecycle -> xterm.js + RIS repair + VT adapters -> ordered
// ACK. Raw xterm.js (the VT harness with `vt: false`, no application code) is the reference for
// where xterm.js runs RIS at all. Chrome + IPC stub only: nothing here reaches Rust, a native PTY,
// an SSH or Telnet peer or a native WebView, and nothing is claimed about WindTerm 2.7.0, xterm or
// DEC hardware.
test.setTimeout(60_000);

const E = '\x1b';
const ST = `${E}\\`;
const SIZE = { cols: 40, rows: 10 };
const GATE = 'xterm.js private field _core.coreService.isCursorHidden no longer behaves as in 6.0.0: '
  + 're-check src/terminal-compat/xterm-private.ts under G-UPGRADE (docs/p0/TERMINAL_CORE_ADR.zh-CN.md)';
/** Hides the cursor (DECTCEM) and sets LNM: the two states xterm.js 6.0.0's own RIS keeps. */
const DIRTY = `${E}[?25l${E}[20h`;
/** DECRQM for both, and what it answers once RIS restored them or while they are kept. */
const ASK = `${E}[?25$p${E}[20$p`;
const REPAIRED = `${E}[?25;1$y${E}[20;2$y`;
const KEPT = `${E}[?25;2$y${E}[20;1$y`;
/** With LNM reset the LF keeps the column: rows `A`, ` B`. */
const LINES = 'A\nB';
const utf8 = (text: string) => [...Buffer.from(text, 'utf8')];
/**
 * Fixed multi-cut lists (every 2nd, 3rd and 5th offset) next to the single cuts and the
 * byte-by-byte run that `splits` always adds. Not `randomCuts`: for some lengths (13 and 25 among
 * them) its generator never finds enough distinct offsets and the loop does not end.
 */
const strides = (length: number) =>
  [2, 3, 5].map((step) => Array.from({ length: Math.floor((length - 1) / step) }, (_, i) => (i + 1) * step));
const lines = (name: string, count: number) => Array.from({ length: count }, (_, i) => `${name} ${i}`);
const crlf = (list: string[]) => list.map((line) => `${line}\r\n`).join('');
const cursor = (page: Page) => page.locator('.terminal-pane:not([hidden]) .xterm-rows .xterm-cursor');
const diagnostics = (page: Page) =>
  page.evaluate(() => (window as any).__WINDTERM_P0_DIAGNOSTICS__.snapshot() as Record<string, number>);
/** The RIS repair's diagnostics counters (development builds with `?p0Diagnostics` only). */
const repairs = async (page: Page) => {
  const d = await diagnostics(page);
  return { repairs: d.risRepairs, cursorUnavailable: d.risCursorUnavailable, lineFeedFailed: d.risLineFeedFailed };
};

async function ask(s: Session, request = ASK): Promise<string> {
  await s.mark();
  await s.send(request);
  await s.settle();
  return (await s.written()).text;
}
async function expectOrderedAcks(s: Session) {
  await s.drained();
  const sequence = await s.sequence();
  expect(await s.acks()).toEqual(Array.from({ length: sequence }, (_, i) => `${s.transport}_ack:${i + 1}`));
}
async function hardReset(s: Session) {
  await s.page.locator('#terminal-actions-open').click();
  await s.page.locator('[data-terminal-action="reset-hard"]').click();
  await s.send(); // an empty write queued behind the action: resolves once it was parsed
}
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

/** What one case did: the first rows and title after `A LF B`, replies during the case and to ASK. */
interface CaseResult { rows: string[]; titles: string; during: string; replies: string }

/** Raw xterm.js at the production size, a fresh terminal per case: `XYZ`, DIRTY, the case, `A LF B`, ASK. */
async function rawCases(page: Page, cases: number[][]): Promise<CaseResult[]> {
  await page.evaluate(installHarness);
  return page.evaluate(async ({ cases, size }) => {
    const out = [];
    for (const bytes of cases) {
      const h = await (window as any).vtHarness({ ...size, vt: false });
      try {
        await h.write('XYZ\x1b[?25l\x1b[20h');
        h.take();
        await new Promise<void>((resolve) => h.term.write(Uint8Array.from(bytes), resolve));
        const during = h.take();
        await h.write('A\nB');
        out.push({ rows: h.lines().slice(0, 3), titles: h.titles.join('|'), during, replies: await h.query('\x1b[?25$p\x1b[20$p') });
      } finally {
        h.dispose();
      }
    }
    return out;
  }, { cases, size: SIZE });
}

/** The same cases in one production session; a RIS before each one gives it a clean start. */
async function productionCases(s: Session, cases: number[][]): Promise<CaseResult[]> {
  const out: CaseResult[] = [];
  for (const bytes of cases) {
    await s.send(`${E}c`);
    await s.page.evaluate(() => { (window as any).qa.titles = []; });
    await s.send(`XYZ${DIRTY}`);
    await s.mark();
    await s.send(bytes);
    await s.settle();
    const during = (await s.written()).text;
    await s.send(LINES);
    const snapshot: Snapshot = await s.snapshot();
    out.push({ rows: snapshot.rows.slice(0, 3), titles: snapshot.titles, during, replies: await ask(s) });
  }
  return out;
}

let pageErrors: string[] = [];
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
});
test.afterEach(() => {
  // Nothing in the parser path may throw, with or without the private field (screen reader mode on).
  expect(pageErrors).toEqual([]);
});

test.describe('guard: the one private xterm.js field (E2)', () => {
  test('guard: _core.coreService.isCursorHidden exists, follows DECTCEM, and the repair clears it on RIS', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE, query: '?p0Diagnostics' });
    const field = () => page.evaluate(() => {
      const service = (window as any).qa.terminal._core?.coreService;
      const value = service?.isCursorHidden;
      return typeof value === 'boolean' ? value : `not a boolean: ${typeof value}`;
    });
    expect(await field(), GATE).toBe(false);
    await s.send(`${E}[?25l`);
    expect(await field(), GATE).toBe(true);
    await expect(cursor(page)).toHaveCount(0);
    expect(await ask(s, `${E}[?25$p`), GATE).toBe(`${E}[?25;2$y`);
    await s.send(`${E}c`);
    expect(await field(), GATE).toBe(false);
    expect(await ask(s, `${E}[?25$p`), GATE).toBe(`${E}[?25;1$y`);
    await expect(cursor(page), GATE).toHaveCount(1);
    expect(await repairs(page), GATE).toEqual({ repairs: 1, cursorUnavailable: 0, lineFeedFailed: 0 });
    // The screen reader mirror the factory enables is still there after the reset.
    await expect(page.locator('.terminal-pane:not([hidden]) .xterm-accessibility-tree')).toHaveCount(1);
    await expectOrderedAcks(s);
  });

  test('fallback: a non-boolean or missing field leaves the cursor as xterm.js does, LNM is still reset, nothing throws', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE, query: '?p0Diagnostics' });
    await s.send(DIRTY);
    // Stand-in for a later xterm.js that changed the field's type: the repair must not write it.
    await page.evaluate(() => { (window as any).qa.terminal._core.coreService.isCursorHidden = 1; });
    await s.send(`${E}c${LINES}`);
    // The rest of the chunk was parsed and E1 still applied; the cursor stays hidden, as before the repair.
    expect((await s.snapshot()).rows.slice(0, 2)).toEqual(['A', ' B']);
    expect(await ask(s)).toBe(`${E}[?25;2$y${E}[20;2$y`);
    await expect(cursor(page)).toHaveCount(0);
    expect(await repairs(page)).toEqual({ repairs: 1, cursorUnavailable: 1, lineFeedFailed: 0 });
    // Stand-in for a field that moved away.
    await page.evaluate(() => { delete (window as any).qa.terminal._core.coreService.isCursorHidden; });
    await s.send(`${E}c`);
    expect(await repairs(page)).toEqual({ repairs: 2, cursorUnavailable: 2, lineFeedFailed: 0 });
    // The host's own DECSET/DECRST 25 put a boolean back, and the next RIS is repaired again.
    await s.send(`${E}[?25h${E}[?25l${E}c`);
    expect(await ask(s)).toBe(REPAIRED);
    await expect(cursor(page)).toHaveCount(1);
    expect(await repairs(page)).toEqual({ repairs: 3, cursorUnavailable: 2, lineFeedFailed: 0 });
    await expectOrderedAcks(s);
  });

  test('fallback (unit): showHiddenCursor reports unavailable and changes nothing for unusable shapes, and never throws', async ({ page }) => {
    await page.goto('/');
    const results = await page.evaluate(async () => {
      const { showHiddenCursor, CURSOR_HIDDEN_FIELD } = await import(/* @vite-ignore */ '/src/terminal-compat/xterm-private.ts');
      const getterOnly = { get isCursorHidden() { return true; } };
      const ignoresWrites = { get isCursorHidden() { return true; }, set isCursorHidden(_value: boolean) { /* ignored */ } };
      const throwing = { get coreService(): unknown { throw new Error('moved'); } };
      const cases: Record<string, unknown> = {
        noCore: {}, nullCore: { _core: null }, numberCore: { _core: 7 }, noService: { _core: {} },
        nullService: { _core: { coreService: null } }, noField: { _core: { coreService: {} } },
        numberField: { _core: { coreService: { isCursorHidden: 1 } } },
        stringField: { _core: { coreService: { isCursorHidden: 'true' } } },
        frozen: { _core: { coreService: Object.freeze({ isCursorHidden: true }) } },
        getterOnly: { _core: { coreService: getterOnly } },
        ignoresWrites: { _core: { coreService: ignoresWrites } },
        throwingGetter: { _core: throwing },
        hidden: { _core: { coreService: { isCursorHidden: true } } },
        visible: { _core: { coreService: { isCursorHidden: false } } },
      };
      const describe = (value: unknown) => { try { return JSON.stringify(value); } catch { return 'unserialisable'; } };
      const out: Record<string, unknown> = { field: CURSOR_HIDDEN_FIELD };
      for (const [name, target] of Object.entries(cases)) {
        const before = describe(target);
        let result: string;
        try {
          result = showHiddenCursor(target as never);
        } catch (error) {
          result = `threw ${String(error)}`;
        }
        out[name] = { result, changed: describe(target) !== before };
      }
      return out;
    });
    const unavailable = { result: 'unavailable', changed: false };
    expect(results).toEqual({
      field: '_core.coreService.isCursorHidden',
      noCore: unavailable, nullCore: unavailable, numberCore: unavailable, noService: unavailable,
      nullService: unavailable, noField: unavailable, numberField: unavailable, stringField: unavailable,
      frozen: unavailable, getterOnly: unavailable, ignoresWrites: unavailable, throwingGetter: unavailable,
      hidden: { result: 'shown', changed: true }, visible: { result: 'visible', changed: false },
    });
  });

  test('unit: on raw xterm.js the addon restores an initial convertEol of true, contains a throwing hook and stops after dispose', async ({ page }) => {
    await page.goto('/');
    const out = await page.evaluate(async () => {
      const { Terminal } = await import(/* @vite-ignore */ '/node_modules/@xterm/xterm/lib/xterm.mjs');
      const { risRepair } = await import(/* @vite-ignore */ '/src/terminal-compat/ris-repair.ts');
      const replies: string[] = [];
      const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
      const query = async () => { replies.length = 0; await write('\x1b[?25$p\x1b[20$p'); return replies.join(''); };
      // No production session sets convertEol; an embedder that does gets its own value back.
      const term = new Terminal({ cols: 20, rows: 4, convertEol: true });
      term.onData((data: string) => replies.push(data));
      const outcomes: unknown[] = [];
      const addon = risRepair({ onRepair: (outcome: unknown) => { outcomes.push(outcome); throw new Error('diagnostics failure'); } });
      term.loadAddon(addon);
      await write('\x1b[?25l\x1b[20l\x1bcA\nB');
      const loaded = { replies: await query(), rows: [0, 1].map((y) => term.buffer.active.getLine(y).translateToString(true)) };
      addon.dispose();
      await write('\x1b[?25l\x1b[20l\x1bc');
      const disposed = await query();
      term.dispose();
      return { loaded, outcomes, disposed };
    });
    // convertEol true again after RIS: DECRQM 20 reports set and LF returns to column 1.
    expect(out.loaded).toEqual({ replies: `${E}[?25;1$y${E}[20;1$y`, rows: ['A', 'B'] });
    expect(out.outcomes).toEqual([{ lineFeed: 'restored', cursor: 'shown' }]);
    // Disposed: raw xterm.js again, the hidden cursor and the reset LNM both survive RIS.
    expect(out.disposed).toBe(`${E}[?25;2$y${E}[20;2$y`);
  });
});

test.describe('timing: where xterm.js runs RIS, the repair runs', () => {
  for (const transport of TRANSPORTS) {
    test(`${transport}: ESC c, ESC LF c and ESC DEL c are repaired whole, at every cut and byte by byte`, async ({ page }) => {
      const s = await Session.open(page, transport, { size: SIZE });
      for (const sample of [`${DIRTY}${E}c`, `${DIRTY}${E}\nc`, `${DIRTY}${E}\x7fc`]) {
        const runs = await s.splits(sample, `${LINES}${ASK}`, strides(utf8(sample).length));
        const whole = runs[0];
        expect(whole.rows.slice(0, 2)).toEqual(['A', ' B']);
        expect(whole.replies).toBe(REPAIRED);
        const strip = ({ cuts, ...rest }: Snapshot & { cuts: string }) => rest;
        const differing = runs.filter((run) => JSON.stringify(strip(run)) !== JSON.stringify(strip(whole))).map((run) => run.cuts);
        expect({ sample, differing }).toEqual({ sample, differing: [] });
      }
      await expect(cursor(page)).toHaveCount(1);
      await expectOrderedAcks(s);
    });
  }

  test('in the same chunk the host modes set after RIS are kept; back-to-back RIS repair each time', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE, query: '?p0Diagnostics' });
    await s.send(`${DIRTY}${E}c${E}[?25l`);
    expect(await ask(s)).toBe(`${E}[?25;2$y${E}[20;2$y`);
    await expect(cursor(page)).toHaveCount(0);
    await s.send(`${E}c${E}[20h${LINES}`);
    expect((await s.snapshot()).rows.slice(0, 2)).toEqual(['A', 'B']);
    expect(await ask(s)).toBe(`${E}[?25;1$y${E}[20;1$y`);
    await s.send(`${DIRTY}${E}c${E}c${LINES}`);
    expect((await s.snapshot()).rows.slice(0, 2)).toEqual(['A', ' B']);
    expect(await ask(s)).toBe(REPAIRED);
    expect(await repairs(page)).toEqual({ repairs: 4, cursorUnavailable: 0, lineFeedFailed: 0 });
    await expectOrderedAcks(s);
  });

  test('an ESC that ends a string, C0 or another ESC before c, and a broken UTF-8 lead still run RIS, as in raw xterm.js, and are repaired', async ({ page }) => {
    const cases: Record<string, number[]> = {
      'OSC 0;t ESC c': utf8(`${E}]0;t${E}c`),
      'C1 OSC 0;t ESC c': utf8(`\u009d0;t${E}c`),
      'DCS $ q m ESC c': utf8(`${E}P$qm${E}c`),
      'APC abc ESC c': utf8(`${E}_abc${E}c`),
      'PM abc ESC c': utf8(`${E}^abc${E}c`),
      'SOS abc ESC c': utf8(`${E}Xabc${E}c`),
      'ESC BEL c': utf8(`${E}\x07c`),
      'ESC ESC c': utf8(`${E}${E}c`),
      'CSI 1 ESC c': utf8(`${E}[1${E}c`),
      'E4 ESC c': [0xe4, 0x1b, 0x63],
    };
    const s = await Session.open(page, 'pty', { size: SIZE, query: '?p0Diagnostics' });
    const raw = await rawCases(page, Object.values(cases));
    const production = await productionCases(s, Object.values(cases));
    const names = Object.keys(cases);
    for (const [i, name] of names.entries()) {
      // Raw xterm.js ran RIS (XYZ is gone) and kept both states.
      expect({ name, raw: raw[i] }).toMatchObject({ name, raw: { rows: ['A', 'B', ''], replies: KEPT } });
      // Production ran the same RIS and repaired it; the string's own effect is unchanged.
      expect({ name, production: production[i] }).toEqual({
        name, production: { ...raw[i], rows: ['A', ' B', ''], replies: REPAIRED },
      });
    }
    expect(raw[0].titles).toBe('t');
    expect(raw[1].titles).toBe('t');
    // Recorded, not changed: the DECRQSS ended by ESC is answered, by xterm.js raw and by the adapter here.
    expect(raw[2].during).toBe(`${E}P1$r0m${ST}`);
    // One repair per case plus the clean-start RIS before each.
    expect(await repairs(page)).toEqual({ repairs: 2 * names.length, cursorUnavailable: 0, lineFeedFailed: 0 });
    await expectOrderedAcks(s);
  });

  test('ESC CAN c, ESC SUB c, ESC # c and ESC NEL c are not RIS: no reset and no repair, exactly as raw xterm.js', async ({ page }) => {
    const cases: Record<string, number[]> = {
      'ESC CAN c': utf8(`${E}\x18c`),
      'ESC SUB c': utf8(`${E}\x1ac`),
      'ESC # c': utf8(`${E}#c`),
      'ESC U+0085 c': utf8(`${E}\u0085c`),
    };
    const s = await Session.open(page, 'pty', { size: SIZE, query: '?p0Diagnostics' });
    const raw = await rawCases(page, Object.values(cases));
    const production = await productionCases(s, Object.values(cases));
    for (const [i, name] of Object.keys(cases).entries()) {
      expect({ name, production: production[i] }).toEqual({ name, production: raw[i] });
      expect({ name, replies: raw[i].replies, kept: raw[i].rows[0].startsWith('XYZ') }).toEqual({ name, replies: KEPT, kept: true });
    }
    await expect(cursor(page)).toHaveCount(0);
    // Only the clean-start RIS before each case.
    expect(await repairs(page)).toEqual({ repairs: 4, cursorUnavailable: 0, lineFeedFailed: 0 });
    await expectOrderedAcks(s);
  });

  test('the repair runs exactly when xterm.js runs RIS: a newer ESC c handler that swallows it skips both', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE, query: '?p0Diagnostics' });
    await page.evaluate(() => {
      const w = window as any;
      w.qaSwallow = w.qa.terminal.parser.registerEscHandler({ final: 'c' }, () => true);
    });
    await s.send(`XYZ${DIRTY}${E}c`);
    expect((await s.snapshot()).rows[0]).toBe('XYZ');
    expect(await ask(s)).toBe(KEPT);
    expect(await repairs(page)).toEqual({ repairs: 0, cursorUnavailable: 0, lineFeedFailed: 0 });
    expect(await diagnostics(page)).toMatchObject({ historyClears: 0 });
    await page.evaluate(() => (window as any).qaSwallow.dispose());
    await s.send(`${E}[1;31m${E}c`);
    expect(await ask(s)).toBe(REPAIRED);
    // The handlers registered after the repair still ran: the adapters' SGR shadow and the archive's reset note.
    expect(await ask(s, `${E}P$qm${ST}`)).toBe(`${E}P1$r0m${ST}`);
    expect(await repairs(page)).toEqual({ repairs: 1, cursorUnavailable: 0, lineFeedFailed: 0 });
    expect(await diagnostics(page)).toMatchObject({ historyClears: 1, historyGaps: 0 });
    await expectOrderedAcks(s);
  });
});

test.describe('session paths', () => {
  test('GBK, Big5 and Shift_JIS: characters and a lone lead byte next to RIS end like UTF-8 at every cut', async ({ browser }) => {
    // 中, ESC c, a lone lead byte, ESC c, 文, LF, B: the lead byte becomes U+FFFD and RIS still runs.
    const SAMPLES: Record<string, { zhong: number[]; wen: number[]; lead: number }> = {
      'utf-8': { zhong: utf8('中'), wen: utf8('文'), lead: 0xe4 },
      gbk: { zhong: [0xd6, 0xd0], wen: [0xce, 0xc4], lead: 0xd6 },
      big5: { zhong: [0xa4, 0xa4], wen: [0xa4, 0xe5], lead: 0xa4 },
      shift_jis: { zhong: [0x92, 0x86], wen: [0x95, 0xb6], lead: 0x92 },
    };
    const results: Record<string, unknown> = {};
    for (const [encoding, { zhong, wen, lead }] of Object.entries(SAMPLES)) {
      const page = await browser.newPage();
      const t = encoding === 'utf-8'
        ? await Session.open(page, 'pty', { size: { cols: 60, rows: 8 } })
        : await openEncoded(page, 'pty', encoding);
      const sample = [...utf8(DIRTY), ...zhong, 0x1b, 0x63, lead, 0x1b, 0x63, ...wen, 0x0a, 0x42];
      const runs = await t.splits(sample, ASK, strides(sample.length));
      const whole = runs[0];
      const strip = ({ cuts, ...rest }: Snapshot & { cuts: string }) => rest;
      results[encoding] = {
        rows: whole.rows.slice(0, 2), replies: whole.replies,
        differing: runs.filter((run) => JSON.stringify(strip(run)) !== JSON.stringify(strip(whole))).map((run) => run.cuts),
      };
      await expect(cursor(page)).toHaveCount(1);
      await expectOrderedAcks(t);
      await page.close();
    }
    const same = { rows: ['文', '  B'], replies: REPAIRED, differing: [] };
    expect(results).toEqual({ 'utf-8': same, gbk: same, big5: same, shift_jis: same });
  });

  test('host chunks reach xterm unchanged, the repair writes nothing, and every chunk is acknowledged once in order', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    await recordWrites(page);
    const chunks = [`one\r\n${DIRTY}`, E, 'c', `${E}\n`, `c${E}]0;t${E}`, 'ctail'];
    await s.send(...chunks);
    expect(await recordedWrites(page)).toEqual(chunks.map((chunk) => ({ host: utf8(chunk) })));
    expect(await s.writeCalls()).toEqual([]);
    expect((await s.snapshot()).rows[0]).toBe('tail');
    // The status bar counts the bytes the backend sent, nothing more.
    const total = chunks.reduce((sum, chunk) => sum + utf8(chunk).length, 0);
    await expect(page.locator('#terminal-size')).toContainText(`· ${total} B 接收`);
    await expectOrderedAcks(s);
    expect(await ask(s)).toBe(REPAIRED);
  });

  test('while ACKs are held, input typed around a host RIS keeps its order and the ACK sequence continues', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE });
    await s.mark();
    await page.evaluate(() => { (window as any).qaIpc.holdAck = true; });
    await page.keyboard.type('ab');
    await s.send(`${DIRTY}${E}`, 'c');
    await page.keyboard.type('c');
    await s.paste('d\ne');
    await s.send(`${E}\n`, 'ctail');
    await expect.poll(() => s.writeCalls()).toEqual(['a', 'b', 'c', 'd\re']);
    // Only the first ACK is in flight; the others wait behind it in the frontend.
    expect(await s.acks()).toEqual(['pty_ack:1']);
    await page.evaluate(() => {
      const ipc = (window as any).qaIpc;
      ipc.holdAck = false;
      for (const resolve of ipc.heldAcks.splice(0)) resolve(null);
    });
    await expectOrderedAcks(s);
    expect((await s.snapshot()).rows[0]).toBe('tail');
    expect(await ask(s)).toBe(REPAIRED);
  });

  test('cold archive: each RIS counts one clear and no gap and keeps archived lines, the hard reset too', async ({ page }) => {
    const s = await Session.open(page, 'pty', { size: SIZE, query: '?p0Diagnostics' });
    await s.send(crlf(lines('first', 40)));
    // 31 lines have left the 10-row screen; the 9 still on it are lost with the RIS.
    expect((await archive(s)).lines).toEqual(lines('first', 31));
    await s.send(`${E}c`);
    await s.send(crlf(lines('second', 40)));
    await s.send(`${DIRTY}${E}c`);
    await hardReset(s);
    await s.send(crlf(lines('third', 30)));
    const after = await archive(s);
    expect(after.lines).toEqual([...lines('first', 31), ...lines('second', 31), ...lines('third', 21)]);
    expect(after.stats).toMatchObject({ clears: 3, gaps: 0, userClears: 0, clearedLines: 0 });
    expect(await diagnostics(page)).toMatchObject({
      risRepairs: 3, risCursorUnavailable: 0, risLineFeedFailed: 0, historyClears: 3, historyGaps: 0,
    });
    expect(await ask(s)).toBe(REPAIRED);
    await expectOrderedAcks(s);
  });

  test('T31 and T32 on top: host RIS returns to normal cursor keys, DECSTR is unchanged, the hard reset keeps its write', async ({ page }) => {
    const s = await openWithKeyboard(page, 'pty', { cursorKeys: 'application' }, { size: SIZE, query: '?p0Diagnostics' });
    const arrow = async () => (await s.pressEach(['ArrowUp'])).ArrowUp;
    expect(await arrow()).toBe(`${E}OA`);
    // Host RIS: DECCKM back to normal (user decision 5, not the session's initial mode), repaired.
    await s.send(`${DIRTY}${E}c`);
    expect(await arrow()).toBe(`${E}[A`);
    expect(await ask(s)).toBe(REPAIRED);
    await expect(cursor(page)).toHaveCount(1);
    // Host DECSTR is not RIS: it shows the cursor itself (xterm.js) and leaves LNM set; no repair.
    await s.send(`${DIRTY}${E}[!p`);
    expect(await ask(s)).toBe(`${E}[?25;1$y${E}[20;1$y`);
    expect(await repairs(page)).toEqual({ repairs: 1, cursorUnavailable: 0, lineFeedFailed: 0 });
    // The user's hard reset: the same single local write as before, once more through the repair.
    await s.send(DIRTY);
    await page.evaluate(() => {
      const w = window as any;
      const terminal = w.qa.terminal;
      const write = terminal.write.bind(terminal);
      w.qaLocal = [];
      terminal.write = (data: string | Uint8Array, callback?: () => void) => {
        if (typeof data === 'string' && data.length) w.qaLocal.push(data);
        return write(data, callback);
      };
    });
    await s.mark();
    await hardReset(s);
    expect(await page.evaluate(() => (window as any).qaLocal)).toEqual([`\x18${E}c${E}[?25h${E}[20l${E}[?1h`]);
    expect(await s.writeCalls()).toEqual([]);
    expect(await arrow()).toBe(`${E}OA`);
    expect(await ask(s)).toBe(REPAIRED);
    await expect(cursor(page)).toHaveCount(1);
    expect(await repairs(page)).toEqual({ repairs: 2, cursorUnavailable: 0, lineFeedFailed: 0 });
    await expectOrderedAcks(s);
  });
});

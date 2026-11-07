import { test, expect, type Page } from '@playwright/test';
import { Session, randomCuts, type Snapshot } from './support/session-harness';
import { ascii, fromHex, openArguments, openEncoded, recordOpenArguments } from './support/encoding-harness';
import { onLive } from './support/history-harness';

// T28/T29/T33 part 1, output side (docs/p1/SESSION_ENCODING_PLAN.zh-CN.md). Known Big5 / EUC-JP
// bytes go through the production path: stub IPC -> Channel -> session-lifecycle.ts (SessionCodec,
// ordered ACK) -> xterm.js + VT adapters. Chrome + IPC stub only: no Rust, native PTY, SSH server,
// telnetd or native WebView; nothing here shows that a real remote program emits these bytes.

const ESC = '\x1b';
/** Big5: SGR around 許功 (0x5C trails), 中文, an OSC title in Big5, 「」 and an underlined 中. */
const BIG5_SAMPLE = [
  ...ascii(`${ESC}[1;31m`), ...fromHex('B35C A55C'), ...ascii(`${ESC}[0m `), ...fromHex('A4A4 A4E5'), ...ascii('\r\n'),
  ...ascii(`${ESC}]2;`), ...fromHex('C163 C5E9'), 0x07, ...fromHex('A175 A176'),
  ...ascii(`${ESC}[4m`), ...fromHex('A4A4'), ...ascii(`${ESC}[0m ok`),
];
/** EUC-JP: green 日本語, half-width ｱｲｳ (0x8E), JIS X 0212 丂 (0x8F), title 日本, then ア。. */
const EUC_JP_SAMPLE = [
  ...ascii(`${ESC}[32m`), ...fromHex('C6FC CBDC B8EC'), ...ascii(`${ESC}[0m`), ...fromHex('8EB1 8EB2 8EB3'), 0x20, ...fromHex('8FB0A1'),
  ...ascii('\r\n'), ...ascii(`${ESC}]2;`), ...fromHex('C6FC CBDC'), 0x07, ...fromHex('A5A2 A1A3'),
];

/** Every cut of the sample renders like the whole sample: screen, cell attributes, cursor, title. */
async function expectSplitsEqual(t: Session, sample: number[], rows: string[], title: string) {
  const runs = await t.splits(sample, [], randomCuts(sample.length, 8));
  const whole = runs[0];
  expect(whole.rows.slice(0, rows.length)).toEqual(rows);
  expect(whole.titles).toBe(title);
  const strip = ({ cuts, ...rest }: Snapshot & { cuts: string }) => rest;
  const differing = runs.filter((run) => JSON.stringify(strip(run)) !== JSON.stringify(strip(whole))).map((run) => run.cuts);
  expect(differing).toEqual([]);
  // Each chunk (including those that decode to nothing) is acknowledged once, in order.
  await t.drained();
  expect(await t.acks()).toEqual(Array.from({ length: await t.sequence() }, (_, i) => `${t.transport}_ack:${i + 1}`));
}

test.describe('decoding at every cut', () => {
  test.setTimeout(60_000);
  test('pty Big5: wide text, 0x5C trail bytes, SGR and an OSC title survive any chunking', async ({ page }) => {
    const t = await openEncoded(page, 'pty', 'big5');
    await expect(page.locator('#terminal-size')).toContainText('B 接收 · Big5');
    await expectSplitsEqual(t, BIG5_SAMPLE, ['許功 中文', '「」中 ok'], '繁體');
  });
  test('pty EUC-JP: kanji, half-width katakana and JIS X 0212 survive any chunking', async ({ page }) => {
    const t = await openEncoded(page, 'pty', 'euc-jp');
    await expectSplitsEqual(t, EUC_JP_SAMPLE, ['日本語ｱｲｳ 丂', 'ア。'], '日本');
  });
  test('ssh Big5 and Telnet EUC-JP decode the same samples the same way', async ({ browser }) => {
    for (const [transport, encoding, sample, rows, title] of [
      ['ssh', 'big5', BIG5_SAMPLE, ['許功 中文', '「」中 ok'], '繁體'],
      ['net', 'euc-jp', EUC_JP_SAMPLE, ['日本語ｱｲｳ 丂', 'ア。'], '日本'],
    ] as const) {
      const page = await browser.newPage();
      const t = await openEncoded(page, transport, encoding);
      await expectSplitsEqual(t, [...sample], [...rows], title);
      await page.close();
    }
  });
});

/** The visible row `y` as text, and the width of each cell up to the cursor. */
const rowAt = (page: Page, y: number) => page.evaluate((y) => {
  const t = (window as any).qa.terminal;
  const line = t.buffer.active.getLine(t.buffer.active.viewportY + y);
  return line.translateToString(true) as string;
}, y);

test('incomplete and invalid sequences become U+FFFD without eating controls, and every chunk is acknowledged', async ({ page }) => {
  const t = await openEncoded(page, 'pty', 'big5');
  // A lead byte at a chunk end is completed by the next chunk; a chunk of only a lead byte decodes
  // to nothing yet is acknowledged; a lead byte before ESC becomes U+FFFD and the SGR still applies.
  await t.send([0x41, 0xa4], [0xe5], [0xa4], [...ascii(`${ESC}[31mB${ESC}[0m`)]);
  expect(await rowAt(page, 0)).toBe('A文�B');
  const red = await page.evaluate(() => (window as any).qa.terminal.buffer.active.getLine(0).getCell(4).getFgColor());
  expect(red).toBe(1);
  // 0x80 and 0xFF are never valid; a lead byte before "0" (not a trail byte) keeps the "0".
  await t.send([...ascii('\r\n'), 0x80, 0xff, 0xa4, 0x30, ...ascii('\r\n'), 0xa4, 0x0a, 0x43]);
  expect(await rowAt(page, 1)).toBe('���0');
  expect(await rowAt(page, 2)).toBe('�');
  expect(await rowAt(page, 3)).toBe(' C');
  await t.drained();
  expect((await t.acks()).length).toBe(await t.sequence());
  // Output that ends inside a character shows U+FFFD when the shell exits.
  await t.send([...ascii('\r\nD'), 0xa4]);
  await page.evaluate(() => {
    const ipc = (window as any).qaIpc;
    ipc.channel.onmessage({ kind: 'exit', id: ipc.id, code: 0 });
  });
  await expect.poll(() => rowAt(page, 4)).toBe('D�');
});

test('ssh and Telnet sessions flush an unfinished character on disconnect', async ({ browser }) => {
  for (const [transport, encoding, tail] of [['ssh', 'euc-jp', [0x8e]], ['net', 'big5', [0xa4]]] as const) {
    const page = await browser.newPage();
    const t = await openEncoded(page, transport, encoding);
    await t.send([0x45, ...tail]);
    await page.evaluate(() => {
      const ipc = (window as any).qaIpc;
      ipc.channel.onmessage({ kind: 'error', id: ipc.id, message: 'closed by peer' });
    });
    await expect.poll(() => rowAt(page, 0)).toBe('E�');
    await page.close();
  }
});

test('column widths, copied text and buffer text are Unicode', async ({ page }) => {
  const t = await openEncoded(page, 'pty', 'big5');
  // 中文ab, an ideographic space, then U+2500 (Big5 0xA277), an East Asian Ambiguous character.
  await t.send([...fromHex('A4A4 A4E5'), ...ascii('ab'), ...fromHex('A140'), ...fromHex('A277'), ...ascii('|')]);
  const cells = await page.evaluate(() => {
    const t = (window as any).qa.terminal;
    const line = t.buffer.active.getLine(0);
    return { cursor: t.buffer.active.cursorX, widths: Array.from({ length: 10 }, (_, x) => line.getCell(x).getWidth()), text: line.translateToString(true) };
  });
  expect(cells.text).toBe('中文ab　─|');
  // Wide characters take two cells; the ambiguous-width box drawing character takes one (observed
  // xterm.js Unicode 11 behaviour, not the two cells some CJK legacy terminals use).
  expect(cells.widths).toEqual([2, 0, 2, 0, 1, 1, 2, 0, 1, 1]);
  expect(cells.cursor).toBe(10);
  // Copy hands the clipboard Unicode text, whatever the session encoding.
  const copied = await page.evaluate(() => {
    const t = (window as any).qa.terminal;
    t.select(0, 0, 10);
    const clipboardData = new DataTransfer();
    t.textarea.dispatchEvent(new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true }));
    return { selection: t.getSelection(), clipboard: clipboardData.getData('text/plain') };
  });
  expect(copied).toEqual({ selection: '中文ab　─|', clipboard: '中文ab　─|' });
  // EUC-JP half-width katakana take one cell each.
  const jp = await (async () => {
    const other = await page.context().newPage();
    const s = await openEncoded(other, 'pty', 'euc-jp');
    await s.send([...fromHex('8EB1 8EB2 8EB3 C6FC')]);
    const result = await other.evaluate(() => {
      const t = (window as any).qa.terminal;
      return { cursor: t.buffer.active.cursorX, text: t.buffer.active.getLine(0).translateToString(true) };
    });
    await other.close();
    return result;
  })();
  expect(jp).toEqual({ cursor: 5, text: 'ｱｲｳ日' });
});

test('the cold archive matches a Big5 stream line by line past the 5,000-line hot window', async ({ page }) => {
  test.setTimeout(60_000);
  const t = await openEncoded(page, 'pty', 'big5', { cols: 60, rows: 8 });
  const cdp = await page.context().newCDPSession(page);
  const total = 6000;
  const sent = await page.evaluate(async (total) => {
    const { encodeText } = await import(/* @vite-ignore */ '/src/text-encoding.ts');
    const id = (i: number) => String(i).padStart(5, '0');
    const line = (i: number) => {
      switch (i % 4) {
        case 0: return `${id(i)} 中文繁體「引號」許功蓋`;
        case 1: return `\x1b[1;31m${id(i)} 紅色\x1b[0m 一般`;
        case 2: return `${id(i)} ${'漢字'.repeat(40)}`;
        default: return '';
      }
    };
    const text = [...Array.from({ length: total }, (_, i) => line(i)), ...Array(8).fill('')].map((l) => `${l}\r\n`).join('');
    const encoded = encodeText('big5', text);
    if (!encoded.ok) throw new Error('sample is not Big5');
    const ipc = (window as any).qaIpc;
    // Rust's 4096-byte blocks, which cut Big5 characters and escape sequences anywhere.
    for (let at = 0; at < encoded.bytes.length; at += 4096)
      ipc.channel.onmessage({ kind: 'data', id: ipc.id, sequence: ++ipc.sequence, data: Array.from(encoded.bytes.slice(at, at + 4096)) });
    (window as any).qaExpected = Array.from({ length: total }, (_, i) => line(i).replace(/\x1b\[[0-9;]*m/g, ''));
    return ipc.sequence;
  }, total);
  await expect.poll(() => page.evaluate(() => (window as any).qaIpc.acks.length), { timeout: 30_000 }).toBe(sent);
  expect(await t.acks()).toEqual(Array.from({ length: sent }, (_, i) => `pty_ack:${i + 1}`));
  const archived = await onLive<{ lines: string[]; gaps: number }>(cdp, 'archivePrototype', `async function () {
    if (this.length !== 1) throw new Error('expected one live archive, found ' + this.length);
    const archive = this[0];
    await archive.flush(true);
    const stats = archive.stats();
    const raw = await archive.lines(0, stats.archivedLines);
    return { lines: raw.map((l) => l.replace(/\\x1b\\[[0-9;]*m/g, '')), gaps: stats.gaps };
  }`);
  const expected = await page.evaluate(() => (window as any).qaExpected as string[]);
  const firstMismatch = expected.findIndex((line, i) => archived.lines[i] !== line);
  expect(firstMismatch).toBe(-1);
  expect(archived.gaps).toBe(0);
  expect(archived.lines.join('')).not.toContain('�');
});

test('default sessions stay UTF-8 and no encoding reaches the native open calls', async ({ browser }) => {
  for (const transport of ['pty', 'ssh', 'net'] as const) {
    const page = await browser.newPage();
    const t = await Session.open(page, transport, {}, false);
    await recordOpenArguments(page);
    await t.start();
    await expect(page.locator('#terminal-size')).toHaveText(/B 接收$/);
    // UTF-8 bytes still reach xterm through Utf8Boundary (here split inside 中).
    await t.send([0x41, 0xe4], [0xb8, 0xad]);
    expect(await rowAt(page, 0)).toBe('A中');
    const [defaults] = await openArguments(page);
    await page.close();
    const encodedPage = await browser.newPage();
    await openEncoded(encodedPage, transport, 'big5');
    const [encoded] = await openArguments(encodedPage);
    await encodedPage.close();
    // Same argument names with and without an encoding; the choice never leaves the frontend.
    expect(encoded.command).toBe(defaults.command);
    expect(encoded.keys).toEqual(defaults.keys);
    for (const args of [defaults, encoded]) {
      expect(args.json).not.toContain('big5');
      expect(args.json).not.toContain('encoding');
    }
    expect(defaults.keys).toEqual({
      pty: ['cols', 'cwd', 'env', 'locale', 'onEvent', 'rows', 'shell'],
      ssh: ['challengeToken', 'cols', 'credential', 'onAuth', 'onEvent', 'operationId', 'rows', 'scopeToken'],
      net: ['cols', 'id', 'onEvent', 'rows', 'target'],
    }[transport]);
  }
});

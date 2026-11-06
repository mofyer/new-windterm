import { test, expect } from '@playwright/test';
import { Session, randomCuts, type Snapshot, type Transport } from './support/session-harness';

// P1 slice 4 cross-chunk regressions through the production session path (stub IPC -> Channel ->
// session-lifecycle -> Utf8Boundary -> xterm.js + VT adapters -> ordered ACK). Each sample is run
// whole and then cut at every byte offset, one byte per chunk and at seeded random offsets; every
// run must leave the same screen, cell attributes, cursor, modes, titles and replies as the whole
// run. Expected values are xterm.js 6.0.0's own behaviour in Chrome; nothing here reaches Rust, a
// native PTY / SSH / TCP peer or a native WebView.
const E = '\x1b';
const ST = `${E}\\`;
const SIZE = { cols: 40, rows: 10 };
const DECRQSS_SGR = `${E}P$qm${ST}`;
const utf8 = (text: string) => [...Buffer.from(text, 'utf8')];

interface Sample {
  name: string;
  data: string | number[];
  /** Delivered as its own chunk after the sample, e.g. a report request. */
  probe?: string;
  /** Facts about the whole-sample reference run, so equality is never vacuous. */
  check(reference: Snapshot): void;
}

const SAMPLES: Sample[] = [
  {
    name: 'SGR truecolour, 256-colour, attributes and reset',
    data: `${E}[1;38;2;10;20;30;48;5;196mRGB${E}[0m plain ${E}[3;4;9mX`,
    probe: DECRQSS_SGR,
    check: (r) => {
      expect(r.rows[0]).toBe('RGB plain X');
      expect(r.cells[0]).toBe('0,0:R,1,50331648:660510,33554432:196,1,0,0,0,0,0,0,0,0');
      expect(r.replies).toBe(`${E}P1$r0;3;4;9m${ST}`);
    },
  },
  {
    name: 'SGR colon forms (underline style, underline colour, 256-colour)',
    data: `${E}[4:3;58:2::255:0:0;38:5:202mU`,
    probe: DECRQSS_SGR,
    check: (r) => {
      expect(r.rows[0]).toBe('U');
      // The adapter reports colon forms in their semicolon spelling (replay-equivalent, vt-adapters.spec.ts).
      expect(r.replies).toBe(`${E}P1$r0;4:3;38;5;202;58;2;255;0;0m${ST}`);
    },
  },
  {
    name: 'cursor movement, erase, insert and delete characters',
    data: `ABCDEF${E}[3D${E}[1KX${E}[2;5HY${E}[K${E}[1;5H${E}[2@Z${E}[P`,
    check: (r) => {
      expect(r.rows.slice(0, 2)).toEqual(['   XZEF', '    Y']);
      expect(r.cursor).toBe('5,0');
    },
  },
  {
    name: 'scroll region, origin mode and CPR relative to the margin',
    data: `1\r\n2\r\n3\r\n4\r\n5${E}[2;4r${E}[?6h${E}[2;1HZ${E}[6n${E}[?6l${E}[4;1H\n\nW${E}[r`,
    check: (r) => {
      expect(r.rows.slice(0, 5)).toEqual(['1', '4', '', 'W', '5']);
      expect(r.replies).toBe(`${E}[2;2R`);
    },
  },
  {
    name: 'private modes and DECRQM',
    data: `${E}[?1h${E}=${E}[?2004h${E}[?1000;1006h${E}[?1004h${E}[4h${E}[?7l${E}[?25lM`,
    probe: `${E}[?25$p${E}[?7$p`,
    check: (r) => {
      expect(r.modes).toMatchObject({
        applicationCursorKeysMode: true, applicationKeypadMode: true, bracketedPasteMode: true,
        mouseTrackingMode: 'vt200', sendFocusMode: true, insertMode: true, wraparoundMode: false,
      });
      // xterm.js 6.0.0 reports the current focus once when 1004 is enabled on a focused terminal.
      expect(r.replies).toBe(`${E}[I${E}[?25;2$y${E}[?7;2$y`);
    },
  },
  {
    name: 'DEC special graphics in G0 and through SO/SI in G1',
    data: `${E}(0lqk${E}(B|${E})0\x0eqx\x0f.`,
    check: (r) => expect(r.rows[0]).toBe('┌─┐|─│.'),
  },
  {
    name: 'DECSC/DECRC restore position and SGR',
    data: `${E}[3;3H${E}[31m${E}7${E}[H${E}[0mA${E}8B`,
    probe: DECRQSS_SGR,
    check: (r) => {
      expect(r.rows.slice(0, 3)).toEqual(['A', '', '  B']);
      expect(r.replies).toBe(`${E}P1$r0;31m${ST}`);
    },
  },
  {
    name: 'alternate screen enter and leave',
    data: `MAIN${E}[?1049h${E}[2JALT${E}[?1049l!`,
    check: (r) => {
      expect(r.type).toBe('normal');
      expect(r.rows[0]).toBe('MAIN!');
    },
  },
  {
    name: 'OSC titles with UTF-8, ended by BEL and by ST',
    data: `${E}]0;标题 🌏 title\x07${E}]2;第二${ST}T`,
    check: (r) => {
      expect(r.titles).toBe('标题 🌏 title|第二');
      expect(r.rows[0]).toBe('T');
    },
  },
  {
    name: 'OSC 8 hyperlink with a UTF-8 URI',
    data: `${E}]8;id=a;https://example.com/路径${ST}链接${E}]8;;${ST} tail`,
    check: (r) => expect(r.rows[0]).toBe('链接 tail'),
  },
  {
    name: 'DCS DECRQSS and identity replies (adapter and built-in)',
    data: `${E}[1;31m${E}P$qm${ST}${E}[c${E}[>c${E}[>0q${E}P$q"p${ST}${E}P$qr${ST}${E}[5n`,
    check: (r) => {
      expect(r.replies).toBe([
        `${E}P1$r0;1;31m${ST}`, `${E}[?1;2c`, `${E}[>0;276;0c`, `${E}P>|new-windterm(0.0.1)${ST}`,
        `${E}P1$r61;1"p${ST}`, `${E}P1$r1;10r${ST}`, `${E}[0n`,
      ].join(''));
    },
  },
  {
    name: 'CAN and SUB cancel a pending CSI and OSC',
    data: `${E}[31\x18X${E}[1\x1aY${E}]0;never\x18Z`,
    check: (r) => {
      expect(r.titles).toBe('');
      expect(r.rows[0]).toMatch(/^X.*Y.*Z$/u);
    },
  },
  {
    name: 'combining marks, Hangul jamo, ZWJ, flags, skin tone and VS16',
    data: 'é ạ̈ 각 👨‍👩‍👧 🇨🇳 👍🏽 ❤️ 中',
    check: (r) => expect(r.rows[0]).toBe('é ạ̈ 각 👨‍👩‍👧 🇨🇳 👍🏽 ❤️ 中'),
  },
  {
    name: 'wide characters at the right margin wrap whole',
    data: `${'x'.repeat(39)}中文${E}[3;40H🌏!`,
    check: (r) => {
      expect(r.rows.slice(0, 4)).toEqual(['x'.repeat(39), '~中文', '', '~🌏!']);
    },
  },
  {
    name: 'invalid UTF-8 between escapes and text',
    data: [0x41, 0xe4, ...utf8(`${E}[31mB`), 0xff, 0x43, 0xf0, 0x9f, ...utf8(`${E}[0mD`), 0xe3, 0x80, 0x45],
    check: (r) => expect(r.rows[0]).toMatch(/B.*C.*D.*E/u),
  },
  {
    name: 'RIS inside the sample',
    data: `XYZ${E}[?1h${E}[1;31m${E}cAFTER`,
    check: (r) => {
      expect(r.rows[0]).toBe('AFTER');
      expect(r.modes.applicationCursorKeysMode).toBe(false);
      // Only the characters remain; every cell has default attributes again.
      expect(r.cells.every((cell) => cell.endsWith(',1,,,0,0,0,0,0,0,0,0,0'))).toBe(true);
    },
  },
  {
    name: 'DECSTR inside the sample',
    data: `${E}[?1h${E}[1;31mK${E}[!pN`,
    probe: DECRQSS_SGR,
    check: (r) => {
      expect(r.rows[0]).toBe('KN');
      expect(r.modes.applicationCursorKeysMode).toBe(false);
      expect(r.replies).toBe(`${E}P1$r0m${ST}`);
    },
  },
  {
    name: 'OSC 52 is swallowed without the opt-in; reads are never answered',
    data: `${E}]52;c;aGVsbG8=\x07T${E}]52;c;?${ST}U`,
    check: (r) => {
      expect(r.rows[0]).toBe('TU');
      expect(r.replies).toBe('');
    },
  },
  {
    name: 'tab stops set and cleared',
    data: `${E}[3g${E}[5G${E}H\r\tX\r\t${E}[0g\r\tY`,
    check: (r) => expect(r.rows[0]).toBe(`${'    X'.padEnd(39)}Y`),
  },
  {
    name: 'C0 controls BS, CR, LF, HT and BEL',
    data: 'abc\b\bX\rY\n\tZ\x07',
    check: (r) => expect(r.rows.slice(0, 2)).toEqual(['YXc', '        Z']),
  },
];

/** The first field of `actual` that differs from `expected`, for a readable failure list. */
function differences(expected: Snapshot, actual: Snapshot): string[] {
  const keys = (Object.keys(expected) as (keyof Snapshot)[]).filter((key) => (key as string) !== 'cuts');
  return keys.filter((key) => JSON.stringify(expected[key]) !== JSON.stringify(actual[key]))
    .map((key) => `${key}: ${JSON.stringify(actual[key]).slice(0, 160)}`);
}

/** Runs every sample's splits and returns the mismatches; also checks replies reached `<transport>_write`. */
async function runSamples(s: Session, samples: Sample[]) {
  const failures: string[] = [];
  for (const sample of samples) {
    await s.mark();
    const length = typeof sample.data === 'string' ? utf8(sample.data).length : sample.data.length;
    const runs = await s.splits(sample.data, sample.probe ?? [], randomCuts(length, 8));
    const [reference, ...others] = runs;
    sample.check(reference);
    expect(reference.size, sample.name).toBe(`${SIZE.cols}x${SIZE.rows}`);
    for (const run of others) {
      const diff = differences(reference, run);
      if (diff.length) failures.push(`${sample.name} [cuts ${run.cuts}] ${diff.join('; ')}`);
    }
    // Every reply produced during the runs was written, in order, through this session's transport.
    await s.expectWritten(runs.map((run) => run.replies).join(''));
  }
  return failures;
}

/** All chunks were acknowledged exactly once, in delivery order, on this transport. */
async function expectOrderedAcks(s: Session) {
  await s.drained();
  const sequence = await s.sequence();
  expect(await s.acks()).toEqual(Array.from({ length: sequence }, (_, i) => `${s.transport}_ack:${i + 1}`));
}

const GROUPS = [SAMPLES.slice(0, 7), SAMPLES.slice(7, 14), SAMPLES.slice(14)];
for (const [index, group] of GROUPS.entries()) {
  test(`pty: samples ${index + 1}/${GROUPS.length} cut anywhere render, reply and ACK like the whole sample`, async ({ page }) => {
    test.setTimeout(90_000);
    const s = await Session.open(page, 'pty', { size: SIZE });
    expect(await runSamples(s, group)).toEqual([]);
    await expectOrderedAcks(s);
  });
}

const REMOTE = ['DCS DECRQSS and identity replies (adapter and built-in)', 'OSC titles with UTF-8, ended by BEL and by ST',
  'combining marks, Hangul jamo, ZWJ, flags, skin tone and VS16', 'invalid UTF-8 between escapes and text', 'RIS inside the sample'];
for (const transport of ['ssh', 'net'] as Transport[]) {
  test(`${transport}: split replies, titles, text and RIS match the whole sample and use ${transport}_write`, async ({ page }) => {
    test.setTimeout(60_000);
    const s = await Session.open(page, transport, { size: SIZE });
    expect(await runSamples(s, SAMPLES.filter((sample) => REMOTE.includes(sample.name)))).toEqual([]);
    await expectOrderedAcks(s);
  });
}

test('a chunk holding only an unfinished escape or UTF-8 prefix is acknowledged before the rest arrives', async ({ page }) => {
  // The backend may not send more until earlier chunks are acknowledged, so an ACK must never wait
  // for a sequence that a later chunk completes (docs/p0/TERMINAL_COMPAT.zh-CN.md, ACK constraint).
  const s = await Session.open(page, 'pty', { size: SIZE });
  const prefixes: [string, number[], number[]][] = [
    ['CSI parameters', utf8(`${E}[3`), utf8('1mR')],
    ['OSC title', utf8(`${E}]0;tit`), utf8(`le${ST}`)],
    ['DCS request', utf8(`${E}P$`), utf8(`qm${ST}`)],
    ['UTF-8 lead byte held back by Utf8Boundary', [0xe4], [0xb8, 0xad]],
    ['UTF-8 lead and continuation 0x80', [0xe3, 0x80], [0x82]],
  ];
  for (const [name, head, tail] of prefixes) {
    await s.send(`${E}c`);
    await s.drained();
    const before = await s.sequence();
    await s.send(head);
    await expect.poll(() => s.acks(), { message: name }).toContain(`pty_ack:${before + 1}`);
    await s.send(tail);
  }
  await s.drained();
  const snap = await s.snapshot();
  expect(snap.rows[0]).toBe('。');
  expect(snap.titles).toBe('title');
  await expectOrderedAcks(s);
});

test('an OSC 52 string spanning 25 chunks is acknowledged chunk by chunk and stays swallowed', async ({ page }) => {
  const s = await Session.open(page, 'pty', { size: SIZE });
  await s.mark();
  const payload = 'YWFh'.repeat(25_000); // 100,000 base64 characters
  const body = utf8(`${E}]52;c;${payload}`);
  const chunks = Array.from({ length: Math.ceil(body.length / 4096) }, (_, i) => body.slice(i * 4096, (i + 1) * 4096));
  expect(chunks).toHaveLength(25);
  await s.send(...chunks);
  // Every chunk of the unterminated string is already acknowledged.
  await expect.poll(() => s.acks()).toHaveLength(25);
  await s.send('\x07T');
  await s.drained();
  expect((await s.snapshot()).rows[0]).toBe('T');
  await expect(page.locator('#toast')).toContainText('已拦截 OSC 52 剪贴板写入');
  expect(await page.evaluate(() => (window as any).qaIpc.clipboard)).toEqual([]);
  await s.expectWritten('');
  await expectOrderedAcks(s);
});

test('an opted-in OSC 52 write split into one-byte chunks reaches the clipboard once', async ({ page }) => {
  const s = await Session.open(page, 'pty', { size: SIZE });
  await page.locator('#palette-open').click();
  await page.locator('#command-search').fill('OSC 52');
  await page.locator('#command-list .command').first().click();
  await expect(page.locator('#session-detail')).toContainText('OSC 52 可写剪贴板');
  const secret = '跨块 clip ✓';
  const payload = Buffer.from(secret, 'utf8').toString('base64');
  await s.send(...utf8(`${E}]52;c;${payload}\x07`).map((b) => [b]));
  await expect.poll(() => page.evaluate(() => (window as any).qaIpc.clipboard)).toEqual([secret]);
  await expect(page.locator('#toast')).toContainText(`写入了剪贴板（${Buffer.byteLength(secret)} 字节）`);
  await expectOrderedAcks(s);
});

test('while one ACK is pending, later one-byte chunks are parsed but their ACKs wait and stay in order', async ({ page }) => {
  // The frontend never releases the backend budget early: the ACK chain is serial even though
  // parsing runs ahead (the 64-chunk / 64 KiB budget itself is enforced by the Rust side).
  const s = await Session.open(page, 'pty', { size: SIZE });
  await s.drained();
  const start = await s.sequence();
  await page.evaluate(() => { (window as any).qaIpc.holdAck = true; });
  const text = `${E}[1;31m中文${E}]0;标题${ST}${E}[0m 🌏 done`;
  const chunks = utf8(text).map((b) => [b]);
  await s.send(...chunks);
  const parsed = await s.snapshot();
  expect(parsed.rows[0]).toBe('中文 🌏 done');
  expect(parsed.titles).toBe('标题');
  expect((await s.acks()).slice(start)).toEqual([`pty_ack:${start + 1}`]);
  await page.evaluate(() => {
    const ipc = (window as any).qaIpc;
    ipc.holdAck = false;
    // Releasing the held ACK lets the chain continue; later ACKs resolve at once.
    for (const resolve of ipc.heldAcks.splice(0)) resolve(null);
  });
  await expectOrderedAcks(s);
  expect((await s.acks()).length - start).toBe(chunks.length);
});

test('replies to queries split before the native ID exists: adapter replies wait, built-in replies are dropped', async ({ page }) => {
  // Observed boundary of the early FIFO (session-lifecycle.ts): only replies sent through the VT
  // adapters are marked as terminal replies and kept until pty_open returns. xterm.js's own replies
  // (DSR 5, DECRQM, OSC 10/11 colour queries, DECRQSS r) are user-sourced to the lifecycle and are
  // not sent for a session without a native ID. After open both kinds are sent.
  const s = await Session.open(page, 'pty', {}, false);
  await s.start({ size: SIZE }, false);
  const queries = `${E}[6n${E}[c${E}[5n${E}]11;?\x07${E}[?2004$p${E}P$qr${ST}${E}P$qm${ST}`;
  await s.send(...utf8(queries).map((b) => [b]));
  expect(await s.writeCalls()).toEqual([]);
  await s.resolveOpen();
  await expect.poll(() => s.writeCalls()).toEqual([`${E}[1;1R`, `${E}[?1;2c`, `${E}P1$r0m${ST}`]);
  await s.mark();
  await s.send(queries);
  // Every reply xterm emitted for an open session reached pty_write, in order.
  await s.expectWritten(await page.evaluate(() => (window as any).qa.data.join('')));
  const after = (await s.written()).text;
  expect(after.startsWith(`${E}[1;1R${E}[?1;2c${E}[0n${E}]11;rgb:`)).toBe(true);
  expect(after.endsWith(`${E}[?2004;2$y${E}P1$r1;10r${ST}${E}P1$r0m${ST}`)).toBe(true);
  await expectOrderedAcks(s);
});

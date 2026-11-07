import { test, expect, type Page } from '@playwright/test';

// Q04/Q06 archive in isolation: a real xterm with a bounded hot scrollback, read
// through the terminal-core boundary into the compressed cold archive. The
// production capture path is covered by history-capture.spec.ts.
test.setTimeout(60_000);

async function harness(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { Terminal } = await import(/* @vite-ignore */ '/node_modules/@xterm/xterm/lib/xterm.mjs');
    const { HistoryArchive, stripSgr } = await import(/* @vite-ignore */ '/src/terminal-compat/history-archive.ts');
    const { xtermHistorySource } = await import(/* @vite-ignore */ '/src/terminal-core.ts');
    (window as any).historyQa = {
      make(cols: number, rows: number, scrollback: number, blockLines = 512, onBlock?: () => void) {
        const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
        const holder = document.createElement('div');
        document.body.append(holder);
        terminal.open(holder);
        const archive = new HistoryArchive(xtermHistorySource(terminal), blockLines, onBlock);
        const write = (data: string) => new Promise<void>(resolve => terminal.write(data, () => { archive.capture(); resolve(); }));
        return { terminal, archive, write };
      },
      stripSgr,
    };
  });
}

test('every scrolled-off line is archived exactly once, in order, with bounded hot scrollback', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { make } = (window as any).historyQa;
    const { terminal, archive, write } = make(80, 24, 1000);
    const total = 50_000;
    const lines = Array.from({ length: total }, (_, i) => `line ${String(i).padStart(6, '0')} 中文 🌏 payload-${(i * 7919) % 1000}`);
    // 4 KiB-ish chunks like PTY reads; chunk boundaries split lines and UTF-8.
    const stream = new TextEncoder().encode(lines.join('\r\n') + '\r\n');
    const started = performance.now();
    for (let offset = 0; offset < stream.length; offset += 4096) await write(stream.slice(offset, offset + 4096));
    const writeMs = performance.now() - started;
    // Control: the same stream into an identical terminal without capture.
    const control = new (terminal.constructor as any)({ cols: 80, rows: 24, scrollback: 1000 });
    const holder = document.createElement('div');
    document.body.append(holder);
    control.open(holder);
    const controlStarted = performance.now();
    for (let offset = 0; offset < stream.length; offset += 4096) {
      await new Promise<void>(resolve => control.write(stream.slice(offset, offset + 4096), resolve));
    }
    const controlMs = performance.now() - controlStarted;
    await archive.flush(true);
    const stats = archive.stats();
    const archived = (await archive.lines(0, total)).map((line: string) => (window as any).historyQa.stripSgr(line));
    const firstMismatch = archived.findIndex((line: string, index: number) => line !== lines[index]);
    return { stats, archivedCount: archived.length, firstMismatch, bufferLength: terminal.buffer.normal.length, rows: terminal.rows, writeMs: Math.round(writeMs), controlMs: Math.round(controlMs) };
  });
  console.log('history archive 50k lines', JSON.stringify(result));
  expect(result.stats.gaps).toBe(0);
  expect(result.firstMismatch).toBe(-1);
  // Only the lines still on screen (plus the cursor row) are not archived yet.
  expect(result.archivedCount).toBeGreaterThanOrEqual(50_000 - result.rows);
  expect(result.bufferLength).toBeLessThanOrEqual(1000 + result.rows);
  expect(result.stats.compressedBytes).toBeLessThan(result.stats.rawBytes / 4);
});

test('wrapped lines stay whole across reflow, and the alternate screen is never archived', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { make, stripSgr } = (window as any).historyQa;
    const { terminal, archive, write } = make(20, 5, 200);
    const long = (i: number) => `L${i}:` + 'abcdefghij'.repeat(4) + '末';
    await write(Array.from({ length: 30 }, (_, i) => long(i)).join('\r\n') + '\r\n');
    terminal.resize(13, 5); // reflow rewraps hot scrollback rows
    await write(Array.from({ length: 30 }, (_, i) => long(i + 30)).join('\r\n') + '\r\n');
    terminal.resize(31, 5);
    await write('\x1b[?1049h' + Array.from({ length: 40 }, (_, i) => `ALT${i}`).join('\r\n') + '\x1b[?1049l');
    await write(Array.from({ length: 30 }, (_, i) => long(i + 60)).join('\r\n') + '\r\n' + '\r\n'.repeat(5));
    await archive.flush(true);
    const archived = (await archive.lines(0, 1000)).map(stripSgr);
    return { archived, gaps: archive.stats().gaps, expected: Array.from({ length: 90 }, (_, i) => long(i)) };
  });
  expect(result.gaps).toBe(0);
  expect(result.archived.filter((line: string) => line.startsWith('ALT'))).toEqual([]);
  expect(result.archived.filter((line: string) => line !== '')).toEqual(result.expected);
});

test('attributes and wide characters survive the archive and rehydrate into a fresh xterm', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { make } = (window as any).historyQa;
    const source = make(40, 3, 100);
    await source.write('\x1b[1;31mbold red\x1b[0m plain \x1b[38;5;208m256\x1b[0m \x1b[38;2;10;20;30;48;2;200;100;50mrgb\x1b[0m 中文🌏\r\n\r\n\r\n\r\n');
    await source.archive.flush(true);
    const [line] = await source.archive.lines(0, 1);
    const target = make(40, 3, 100);
    await target.write(line);
    const cell = (term: any, x: number) => {
      const c = term.buffer.active.getLine(0).getCell(x);
      return { chars: c.getChars(), width: c.getWidth(), bold: !!c.isBold(), fg: c.getFgColor(), fgRGB: c.isFgRGB(), bg: c.getBgColor(), bgRGB: c.isBgRGB() };
    };
    const original = source.terminal.buffer.normal.getLine(source.terminal.buffer.normal.length - 7);
    return {
      text: target.terminal.buffer.active.getLine(0).translateToString(true),
      cells: [0, 9, 15, 19, 23, 25].map(x => cell(target.terminal, x)),
      originalText: original?.translateToString(true),
    };
  });
  expect(result.text).toBe('bold red plain 256 rgb 中文🌏');
  expect(result.cells[0]).toMatchObject({ chars: 'b', bold: true, fg: 1 });
  expect(result.cells[1]).toMatchObject({ chars: 'p', bold: false });
  expect(result.cells[2]).toMatchObject({ chars: '2', fg: 208 });
  expect(result.cells[3]).toMatchObject({ chars: 'r', fgRGB: true, fg: (10 << 16) | (20 << 8) | 30, bgRGB: true, bg: (200 << 16) | (100 << 8) | 50 });
  expect(result.cells[4]).toMatchObject({ chars: '中', width: 2 });
});

test('search spans compressed cold blocks and the pending block with absolute line numbers', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { make } = (window as any).historyQa;
    const { archive, write } = make(80, 10, 500, 256);
    const lines = Array.from({ length: 20_000 }, (_, i) => i === 123 ? 'needle-cold in block zero' : i === 19_950 ? '   needle-recent' : `filler ${i}`);
    const stream = lines.join('\r\n') + '\r\n';
    for (let offset = 0; offset < stream.length; offset += 4096) await write(stream.slice(offset, offset + 4096));
    await archive.flush();
    const started = performance.now();
    const cold = await archive.search('needle-cold');
    const recent = await archive.search('needle-recent');
    const missing = await archive.search('not-present-anywhere');
    return { cold, recent, missing, searchMs: Math.round(performance.now() - started), stats: archive.stats() };
  });
  console.log('history archive search', JSON.stringify({ searchMs: result.searchMs, stats: result.stats }));
  expect(result.cold).toEqual([{ line: 123, column: 0 }]);
  expect(result.recent).toEqual([{ line: 19_950, column: 3 }]);
  expect(result.missing).toEqual([]);
  expect(result.stats.blocks).toBeGreaterThan(70);
});

test('dropOldest removes whole blocks oldest first; reads, search and sizes stay consistent', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { make } = (window as any).historyQa;
    let added = 0;
    const { archive, write } = make(80, 10, 500, 64, () => added++);
    const stream = Array.from({ length: 1000 }, (_, i) => `row ${i}`).join('\r\n') + '\r\n';
    for (let offset = 0; offset < stream.length; offset += 4096) await write(stream.slice(offset, offset + 4096));
    await archive.flush();
    const before = archive.stats();
    const sizes = archive.blocks.map((block: any) => block.data.length);
    // Decoded blocks are cached; a dropped block must not be served from that cache.
    await archive.lines(0, 200);
    const first = archive.dropOldest();
    const second = archive.dropOldest();
    const after = archive.stats();
    const fromZero = await archive.lines(0, 200);
    const window64 = await archive.lines(128, 64);
    const droppedSearch = await archive.search('row 100');
    const keptSearch = await archive.search('row 130');
    const remainingBlocks = archive.stats().blocks;
    let all = 0;
    while (archive.dropOldest()) all++;
    const empty = archive.stats();
    const pendingOnly = await archive.lines(0, empty.archivedLines);
    return { added, before, sizes, first, second, after, fromZero, window64, droppedSearch, keptSearch, remainingBlocks, all, empty, pendingOnly, none: archive.dropOldest() ?? null };
  });
  const rows = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `row ${from + i}`);
  // 1000 lines on a 10-row screen: 991 left it, 15 blocks of 64 are sealed, 31 lines pending.
  expect(result.before).toMatchObject({ archivedLines: 991, blocks: 15, pendingLines: 31, droppedLines: 0, droppedBlocks: 0 });
  expect(result.added).toBe(15);
  expect(result.first).toEqual({ lines: 64, bytes: result.sizes[0] });
  expect(result.second).toEqual({ lines: 64, bytes: result.sizes[1] });
  expect(result.after).toMatchObject({ archivedLines: 991, blocks: 13, pendingLines: 31, droppedLines: 128, droppedBlocks: 2 });
  expect(result.after.compressedBytes).toBe(result.before.compressedBytes - result.sizes[0] - result.sizes[1]);
  expect(result.after.compressedBytes).toBe(result.sizes.slice(2).reduce((sum: number, size: number) => sum + size, 0));
  expect(result.after.rawBytes).toBeLessThan(result.before.rawBytes);
  // Line numbers do not move; dropped lines are simply absent.
  expect(result.fromZero).toEqual(rows(128, 200));
  expect(result.window64).toEqual(rows(128, 192));
  expect(result.droppedSearch).toEqual([]);
  expect(result.keptSearch).toEqual([{ line: 130, column: 0 }]);
  // Dropping everything leaves only the pending lines, which are never dropped.
  expect(result.all).toBe(13);
  expect(result.empty).toMatchObject({ blocks: 0, compressedBytes: 0, rawBytes: 0, droppedLines: 960, droppedBlocks: 15 });
  expect(result.pendingOnly).toEqual(rows(960, 991));
  expect(result.none).toBeNull();
});

test('an undersized hot scrollback is reported as a gap instead of silently losing lines', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { make } = (window as any).historyQa;
    const { archive, write } = make(40, 5, 10);
    await write('first\r\n');
    // One write adds far more rows than the 10-row hot scrollback holds.
    await write(Array.from({ length: 200 }, (_, i) => `burst ${i}`).join('\r\n') + '\r\n');
    await archive.flush(true);
    return archive.stats();
  });
  expect(result.gaps).toBe(1);
});

test('written trailing spaces are kept, never-written cells and wide-character wrap padding are not', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { make } = (window as any).historyQa;
    const { archive, write } = make(9, 3, 100);
    // 9 columns: "ab" + four wide characters fill 2 + 8 = 10 > 9 cells, so the fourth wraps and
    // leaves one padding cell; "x\x1b[5C" moves the cursor without writing.
    await write('tail   \r\nab中文字符\r\nx\x1b[5C\r\n\x1b[41mred\x1b[K\x1b[0m\r\n' + '\r\n'.repeat(4));
    await archive.flush(true);
    return archive.lines(0, 4);
  });
  expect(result).toEqual([
    'tail   ',
    'ab中文字符',
    'x',
    // A coloured erase to the end of the line is kept with its background.
    '\x1b[0;41mred      \x1b[0m',
  ]);
});

test('erasing or deleting rows on screen neither duplicates nor drops archived lines', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { make, stripSgr } = (window as any).historyQa;
    const lines = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name}${i}`).join('\r\n') + '\r\n';
    const { archive, write } = make(40, 5, 100);
    await write(lines('L', 20)); // L0..L15 leave the screen
    await write('\x1b[H\x1b[M'); // DL at the screen top deletes L16 there
    await write('\x1b[5;1H' + lines('N', 10));
    await write('\x1b[H\x1b[2J'); // Ctrl-L: erase the screen only
    await write(lines('P', 10) + '\r\n'.repeat(5));
    await archive.flush(true);
    const archived = (await archive.lines(0, 1000)).map(stripSgr).filter((line: string) => line !== '');
    return { archived, stats: archive.stats() };
  });
  const range = (name: string, from: number, to: number) => Array.from({ length: to - from }, (_, i) => `${name}${from + i}`);
  // L16 was deleted and N6..N9 erased while on screen, as in the terminal itself.
  expect(result.archived).toEqual([...range('L', 0, 16), ...range('L', 17, 20), ...range('N', 0, 6), ...range('P', 0, 10)]);
  expect(result.stats.gaps).toBe(0);
});

test('a taller screen erased over archived rows reports a gap instead of archiving them twice', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { make, stripSgr } = (window as any).historyQa;
    const lines = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name}${i}`).join('\r\n') + '\r\n';
    const { terminal, archive, write } = make(40, 5, 100);
    await write(lines('L', 20));
    terminal.resize(40, 15); // pulls archived rows back on screen
    await write('\x1b[H\x1b[2J'); // and erases them together with the archive's marker
    await write(lines('M', 30) + '\r\n'.repeat(15));
    await archive.flush(true);
    const archived = (await archive.lines(0, 1000)).map(stripSgr).filter((line: string) => line !== '');
    return { archived, stats: archive.stats() };
  });
  // The resume position is unknown once the marker is erased: no line is archived twice and the
  // possible hole is reported. Here nothing was actually lost (L16..L19 were erased on screen).
  expect(new Set(result.archived).size).toBe(result.archived.length);
  expect(result.archived.slice(0, 16)).toEqual(Array.from({ length: 16 }, (_, i) => `L${i}`));
  expect(result.archived.slice(16)).toEqual(Array.from({ length: 30 }, (_, i) => `M${i}`));
  expect(result.stats.gaps).toBe(1);
});

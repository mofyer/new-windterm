import { test, expect, type Page } from '@playwright/test';

// Isolated Q04/Q06 experiment: a real xterm with a bounded hot scrollback and
// the compressed cold archive. Not wired into production terminals.
test.setTimeout(60_000);

async function harness(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { Terminal } = await import(/* @vite-ignore */ '/node_modules/@xterm/xterm/lib/xterm.mjs');
    const { HistoryArchive, stripSgr } = await import(/* @vite-ignore */ '/src/terminal-compat/history-archive.ts');
    (window as any).historyQa = {
      make(cols: number, rows: number, scrollback: number, blockLines = 512) {
        const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
        const holder = document.createElement('div');
        document.body.append(holder);
        terminal.open(holder);
        const archive = new HistoryArchive(terminal, blockLines);
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

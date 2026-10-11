import { test, expect, type Page } from '@playwright/test';

// Isolated G16/G17 experiment: folding, outline, copy and search on a
// read-only history view rendered from logical lines. Not production UI.
async function harness(page: Page) {
  await page.goto('/');
  await page.evaluate(async () => {
    const { Terminal } = await import(/* @vite-ignore */ '/node_modules/@xterm/xterm/lib/xterm.mjs');
    const { FoldView } = await import(/* @vite-ignore */ '/src/terminal-compat/fold-view.ts');
    const { HistoryArchive } = await import(/* @vite-ignore */ '/src/terminal-compat/history-archive.ts');
    const terminal = (cols: number, rows: number, scrollback: number) => {
      const t = new Terminal({ cols, rows, scrollback, allowProposedApi: true, disableStdin: true });
      const holder = document.createElement('div');
      document.body.append(holder);
      t.open(holder);
      return t;
    };
    (window as any).foldQa = { Terminal, FoldView, HistoryArchive, terminal };
  });
}

const session = () => {
  const lines: string[] = [];
  for (const [command, count] of [['ls -la', 120], ['make test', 300], ['git status', 20]] as const) {
    lines.push(`\x1b[32mP0 $\x1b[0m ${command}`);
    for (let i = 0; i < count; i++) lines.push(`${command} output ${i}${i === 150 && command === 'make test' ? ' needle-in-fold' : ''}`);
  }
  return lines;
};

test('outline sections fold to one summary row and copy expands the folded output', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async lines => {
    const { FoldView, terminal } = (window as any).foldQa;
    const view = terminal(80, 20, 2000);
    const folds = new FoldView(view, lines);
    const outline = folds.outline(/^P0 \$/);
    for (const item of outline) folds.fold(item.line + 1, item.end);
    await folds.render();
    const rows = Array.from({ length: 8 }, (_, row) => view.buffer.active.getLine(row).translateToString(true));
    const summaryRow = folds.rowOf(outline[1].line + 1);
    view.selectLines(summaryRow - 1, summaryRow);
    const copied = folds.copySelection().split('\n');
    return { outline, rows, copiedLength: copied.length, copiedFirst: copied[0], copiedLast: copied[copied.length - 1] };
  }, session());
  expect(result.outline.map((item: any) => [item.line, item.title, item.end])).toEqual([
    [0, 'P0 $ ls -la', 120], [121, 'P0 $ make test', 421], [422, 'P0 $ git status', 442],
  ]);
  expect(result.rows.slice(0, 6)).toEqual([
    'P0 $ ls -la', '▸ ls -la output 0 … (120 行已折叠)',
    'P0 $ make test', '▸ make test output 0 … (300 行已折叠)',
    'P0 $ git status', '▸ git status output 0 … (20 行已折叠)',
  ]);
  expect(result.copiedLength).toBe(301);
  expect(result.copiedFirst).toBe('P0 $ make test');
  expect(result.copiedLast).toBe('make test output 299');
});

test('search inside a fold expands only that fold and selects the match', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async lines => {
    const { FoldView, terminal } = (window as any).foldQa;
    const view = terminal(80, 20, 2000);
    const folds = new FoldView(view, lines);
    for (const item of folds.outline(/^P0 \$/)) folds.fold(item.line + 1, item.end);
    await folds.render();
    const line = await folds.find('needle-in-fold');
    return { line, selection: view.getSelection(), remaining: folds.foldedRanges(), missing: await folds.find('absent-text') };
  }, session());
  expect(result.line).toBe(272);
  expect(result.selection).toBe('needle-in-fold');
  expect(result.remaining).toEqual([{ start: 1, end: 120 }, { start: 423, end: 442 }]);
  expect(result.missing).toBe(-1);
});

test('row mapping survives reflow of wrapped lines', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async () => {
    const { FoldView, terminal } = (window as any).foldQa;
    const lines = Array.from({ length: 60 }, (_, i) => `line-${i}:` + 'x'.repeat(i % 3 === 0 ? 70 : 5));
    const view = terminal(30, 10, 500);
    const folds = new FoldView(view, lines);
    folds.fold(10, 29);
    await folds.render();
    const before = folds.rowOf(45);
    view.resize(17, 10);
    const after = folds.rowOf(45);
    const startsWith = view.buffer.active.getLine(after).translateToString(true).slice(0, 8);
    view.selectLines(folds.rowOf(9), folds.rowOf(30));
    const lines30 = folds.linesForRows(folds.rowOf(9), folds.rowOf(30));
    return { before, after, startsWith, lines30: [lines30[0], lines30.length, lines30[lines30.length - 1]], copied: folds.copySelection().split('\n').length };
  });
  expect(result.after).toBeGreaterThan(result.before);
  expect(result.startsWith).toBe('line-45:');
  expect(result.lines30).toEqual([9, 22, 30]);
  expect(result.copied).toBe(22);
});

test('folding works on lines read back from the compressed archive', async ({ page }) => {
  await harness(page);
  const result = await page.evaluate(async lines => {
    const { FoldView, HistoryArchive, terminal } = (window as any).foldQa;
    const live = terminal(80, 10, 1000);
    const archive = new HistoryArchive(live, 64);
    const stream = lines.join('\r\n') + '\r\n' + '\r\n'.repeat(12);
    for (let offset = 0; offset < stream.length; offset += 4096) {
      await new Promise<void>(resolve => live.write(stream.slice(offset, offset + 4096), () => { archive.capture(); resolve(); }));
    }
    await archive.flush(true);
    const archived = await archive.lines(0, lines.length);
    const view = terminal(80, 20, 2000);
    const folds = new FoldView(view, archived);
    for (const item of folds.outline(/^P0 \$/)) folds.fold(item.line + 1, item.end);
    await folds.render();
    const prompt = view.buffer.active.getLine(0).getCell(0);
    return { count: archived.length, blocks: archive.stats().blocks, found: await folds.find('needle-in-fold'), promptGreen: prompt.getFgColor(), selection: view.getSelection() };
  }, session());
  expect(result.count).toBe(443);
  expect(result.blocks).toBeGreaterThan(5);
  expect(result.found).toBe(272);
  expect(result.selection).toBe('needle-in-fold');
  expect(result.promptGreen).toBe(2);
});

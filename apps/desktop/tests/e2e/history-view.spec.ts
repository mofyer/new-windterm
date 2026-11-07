import { test, expect, type Page } from '@playwright/test';
import { installModules, liveArchives, liveViews, onLive, record } from './support/history-harness';
import { currentLine, openLocal, openView, plainLines, status, stream, view } from './support/history-view-harness';

// P1 slice 5, step 7: read-only history view and search (docs/p1/HISTORY_VIEW_PLAN.zh-CN.md).
// Bytes go from an in-page Tauri IPC stub through the real `Channel` index/end protocol,
// session-lifecycle.ts (Utf8Boundary, ordered ACK) and the workbench xterm into each session's
// archive; the view is opened from the tool bar or the command palette and read through its DOM.
//
// Environment: Chrome + Vite dev server + IPC stub. This is NOT WKWebView, WebView2, WebKitGTK,
// Tauri IPC or a Rust PTY; timings are observations of one Chrome renderer, not limits.
test.setTimeout(120_000);

interface SweepRow { row: number; line?: number; gutter?: string; text: string; mark?: string }
/** Scrolls the view from the top to the bottom and returns every row once, in order. */
async function sweep(page: Page): Promise<SweepRow[]> {
  return page.evaluate(async () => {
    const list = document.querySelector<HTMLElement>('.terminal-pane:not([hidden]) .history-list')!;
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const rows = new Map<number, any>();
    const total = Number(list.querySelector('.history-row')!.getAttribute('aria-setsize'));
    const step = Math.max(1, Math.floor(list.clientHeight / 20) - 2);
    for (let row = 0; row < total; row += step) {
      list.scrollTop = row * 20;
      for (let tries = 0; ; tries++) {
        await frame();
        const nodes = [...list.querySelectorAll<HTMLElement>('.history-row')];
        const at = new Set(nodes.map((n) => Number(n.getAttribute('aria-posinset')) - 1));
        // Both ends of this step are drawn, so the rows are from this scroll position, not the last.
        const covers = at.has(row) && at.has(Math.min(total - 1, row + step));
        if (covers && !nodes.some((n) => n.getAttribute('aria-busy'))) break;
        if (tries > 200) throw new Error(`row ${row} not drawn`);
      }
      for (const node of list.querySelectorAll<HTMLElement>('.history-row')) {
        const index = Number(node.getAttribute('aria-posinset')) - 1;
        rows.set(index, {
          row: index,
          line: node.dataset.line === undefined ? undefined : Number(node.dataset.line),
          gutter: node.dataset.line === undefined ? undefined : node.querySelector('.history-gutter')!.textContent,
          text: node.querySelector('.history-text')!.textContent,
          mark: node.dataset.mark,
        });
      }
    }
    return [...rows.values()].sort((a, b) => a.row - b.row);
  });
}

const lineRows = (rows: SweepRow[]) => rows.filter((row) => row.line !== undefined);

test('the view lists every line past the 5,000-line hot window, numbered without a jump into the screen', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  const { cdp, id } = await openLocal(page);
  const total = 12_000;
  await stream(page, id, `return ipc.stream(id, qa.encode(Array.from({ length: ${total} }, (_, i) => qa.line(i).raw)));`);
  const hot = await onLive<{ length: number; rows: number; onScreen: number }>(cdp, 'terminalPrototype', `function () {
    const t = this.find(t => t.element && t.element.closest('.terminal-pane[aria-label^="Local"]'));
    const b = t.buffer.normal;
    // Logical lines with a row on screen: the ones not archived yet.
    let start = b.baseY;
    while (start > 0 && b.getLine(start).isWrapped) start--;
    let onScreen = 0;
    for (let row = start; row <= b.baseY + b.cursorY; row++) if (!b.getLine(row).isWrapped) onScreen++;
    return { length: b.length, rows: t.rows, onScreen };
  }`);
  expect(hot.length).toBe(hot.rows + 5000);
  const opened = Date.now();
  await openView(page);
  await expect(view(page).locator('.history-row').first()).toBeVisible();
  const openMs = Date.now() - opened;
  // Virtualised: a few dozen rows exist, not 12,000.
  const drawn = await view(page).locator('.history-row').count();
  expect(drawn).toBeLessThan(200);
  await expect(view(page).locator('.history-summary')).toHaveText(`第 1–${(total + 1).toLocaleString()} 行 · 共 ${(total + 1).toLocaleString()} 行`);
  const rows = await sweep(page);
  const lines = lineRows(rows);
  const expected = [...await plainLines(page, 0, total), ''];
  expect(lines.length).toBe(total + 1);
  expect(lines.map((row) => row.line)).toEqual(Array.from({ length: total + 1 }, (_, i) => i));
  expect(lines.map((row) => row.gutter)).toEqual(Array.from({ length: total + 1 }, (_, i) => String(i + 1)));
  const firstMismatch = expected.findIndex((text, i) => lines[i].text !== text);
  expect(firstMismatch).toBe(-1);
  // The only mark is the boundary to the screen: the lines not archived yet are the visible rows.
  const marks = rows.filter((row) => row.mark);
  expect(marks.map((row) => row.mark)).toEqual(['screen']);
  const screenStart = rows[marks[0].row + 1].line!;
  expect(total + 1 - screenStart).toBe(hot.onScreen);
  // Colours: line 1 is bold red (bright, as xterm draws bold), then an RGB run.
  await view(page).locator('.history-list').evaluate((list) => { list.scrollTop = 0; });
  const lineOne = view(page).locator('.history-row[data-line="1"]');
  await expect(lineOne).toHaveAttribute('aria-label', '第 2 行 000001 red plain rgb');
  const coloured = await lineOne.evaluate((row) => [...row.querySelectorAll<HTMLElement>('.history-text span')].map((span) => ({
    text: span.textContent, bold: span.classList.contains('sgr-bold'), color: span.style.color,
  })));
  expect(coloured).toEqual([
    { text: '000001 red', bold: true, color: 'var(--history-ansi-9)' },
    { text: ' plain ', bold: false, color: '' },
    { text: 'rgb', bold: false, color: 'rgb(10, 20, 30)' },
  ]);
  await record(testInfo, 'history-view-open', { lines: total + 1, drawnRows: drawn, openMs });
});

test('a gap and a host reset are marked where they happened; the lines on either side stay whole and in order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1600 });
  const { id } = await openLocal(page);
  await stream(page, id, `
    const named = (name) => Array.from({ length: 100 }, (_, i) => name + ' ' + i);
    const push = Array(80).fill('');
    ipc.stream(id, qa.encode([...named('before'), ...push]));
    // REP: a few bytes become one logical line longer than the hot window, so its start is lost.
    ipc.stream(id, bytes('x\\x1b[999999b\\r\\n'));
    ipc.stream(id, qa.encode([...named('mid'), ...push]));
    ipc.stream(id, bytes('\\x1b[H\\x1b[2J\\x1b[3J'));               // clear: screen and scrollback
    return ipc.stream(id, qa.encode(named('after')));`);
  await openView(page);
  const rows = await sweep(page);
  const marks = rows.filter((row) => row.mark);
  expect(marks.map((row) => row.mark)).toEqual(['gap', 'clear', 'screen']);
  expect(marks[0].text).toBe('此处有缺口：部分输出在保存进历史之前已被终端裁掉');
  expect(marks[1].text).toBe('此处终端被复位或清除了回滚；以上各行只保留在历史中');
  const rowOf = (text: string) => rows.findIndex((row) => row.text === text);
  const named = rows.filter((row) => /^(before|mid|after) \d+$/.test(row.text)).map((row) => row.text);
  expect(named).toEqual(['before', 'mid', 'after'].flatMap((name) => Array.from({ length: 100 }, (_, i) => `${name} ${i}`)));
  expect(rowOf('before 99')).toBeLessThan(marks[0].row);
  // What is left of the long line comes right after the gap, cut to the drawing limit.
  expect(rows[marks[0].row + 1].text).toMatch(/^x{2000}…（本行共 [\d,]+ 个字符）$/);
  expect(marks[0].row).toBeLessThan(rowOf('mid 0'));
  expect(rowOf('mid 99')).toBeLessThan(marks[1].row);
  expect(marks[1].row).toBeLessThan(rowOf('after 0'));
  // Line numbers run on through the marks.
  const numbered = lineRows(rows);
  expect(numbered.every((row, i) => row.line === numbered[0].line! + i && row.gutter === String(row.line! + 1))).toBe(true);
});

test('lines dropped by the budget and a user clear are shown where the history starts', async ({ page }) => {
  // Development-only query: a 16 KiB session budget drops the oldest blocks quickly.
  const { cdp, id } = await openLocal(page, '?p0HistoryBudget=sessionBytes:16384');
  const total = 12_000;
  await stream(page, id, `return ipc.stream(id, qa.encode(Array.from({ length: ${total} }, (_, i) => qa.line(i).raw)));`);
  const dropped = await onLive<number>(cdp, 'archivePrototype', 'function () { return this[0].stats().droppedLines; }');
  expect(dropped).toBeGreaterThan(0);
  expect(dropped % 512).toBe(0);
  await openView(page);
  const v = view(page);
  await expect(v.locator('.history-notice')).toContainText(`最早的 ${dropped.toLocaleString()} 行已不在历史中：${dropped.toLocaleString()} 行超出历史预算已丢弃`);
  await v.locator('.history-list').focus();
  await page.keyboard.press('Home');
  await expect(v.locator('.history-row[data-mark="unavailable"]')).toHaveText(`第 1–${dropped.toLocaleString()} 行已因超出历史预算丢弃`);
  const first = v.locator(`.history-row[data-line="${dropped}"]`);
  await expect(first.locator('.history-gutter')).toHaveText(String(dropped + 1));
  await expect(first.locator('.history-text')).toHaveText((await plainLines(page, dropped, dropped + 1))[0]);
  await expect(first).toHaveClass(/active/);
  // The user's 清除回滚 (T32) while the view is open: it takes a new snapshot by itself.
  await page.locator('#terminal-actions-open').click();
  await page.getByRole('menuitem', { name: '清除回滚' }).click();
  await expect(page.locator('#toast')).toContainText('的历史已清除，历史视图已刷新');
  // Focus went back to the view, not to the terminal under it.
  await expect(v.locator('.history-search')).toBeFocused();
  const cleared = await onLive<number>(cdp, 'archivePrototype', 'function () { return this[0].stats().clearedLines; }');
  const gone = dropped + cleared;
  await expect(v.locator('.history-notice')).toContainText(
    `最早的 ${gone.toLocaleString()} 行已不在历史中：${dropped.toLocaleString()} 行超出历史预算已丢弃，${cleared.toLocaleString()} 行已由清除回滚删除`);
  await v.locator('.history-list').focus();
  await page.keyboard.press('Home');
  await expect(v.locator('.history-row[data-mark="unavailable"]')).toHaveText(`第 1–${gone.toLocaleString()} 行已不在历史中（已丢弃或已清除）`);
  // What remains is the screen, numbered on from the cleared lines.
  await expect(v.locator('.history-row[data-mark="screen"]')).toHaveCount(1);
  await expect(v.locator(`.history-row[data-line="${gone}"] .history-gutter`)).toHaveText(String(gone + 1));
});

test('search: case, counts, wide text, matches across soft wraps, the newest-first limit and jumping', async ({ page }, testInfo) => {
  const { id } = await openLocal(page);
  const total = 12_000;
  const needle = (i: number) => (['Needle', 'needle', 'NEEDLE'] as const)[i % 3];
  await stream(page, id, `
    const lines = Array.from({ length: ${total} }, (_, i) => (i % 1000 === 999 ? ['Needle', 'needle', 'NEEDLE'][((i + 1) / 1000 - 1) % 3] + ' at ' + i : qa.line(i).raw));
    return ipc.stream(id, qa.encode(lines));`);
  const needles = Array.from({ length: 12 }, (_, k) => ({ line: k * 1000 + 999, word: needle(k) }));
  await openView(page);
  const input = view(page).locator('.history-search');
  const started = Date.now();
  await input.fill('needle');
  await input.press('Enter');
  await expect(status(page)).toHaveText('第 12 处，共 12 处');
  const searchMs = Date.now() - started;
  // The view opened at the newest line: the first match is the newest, centred and highlighted.
  await expect.poll(() => currentLine(page)).toBe(11_999);
  await expect(view(page).locator('.history-match-current')).toHaveText(needle(11));
  await expect(view(page).locator('.history-match-current')).toBeInViewport();
  // Enter continues upward (older), Shift+Enter downward; both wrap around.
  await input.press('Enter');
  await expect(status(page)).toHaveText('第 11 处，共 12 处');
  await expect.poll(() => currentLine(page)).toBe(10_999);
  await input.press('Shift+Enter');
  await input.press('Shift+Enter');
  await expect(status(page)).toHaveText('第 1 处，共 12 处');
  await expect.poll(() => currentLine(page)).toBe(999);
  await expect(view(page).locator('.history-match-current')).toBeInViewport();
  await view(page).getByRole('button', { name: '下一处' }).click();
  await expect(status(page)).toHaveText('第 2 处，共 12 处');
  await expect.poll(() => currentLine(page)).toBe(1999);
  // Another tab and back: the view is still open, at the same place, and takes the focus.
  await page.getByRole('tab', { name: /Getting started/ }).click();
  await expect(view(page)).toHaveCount(0);
  await expect(page.locator('#history-view-toggle')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('tab', { name: /Local/ }).click();
  await expect(input).toBeFocused();
  await expect(page.locator('#history-view-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(view(page).locator('.history-match-current')).toBeInViewport();
  // Case-sensitive: only the lowercase needles (1,999, 4,999, 7,999, 10,999). A new search starts
  // at the nearest match at or above the bottom of the view, which shows line 1,999 now.
  await view(page).getByRole('button', { name: '区分大小写' }).click();
  await expect(view(page).getByRole('button', { name: '区分大小写' })).toHaveAttribute('aria-pressed', 'true');
  expect(needles.filter((n) => n.word === 'needle').map((n) => n.line)).toEqual([1999, 4999, 7999, 10999]);
  await expect(status(page)).toHaveText('第 1 处，共 4 处');
  await expect.poll(() => currentLine(page)).toBe(1999);
  await input.press('Enter');
  await expect(status(page)).toHaveText('第 4 处，共 4 处');
  await expect.poll(() => currentLine(page)).toBe(10_999);
  // Wide characters and emoji are matched as text.
  const expected = (await plainLines(page, 0, total)).map((text, i) => (i % 1000 === 999 ? '' : text));
  const count = (query: string) => expected.reduce((sum, text) => sum + text.split(query).length - 1, 0);
  await input.fill('宽字符 🌏');
  await input.press('Enter');
  await expect(status(page)).toHaveText(new RegExp(`共 ${count('宽字符 🌏').toLocaleString()} 处$`));
  // 'defghijab' occurs 24 times in each long line, two of them across the terminal's soft
  // wraps (the archive joins wrapped rows): 41k matches, so the limit keeps the newest 10,000.
  const wrapped = count('defghijab');
  expect(wrapped).toBeGreaterThan(10_000);
  await view(page).getByRole('button', { name: '区分大小写' }).click();
  // From the newest line, so the first match shown is the newest.
  await view(page).locator('.history-list').focus();
  await page.keyboard.press('End');
  await input.fill('defghijab');
  await input.press('Enter');
  await expect(status(page)).toHaveText('第 10,000 处，共 10,000 处（已达上限，只列出最新的 10,000 处）');
  const longLines = expected.map((text, i) => (text.includes('defghijab') ? i : -1)).filter((i) => i >= 0);
  await expect.poll(() => currentLine(page)).toBe(longLines.at(-1));
  // The oldest kept match is in the 417th newest long line: 416 × 24 + 16 = 10,000.
  await input.press('Shift+Enter');
  await expect(status(page)).toHaveText(/^第 1 处，共 10,000 处/);
  await expect.poll(() => currentLine(page)).toBe(longLines.at(-417));
  // No match.
  await input.fill('no such text');
  await input.press('Enter');
  await expect(status(page)).toHaveText('没有找到');
  await expect(view(page).getByRole('button', { name: '上一处' })).toBeDisabled();
  await record(testInfo, 'history-view-search', { lines: total + 1, needleSearchMs: searchMs, wrappedMatches: wrapped });
});

test('a long search can be stopped, a new query replaces a running one, and output keeps flowing meanwhile', async ({ page }, testInfo) => {
  const { id } = await openLocal(page);
  const total = 300_000;
  // The three needles are the oldest lines: a search reaches them last.
  await stream(page, id, `return ipc.stream(id, qa.encode([...['needle 0', 'needle 1', 'needle 2'], ...Array(${total}).fill('y')]));`);
  await openView(page);
  const run = (query: string, stop: boolean) => view(page).locator('.history-search').evaluate((input: HTMLInputElement, [query, stop]) => {
    input.value = query as string;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    // Same task: the search has scanned at most the screen lines before this click.
    if (stop) [...input.closest('.history-view')!.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '停止')!.click();
  }, [query, stop] as const);
  await run('needle', true);
  await expect(status(page)).toHaveText('已停止：已找到 0 处（未搜索完）');
  await page.waitForTimeout(500);
  await expect(status(page)).toHaveText('已停止：已找到 0 处（未搜索完）');
  await expect(view(page).getByRole('button', { name: '停止' })).toBeHidden();
  // Enter on a stopped search starts it again; meanwhile the session's output is parsed and ACKed.
  const started = Date.now();
  await run('needle', false);
  await stream(page, id, `return ipc.stream(id, qa.encode(Array.from({ length: 2000 }, (_, i) => 'during ' + i)));`);
  await expect(status(page)).toHaveText('第 3 处，共 3 处', { timeout: 30_000 });
  const fullMs = Date.now() - started;
  await expect.poll(() => currentLine(page)).toBe(2);
  // The view keeps its snapshot and says there is more.
  await expect(view(page).locator('.history-notice')).toContainText('打开后有新输出');
  // A new query replaces a running one: only its result is shown.
  await run('zzz', false);
  await run('needle 1', false);
  await expect(status(page)).toHaveText('第 1 处，共 1 处', { timeout: 30_000 });
  await expect.poll(() => currentLine(page)).toBe(1);
  await record(testInfo, 'history-view-long-search', { lines: total + 3, fullSearchMs: fullMs });
});

test('selected lines are copied whole, from the cold archive and the screen', async ({ page }) => {
  // The view writes with navigator.clipboard.writeText. It is recorded here instead of reaching the
  // browser's clipboard, which other tests in the same worker paste from (Shift+Insert).
  await page.addInitScript(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => { (window as any).copiedText = text; },
    });
  });
  const { id } = await openLocal(page);
  const total = 12_000;
  await stream(page, id, `return ipc.stream(id, qa.encode(Array.from({ length: ${total} }, (_, i) => qa.line(i).raw)));`);
  await openView(page);
  const list = view(page).locator('.history-list');
  const clipboard = () => page.evaluate(() => (window as any).copiedText as string);
  // Keyboard: Home is the oldest line, in the cold archive.
  await list.focus();
  await page.keyboard.press('Home');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowDown');
  await expect(view(page).locator('.history-row.selected')).toHaveCount(4);
  await page.keyboard.press('ControlOrMeta+C');
  await expect(page.locator('#toast')).toHaveText('已复制 4 行。');
  expect(await clipboard()).toBe((await plainLines(page, 0, 4)).join('\n'));
  // Mouse: click one row and shift-click another near the end; the last line is on screen.
  await page.keyboard.press('End');
  const last = total; // the cursor row
  await view(page).locator(`.history-row[data-line="${last - 5}"]`).click();
  await view(page).locator(`.history-row[data-line="${last}"]`).click({ modifiers: ['Shift'] });
  await view(page).getByRole('button', { name: '复制所选行' }).click();
  await expect(page.locator('#toast')).toHaveText('已复制 6 行。');
  expect(await clipboard()).toBe([...(await plainLines(page, last - 5, last)), ''].join('\n'));
  // Everything: 12,001 lines, within the copy limit.
  await list.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  await expect(page.locator('#toast')).toHaveText('已复制 12,001 行。');
  expect(await clipboard()).toBe([...(await plainLines(page, 0, total)), ''].join('\n'));
});

test('Esc returns focus to the terminal, which the view never changed; input and ACKs are not held up', async ({ page }) => {
  const { cdp, id } = await openLocal(page);
  await stream(page, id, `return ipc.stream(id, qa.encode(Array.from({ length: 8000 }, (_, i) => qa.line(i).raw)));`);
  const terminalState = () => onLive<Record<string, unknown>>(cdp, 'terminalPrototype', `function () {
    const t = this.find(t => t.element && t.element.closest('.terminal-pane[aria-label^="Local"]'));
    const b = t.buffer.normal;
    const rows = [];
    for (let r = 0; r < b.length; r++) rows.push(b.getLine(r).translateToString(false) + (b.getLine(r).isWrapped ? '~' : ''));
    return { rows: rows.join('\\n'), cursor: [b.cursorX, b.cursorY], baseY: b.baseY, viewportY: b.viewportY, active: t.buffer.active.type,
      modes: JSON.stringify(t.modes), selection: t.getSelection(), inert: t.element.inert };
  }`);
  const before = await terminalState();
  await openView(page);
  expect((await terminalState()).inert).toBe(true);
  // Keys in the view stay in the view.
  const input = view(page).locator('.history-search');
  await input.fill('red');
  await input.press('Enter');
  await expect(status(page)).toHaveText(/共 1,143 处/);
  await view(page).locator('.history-list').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('PageDown');
  await page.keyboard.type('abc');
  expect(await page.evaluate(() => (window as any).viewIpc.writes.length)).toBe(0);
  // Nothing about the terminal changed.
  expect({ ...(await terminalState()), inert: false }).toEqual({ ...before, inert: false });
  // Output while the view is open is parsed and ACKed as usual.
  await stream(page, id, `return ipc.stream(id, qa.encode(Array.from({ length: 2000 }, (_, i) => 'while open ' + i)));`);
  await expect(view(page).locator('.history-notice')).toContainText('打开后有新输出');
  await page.keyboard.press('Escape');
  await expect(page.locator('.history-view')).toHaveCount(0);
  await expect(page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea')).toBeFocused();
  await expect(page.locator('#history-view-toggle')).toHaveAttribute('aria-pressed', 'false');
  // A closed view is not kept by the still open session either.
  await expect.poll(() => liveViews(cdp), { timeout: 5_000 }).toBe(0); // pending async work may hold it briefly
  const after = await terminalState();
  expect(after.inert).toBe(false);
  expect(after.viewportY).toBe(after.baseY);
  expect(after.rows).toContain('while open 1999');
  // The terminal equals one fed the same bytes without a view.
  const same = await onLive<boolean>(cdp, 'terminalPrototype', `async function () {
    const t = this.find(t => t.element && t.element.closest('.terminal-pane[aria-label^="Local"]'));
    const ipc = window.viewIpc;
    const s = ipc.sessions.get(${JSON.stringify(id)});
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:600px';
    document.body.append(holder);
    const { terminal } = window.captureQa.createWorkspaceSession();
    terminal.open(holder);
    terminal.resize(t.cols, t.rows);
    for (const bytes of s.sent) await new Promise((resolve) => terminal.write(bytes, resolve));
    const dump = (x) => { const b = x.buffer.normal; const rows = []; for (let r = 0; r < b.length; r++) rows.push(b.getLine(r).translateToString(false)); return rows.join('\\n') + JSON.stringify(x.modes) + b.cursorX + ',' + b.cursorY; };
    const same = dump(terminal) === dump(t);
    terminal.dispose();
    holder.remove();
    return same;
  }`);
  expect(same).toBe(true);
  // Typing now reaches the terminal again.
  await page.keyboard.type('z');
  await expect.poll(() => page.evaluate(() => (window as any).viewIpc.writes.flat())).toEqual([122]);
});

test('closing the tab disposes the view with its running search, snapshot and caches (R2)', async ({ page }) => {
  const { cdp, id } = await openLocal(page);
  await stream(page, id, `return ipc.stream(id, qa.encode([...['needle 0'], ...Array(200000).fill('y')]));`);
  await openView(page);
  expect(await liveViews(cdp)).toBe(1);
  await onLive(cdp, 'viewPrototype', 'function () { window.captureQa.weakView = new WeakRef(this[0]); }');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Start a search and close the tab in the same task: the search is still running then.
  const running = await view(page).locator('.history-search').evaluate((input: HTMLInputElement) => {
    input.value = 'needle';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const stop = [...document.querySelectorAll<HTMLButtonElement>('.history-view button')].find((b) => b.textContent === '停止')!;
    const wasRunning = !stop.hidden;
    document.querySelector<HTMLButtonElement>('button[aria-label^="关闭 Local"]')!.click();
    return wasRunning;
  });
  expect(running).toBe(true);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.locator('.history-view')).toHaveCount(0);
  await expect(page.locator('#history-view-toggle')).toHaveAttribute('aria-pressed', 'false');
  // Let the aborted search reach its next check, then collect.
  await page.waitForTimeout(200);
  await expect.poll(() => liveViews(cdp), { timeout: 5_000 }).toBe(0); // pending async work may hold it briefly
  expect(await liveArchives(cdp)).toBe(0);
  expect(await page.evaluate(() => (window as any).captureQa.weakView.deref() === undefined)).toBe(true);
  expect(errors).toEqual([]);
});

test('terminal output that looks like HTML is shown and searched as plain text', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { id } = await openLocal(page);
  const hostile = [
    '<img src=x onerror="window.__historyXss=1">',
    '<script>window.__historyXss=2</script>',
    '<b>bold?</b> &lt;not an entity&gt; <a href="javascript:alert(1)">link</a>',
    '<svg onload="window.__historyXss=3"></svg>',
  ];
  await stream(page, id, `return ipc.stream(id, qa.encode([...${JSON.stringify(hostile)}, ...Array(6000).fill('filler')]));`);
  await openView(page);
  await view(page).locator('.history-list').focus();
  await page.keyboard.press('Home');
  for (const [line, text] of hostile.entries()) {
    await expect(view(page).locator(`.history-row[data-line="${line}"] .history-text`)).toHaveText(text);
  }
  const input = view(page).locator('.history-search');
  await input.fill('<img');
  await input.press('Enter');
  await expect(status(page)).toHaveText('第 1 处，共 1 处');
  await expect(view(page).locator('.history-match-current')).toHaveText('<img');
  expect(await page.locator('.history-view img, .history-view script, .history-view b, .history-view a, .history-view svg:not(button svg)').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).__historyXss)).toBeUndefined();
  expect(errors).toEqual([]);
});

test('a demo session opened from the command palette shows its terminal buffer; the tool bar button closes it', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await installModules(page);
  const cdp = await page.context().newCDPSession(page);
  // The demo terminal's own logical lines, read with xterm's public API.
  const readBuffer = () => onLive<string[]>(cdp, 'terminalPrototype', `function () {
    const t = this.find(t => t.element && t.element.closest('.terminal-pane:not([hidden])'));
    const b = t.buffer.normal;
    const lines = [];
    for (let r = 0; r <= b.baseY + b.cursorY; r++) {
      const text = b.getLine(r).translateToString(true);
      if (b.getLine(r).isWrapped) lines[lines.length - 1] += text; else lines.push(text);
    }
    return lines;
  }`);
  await page.locator('#sample-run').click();
  // The sample is written in several pieces; the view's snapshot is taken after the last one.
  await expect.poll(async () => (await readBuffer()).slice(-2).map((line) => line.trimEnd())).toEqual(['└───────────────┘', 'demo ~/workspace %']);
  await page.keyboard.press('ControlOrMeta+K');
  await page.locator('#command-search').fill('历史与搜索');
  await page.locator('#command-search').press('Enter');
  await expect(view(page)).toBeVisible();
  await expect(page.locator('#history-view-toggle')).toHaveAttribute('aria-pressed', 'true');
  const v = view(page);
  await expect(v.locator('.history-notice')).toContainText('此会话没有压缩历史，只显示终端中的');
  const buffer = await readBuffer();
  const rows = await sweep(page);
  expect(rows.filter((row) => row.mark)).toEqual([]);
  const texts = lineRows(rows).map((row) => row.text.trimEnd());
  expect(texts).toEqual(buffer.map((line) => line.trimEnd()));
  expect(texts).toContain('字符 / 列宽 / ANSI 样本');
  expect(lineRows(rows).map((row) => row.gutter)).toEqual(lineRows(rows).map((_, i) => String(i + 1)));
  await page.locator('#history-view-toggle').click();
  await expect(page.locator('.history-view')).toHaveCount(0);
  await expect(page.locator('#history-view-toggle')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.terminal-pane:not([hidden]) .xterm-helper-textarea')).toBeFocused();
});

test('a 600,000-line history scrolls proportionally and still lands on exact lines', async ({ page }, testInfo) => {
  const { id } = await openLocal(page);
  const total = 600_000;
  await stream(page, id, `
    const lines = Array(${total}).fill('y');
    lines[300000] = 'needle in the middle';
    return ipc.stream(id, qa.encode(lines));`);
  await openView(page);
  const v = view(page);
  const list = v.locator('.history-list');
  await expect(v.locator('.history-summary')).toHaveText(`第 1–${(total + 1).toLocaleString()} 行 · 共 ${(total + 1).toLocaleString()} 行`);
  // The scroll height is capped; positions are proportional.
  expect(await v.locator('.history-spacer').evaluate((spacer) => spacer.offsetHeight)).toBe(8_000_000);
  await list.focus();
  await page.keyboard.press('End');
  await expect(v.locator(`.history-row[data-line="${total}"]`)).toBeInViewport();
  await page.keyboard.press('ArrowUp');
  await expect(v.locator('.history-row.active')).toHaveAttribute('data-line', String(total - 1));
  await page.keyboard.press('Home');
  await expect(v.locator('.history-row[data-line="0"] .history-gutter')).toHaveText('1');
  await expect(v.locator('.history-row[data-line="0"]')).toBeInViewport();
  await page.keyboard.press('PageDown');
  await expect(v.locator('.history-row.active')).toBeInViewport();
  const started = Date.now();
  const input = v.locator('.history-search');
  await input.fill('needle');
  await input.press('Enter');
  await expect(status(page)).toHaveText('第 1 处，共 1 处', { timeout: 30_000 });
  const searchMs = Date.now() - started;
  const hit = v.locator('.history-row[data-line="300000"]');
  await expect(hit).toBeInViewport();
  await expect(hit.locator('.history-gutter')).toHaveText('300001');
  await expect(hit.locator('.history-text')).toHaveText('needle in the middle');
  // Copying more than the limit is refused, not cut short.
  await list.focus();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+C');
  await expect(page.locator('#toast')).toHaveText('所选 600,001 行超过单次复制上限 50,000 行，请缩小范围。');
  await record(testInfo, 'history-view-600k', { lines: total + 1, searchMs });
});

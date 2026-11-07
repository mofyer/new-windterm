import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { liveArchives, liveViews, onLive, record } from './support/history-harness';
import { currentLine, openLocal, openView, plainLines, status, stream, view } from './support/history-view-harness';

// Regular-expression search in the read-only history view (user decision 2026-11-07, second set,
// item 12; docs/p1/HISTORY_VIEW_PLAN.zh-CN.md section 14). The pattern is compiled and matched only
// in a dedicated Web Worker; each batch has a timeout after which the worker is terminated.
//
// Page-side instruments, installed before the app loads and not part of the product:
// - `window.regexWorkers`: every Worker the page constructs, whether it was terminated, and a
//   summary of each message posted to it (field names, line count, whether a line holds ESC);
// - `window.mainRegExps`: the source of every RegExp constructed through the global `RegExp` on
//   the main thread, to show the user's pattern is never compiled there.
//
// Environment: Chrome + Vite dev server + IPC stub. This is NOT WKWebView, WebView2 or WebKitGTK:
// whether their WebViews start this worker under the Tauri CSP is not shown here.
test.setTimeout(120_000);

const tauriConf = JSON.parse(readFileSync(fileURLToPath(new URL('../../src-tauri/tauri.conf.json', import.meta.url)), 'utf8'));
const PRODUCTION_CSP: string = tauriConf.app.security.csp;

interface WorkerEntry {
  terminated: boolean;
  posted: { keys: string[]; kind: string; source?: string; caseSensitive?: boolean; lines?: number; esc?: boolean; limit?: number }[];
}

async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const workers: WorkerEntry[] = [];
    class CountedWorker extends NativeWorker {
      private readonly entry: WorkerEntry = { terminated: false, posted: [] };
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        workers.push(this.entry);
        (window as any).lastRegexWorker = new WeakRef(this);
      }
      postMessage(message: any, transfer?: any): void {
        const lines: string[] | undefined = Array.isArray(message?.lines) ? message.lines : undefined;
        this.entry.posted.push({
          keys: Object.keys(message ?? {}).sort(), kind: message?.kind, source: message?.source, caseSensitive: message?.caseSensitive,
          lines: lines?.length, esc: lines?.some((line) => line.includes('\x1b')), limit: message?.limit,
        });
        super.postMessage(message, transfer);
      }
      terminate(): void {
        this.entry.terminated = true;
        super.terminate();
      }
    }
    window.Worker = CountedWorker as typeof Worker;
    (window as any).regexWorkers = workers;
    const NativeRegExp = RegExp;
    const sources: string[] = [];
    const note = (args: unknown[]) => sources.push(args[0] instanceof NativeRegExp ? args[0].source : String(args[0]));
    window.RegExp = new Proxy(NativeRegExp, {
      construct(target, args, newTarget) { note(args); return Reflect.construct(target, args, newTarget); },
      apply(target, self, args) { note(args); return Reflect.apply(target, self, args); },
    });
    (window as any).mainRegExps = sources;
    // Copies are recorded instead of reaching the browser's clipboard (see history-view.spec.ts).
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => { (window as any).copiedText = text; },
    });
  });
}

const workers = (page: Page) => page.evaluate(() => (window as any).regexWorkers as WorkerEntry[]);
const toggle = (page: Page) => view(page).getByRole('button', { name: '正则' });
const input = (page: Page) => view(page).locator('.history-search');
/** Text of the current match; a match across SGR runs is drawn in several spans. */
const currentText = (page: Page) => view(page).locator('.history-match-current').allTextContents().then((parts) => parts.join(''));

/** Searches and waits until that search has ended (停止 hidden), not just until the status matches. */
async function search(page: Page, query: string, expected: string | RegExp): Promise<void> {
  await input(page).fill(query);
  await input(page).press('Enter');
  await expect(view(page).getByRole('button', { name: '停止' })).toBeHidden({ timeout: 30_000 });
  await expect(status(page)).toHaveText(expected);
}

test('regex search: matches, jumps, case and the toggle; the pattern only ever reaches the worker', async ({ page }) => {
  await instrument(page);
  const { id } = await openLocal(page);
  const total = 12_000;
  // Every 1,000th line is a coloured needle: SGR must not reach the worker.
  await stream(page, id, `
    const lines = Array.from({ length: ${total} }, (_, i) => (i % 1000 === 999
      ? '\\x1b[1;31m' + ['Needle', 'needle', 'NEEDLE'][((i + 1) / 1000 - 1) % 3] + '\\x1b[0m at ' + i : qa.line(i).raw));
    return ipc.stream(id, qa.encode(lines));`);
  await openView(page);
  // Off by default; turning it on starts nothing while the field is empty.
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(input(page)).toHaveAttribute('placeholder', '搜索历史');
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(input(page)).toHaveAttribute('placeholder', '正则表达式');
  expect(await workers(page)).toEqual([]);
  // Case-insensitive by default, like the plain-text search.
  await search(page, 'ne{2}dle at \\d*999$', '第 12 处，共 12 处');
  await expect.poll(() => currentLine(page)).toBe(11_999);
  await expect.poll(() => currentText(page)).toBe('NEEDLE at 11999');
  await expect(view(page).locator('.history-match-current').first()).toBeInViewport();
  await input(page).press('Enter');
  await expect(status(page)).toHaveText('第 11 处，共 12 处');
  await expect.poll(() => currentLine(page)).toBe(10_999);
  await input(page).press('Shift+Enter');
  await input(page).press('Shift+Enter');
  await expect(status(page)).toHaveText('第 1 处，共 12 处');
  await expect.poll(() => currentLine(page)).toBe(999);
  await expect.poll(() => currentText(page)).toBe('Needle at 999');
  // Copying the line a jump selected gives the whole line, as after a plain-text jump.
  await view(page).locator('.history-list').focus();
  await page.keyboard.press('ControlOrMeta+C');
  await expect(page.locator('#toast')).toHaveText('已复制 1 行。');
  expect(await page.evaluate(() => (window as any).copiedText)).toBe('Needle at 999');
  // Case-sensitive with regex: the four lowercase needles.
  await view(page).getByRole('button', { name: '区分大小写' }).click();
  await expect(status(page)).toHaveText('第 1 处，共 4 处');
  await expect.poll(() => currentLine(page)).toBe(1999);
  await input(page).press('Enter');
  await expect(status(page)).toHaveText('第 4 处，共 4 处');
  await expect.poll(() => currentLine(page)).toBe(10_999);
  // The same text without regex is literal again.
  await toggle(page).click();
  await expect(status(page)).toHaveText('没有找到');
  await toggle(page).click();
  await expect(status(page)).toHaveText(/共 4 处$/);
  await view(page).getByRole('button', { name: '区分大小写' }).click();
  await expect(status(page)).toHaveText(/共 12 处$/);
  // Lookbehind is passed to the engine (Chrome supports it); only the digits are highlighted.
  await search(page, '(?<=needle at )1\\d999', /共 2 处$/);
  await expect.poll(() => currentText(page)).toMatch(/^1\d999$/);
  // There is no /…/flags form: the slashes are part of the pattern.
  await search(page, '/needle/i', '没有找到');
  // The main thread never compiled the user's patterns. It did compile the escaped, literal form
  // of the plain-text search (regex off), which shows the instrument sees the app's RegExps.
  const mainSources = await page.evaluate(() => (window as any).mainRegExps as string[]);
  expect(mainSources.filter((source) => source.includes('e{2}') || source.includes('(?<=') || source.includes('needle/i'))).toEqual([]);
  expect(mainSources.some((source) => source.includes('ne\\{2\\}dle at'))).toBe(true);
  // What the worker got: the pattern and the case flag, then plain text only, every line once.
  const [worker, ...more] = await workers(page);
  expect(more).toEqual([]);
  expect(worker.terminated).toBe(false);
  const compiles = worker.posted.filter((m) => m.kind === 'compile');
  // Off, case on, regex off and on again (case still on), case off; then two new patterns.
  const needle = 'ne{2}dle at \\d*999$';
  expect(compiles.map((m) => [m.source, m.caseSensitive])).toEqual([
    [needle, false], [needle, true], [needle, true], [needle, false], ['(?<=needle at )1\\d999', false], ['/needle/i', false],
  ]);
  expect(new Set(compiles.map((m) => m.keys.join()))).toEqual(new Set(['caseSensitive,kind,search,source']));
  const batches = worker.posted.filter((m) => m.kind === 'match');
  expect(new Set(batches.map((m) => m.keys.join()))).toEqual(new Set(['batch,kind,limit,lines,search']));
  expect(batches.some((m) => m.esc)).toBe(false);
  const firstSearch = worker.posted.slice(1, worker.posted.indexOf(compiles[1]));
  expect(firstSearch.reduce((sum, m) => sum + (m.lines ?? 0), 0)).toBe(total + 1);
});

test('an invalid pattern is reported in fixed words, without the engine message; a valid one then works', async ({ page }) => {
  await instrument(page);
  const { id } = await openLocal(page);
  await stream(page, id, `return ipc.stream(id, qa.encode(['needle 1', ...Array(100).fill('y'), 'needle 2']));`);
  await openView(page);
  await toggle(page).click();
  const message = '正则表达式无效，请检查括号、量词与转义';
  // An open group, a reversed range, a bad quantifier, an escape the Unicode mode rejects.
  for (const pattern of ['needle(', '[z-a]', 'a{2,1}', '\\-']) {
    await search(page, pattern, message);
    await expect(input(page)).toHaveAttribute('aria-invalid', 'true');
    await expect(view(page).getByRole('button', { name: '上一处' })).toBeDisabled();
    await expect(view(page).locator('.history-match')).toHaveCount(0);
  }
  await expect(view(page)).not.toContainText(/invalid|regular expression|unterminated/i);
  // The same text is fine as a plain-text query.
  await toggle(page).click();
  await search(page, '\\-', '没有找到');
  // Back to regex: the same text is searched again and is invalid again.
  await toggle(page).click();
  await expect(view(page).getByRole('button', { name: '停止' })).toBeHidden();
  await expect(status(page)).toHaveText(message);
  await search(page, 'needle \\d', '第 2 处，共 2 处');
  await expect(input(page)).not.toHaveAttribute('aria-invalid');
  // An invalid pattern is an answer, not a fault: the worker was kept.
  expect((await workers(page)).map((w) => w.terminated)).toEqual([false]);
});

test('catastrophic backtracking times out: the worker is terminated, the page never blocks, the view stays usable', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await instrument(page);
  const { id } = await openLocal(page);
  // `(a+)+$` takes about 2^40 steps on the long line. It sits in the archive, while the five short
  // matches are the newest lines, on screen: they are in the first batch and found before it.
  await stream(page, id, `return ipc.stream(id, qa.encode(['needle old', 'a'.repeat(40) + '!', ...Array(800).fill('y'), ...Array(5).fill('aaa')]));`);
  await openView(page);
  await toggle(page).click();
  // Gaps between main-thread turns while the worker spins.
  await page.evaluate(() => {
    const probe = { last: performance.now(), max: 0, running: true };
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      const now = performance.now();
      probe.max = Math.max(probe.max, now - probe.last);
      probe.last = now;
      if (probe.running) setTimeout(() => channel.port2.postMessage(null), 5);
    };
    channel.port2.postMessage(null);
    (window as any).turnProbe = probe;
  });
  const started = Date.now();
  await input(page).fill('(a+)+$');
  await input(page).press('Enter');
  // Output keeps being parsed and ACKed while the worker is busy.
  await stream(page, id, `return ipc.stream(id, qa.encode(Array.from({ length: 2000 }, (_, i) => 'during ' + i)));`);
  const timedOut = '匹配超时，已停止：第 5 处，已找到 5 处（未搜索完，一批行超过 1 秒）';
  await expect(status(page)).toHaveText(timedOut, { timeout: 10_000 });
  const timeoutMs = Date.now() - started;
  expect(timeoutMs).toBeGreaterThanOrEqual(1_000);
  const maxTurnGap = await page.evaluate(() => { const probe = (window as any).turnProbe; probe.running = false; return probe.max; });
  expect(maxTurnGap).toBeLessThan(250);
  expect((await workers(page)).map((w) => w.terminated)).toEqual([true]);
  // The matches found before the timeout can still be visited (Enter would search again).
  await expect.poll(() => currentLine(page)).toBe(806);
  await view(page).getByRole('button', { name: '下一处' }).click();
  await expect(status(page)).toHaveText('匹配超时，已停止：第 1 处，已找到 5 处（未搜索完，一批行超过 1 秒）');
  await expect.poll(() => currentLine(page)).toBe(802);
  await expect(view(page).getByRole('button', { name: '停止' })).toBeHidden();
  // Stopping a worker in the middle of the same batch: no timeout is reported afterwards.
  await input(page).fill('(a+)+$|needle');
  await input(page).press('Enter');
  await expect(status(page)).toHaveText(/^正在搜索…/);
  await page.waitForTimeout(300);
  await view(page).getByRole('button', { name: '停止' }).click();
  await expect(status(page)).toHaveText(/^已停止：.*已找到 5 处（未搜索完）$/);
  expect((await workers(page)).map((w) => w.terminated)).toEqual([true, true]);
  await page.waitForTimeout(1_500);
  await expect(status(page)).toHaveText(/^已停止：.*已找到 5 处（未搜索完）$/);
  // A new worker for the next regex search; plain-text search is unaffected.
  await search(page, '^a{3}$', '第 5 处，共 5 处');
  await search(page, 'ne{2}dle', '第 1 处，共 1 处');
  await toggle(page).click();
  await search(page, 'needle', '第 1 处，共 1 处');
  expect((await workers(page)).map((w) => w.terminated)).toEqual([true, true, false]);
  // Closing the view terminates the idle worker too.
  await page.keyboard.press('Escape');
  await expect(page.locator('.history-view')).toHaveCount(0);
  expect((await workers(page)).map((w) => w.terminated)).toEqual([true, true, true]);
  expect(errors).toEqual([]);
  await record(testInfo, 'history-regex-timeout', { timeoutMs, maxTurnGapMs: Math.round(maxTurnGap) });
});

test('stopping, a new query, closing the view and closing the tab each terminate the running worker (R2)', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await instrument(page);
  const { cdp, id } = await openLocal(page);
  await stream(page, id, `return ipc.stream(id, qa.encode(['needle 0', ...Array(200000).fill('y')]));`);
  await openView(page);
  await toggle(page).click();
  /** Starts a regex search and, in the same task, does `then` while it is still running. */
  const raceWith = (query: string, then: 'stop' | 'query' | 'escape' | 'close-tab') => input(page).evaluate((field: HTMLInputElement, [query, then]) => {
    const enter = () => field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    field.value = query;
    enter();
    const stop = [...document.querySelectorAll<HTMLButtonElement>('.history-view button')].find((b) => b.textContent === '停止')!;
    const running = !stop.hidden;
    if (then === 'stop') stop.click();
    if (then === 'query') { field.value = 'zz+'; enter(); }
    if (then === 'escape') field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    if (then === 'close-tab') document.querySelector<HTMLButtonElement>('button[aria-label^="关闭 Local"]')!.click();
    return running;
  }, [query, then] as const);
  const terminated = async () => (await workers(page)).map((w) => w.terminated);
  // 停止
  expect(await raceWith('ne+dle', 'stop')).toBe(true);
  await expect(status(page)).toHaveText('已停止：已找到 0 处（未搜索完）');
  expect(await terminated()).toEqual([true]);
  // A new query replaces the running one: its worker goes, the new search gets a new one.
  expect(await raceWith('ne+dle', 'query')).toBe(true);
  expect(await terminated()).toEqual([true, true, false]);
  await expect(status(page)).toHaveText('没有找到', { timeout: 30_000 });
  // A finished search leaves its worker for the next one; closing the view while that one runs ends it.
  expect(await terminated()).toEqual([true, true, false]);
  expect(await raceWith('ne+dle', 'escape')).toBe(true);
  await expect(page.locator('.history-view')).toHaveCount(0);
  expect(await terminated()).toEqual([true, true, true]);
  expect(await liveViews(cdp)).toBe(0);
  // Closing the tab while a search runs: worker, view, snapshot and archive all go.
  await openView(page);
  await toggle(page).click();
  await onLive(cdp, 'viewPrototype', 'function () { window.captureQa.weakView = new WeakRef(this[0]); }');
  expect(await raceWith('ne+dle', 'close-tab')).toBe(true);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.locator('.history-view')).toHaveCount(0);
  expect(await terminated()).toEqual([true, true, true, true]);
  await page.waitForTimeout(200);
  expect(await liveViews(cdp)).toBe(0);
  expect(await liveArchives(cdp)).toBe(0);
  expect(await page.evaluate(() => (window as any).captureQa.weakView.deref() === undefined)).toBe(true);
  expect(await page.evaluate(() => (window as any).lastRegexWorker.deref() === undefined)).toBe(true);
  expect(errors).toEqual([]);
});

test('the match limit, newest-first order and jumps of a regex search equal the plain-text search', async ({ page }) => {
  await instrument(page);
  const { id } = await openLocal(page);
  const total = 12_000;
  await stream(page, id, `return ipc.stream(id, qa.encode(Array.from({ length: ${total} }, (_, i) => qa.line(i).raw)));`);
  const expected = await plainLines(page, 0, total);
  const longLines = expected.map((text, i) => (text.includes('defghijab') ? i : -1)).filter((i) => i >= 0);
  await openView(page);
  const limited = '第 10,000 处，共 10,000 处（已达上限，只列出最新的 10,000 处）';
  /** From the newest line: the newest match first, then (Shift+Enter wraps) the oldest one kept. */
  const walk = async (query: string) => {
    await view(page).locator('.history-list').focus();
    await page.keyboard.press('End');
    await search(page, query, limited);
    await expect.poll(() => currentLine(page)).toBe(longLines.at(-1));
    await expect.poll(() => currentText(page)).toBe('defghijab');
    await input(page).press('Shift+Enter');
    await expect(status(page)).toHaveText(/^第 1 处，共 10,000 处/);
    // The oldest match kept is in the 417th newest long line: 416 × 24 + 16 = 10,000.
    await expect.poll(() => currentLine(page)).toBe(longLines.at(-417));
    await expect.poll(() => currentText(page)).toBe('defghijab');
  };
  await walk('defghijab');
  // Turning regex on searches the same text again, now in the worker.
  await toggle(page).click();
  await expect(view(page).getByRole('button', { name: '停止' })).toBeHidden({ timeout: 30_000 });
  await expect(status(page)).toHaveText(/共 10,000 处（已达上限，只列出最新的 10,000 处）$/);
  await walk('d[e]fgh.ja(?=b)b');
  // The worker of both regex searches was asked for no more than the matches still missing.
  const [worker, ...more] = await workers(page);
  expect(more).toEqual([]);
  const last = worker.posted.map((m) => m.kind).lastIndexOf('compile');
  expect(worker.posted[last].source).toBe('d[e]fgh.ja(?=b)b');
  const batches = worker.posted.slice(last + 1);
  expect(batches[0].limit).toBe(10_000);
  expect(batches.every((m, i) => m.kind === 'match' && (i === 0 || m.limit! <= batches[i - 1].limit!))).toBe(true);
  expect(batches.at(-1)!.limit).toBeLessThan(10_000);
});

test('HTML-looking output found by a regex is shown as text only', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await instrument(page);
  const { id } = await openLocal(page);
  const hostile = [
    '<img src=x onerror="window.__historyXss=1">',
    '<script>window.__historyXss=2</script>',
    '<b>bold?</b> <a href="javascript:alert(1)">link</a>',
    '<svg onload="window.__historyXss=3"></svg>',
  ];
  await stream(page, id, `return ipc.stream(id, qa.encode([...${JSON.stringify(hostile)}, ...Array(6000).fill('filler')]));`);
  await openView(page);
  await toggle(page).click();
  await search(page, '<(img|svg|script)\\b[^>]*>', '第 3 处，共 3 处');
  await expect.poll(() => currentText(page)).toBe('<svg onload="window.__historyXss=3">');
  await input(page).press('Enter');
  await expect.poll(() => currentText(page)).toBe('<script>');
  await input(page).press('Enter');
  await expect.poll(() => currentText(page)).toBe('<img src=x onerror="window.__historyXss=1">');
  for (const [line, text] of hostile.entries()) {
    await expect(view(page).locator(`.history-row[data-line="${line}"] .history-text`)).toHaveText(text);
  }
  expect(await page.locator('.history-view img, .history-view script, .history-view b, .history-view a, .history-view svg:not(button svg)').count()).toBe(0);
  expect(await page.evaluate(() => (window as any).__historyXss)).toBeUndefined();
  expect(errors).toEqual([]);
});

/** A blank page served with `csp`, from which the app's regex module is imported. */
function servedWithCsp(page: Page, csp: string) {
  return page.route('**/csp-probe.html', (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    headers: { 'content-security-policy': csp },
    body: '<!doctype html><meta charset="utf-8"><title>csp probe</title><body></body>',
  }));
}

/** Runs one regex search over three lines through the app's module; returns the outcome. */
const probeSearch = (page: Page) => page.evaluate(async () => {
  const { RegexWorker, searchHistoryRegex } = await import('/src/history-regex.ts');
  const worker = new RegexWorker();
  const outcome = await searchHistoryRegex(
    { tailFirst: 7, tail: ['a1', 'b22', '\x1b[31mc333\x1b[0m'] },
    { text: '\\d+', caseSensitive: false, regex: true },
    { limit: 100, signal: new AbortController().signal },
    worker,
  );
  worker.dispose();
  return { matches: outcome.matches, complete: outcome.complete, failure: outcome.failure ?? null };
});

test("the production CSP (script-src 'self') lets the worker start; with worker-src 'none' regex search reports unavailable", async ({ page }) => {
  expect(PRODUCTION_CSP).toContain("script-src 'self'");
  expect(PRODUCTION_CSP).not.toContain('worker-src');
  await servedWithCsp(page, PRODUCTION_CSP);
  await page.goto('/csp-probe.html');
  expect(await probeSearch(page)).toEqual({
    matches: [{ line: 9, start: 1, end: 4 }, { line: 8, start: 1, end: 3 }, { line: 7, start: 1, end: 2 }],
    complete: true, failure: null,
  });
  // Control: the same page with workers forbidden.
  await page.unrouteAll();
  await servedWithCsp(page, `${PRODUCTION_CSP}; worker-src 'none'`);
  await page.goto('/csp-probe.html');
  expect(await probeSearch(page)).toEqual({ matches: [], complete: false, failure: 'unavailable' });
});

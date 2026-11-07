import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { CHUNK, diagnostics, installModules, liveArchives, onLive, record } from './support/history-harness';

// P1 slice 5, step 6: cold-history budget enforcement and the "已丢弃最早 N 行" notice
// (docs/p1/HISTORY_BUDGET_PLAN.zh-CN.md). Bytes go from an in-page Tauri IPC stub through the
// real `Channel` index/end protocol, session-lifecycle.ts (Utf8Boundary, ordered ACK) and the
// workbench xterm into each session's live HistoryArchive.
//
// The budgets are lowered with the development-only `?p0HistoryBudget=` query, which can only
// lower the defaults and is not in release assets (`import.meta.env.DEV` is false there).
//
// Environment: Chrome + Vite dev server + IPC stub. This is NOT WKWebView, WebView2, WebKitGTK,
// Tauri IPC or a Rust PTY.
test.setTimeout(90_000);

const BLOCK = 512; // ARCHIVE_BLOCK_LINES

/** Stub IPC for several local PTY tabs, each with its own Channel, sequence and ACK order check. */
async function installIpc(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (message: unknown) => void>();
    let nextCallback = 1;
    const sessions = new Map<string, any>();
    const state: any = { callbacks, sessions, opened: 0, closes: 0, last: '' };
    state.send = (id: string, message: unknown) => {
      const s = sessions.get(id);
      callbacks.get(s.channelId)?.({ index: s.index++, message });
    };
    state.end = (id: string) => {
      const s = sessions.get(id);
      callbacks.get(s.channelId)?.({ index: s.index++, end: true });
    };
    /** Sends bytes as Rust would, in 4096 B data events, and keeps them for a reference terminal. */
    state.stream = (id: string, bytes: Uint8Array, chunk: number) => {
      const s = sessions.get(id);
      s.sent.push(bytes);
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        state.send(id, { kind: 'data', id, sequence: ++s.sequence, data: Array.from(bytes.slice(offset, offset + chunk)) });
      }
      return s.sequence;
    };
    Object.assign(window, {
      isTauri: true,
      trimIpc: state,
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (message: unknown) => void) => {
          const id = nextCallback++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: (command: string, args: any = {}) => {
          if (command === 'pty_open') {
            const id = `trim-pty-${++state.opened}`;
            sessions.set(id, { channelId: args.onEvent.id, index: 0, sequence: 0, acks: 0, ackOrder: true, sent: [] });
            state.last = id;
            return Promise.resolve({ id });
          }
          if (command === 'pty_ack') {
            const s = sessions.get(args.id);
            s.ackOrder &&= args.sequence === s.acks + 1;
            s.acks = args.sequence;
          }
          if (command === 'pty_close') state.closes++;
          if (command === 'pty_shells') return Promise.resolve([]);
          return Promise.resolve(null);
        },
      },
    });
  });
}

/** Loads the workbench with lowered budgets and watches the notice and the toast. */
async function load(page: Page, budget: string): Promise<CDPSession> {
  await installIpc(page);
  await page.goto(`/?p0Diagnostics&p0HistoryBudget=${budget}`);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await installModules(page);
  await page.evaluate(() => {
    const qa = (window as any).captureQa;
    qa.tagged = (tag: string, i: number) => ({ raw: tag + qa.line(i).raw, plain: tag + qa.line(i).plain });
    qa.archives = {};
    const notice = document.getElementById('terminal-history')!;
    qa.notice = { mutations: 0, texts: [] as string[], initiallyHidden: notice.hidden };
    new MutationObserver((records) => {
      qa.notice.mutations += records.length;
      if (notice.textContent && qa.notice.texts.at(-1) !== notice.textContent) qa.notice.texts.push(notice.textContent);
    }).observe(notice, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    const toast = document.getElementById('toast')!;
    qa.toasts = [] as string[];
    new MutationObserver(() => qa.toasts.push(toast.textContent ?? '')).observe(toast, { childList: true, characterData: true, subtree: true });
  });
  return page.context().newCDPSession(page);
}

/** Opens a stubbed local tab and keeps a reference to its new archive as `captureQa.archives[tag]`. */
async function openLocal(page: Page, cdp: CDPSession, tag: string): Promise<string> {
  const tabs = await page.getByRole('tab').count();
  await page.locator('#local-open').click();
  await expect(page.getByRole('tab')).toHaveCount(tabs + 1);
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
  await onLive(cdp, 'archivePrototype', `function () {
    const archives = window.captureQa.archives;
    const known = Object.values(archives);
    const fresh = this.filter((archive) => !known.includes(archive));
    if (fresh.length !== 1) throw new Error('expected one new archive, found ' + fresh.length);
    archives[${JSON.stringify(tag)}] = fresh[0];
  }`);
  return page.evaluate(() => (window as any).trimIpc.last as string);
}

/** Streams tagged lines `[from, to)` to one tab and waits until every chunk is acknowledged in order. */
async function stream(page: Page, id: string, tag: string, from: number, to: number): Promise<void> {
  const sent = await page.evaluate(({ id, tag, from, to, chunk }) => {
    const qa = (window as any).captureQa;
    const lines = Array.from({ length: to - from }, (_, i) => qa.tagged(tag, from + i).raw);
    return (window as any).trimIpc.stream(id, qa.encode(lines), chunk) as number;
  }, { id, tag, from, to, chunk: CHUNK });
  await expect.poll(() => page.evaluate((id) => (window as any).trimIpc.sessions.get(id).acks, id), { timeout: 30_000 }).toBe(sent);
  expect(await page.evaluate((id) => (window as any).trimIpc.sessions.get(id).ackOrder, id)).toBe(true);
}

/** Waits for every queued compression, so every budget pass has run. */
const settle = (page: Page) => page.evaluate(async () => {
  for (const archive of Object.values((window as any).captureQa.archives) as any[]) await archive.flush();
});

interface Held {
  stats: Record<string, number>;
  /** Plain text of every line still held, oldest first. */
  lines: string[];
  /** Compressed size of each completed block still held. */
  blockBytes: number[];
  /** Line count of each completed block still held. */
  blockLines: number[];
}
/** Reads one archive without sealing its partial block (which would start another budget pass). */
const held = (page: Page, tag: string) => page.evaluate(async (tag) => {
  const qa = (window as any).captureQa;
  const archive = qa.archives[tag];
  await archive.flush();
  const stats = archive.stats();
  const lines = (await archive.lines(stats.droppedLines, stats.archivedLines - stats.droppedLines)).map(qa.stripSgr);
  // Test-only peek at the private block list: sizes only.
  return { stats, lines, blockBytes: archive.blocks.map((b: any) => b.data.length), blockLines: archive.blocks.map((b: any) => b.count) };
}, tag) as Promise<Held>;

/** The plain text of tagged lines `[from, to)`. */
const expected = (page: Page, tag: string, from: number, to: number) => page.evaluate(({ tag, from, to }) =>
  Array.from({ length: Math.max(0, to - from) }, (_, i) => (window as any).captureQa.tagged(tag, from + i).plain), { tag, from, to });

/** Every buffer row of the named workbench pane, and of a reference xterm fed the same bytes. */
const hotAgainstReference = (cdp: CDPSession, pane: string, id: string) => onLive<{ live: string[]; reference: string[]; length: number; rows: number }>(
  cdp, 'terminalPrototype', `async function () {
  const live = this.find(t => t.element && t.element.closest('.terminal-pane[aria-label=${JSON.stringify(`${pane} 终端`)}]'));
  const rowsOf = (t) => Array.from({ length: t.buffer.normal.length }, (_, y) => {
    const line = t.buffer.normal.getLine(y);
    return (line.isWrapped ? '\\u21a9' : '') + line.translateToString(true);
  });
  const qa = window.captureQa;
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-3000px;top:0;width:1200px;height:600px';
  document.body.append(holder);
  const reference = qa.createWorkspaceSession();
  reference.terminal.open(holder);
  reference.terminal.resize(live.cols, live.rows);
  for (const bytes of window.trimIpc.sessions.get(${JSON.stringify(id)}).sent) {
    await new Promise((resolve) => reference.terminal.write(bytes, resolve));
  }
  const result = { live: rowsOf(live), reference: rowsOf(reference.terminal), length: live.buffer.normal.length, rows: live.rows };
  reference.vt.dispose();
  reference.terminal.dispose();
  holder.remove();
  return result;
}`);

const notice = (page: Page) => page.locator('#terminal-history');
const noticeText = (page: Page, lines: number) => page.evaluate((n) => `已丢弃最早 ${n.toLocaleString()} 行`, lines);

/** Closes every tab, drops the test's own references and checks that nothing is left (R2). */
async function closeAllAndCheckRelease(page: Page, cdp: CDPSession): Promise<void> {
  while (await page.getByRole('button', { name: /^关闭 Local/ }).count()) {
    const tabs = await page.getByRole('tab').count();
    await page.getByRole('button', { name: /^关闭 Local/ }).first().click();
    await expect(page.getByRole('tab')).toHaveCount(tabs - 1);
  }
  await page.evaluate(() => { (window as any).captureQa.archives = {}; });
  expect(await liveArchives(cdp)).toBe(0);
  const snapshot = await diagnostics(page);
  expect(snapshot.historyArchives).toBe(0);
  expect(snapshot.historyCompressedBytes).toBe(0);
}

test('one session over its byte budget drops its oldest whole blocks; the notice N matches and is throttled', async ({ page }, testInfo) => {
  const budget = 16 * 1024;
  const cdp = await load(page, `sessionBytes:${budget}`);
  const id = await openLocal(page, cdp, 'A');
  expect(await page.evaluate(() => (window as any).captureQa.notice.initiallyHidden)).toBe(true);
  await expect(notice(page)).toBeHidden();
  const total = 12_000;
  const started = Date.now();
  await stream(page, id, 'A', 0, total);
  await settle(page);
  const archive = await held(page, 'A');
  const { stats } = archive;
  const dropped = stats.droppedLines;
  await expect(notice(page)).toHaveText(await noticeText(page, dropped));
  const elapsedMs = Date.now() - started;
  const log = await page.evaluate(() => {
    const qa = (window as any).captureQa;
    return { mutations: qa.notice.mutations as number, texts: qa.notice.texts as string[], toasts: qa.toasts as string[] };
  });
  const snapshot = await diagnostics(page);
  const hot = await hotAgainstReference(cdp, 'Local 2', id);
  await record(testInfo, 'history-trim-session', {
    budget, elapsedMs, stats, blocks: archive.blockBytes.length, maxBlockBytes: Math.max(...archive.blockBytes),
    noticeMutations: log.mutations, noticeTexts: log.texts.length,
  });

  // Whole blocks, oldest first, and no more than needed.
  expect(stats.gaps).toBe(0);
  expect(dropped).toBeGreaterThan(0);
  expect(dropped).toBe(stats.droppedBlocks * BLOCK);
  expect(archive.blockLines.every((count) => count === BLOCK)).toBe(true);
  expect(stats.compressedBytes).toBe(archive.blockBytes.reduce((sum, bytes) => sum + bytes, 0));
  expect(stats.compressedBytes).toBeLessThanOrEqual(budget);
  expect(stats.compressedBytes).toBeGreaterThan(budget - 2 * Math.max(...archive.blockBytes));
  // What is left is exactly the tail of the stream, line by line.
  expect(archive.lines).toEqual(await expected(page, 'A', dropped, stats.archivedLines));
  // The hot window is untouched: identical to an xterm that was fed the same bytes without archiving.
  expect(hot.length).toBe(hot.rows + 5000);
  expect(hot.live).toEqual(hot.reference);
  // The notice: only the count, one element, refreshed with the throttled status bar, no toast.
  expect(log.texts.every((text) => /^已丢弃最早 [\d,]+ 行$/.test(text))).toBe(true);
  expect(log.texts.at(-1)).toBe(await noticeText(page, dropped));
  expect(log.mutations).toBeLessThanOrEqual(Math.ceil(elapsedMs / 100) + 3);
  expect(log.toasts.some((text) => text.includes('丢弃'))).toBe(false);
  await expect(page.locator('#terminal-history')).toHaveCount(1);
  // Development counters agree with the archive.
  expect(snapshot.historyTrimmedLines).toBe(dropped);
  expect(snapshot.historyTrimmedBlocks).toBe(stats.droppedBlocks);
  expect(snapshot.historyCompressedBytes).toBe(stats.compressedBytes);
  expect(snapshot.historyMaxSessionCompressedBytes).toBeLessThanOrEqual(budget);
  expect(snapshot.historySessionBudgetExceeded).toBeGreaterThan(0);
  expect(snapshot.historySessionBudgetExceeded).toBeLessThanOrEqual(stats.droppedBlocks);
  expect(snapshot.historyTotalBudgetExceeded).toBe(0);
  expect(snapshot.historyLineTargetExceeded).toBe(0);
  expect(snapshot.historyTrimmedEndedBlocks + snapshot.historyTrimmedRunningBlocks).toBe(0);
  expect(snapshot.historyCaptureErrors).toBe(0);
  expect(Object.values(snapshot).every((value) => typeof value === 'number')).toBe(true);
  await closeAllAndCheckRelease(page, cdp);
});

test('the line target drops the oldest whole blocks down to the target; the hot window is untouched', async ({ page }) => {
  const target = 4 * BLOCK;
  const cdp = await load(page, `lines:${target}`);
  const id = await openLocal(page, cdp, 'L');
  // A burst first (blocks complete one at a time while later ones queue), then settled rounds
  // (several completed blocks, so only the oldest one may go).
  await stream(page, id, 'L', 0, 6_000);
  await settle(page);
  for (let from = 6_000; from < 12_000; from += 1_000) {
    await stream(page, id, 'L', from, from + 1_000);
    await settle(page);
  }
  const archive = await held(page, 'L');
  const { stats } = archive;
  const sealed = stats.archivedLines - stats.pendingLines;
  // Lines in sealed blocks stay within the target; the newest partial block is not trimmed.
  expect(stats.pendingLines).toBe(stats.archivedLines % BLOCK);
  expect(sealed - stats.droppedLines).toBe(target);
  expect(stats.droppedLines).toBe(sealed - target);
  expect(stats.droppedLines % BLOCK).toBe(0);
  expect(archive.lines).toEqual(await expected(page, 'L', stats.droppedLines, stats.archivedLines));
  await expect(notice(page)).toHaveText(await noticeText(page, stats.droppedLines));
  const hot = await hotAgainstReference(cdp, 'Local 2', id);
  expect(hot.length).toBe(hot.rows + 5000);
  expect(hot.live).toEqual(hot.reference);
  const snapshot = await diagnostics(page);
  expect(snapshot.historyTrimmedLines).toBe(stats.droppedLines);
  expect(snapshot.historyLineTargetExceeded).toBeGreaterThan(0);
  expect(snapshot.historySessionBudgetExceeded).toBe(0);
  expect(snapshot.historyTotalBudgetExceeded).toBe(0);
  await closeAllAndCheckRelease(page, cdp);
});

test('over the total budget, exited tabs lose their oldest blocks first, least recently focused first, then running tabs', async ({ page }, testInfo) => {
  const budget = 40 * 1024;
  const cdp = await load(page, `totalBytes:${budget}`);
  const tags = ['R', 'A', 'B', 'C'] as const;
  type Tag = (typeof tags)[number];
  const panes: Record<Tag, string> = { R: 'Local 2', A: 'Local 3', B: 'Local 4', C: 'Local 5' };
  const ids: Partial<Record<Tag, string>> = {};
  const sent: Record<Tag, number> = { R: 2000, A: 4000, B: 4000, C: 0 };
  // R keeps running but stays idle: by focus alone it is the least recently used tab.
  for (const tag of ['R', 'A', 'B'] as const) {
    ids[tag] = await openLocal(page, cdp, tag);
    await stream(page, ids[tag]!, tag, 0, sent[tag]);
  }
  for (const tag of ['A', 'B'] as const) {
    await page.evaluate((id) => {
      const ipc = (window as any).trimIpc;
      ipc.send(id, { kind: 'exit', id, code: 0 });
      ipc.end(id);
    }, ids[tag]!);
  }
  await settle(page);
  // Precondition: everything fits; nothing has been dropped yet.
  expect((await diagnostics(page)).historyTrimmedBlocks).toBe(0);
  // A exited first, but is focused after B: B is now the least recently used exited tab.
  await page.getByRole('tab', { name: panes.A }).click();
  await expect(page.locator('#terminal-state')).toContainText('已退出 · code 0');
  ids.C = await openLocal(page, cdp, 'C');

  type All = Record<Tag, Record<string, number>>;
  const read = async () => Object.fromEntries(await Promise.all(tags.map(async (tag) => [tag, (await held(page, tag)).stats] as const))) as All;
  const rounds: Record<string, number> = {};
  /** Streams C a block at a time until `done` holds for the archives' stats; returns those stats. */
  const until = async (label: string, done: (stats: All) => boolean) => {
    for (let round = 0; round < 80; round++) {
      await stream(page, ids.C!, 'C', sent.C, sent.C + BLOCK);
      sent.C += BLOCK;
      await settle(page);
      const stats = await read();
      if (done(stats)) {
        rounds[label] = round + 1;
        return stats;
      }
    }
    throw new Error(`${label} was not reached`);
  };
  const first = await until('B trimmed', (s) => s.B.droppedLines > 0);
  expect([first.A.droppedLines, first.R.droppedLines, first.C.droppedLines]).toEqual([0, 0, 0]);
  const second = await until('A trimmed', (s) => s.A.droppedLines > 0);
  expect(second.B.blocks).toBe(0);
  expect([second.R.droppedLines, second.C.droppedLines]).toEqual([0, 0]);
  expect((await diagnostics(page)).historyTrimmedRunningBlocks).toBe(0);
  const third = await until('R trimmed', (s) => s.R.droppedLines > 0);
  expect([third.A.blocks, third.B.blocks]).toEqual([0, 0]);
  expect(third.C.droppedLines).toBe(0);
  const last = await until('C trimmed', (s) => s.C.droppedLines > 0);
  expect([last.A.blocks, last.B.blocks, last.R.blocks]).toEqual([0, 0, 0]);

  const snapshot = await diagnostics(page);
  const sum = tags.reduce((total, tag) => total + last[tag].compressedBytes, 0);
  await record(testInfo, 'history-trim-total', { budget, rounds, sum, stats: last, snapshot });
  expect(sum).toBeLessThanOrEqual(budget);
  expect(snapshot.historyCompressedBytes).toBe(sum);
  expect(snapshot.historyMaxTotalCompressedBytes).toBeLessThanOrEqual(budget);
  expect(snapshot.historyTrimmedEndedBlocks).toBe(last.A.droppedBlocks + last.B.droppedBlocks);
  expect(snapshot.historyTrimmedRunningBlocks).toBe(last.R.droppedBlocks + last.C.droppedBlocks);
  expect(snapshot.historyTrimmedLines).toBe(tags.reduce((total, tag) => total + last[tag].droppedLines, 0));
  expect(snapshot.historySessionBudgetExceeded + snapshot.historyLineTargetExceeded).toBe(0);
  for (const tag of tags) {
    const archive = await held(page, tag);
    // Whole blocks only, and what is left is the tail of that tab's own stream.
    expect(archive.stats.droppedLines).toBe(archive.stats.droppedBlocks * BLOCK);
    expect(archive.stats.gaps).toBe(0);
    expect(archive.lines).toEqual(await expected(page, tag, archive.stats.droppedLines, archive.stats.archivedLines));
    // Each tab's own count, shown when it is selected.
    await page.getByRole('tab', { name: panes[tag] }).click();
    await expect(notice(page)).toHaveText(await noticeText(page, archive.stats.droppedLines));
  }
  await page.getByRole('tab', { name: 'Getting started' }).click();
  await expect(notice(page)).toBeHidden();
  expect(await page.evaluate(() => (window as any).captureQa.toasts.some((text: string) => text.includes('丢弃')))).toBe(false);
  await closeAllAndCheckRelease(page, cdp);
});

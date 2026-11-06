import { test, expect, type CDPSession, type Page, type TestInfo } from '@playwright/test';

// P1 slice 5, step 1: the named history/session budget plus Chrome-only
// memory and release observations (docs/p1/HISTORY_BUDGET_PLAN.zh-CN.md).
//
// Environment: Chrome + Vite dev server + IPC stub. This is NOT WKWebView,
// WebView2, WebKitGTK, Tauri IPC or a Rust PTY, and heap figures are V8/Blink
// counters of one renderer, not process RSS. Byte counts are recorded as
// observations; assertions only guard the budget values, the oldest-line
// trimming, order of magnitude and whether a closed terminal became
// unreachable after a forced GC.
test.setTimeout(60_000);

const MIB = 1024 * 1024;
const CHUNK = 4096; // Rust PtyEvent::Data block size
const GROUP = 'history-budget';
const PANE = '.terminal-pane[aria-label^="Local"]';

interface HeapSample {
  readonly used: number;
  /** ArrayBuffer backing stores; xterm keeps each buffer line in a Uint32Array. */
  readonly backing: number | null;
  readonly embedder: number | null;
}

interface HeapUsage {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize?: number;
  backingStorageSize?: number;
}

const total = (sample: HeapSample): number => sample.used + (sample.backing ?? 0);
const mib = (bytes: number): number => Math.round((bytes / MIB) * 100) / 100;

/** Forces full GCs, then reads V8's precise counters (no --enable-precise-memory-info needed). */
async function heap(cdp: CDPSession): Promise<HeapSample> {
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const usage = (await cdp.send('Runtime.getHeapUsage')) as HeapUsage;
  return { used: usage.usedSize, backing: usage.backingStorageSize ?? null, embedder: usage.embedderHeapUsedSize ?? null };
}

/** Live xterm `Terminal` objects after a full GC, found by the app's own Terminal prototype. */
async function liveTerminals(cdp: CDPSession): Promise<number> {
  await cdp.send('HeapProfiler.collectGarbage');
  const { result: prototype } = await cdp.send('Runtime.evaluate', {
    expression: 'window.historyBudgetQa.prototype', objectGroup: GROUP,
  });
  const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId!, objectGroup: GROUP });
  const { result } = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objectId!, functionDeclaration: 'function () { return this.length; }', returnByValue: true,
  });
  // The inspector holds every object it returned until the group is released.
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: GROUP });
  return result.value as number;
}

/** Runs a function on the live workbench terminal of the Local pane without keeping it. */
async function onLocalTerminal<T>(cdp: CDPSession, functionDeclaration: string): Promise<T> {
  const { result: prototype } = await cdp.send('Runtime.evaluate', {
    expression: 'window.historyBudgetQa.prototype', objectGroup: GROUP,
  });
  const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.objectId!, objectGroup: GROUP });
  const { result: found } = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objectId!, objectGroup: GROUP,
    functionDeclaration: `function () { return this.find(t => t.element && t.element.closest(${JSON.stringify(PANE)})); }`,
  });
  if (!found.objectId) throw new Error('no live terminal in the Local pane');
  const { result } = await cdp.send('Runtime.callFunctionOn', {
    objectId: found.objectId!, functionDeclaration, returnByValue: true,
  });
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: GROUP });
  return result.value as T;
}

/** Imports the production modules into the page (same module instances as main.ts). */
async function installModules(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const terminal = await import('/src/terminal.ts');
    const budget = await import('/src/history-budget.ts');
    const probe = terminal.createWorkspaceTerminal();
    const prototype = Object.getPrototypeOf(probe);
    probe.dispose();
    const line = (kind: string, index: number, cols: number): string => {
      const id = String(index).padStart(6, '0');
      if (kind === 'short') return `line ${id}`;
      if (kind === 'mixed') {
        // Truecolor SGR, wide CJK, emoji with skin tone and a ZWJ family, combining accent.
        return `\x1b[1;38;2;${index % 256};96;160m${id} 中文宽字符 🙂👍🏽👨‍👩‍👧 é\x1b[0m`;
      }
      return `${id} ${'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(8)}`.slice(0, cols - 1);
    };
    const stream = (kind: string, count: number, cols: number): Uint8Array =>
      new TextEncoder().encode(Array.from({ length: count }, (_, i) => line(kind, i, cols)).join('\r\n') + '\r\n');
    (window as any).historyBudgetQa = { ...terminal, budget: { ...budget }, prototype, line, stream };
  });
}

/** Lets pending xterm frames and timers run, so only real references keep a terminal alive. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
  }));
}

async function record(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value, null, 2);
  // The attachment keeps raw counters; the console line stays readable.
  console.log(`${name} ${JSON.stringify(value, (key, field) => (key === 'raw' ? undefined : field))}`);
  await testInfo.attach(name, { body, contentType: 'application/json' });
}

test('the named budget keeps the 5,000-line production default and trims only the oldest lines', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await installModules(page);
  const result = await page.evaluate(async () => {
    const qa = (window as any).historyBudgetQa;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:500px';
    document.body.append(holder);
    const session = qa.createWorkspaceSession();
    session.terminal.open(holder);
    session.terminal.resize(80, 24);
    const scrollback = session.terminal.options.scrollback;
    const written = qa.budget.DEFAULT_SCROLLBACK_LINES + 24 + 300;
    const bytes = qa.stream('ascii', written, 80);
    await new Promise<void>((resolve) => {
      for (let offset = 0; offset < bytes.length; offset += 4096) session.terminal.write(bytes.slice(offset, offset + 4096));
      session.terminal.write('', resolve);
    });
    const buffer = session.terminal.buffer.normal;
    const out = {
      budget: qa.budget,
      scrollback,
      bufferLength: buffer.length,
      rows: session.terminal.rows,
      written,
      first: buffer.getLine(0)?.translateToString(true),
      // `written` CRLF-terminated lines leave the cursor on one more, empty line.
      expectedFirst: qa.line('ascii', written + 1 - buffer.length, 80),
      last: buffer.getLine(buffer.length - 2)?.translateToString(true),
      expectedLast: qa.line('ascii', written - 1, 80),
    };
    session.vt.dispose();
    session.terminal.dispose();
    holder.remove();
    return out;
  });
  expect(result.budget.DEFAULT_SCROLLBACK_LINES).toBe(5000);
  expect(result.budget.MAX_WORKSPACE_SESSIONS).toBe(8);
  expect(result.budget.MAX_WINDOW_SCROLLBACK_LINES).toBe(40_000);
  expect(result.scrollback).toBe(result.budget.DEFAULT_SCROLLBACK_LINES);
  expect(result.bufferLength).toBe(result.rows + result.budget.DEFAULT_SCROLLBACK_LINES);
  expect(result.first).toBe(result.expectedFirst);
  expect(result.last).toBe(result.expectedLast);
});

test('the workbench refuses a ninth tab at the named session budget', async ({ page }) => {
  await page.goto('/');
  await installModules(page);
  const max = await page.evaluate(() => (window as any).historyBudgetQa.budget.MAX_WORKSPACE_SESSIONS as number);
  for (let tabs = 1; tabs < max; tabs++) await page.locator('#demo-add').click();
  await expect(page.getByRole('tab')).toHaveCount(max);
  await page.locator('#demo-add').click();
  await expect(page.getByRole('status')).toContainText(`最多同时打开 ${max} 个会话`);
  await expect(page.getByRole('tab')).toHaveCount(max);
});

test('Chrome observation: heap and backing store of one filled 5,000-line history', async ({ page, browser }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await installModules(page);
  const cdp = await page.context().newCDPSession(page);
  const cases = [
    { kind: 'ascii', cols: 80 },
    { kind: 'short', cols: 80 },
    { kind: 'mixed', cols: 80 },
    { kind: 'ascii', cols: 200 },
  ] as const;
  const rows = 24;
  const results: Array<Record<string, unknown> & { theoreticalCellMiB: number; historyBackingMiB: number | null; collected: boolean; raw: Record<'baseline' | 'empty' | 'full' | 'disposedHeld' | 'released', HeapSample> }> = [];
  for (const { kind, cols } of cases) {
    const baseline = await heap(cdp);
    const created = await page.evaluate(({ cols, rows }) => {
      const qa = (window as any).historyBudgetQa;
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:600px';
      document.body.append(holder);
      const session = qa.createWorkspaceSession();
      session.terminal.open(holder);
      session.terminal.resize(cols, rows);
      qa.current = { session, holder };
      qa.weak = new WeakRef(session.terminal);
      return { cols: session.terminal.cols, rows: session.terminal.rows };
    }, { cols, rows });
    expect(created).toEqual({ cols, rows });
    const empty = await heap(cdp);
    const filled = await page.evaluate(async ({ kind, cols, rows }) => {
      const qa = (window as any).historyBudgetQa;
      const { terminal } = qa.current.session;
      const written = qa.budget.DEFAULT_SCROLLBACK_LINES + rows + 200;
      const bytes = qa.stream(kind, written, cols);
      await new Promise<void>((resolve) => {
        for (let offset = 0; offset < bytes.length; offset += 4096) terminal.write(bytes.slice(offset, offset + 4096));
        terminal.write('', resolve);
      });
      const buffer = terminal.buffer.normal;
      let wrapped = 0;
      for (let i = 0; i < buffer.length; i++) if (buffer.getLine(i)?.isWrapped) wrapped++;
      return { written, streamBytes: bytes.length, bufferLength: buffer.length, wrapped };
    }, { kind, cols, rows });
    expect(filled.bufferLength).toBe(rows + 5000);
    expect(filled.wrapped).toBe(0);
    const full = await heap(cdp);
    // Disposed but still referenced: xterm 6.0.0 dispose does not clear its buffers.
    await page.evaluate(() => {
      const { session } = (window as any).historyBudgetQa.current;
      session.vt.dispose();
      session.terminal.dispose();
    });
    const disposedHeld = await heap(cdp);
    await page.evaluate(() => {
      const qa = (window as any).historyBudgetQa;
      qa.current.holder.remove();
      qa.current = undefined;
    });
    await settle(page);
    const released = await heap(cdp);
    const collected = await page.evaluate(() => (window as any).historyBudgetQa.weak.deref() === undefined);
    const history = total(full) - total(empty);
    // The empty terminal already holds its visible rows; the delta is the scrollback lines.
    const historyLines = filled.bufferLength - rows;
    const theoreticalCellBytes = historyLines * cols * 12; // xterm 6.0.0: 3 x Uint32 per cell
    const raw = { baseline, empty, full, disposedHeld, released };
    results.push({
      kind, cols, rows, ...filled, historyLines,
      theoreticalCellMiB: mib(theoreticalCellBytes),
      fixedOverheadMiB: mib(total(empty) - total(baseline)),
      historyMiB: mib(history),
      historyHeapMiB: mib(full.used - empty.used),
      historyBackingMiB: full.backing === null || empty.backing === null ? null : mib(full.backing - empty.backing),
      historyBytesPerLine: Math.round(history / historyLines),
      disposedHeldMiB: mib(total(disposedHeld) - total(baseline)),
      releasedMiB: mib(total(released) - total(baseline)),
      releasedHeapMiB: mib(released.used - baseline.used),
      releasedBackingMiB: released.backing === null || baseline.backing === null ? null : mib(released.backing - baseline.backing),
      embedderDeltaMiB: full.embedder === null || empty.embedder === null ? null : mib(full.embedder - empty.embedder),
      collected,
      raw,
    });
  }
  const backingStorageReported = results.every((r) => r.historyBackingMiB !== null);
  await record(testInfo, 'history-budget-heap', { browser: browser.version(), backingStorageReported, results });
  for (const r of results) {
    const history = total(r.raw.full) - total(r.raw.empty);
    // Order-of-magnitude and validity guards only; exact figures are observations.
    expect(history).toBeGreaterThan(0);
    expect(history).toBeLessThan(64 * MIB);
    if (backingStorageReported) {
      const backing = r.raw.full.backing! - r.raw.empty.backing!;
      expect(backing).toBeGreaterThan(r.theoreticalCellMiB * MIB * 0.5);
      expect(backing).toBeLessThan(r.theoreticalCellMiB * MIB * 2);
    }
    // Control: a disposed xterm that is still referenced keeps its history.
    expect(total(r.raw.disposedHeld) - total(r.raw.baseline)).toBeGreaterThan(history / 2);
    expect(total(r.raw.released) - total(r.raw.baseline)).toBeLessThan(history / 4);
    expect(r.collected).toBe(true);
  }
  expect(await liveTerminals(cdp)).toBe(1);
});

/** Stub IPC that keeps Channel callbacks the way the Tauri runtime does until they are unregistered. */
async function installChannelIpc(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (message: unknown) => void>();
    let nextCallback = 1;
    const state: any = { callbacks, channelId: 0, index: 0, ptyId: '', opened: 0, acks: 0, closes: 0 };
    // Plays the Rust side: messages carry Tauri's channel index; `end` is what
    // Tauri sends once the last Rust clone of the channel is dropped. Tests
    // send it explicitly, so closing a tab alone never unregisters the callback.
    state.send = (message: unknown) => callbacks.get(state.channelId)?.({ index: state.index++, message });
    state.end = () => callbacks.get(state.channelId)?.({ index: state.index++, end: true });
    Object.assign(window, {
      isTauri: true,
      historyIpc: state,
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (message: unknown) => void) => {
          const id = nextCallback++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: (command: string, args: any = {}) => {
          if (command === 'pty_open') {
            state.opened++;
            state.channelId = args.onEvent.id;
            state.index = 0;
            state.ptyId = `history-pty-${state.opened}`;
            return Promise.resolve({ id: state.ptyId });
          }
          if (command === 'pty_ack') state.acks++;
          if (command === 'pty_close') state.closes++;
          if (command === 'pty_shells') return Promise.resolve([]);
          return Promise.resolve(null);
        },
      },
    });
  });
}

/** Opens one stubbed local PTY tab and fills it past its scrollback in 4096 B chunks. */
async function openFilledLocal(page: Page): Promise<{ chunks: number; written: number }> {
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await installModules(page);
  await page.locator('#local-open').click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
  const fill = await page.evaluate((chunk) => {
    const qa = (window as any).historyBudgetQa;
    const ipc = (window as any).historyIpc;
    const written = qa.budget.DEFAULT_SCROLLBACK_LINES + 400;
    const bytes = qa.stream('ascii', written, 80);
    let chunks = 0;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      chunks++;
      ipc.send({ kind: 'data', id: ipc.ptyId, sequence: chunks, data: Array.from(bytes.slice(offset, offset + chunk)) });
    }
    return { chunks, written };
  }, CHUNK);
  await expect.poll(() => page.evaluate(() => (window as any).historyIpc.acks)).toBe(fill.chunks);
  return fill;
}

interface LocalHistory { length: number; rows: number; cols: number; scrollback: number; last: string }
const LOCAL_HISTORY = `function () {
  const buffer = this.buffer.normal;
  return { length: buffer.length, rows: this.rows, cols: this.cols, scrollback: this.options.scrollback,
    last: buffer.getLine(buffer.length - 2).translateToString(true) };
}`;

test('Chrome GC observation: an exited tab keeps its history until closed, then its xterm is released', async ({ page }, testInfo) => {
  await installChannelIpc(page);
  const fill = await openFilledLocal(page);
  const cdp = await page.context().newCDPSession(page);
  expect(await liveTerminals(cdp)).toBe(2);
  const running = await onLocalTerminal<LocalHistory>(cdp, LOCAL_HISTORY);
  expect(running.scrollback).toBe(5000);
  expect(running.length).toBe(running.rows + 5000);
  const filled = await heap(cdp);

  await page.evaluate(() => {
    const ipc = (window as any).historyIpc;
    ipc.send({ kind: 'exit', id: ipc.ptyId, code: 0 });
    ipc.end();
  });
  await expect(page.locator('#terminal-state')).toContainText('已退出 · code 0');
  expect(await page.evaluate(() => (window as any).historyIpc.callbacks.size)).toBe(0);
  // Exit ends the process, not the tab: its history stays readable.
  const exited = await onLocalTerminal<LocalHistory>(cdp, LOCAL_HISTORY);
  expect(exited).toEqual(running);
  expect(await liveTerminals(cdp)).toBe(2);

  await page.getByRole('button', { name: /^关闭 Local/ }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.locator(PANE)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).historyIpc.closes)).toBe(0);
  await settle(page);
  expect(await liveTerminals(cdp)).toBe(1);
  const closed = await heap(cdp);
  await record(testInfo, 'history-budget-exit-close', {
    ...fill, cols: running.cols, rows: running.rows, bufferLength: running.length,
    releasedMiB: mib(total(filled) - total(closed)),
    releasedHeapMiB: mib(filled.used - closed.used),
    releasedBackingMiB: filled.backing === null || closed.backing === null ? null : mib(filled.backing - closed.backing),
  });
});

test('Chrome GC observation: a closed running tab stays reachable until its channel ends', async ({ page }, testInfo) => {
  await installChannelIpc(page);
  await openFilledLocal(page);
  const cdp = await page.context().newCDPSession(page);
  expect(await liveTerminals(cdp)).toBe(2);
  const filled = await heap(cdp);
  // Close while the simulated Rust side still holds its channel clone.
  await page.getByRole('button', { name: /^关闭 Local/ }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).historyIpc.closes)).toBe(1);
  // The registered channel callback still reaches the session, so the xterm and its history stay.
  expect(await page.evaluate(() => (window as any).historyIpc.callbacks.size)).toBe(1);
  await settle(page);
  expect(await liveTerminals(cdp)).toBe(2);
  const pending = await heap(cdp);
  await page.evaluate(() => (window as any).historyIpc.end());
  expect(await page.evaluate(() => (window as any).historyIpc.callbacks.size)).toBe(0);
  await settle(page);
  expect(await liveTerminals(cdp)).toBe(1);
  const ended = await heap(cdp);
  await record(testInfo, 'history-budget-close-channel', {
    retainedAfterCloseMiB: mib(total(filled) - total(pending)),
    releasedAfterEndMiB: mib(total(pending) - total(ended)),
  });
  expect(total(pending) - total(ended)).toBeGreaterThan(MIB);
});

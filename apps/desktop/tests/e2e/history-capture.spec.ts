import { test, expect, type CDPSession, type Page, type TestInfo } from '@playwright/test';

// P1 slice 5, step 5: cold-history capture on the production session path
// (docs/p1/HISTORY_BUDGET_PLAN.zh-CN.md). An in-page Tauri IPC stub plays the
// Rust side through the real `Channel` index/end protocol; bytes then go
// through session-lifecycle.ts (Utf8Boundary, ordered ACK) into the
// workbench xterm, and the archive is read back from the live HistoryArchive.
//
// Environment: Chrome + Vite dev server + IPC stub. This is NOT WKWebView,
// WebView2, WebKitGTK, Tauri IPC or a Rust PTY. Timings and heap figures are
// observations of one Chrome renderer, not native results or limits.
test.setTimeout(60_000);

const CHUNK = 4096; // Rust PtyEvent::Data block size
const GROUP = 'history-capture';
const MIB = 1024 * 1024;

/** Stub IPC: keeps Channel callbacks like the Tauri runtime and checks that ACKs arrive in order. */
async function installChannelIpc(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (message: unknown) => void>();
    let nextCallback = 1;
    const state: any = { callbacks, channelId: 0, index: 0, sequence: 0, ptyId: '', opened: 0, acks: 0, ackOrder: true, closes: 0 };
    state.send = (message: unknown) => callbacks.get(state.channelId)?.({ index: state.index++, message });
    state.end = () => callbacks.get(state.channelId)?.({ index: state.index++, end: true });
    /** Sends bytes as Rust would: 4096 B data events, splitting lines and UTF-8 sequences. */
    state.stream = (bytes: Uint8Array, chunk: number) => {
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        state.send({ kind: 'data', id: state.ptyId, sequence: ++state.sequence, data: Array.from(bytes.slice(offset, offset + chunk)) });
      }
      return state.sequence;
    };
    Object.assign(window, {
      isTauri: true,
      captureIpc: state,
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
            state.sequence = 0;
            state.ptyId = `capture-pty-${state.opened}`;
            return Promise.resolve({ id: state.ptyId });
          }
          if (command === 'pty_ack') {
            state.ackOrder &&= args.sequence === state.acks + 1;
            state.acks = args.sequence;
          }
          if (command === 'pty_close') state.closes++;
          if (command === 'pty_shells') return Promise.resolve([]);
          return Promise.resolve(null);
        },
      },
    });
  });
}

/**
 * Test helpers in the page. The workbench's own archives are found through the heap, not by
 * importing history-archive.ts here: after a source edit the dev server serves the app's copy
 * under a `?t=` URL, which would give this page a second, unrelated module instance.
 */
async function installModules(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const terminal = await import('/src/terminal.ts');
    const probe = terminal.createWorkspaceTerminal();
    const terminalPrototype = Object.getPrototypeOf(probe);
    probe.dispose();
    const id = (i: number) => String(i).padStart(6, '0');
    /** One logical line of the mixed stream, with its expected plain text. */
    const line = (i: number): { raw: string; plain: string } => {
      switch (i % 7) {
        case 0: return { raw: `${id(i)} 中文宽字符 🌏 表格`, plain: `${id(i)} 中文宽字符 🌏 表格` };
        case 1: return {
          raw: `\x1b[1;31m${id(i)} red\x1b[0m plain \x1b[38;2;10;20;30mrgb\x1b[0m`,
          plain: `${id(i)} red plain rgb`,
        };
        // Wraps over several rows at any workbench width.
        case 2: return { raw: `${id(i)} ${'abcdefghij'.repeat(25)}末`, plain: `${id(i)} ${'abcdefghij'.repeat(25)}末` };
        case 3: return { raw: '', plain: '' };
        // Combining accent, ZWJ family, skin tone modifier.
        case 4: return { raw: `${id(i)} é 👨‍👩‍👧 👍🏽`, plain: `${id(i)} é 👨‍👩‍👧 👍🏽` };
        // Wide characters across row boundaries leave wrap padding in xterm.
        case 5: return { raw: `${id(i)} ${'漢字'.repeat(80)}`, plain: `${id(i)} ${'漢字'.repeat(80)}` };
        default: return { raw: `${id(i)} plain ascii line`, plain: `${id(i)} plain ascii line` };
      }
    };
    const encode = (lines: string[]) => new TextEncoder().encode(lines.map((l) => `${l}\r\n`).join(''));
    const stripSgr = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
    (window as any).captureQa = { ...terminal, terminalPrototype, line, encode, stripSgr };
  });
}

// V8 also names the synthetic class-field initializer after the class; it has no prototype.
const IS_ARCHIVE_CLASS = "f => f.name === 'HistoryArchive' && typeof f.prototype?.capture === 'function'";

/** The prototype `fn` applies to: the app's xterm Terminal, or the app's HistoryArchive class. */
async function prototypeId(cdp: CDPSession, prototype: 'terminalPrototype' | 'archivePrototype'): Promise<string> {
  if (prototype === 'terminalPrototype') {
    const { result } = await cdp.send('Runtime.evaluate', { expression: 'window.captureQa.terminalPrototype', objectGroup: GROUP });
    return result.objectId!;
  }
  const { result: functionPrototype } = await cdp.send('Runtime.evaluate', { expression: 'Function.prototype', objectGroup: GROUP });
  const { objects: functions } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: functionPrototype.objectId!, objectGroup: GROUP });
  const { result: classes } = await cdp.send('Runtime.callFunctionOn', {
    objectId: functions.objectId!, objectGroup: GROUP, returnByValue: true,
    functionDeclaration: `function () { return this.filter(${IS_ARCHIVE_CLASS}).length; }`,
  });
  if (classes.value !== 1) throw new Error(`expected one HistoryArchive class, found ${classes.value}`);
  const { result } = await cdp.send('Runtime.callFunctionOn', {
    objectId: functions.objectId!, objectGroup: GROUP,
    functionDeclaration: `function () { return this.find(${IS_ARCHIVE_CLASS}).prototype; }`,
  });
  return result.objectId!;
}

/** Live objects with the given prototype after a full GC, then `fn` on that array. */
async function onLive<T>(cdp: CDPSession, prototype: 'terminalPrototype' | 'archivePrototype', fn: string): Promise<T> {
  await cdp.send('HeapProfiler.collectGarbage');
  const { objects } = await cdp.send('Runtime.queryObjects', { prototypeObjectId: await prototypeId(cdp, prototype), objectGroup: GROUP });
  const { result, exceptionDetails } = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objectId!, functionDeclaration: fn, returnByValue: true, awaitPromise: true,
  });
  // The inspector holds every object it returned until the group is released.
  await cdp.send('Runtime.releaseObjectGroup', { objectGroup: GROUP });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  return result.value as T;
}
const liveArchives = (cdp: CDPSession) => onLive<number>(cdp, 'archivePrototype', 'function () { return this.length; }');
const liveTerminals = (cdp: CDPSession) => onLive<number>(cdp, 'terminalPrototype', 'function () { return this.length; }');

interface ArchiveRead {
  stats: Record<string, number>;
  lines: string[];
  /** Raw archived line with SGR, for one coloured line. */
  coloured: string | undefined;
}
/** Seals the partial block of the only live archive and reads every archived line back. */
const readArchive = (cdp: CDPSession) => onLive<ArchiveRead>(cdp, 'archivePrototype', `async function () {
  if (this.length !== 1) throw new Error('expected one live archive, found ' + this.length);
  const archive = this[0];
  await archive.flush(true);
  const stats = archive.stats();
  const raw = await archive.lines(0, stats.archivedLines);
  return { stats, lines: raw.map(window.captureQa.stripSgr), coloured: raw[1] };
}`);

interface Hot { length: number; rows: number; cols: number; scrollback: number }
const hotBuffer = (cdp: CDPSession) => onLive<Hot>(cdp, 'terminalPrototype', `function () {
  const t = this.find(t => t.element && t.element.closest('.terminal-pane[aria-label^="Local"]'));
  return { length: t.buffer.normal.length, rows: t.rows, cols: t.cols, scrollback: t.options.scrollback };
}`);

const diagnostics = (page: Page) => page.evaluate(() => (window as any).__WINDTERM_P0_DIAGNOSTICS__.snapshot() as Record<string, number>);

/** Opens one stubbed local PTY tab. */
async function openLocal(page: Page, query = ''): Promise<void> {
  await page.goto(`/${query}`);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await installModules(page);
  await page.locator('#local-open').click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
}

/** Streams bytes from the page-side generator and waits until every chunk is acknowledged. */
async function streamAndAck(page: Page, script: string): Promise<number> {
  const sent = await page.evaluate(`(() => { const qa = window.captureQa; const ipc = window.captureIpc; ${script} })()`) as number;
  await expect.poll(() => page.evaluate(() => (window as any).captureIpc.acks), { timeout: 30_000 }).toBe(sent);
  expect(await page.evaluate(() => (window as any).captureIpc.ackOrder)).toBe(true);
  return sent;
}

async function record(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  console.log(`${name} ${JSON.stringify(value)}`);
  await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' });
}

test('the archive matches the stub byte stream line by line past the 5,000-line hot window, with no gap', async ({ page }, testInfo) => {
  await installChannelIpc(page);
  await openLocal(page, '?p0Diagnostics');
  const cdp = await page.context().newCDPSession(page);
  const total = 12_000;
  const hot = await hotBuffer(cdp);
  const chunks = await streamAndAck(page, `
    const lines = Array.from({ length: ${total} }, (_, i) => qa.line(i).raw);
    // Then enough empty lines to push every stream line off screen.
    return ipc.stream(qa.encode([...lines, ...Array(${hot.rows}).fill('')]), ${CHUNK});`);
  const archived = await readArchive(cdp);
  const expected = await page.evaluate((n) => Array.from({ length: n }, (_, i) => (window as any).captureQa.line(i).plain), total);
  const after = await hotBuffer(cdp);
  const firstMismatch = expected.findIndex((line, i) => archived.lines[i] !== line);
  const snapshot = await diagnostics(page);
  await record(testInfo, 'history-capture-stream', {
    chunks, cols: after.cols, rows: after.rows, hotLength: after.length, stats: archived.stats,
    captureMs: Math.round(snapshot.historyCaptureMs), maxCaptureMs: Math.round(snapshot.historyMaxCaptureMs * 100) / 100,
  });
  // The hot window was full and trimmed: the oldest stream lines are only in the archive now.
  expect(after.scrollback).toBe(5000);
  expect(after.length).toBe(after.rows + 5000);
  expect(firstMismatch).toBe(-1);
  expect(archived.lines.slice(total).every((line) => line === '')).toBe(true);
  expect(archived.coloured).toBe('\x1b[0;1;31m000001 red\x1b[0m plain \x1b[0;38;2;10;20;30mrgb\x1b[0m');
  expect(archived.stats.gaps).toBe(0);
  expect(archived.stats.clears).toBe(0);
  expect(archived.stats.uncompressedBlocks).toBe(0);
  expect(archived.stats.compressedBytes).toBeLessThan(archived.stats.rawBytes / 4);
  // Development counters agree and are numbers only.
  expect(Object.values(snapshot).every((value) => typeof value === 'number')).toBe(true);
  expect(snapshot.historyArchives).toBe(1);
  expect(snapshot.historyArchivedLines).toBe(archived.stats.archivedLines);
  expect(snapshot.historyGaps).toBe(0);
  expect(snapshot.historySessionBudgetExceeded).toBe(0);
  expect(snapshot.historyTotalBudgetExceeded).toBe(0);
  expect(snapshot.historyCaptureErrors).toBe(0);
  expect(snapshot.ackCompleted).toBe(chunks);
});

test('a write that outruns the hot window is counted as one gap, and capture continues after it', async ({ page }) => {
  await installChannelIpc(page);
  await openLocal(page, '?p0Diagnostics');
  const cdp = await page.context().newCDPSession(page);
  const { rows } = await hotBuffer(cdp);
  // REP (CSI Ps b) repeats one character: a few bytes become one logical line of far more rows
  // than the 5,000-line hot window, so its start is trimmed before it can be archived.
  await streamAndAck(page, `
    const before = Array.from({ length: 100 }, (_, i) => 'before ' + i);
    const after = Array.from({ length: 100 }, (_, i) => 'after ' + i);
    // Every "before" line is archived before the burst arrives.
    ipc.stream(qa.encode([...before, ...Array(${rows}).fill('')]), ${CHUNK});
    ipc.stream(new TextEncoder().encode('x\\x1b[999999b\\r\\n'), ${CHUNK});
    return ipc.stream(qa.encode([...after, ...Array(${rows}).fill('')]), ${CHUNK});`);
  const archived = await readArchive(cdp);
  const named = archived.lines.filter((line) => /^(before|after) /.test(line));
  expect(named).toEqual([
    ...Array.from({ length: 100 }, (_, i) => `before ${i}`),
    ...Array.from({ length: 100 }, (_, i) => `after ${i}`),
  ]);
  expect(archived.stats.gaps).toBe(1);
  expect((await diagnostics(page)).historyGaps).toBe(1);
});

test('clear, Ctrl-L, reset and the alternate screen neither duplicate nor invent gaps', async ({ page }) => {
  await installChannelIpc(page);
  await openLocal(page, '?p0Diagnostics');
  const cdp = await page.context().newCDPSession(page);
  const { rows } = await hotBuffer(cdp);
  test.skip(rows > 30, 'expectations assume at most 30 visible rows');
  const segment = (name: string) => Array.from({ length: 30 }, (_, i) => `${name}${i}`);
  // One chunk per step, as an interactive shell would emit them.
  await streamAndAck(page, `
    const segment = (name) => Array.from({ length: 30 }, (_, i) => name + i);
    const bytes = (text) => new TextEncoder().encode(text);
    ipc.stream(qa.encode(segment('a')), ${CHUNK});
    ipc.stream(bytes('\\x1b[H\\x1b[2J'), ${CHUNK});            // Ctrl-L: erase the screen only
    ipc.stream(qa.encode(segment('b')), ${CHUNK});
    ipc.stream(bytes('\\x1b[H\\x1b[2J\\x1b[3J'), ${CHUNK});    // clear: screen and scrollback
    ipc.stream(qa.encode(segment('c')), ${CHUNK});
    ipc.stream(bytes('\\x1bc'), ${CHUNK});                     // reset (RIS)
    ipc.stream(qa.encode(segment('d')), ${CHUNK});
    ipc.stream(bytes('\\x1b[?1049h' + segment('alt').join('\\r\\n') + '\\x1b[?1049l'), ${CHUNK});
    return ipc.stream(qa.encode([...segment('e'), ...Array(${rows}).fill('')]), ${CHUNK});`);
  const archived = await readArchive(cdp);
  // 30 lines plus the cursor row: the first 31 - rows of a segment left the screen before it was
  // erased; the rest were still on screen and are gone, as in the terminal itself.
  const off = 31 - rows;
  expect(archived.lines.filter((line) => line !== '')).toEqual([
    ...segment('a').slice(0, off), ...segment('b').slice(0, off), ...segment('c').slice(0, off),
    ...segment('d'), ...segment('e'),
  ]);
  expect(archived.stats.gaps).toBe(0);
  expect(archived.stats.clears).toBe(2);
  const snapshot = await diagnostics(page);
  expect(snapshot.historyGaps).toBe(0);
  expect(snapshot.historyClears).toBe(2);
});

test('Chrome GC observation: closing a running tab releases its archive before the channel ends (R2)', async ({ page }) => {
  await installChannelIpc(page);
  // Without the diagnostics query: the production-like path.
  await openLocal(page);
  const cdp = await page.context().newCDPSession(page);
  await streamAndAck(page, `return ipc.stream(qa.encode(Array.from({ length: 8000 }, (_, i) => qa.line(i).raw)), ${CHUNK});`);
  expect(await liveArchives(cdp)).toBe(1);
  await onLive(cdp, 'archivePrototype', 'function () { window.captureQa.weak = new WeakRef(this[0]); }');
  await page.getByRole('button', { name: /^关闭 Local/ }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).captureIpc.closes)).toBe(1);
  // The simulated Rust side still holds its channel clone: the callback is registered, detached.
  expect(await page.evaluate(() => (window as any).captureIpc.callbacks.size)).toBe(1);
  expect(await liveArchives(cdp)).toBe(0);
  expect(await liveTerminals(cdp)).toBe(1);
  expect(await page.evaluate(() => (window as any).captureQa.weak.deref() === undefined)).toBe(true);
});

test('Chrome GC observation: an exited tab keeps its archive until it is closed (R2)', async ({ page }) => {
  await installChannelIpc(page);
  await openLocal(page, '?p0Diagnostics');
  const cdp = await page.context().newCDPSession(page);
  await streamAndAck(page, `return ipc.stream(qa.encode(Array.from({ length: 8000 }, (_, i) => qa.line(i).raw)), ${CHUNK});`);
  await page.evaluate(() => {
    const ipc = (window as any).captureIpc;
    ipc.send({ kind: 'exit', id: ipc.ptyId, code: 0 });
    ipc.end();
  });
  await expect(page.locator('#terminal-state')).toContainText('已退出 · code 0');
  expect(await liveArchives(cdp)).toBe(1);
  const kept = await readArchive(cdp);
  expect(kept.lines.length).toBeGreaterThan(7900);
  expect((await diagnostics(page)).historyArchives).toBe(1);
  await onLive(cdp, 'archivePrototype', 'function () { window.captureQa.weak = new WeakRef(this[0]); }');
  await page.getByRole('button', { name: /^关闭 Local/ }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect(await liveArchives(cdp)).toBe(0);
  expect(await page.evaluate(() => (window as any).captureQa.weak.deref() === undefined)).toBe(true);
  const snapshot = await diagnostics(page);
  expect(snapshot.historyArchives).toBe(0);
  expect(snapshot.historyCompressedBytes).toBe(0);
});

test('Chrome observation: capture time and archive heap against an identical terminal without capture', async ({ page }, testInfo) => {
  await page.goto('/');
  await installModules(page);
  // The archive and boundary the session glue uses, imported into the page; the glue itself only
  // adds a try/catch and the (here disabled) diagnostics around `capture()`.
  await page.evaluate(async () => {
    const qa = (window as any).captureQa;
    qa.archiveModule = await import('/src/terminal-compat/history-archive.ts');
    qa.coreModule = await import('/src/terminal-core.ts');
    qa.budgetModule = await import('/src/history-budget.ts');
  });
  const cdp = await page.context().newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const usage = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; backingStorageSize?: number };
    return usage.usedSize + (usage.backingStorageSize ?? 0);
  };
  const loads = [
    // The responsiveness.spec.ts load: 'y' lines, 1365 per 4095 B chunk.
    { kind: 'yes', lines: 300_000, chunk: 4095 },
    { kind: 'mixed', lines: 30_000, chunk: CHUNK },
  ] as const;
  const results: Record<string, unknown>[] = [];
  for (const { kind, lines, chunk } of loads) {
    for (const withCapture of [false, true]) {
      const before = await heap();
      const run = await page.evaluate(async ({ kind, lines, withCapture, chunk }) => {
        const qa = (window as any).captureQa;
        const holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:600px';
        document.body.append(holder);
        const session = qa.createWorkspaceSession();
        session.terminal.open(holder);
        session.terminal.resize(114, 20);
        const archive = withCapture
          ? new qa.archiveModule.HistoryArchive(qa.coreModule.xtermHistorySource(session.terminal), qa.budgetModule.ARCHIVE_BLOCK_LINES)
          : undefined;
        const bytes = qa.encode(Array.from({ length: lines }, (_, i) => (kind === 'yes' ? 'y' : qa.line(i).raw)));
        let captureMs = 0;
        const started = performance.now();
        await new Promise<void>((resolve) => {
          let pending = 0;
          for (let offset = 0; offset < bytes.length; offset += chunk) {
            pending++;
            session.terminal.write(bytes.slice(offset, offset + chunk), () => {
              if (archive) {
                const t = performance.now();
                archive.capture();
                captureMs += performance.now() - t;
              }
              if (--pending === 0) resolve();
            });
          }
        });
        const elapsedMs = performance.now() - started;
        await archive?.flush();
        qa.current = { session, archive, holder };
        if (archive) qa.weak = new WeakRef(archive);
        return { chunks: Math.ceil(bytes.length / chunk), elapsedMs, captureMs, stats: archive?.stats() };
      }, { kind, lines, withCapture, chunk });
      const filled = await heap();
      await page.evaluate(() => {
        const { session, archive, holder } = (window as any).captureQa.current;
        archive?.dispose();
        session.vt.dispose();
        session.terminal.dispose();
        holder.remove();
        (window as any).captureQa.current = undefined;
      });
      // Pending xterm frames and timers still reach the terminal; let them run first.
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
      }));
      const released = await heap();
      results.push({
        kind, lines, withCapture, chunks: run.chunks,
        elapsedMs: Math.round(run.elapsedMs), captureMs: Math.round(run.captureMs * 10) / 10,
        retainedMiB: Math.round(((filled - before) / MIB) * 100) / 100,
        releasedMiB: Math.round(((filled - released) / MIB) * 100) / 100,
        stats: run.stats,
      });
      if (run.stats) {
        expect(run.stats.gaps).toBe(0);
        expect(await page.evaluate(() => (window as any).captureQa.weak.deref() === undefined)).toBe(true);
      }
    }
  }
  await record(testInfo, 'history-capture-overhead', { results });
});

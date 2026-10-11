import { test, expect, type Page } from '@playwright/test';

// Bounded IPC stub + the application's actual xterm instance. This is not a WKWebView benchmark.
async function installStream(page: Page) {
  await page.addInitScript(() => {
    const state: any = {
      channel: null, sent: 0, acknowledged: 0, limit: 0, running: false,
      statusMutations: 0, statusNodes: {}, ackOrder: true, maxOutstanding: 0,
      input: [], keydownAt: 0, start: 0, elapsed: 0, done: false,
    };
    document.addEventListener('keydown', event => {
      if (event.ctrlKey && event.key.toLowerCase() === 'c') state.keydownAt = performance.now();
    }, true);
    const bytes = Array.from(new TextEncoder().encode('y\r\n'.repeat(1365)));
    state.pump = () => {
      while (state.running && state.sent < state.limit && state.sent - state.acknowledged < 16) {
        const sequence = ++state.sent;
        state.maxOutstanding = Math.max(state.maxOutstanding, state.sent - state.acknowledged);
        state.channel.onmessage({ kind: 'data', id: 'load-pty', sequence, data: bytes });
      }
    };
    state.begin = (limit: number) => {
      state.limit = limit; state.start = performance.now(); state.running = true; state.pump();
    };
    Object.assign(window, {
      isTauri: true, responsivenessStub: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke: (command: string, args: any) => {
          if (command === 'pty_open') { state.channel = args.onEvent; return Promise.resolve({ id: 'load-pty' }); }
          if (command === 'pty_ack') {
            state.ackOrder &&= args.sequence === state.acknowledged + 1;
            state.acknowledged = args.sequence;
            queueMicrotask(state.pump);
            if (state.acknowledged === state.limit || (!state.running && state.acknowledged === state.sent)) {
              state.done = true; state.elapsed = performance.now() - state.start;
            }
          }
          if (command === 'pty_write') {
            state.input.push({ time: performance.now(), data: args.data });
            if (state.holdWrite) return new Promise(resolve => { state.releaseWrite = resolve; });
          }
          return Promise.resolve(null);
        },
      },
    });
  });
  await page.goto('/?p0Diagnostics');
  await page.locator('#local-open').click();
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
  await page.evaluate(() => {
    const state = (window as any).responsivenessStub;
    const observer = new MutationObserver(records => {
      state.statusMutations += records.length;
      for (const record of records) {
        const id = (record.target as Element).id;
        state.statusNodes[id] = (state.statusNodes[id] ?? 0) + 1;
      }
    });
    for (const id of ['terminal-state', 'terminal-size', 'session-detail', 'sample-run', 'stress-run']) {
      observer.observe(document.getElementById(id)!, { childList: true, attributes: true, attributeFilter: ['disabled'] });
    }

  });
}

test('bounded high-output stream preserves ACK order and measures status work', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await installStream(page);
  await page.evaluate(() => (window as any).responsivenessStub.begin(512));
  await expect.poll(() => page.evaluate(() => (window as any).responsivenessStub.done), { timeout: 30_000 }).toBe(true);
  const result = await page.evaluate(() => {
    const s = (window as any).responsivenessStub;
    return { blocks: s.sent, bytes: s.sent * 4095, elapsedMs: s.elapsed, acknowledged: s.acknowledged, ackOrder: s.ackOrder, maxOutstanding: s.maxOutstanding, statusNodes: s.statusNodes, diagnostics: (window as any).__WINDTERM_P0_DIAGNOSTICS__.snapshot() };
  });
  await testInfo.attach('stream-metrics.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.ackOrder).toBe(true);
  expect(result.acknowledged).toBe(512);
  expect(result.maxOutstanding).toBeLessThanOrEqual(16);
  expect(result.statusNodes['terminal-size'] ?? 0).toBeLessThanOrEqual(Math.ceil(result.elapsedMs / 100) + 1);
  for (const id of ['terminal-state', 'session-detail', 'sample-run', 'stress-run']) expect(result.statusNodes[id] ?? 0).toBe(0);
  expect(result.diagnostics.ackCompleted).toBe(512);
  expect(result.diagnostics.parsedChunks).toBe(512);
  await expect(page.locator('#terminal-size')).toContainText('2,096,640 B');
});

test('terminal Ctrl-C input is delivered while high-output ACKs continue', async ({ page }, testInfo) => {
  test.setTimeout(45_000);
  await installStream(page);
  await page.locator('.terminal-pane:visible textarea').focus();
  await page.evaluate(() => (window as any).responsivenessStub.begin(2048));
  await expect.poll(() => page.evaluate(() => (window as any).responsivenessStub.acknowledged), { timeout: 30_000 }).toBeGreaterThan(16);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => (window as any).responsivenessStub.input.some((entry: any) => entry.data.length === 1 && entry.data[0] === 3)), { timeout: 10_000 }).toBe(true);
  const result = await page.evaluate(() => {
    const s = (window as any).responsivenessStub;
    s.running = false;
    return { acknowledgedAtStop: s.acknowledged, sentAtStop: s.sent, input: s.input, durationToInputMs: s.input[0].time - s.start, keydownToIpcMs: s.input[0].time - s.keydownAt };
  });
  await testInfo.attach('input-metrics.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect(result.acknowledgedAtStop).toBeGreaterThan(16);
  expect(result.acknowledgedAtStop).toBeLessThan(2048);
  expect(result.keydownToIpcMs).toBeLessThan(1000);
});

for (const kind of ['error', 'exit'] as const) {
  test(`${kind} status is visible synchronously while a bytes refresh is pending`, async ({ page }) => {
    await installStream(page);
    const result = await page.evaluate(async kind => {
      const s = (window as any).responsivenessStub;
      s.begin(1);
      while (!s.done) await new Promise(resolve => setTimeout(resolve, 1));
      s.channel.onmessage(kind === 'error'
        ? { kind, id: 'load-pty', message: 'TEST immediate error' }
        : { kind, id: 'load-pty', code: 7 });
      return document.getElementById('terminal-state')!.textContent;
    }, kind);
    expect(result).toContain(kind === 'error' ? 'TEST immediate error' : '已退出 · code 7');
  });
}

test('background terminal output does not repaint active demo status', async ({ page }) => {
  await installStream(page);
  await page.getByRole('tab').first().click();
  await expect(page.locator('#terminal-state')).toContainText('演示就绪');
  await page.evaluate(() => { const s = (window as any).responsivenessStub; s.statusNodes = {}; s.begin(64); });
  await expect.poll(() => page.evaluate(() => (window as any).responsivenessStub.done)).toBe(true);
  expect(await page.evaluate(() => (window as any).responsivenessStub.statusNodes)).toEqual({});
  await expect(page.locator('#terminal-state')).toContainText('演示就绪');
});

test('diagnostics require an explicit development query and expose counters only', async ({ page }) => {
  await page.goto('/');
  expect(await page.evaluate(() => '__WINDTERM_P0_DIAGNOSTICS__' in window)).toBe(false);
  await installStream(page);
  const snapshot = await page.evaluate(() => (window as any).__WINDTERM_P0_DIAGNOSTICS__.snapshot());
  expect(Object.values(snapshot).every(value => typeof value === 'number')).toBe(true);
  expect(snapshot.pendingInputBytes).toBe(0);
});

test('development counters reveal input queue wait without recording input contents', async ({ page }) => {
  await installStream(page);
  await page.evaluate(() => { (window as any).responsivenessStub.holdWrite = true; });
  const textarea = page.locator('.terminal-pane:visible textarea');
  await textarea.focus();
  await page.keyboard.type('a');
  await expect.poll(() => page.evaluate(() => (window as any).responsivenessStub.input.length)).toBe(1);
  await page.keyboard.press('Control+c');
  await expect.poll(() => page.evaluate(() => (window as any).__WINDTERM_P0_DIAGNOSTICS__.snapshot().pendingInputBytes)).toBe(2);
  await page.evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    const s = (window as any).responsivenessStub;
    s.holdWrite = false;
    s.releaseWrite(null);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__WINDTERM_P0_DIAGNOSTICS__.snapshot().pendingInputBytes)).toBe(0);
  const result = await page.evaluate(() => ({
    snapshot: (window as any).__WINDTERM_P0_DIAGNOSTICS__.snapshot(),
    writes: (window as any).responsivenessStub.input.map((entry: any) => entry.data),
  }));
  expect(result.writes).toEqual([[97], [3]]);
  expect(result.snapshot.maxPendingInputBytes).toBe(2);
  expect(result.snapshot.maxInputWaitMs).toBeGreaterThanOrEqual(30);
  expect(Object.values(result.snapshot).every(value => typeof value === 'number')).toBe(true);
});

import { test, expect, type Page } from '@playwright/test';

// Contract tests of `session-lifecycle.ts` through its own entries, with a recording host and a
// stub IPC boundary. They check the module boundary (the lifecycle reaches the workbench only
// through its host); they do not exercise a native PTY.
async function installLifecycle(page: Page) {
  await page.addInitScript(() => {
    const state: any = { calls: [], channels: [], opens: [] };
    Object.assign(window, {
      isTauri: true,
      qaIpc: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: (command: string, args: any = {}) => {
          state.calls.push({ command, id: args.id, sequence: args.sequence, cols: args.cols, rows: args.rows });
          if (command === 'pty_open') {
            state.channels.push(args.onEvent);
            return new Promise((resolve, reject) => state.opens.push({ resolve, reject }));
          }
          return Promise.resolve(null);
        },
      },
    });
  });
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.locator('#terminal-state')).toContainText('演示就绪');
  await page.evaluate(async () => {
    const module = await import(/* @vite-ignore */ '/src/session-lifecycle.ts');
    const events: string[] = [];
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;left:-10000px;width:800px;height:500px';
    document.body.append(container);
    const lifecycle = module.createSessionLifecycle({
      theme: () => ({}),
      // Hidden like an inactive workbench pane, so no fit changes the size under test.
      mount: (pane: HTMLElement) => { events.push('mount'); pane.hidden = true; container.append(pane); },
      notify: (message: string) => events.push(`notify:${message}`),
      registered: (s: any) => events.push(`registered:${s.name}`),
      focused: (s: any) => events.push(`focused:${s.name}`),
      changed: () => events.push('changed'),
      status: () => events.push('status'),
      progress: (key: number) => events.push(`progress:${key}`),
      removed: (key: number) => events.push(`removed:${key}`),
    });
    Object.assign(window, { qaLifecycle: { module, lifecycle, events, container } });
  });
}
const workbench = (page: Page) => page.evaluate(() => ({
  tabs: document.querySelector('#tabs')!.innerHTML,
  list: document.querySelector('#session-list')!.innerHTML,
  panes: document.querySelector('#terminals')!.childElementCount,
  state: document.querySelector('#terminal-state')!.textContent,
}));
const commands = (page: Page, name: string) =>
  page.evaluate((name) => (window as any).qaIpc.calls.filter((c: any) => c.command === name), name);

test('lifecycle entries open, resize, ACK, exit and reopen through the host only', async ({ page }) => {
  await installLifecycle(page);
  const before = await workbench(page);
  const first = await page.evaluate(() => {
    const { lifecycle } = (window as any).qaLifecycle;
    const s = lifecycle.openLocal('Probe');
    s.terminal.resize(90, 30);
    return { key: s.key, status: s.status, size: lifecycle.sessions.size };
  });
  expect(first).toEqual({ key: 1, status: '正在启动…', size: 1 });
  // A resize before the native ID exists is not sent; the opened PTY receives the current size.
  expect(await commands(page, 'pty_resize')).toEqual([]);
  await page.evaluate(() => (window as any).qaIpc.opens[0].resolve({ id: 'probe-1' }));
  await expect.poll(() => commands(page, 'pty_resize')).toEqual([{ command: 'pty_resize', id: 'probe-1', cols: 90, rows: 30 }]);
  await page.evaluate(() => {
    const channel = (window as any).qaIpc.channels[0];
    channel.onmessage({ kind: 'data', id: 'probe-1', sequence: 0, data: [111, 107] });
    channel.onmessage({ kind: 'data', id: 'probe-1', sequence: 1, data: [10] });
  });
  await expect.poll(() => commands(page, 'pty_ack')).toEqual([
    { command: 'pty_ack', id: 'probe-1', sequence: 0 },
    { command: 'pty_ack', id: 'probe-1', sequence: 1 },
  ]);
  const ended = await page.evaluate(() => {
    const { lifecycle } = (window as any).qaLifecycle;
    const s = lifecycle.sessions.get(1);
    const refusedWhileLive = lifecycle.reopenLocal(s, 'Too early') === undefined;
    (window as any).qaIpc.channels[0].onmessage({ kind: 'exit', id: 'probe-1', code: 0 });
    const next = lifecycle.reopenLocal(s, 'Probe again');
    return { refusedWhileLive, status: s.status, ptyId: s.ptyId ?? null, nextKey: next.key, sessions: [...lifecycle.sessions.keys()] };
  });
  expect(ended).toEqual({ refusedWhileLive: true, status: '已退出 · code 0', ptyId: null, nextKey: 2, sessions: [1, 2] });
  expect(await commands(page, 'pty_open')).toHaveLength(2);
  const events = await page.evaluate(() => (window as any).qaLifecycle.events as string[]);
  expect(events.filter((e) => /^(mount|registered|removed)/.test(e))).toEqual([
    'mount', 'registered:Probe', 'mount', 'registered:Probe again',
  ]);
  expect(events).toContain('progress:1');
  expect(await page.evaluate(() => (window as any).qaLifecycle.container.childElementCount)).toBe(2);
  // The page's own workbench is untouched by this lifecycle.
  expect(await workbench(page)).toEqual(before);
});

test('exit before open, then close: removed once, late ID closed, no reopen', async ({ page }) => {
  await installLifecycle(page);
  const before = await workbench(page);
  const result = await page.evaluate(async () => {
    const { lifecycle } = (window as any).qaLifecycle;
    const s = lifecycle.openLocal('Pending');
    (window as any).qaIpc.channels[0].onmessage({ kind: 'exit', id: 'late-1', code: 0 });
    await Promise.all([lifecycle.close(s.key), lifecycle.close(s.key)]);
    const reopened = lifecycle.reopenLocal(s, 'Revived') ?? null;
    (window as any).qaIpc.opens[0].resolve({ id: 'late-1' });
    return { reopened, ptyId: s.ptyId ?? null };
  });
  expect(result).toEqual({ reopened: null, ptyId: null });
  await expect.poll(() => commands(page, 'pty_close')).toEqual([{ command: 'pty_close', id: 'late-1' }]);
  const after = await page.evaluate(() => {
    const { lifecycle, events, container } = (window as any).qaLifecycle;
    return {
      sessions: lifecycle.sessions.size,
      panes: container.childElementCount,
      removed: events.filter((e: string) => e.startsWith('removed')),
    };
  });
  expect(after).toEqual({ sessions: 0, panes: 0, removed: ['removed:1'] });
  expect(await commands(page, 'pty_open')).toHaveLength(1);
  expect(await commands(page, 'pty_resize')).toEqual([]);
  expect(await workbench(page)).toEqual(before);
});

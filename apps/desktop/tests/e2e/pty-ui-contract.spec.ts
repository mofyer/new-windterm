import { test, expect, type Page } from '@playwright/test';

// Frontend contract tests with a stub IPC boundary, not native PTY integration.
async function installIpc(page: Page) {
  await page.addInitScript(() => {
    const state: any = { calls: [], pendingOpen: null, channel: null, failClose: false, holdAck: false, resolveAck: null, holdWrite: false, resolveWrite: null };
    Object.assign(window, {
      isTauri: true,
      qaIpc: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: (command: string, args: any) => {
          state.calls.push({ command, id: args.id, sequence: args.sequence, data: args.data });
          if (command === 'pty_open') {
            state.channel = args.onEvent;
            return new Promise(resolve => state.pendingOpen = resolve);
          }
          if (command === 'pty_close' && state.failClose) return Promise.reject('TEST close failure');
          if (command === 'pty_ack' && state.holdAck) return new Promise(resolve => state.resolveAck = resolve);
          if (command === 'pty_write' && state.holdWrite) return new Promise(resolve => state.resolveWrite = resolve);
          return Promise.resolve(null);
        },
      },
    });
  });
  await page.goto('/');
  await page.locator('#local-open').click();
  await expect(page.getByRole('tab')).toHaveCount(2);
}
async function ready(page: Page) {
  await page.evaluate(() => (window as any).qaIpc.pendingOpen({ id: 'test-pty' }));
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
}

test('closing while PTY opens closes the late arriving native ID', async ({ page }) => {
  await installIpc(page);
  await page.locator('.tab-close').last().click();
  await page.evaluate(() => (window as any).qaIpc.pendingOpen({ id: 'late-id' }));
  await expect.poll(() => page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_close'))).toEqual([{ command: 'pty_close', id: 'late-id' }]);
  await expect(page.getByRole('tab')).toHaveCount(1);
});
test('PTY exit before open resolves cannot resurrect a running session', async ({ page }) => {
  await installIpc(page);
  await page.evaluate(() => {
    const state = (window as any).qaIpc;
    state.channel.onmessage({ kind: 'exit', id: 'test-pty', code: 0 });
    state.pendingOpen({ id: 'test-pty' });
  });
  await expect(page.locator('#terminal-state')).toContainText('已退出 · code 0');
  expect(await page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_resize'))).toEqual([]);
});
test('failed native close retains the tab for retry', async ({ page }) => {
  await installIpc(page);
  await ready(page);
  await page.evaluate(() => (window as any).qaIpc.failClose = true);
  await page.locator('.tab-close').last().click();
  await expect(page.getByRole('status')).toContainText('会话关闭失败');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.evaluate(() => (window as any).qaIpc.failClose = false);
  await page.locator('.tab-close').last().click();
  await expect(page.getByRole('tab')).toHaveCount(1);
});
test('output ACKs wait for parsing and preceding acknowledgement completion', async ({ page }) => {
  await installIpc(page);
  await ready(page);
  await page.evaluate(() => {
    const state = (window as any).qaIpc;
    state.holdAck = true;
    state.channel.onmessage({ kind: 'data', id: 'test-pty', sequence: 1, data: [...new TextEncoder().encode('ACK-FIRST\r\n')] });
    state.channel.onmessage({ kind: 'data', id: 'test-pty', sequence: 2, data: [...new TextEncoder().encode('ACK-SECOND\r\n')] });
  });
  await expect(page.locator('.terminal-pane:visible .xterm-accessibility-tree')).toContainText('ACK-SECOND');
  expect(await page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_ack').map((c: any) => c.sequence))).toEqual([1]);
  await page.evaluate(() => {
    const state = (window as any).qaIpc; state.holdAck = false; state.resolveAck(null);
  });
  await expect.poll(() => page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_ack').map((c: any) => c.sequence))).toEqual([1, 2]);
});
test('large terminal input is split and waits for each IPC write', async ({ page }) => {
  await installIpc(page);
  await ready(page);
  await page.evaluate(() => (window as any).qaIpc.holdWrite = true);
  await page.locator('.terminal-pane:visible textarea').focus();
  await page.locator('.terminal-pane:visible textarea').evaluate(el => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'a'.repeat(5000));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  });
  await expect.poll(() => page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_write').map((c: any) => c.data.length))).toEqual([4096]);
  await page.evaluate(() => {
    const state = (window as any).qaIpc; state.holdWrite = false; state.resolveWrite(null);
  });
  await expect.poll(() => page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_write').map((c: any) => c.data.length))).toEqual([4096, 904]);
});

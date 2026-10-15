import { test, expect, type Page } from '@playwright/test';

// Frontend contract tests with a stub IPC boundary, not native PTY integration.
async function installIpc(page: Page) {
  await page.addInitScript(() => {
    const state: any = { calls: [], pendingOpen: null, rejectOpen: null, rejectResize: null, holdResize: false, channel: null, failClose: false, holdAck: false, resolveAck: null, holdWrite: false, resolveWrite: null };
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
            return new Promise((resolve, reject) => { state.pendingOpen = resolve; state.rejectOpen = reject; });
          }
          if (command === 'pty_resize' && state.holdResize) return new Promise((_resolve, reject) => state.rejectResize = reject);
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

test('terminal replies produced before the native ID arrive are sent once it exists', async ({ page }) => {
  await installIpc(page);
  // ConPTY asks for the cursor position before pty_open has returned.
  await page.evaluate(() => (window as any).qaIpc.channel.onmessage({ kind: 'data', id: 'test-pty', sequence: 1, data: [27, 91, 54, 110] }));
  await expect.poll(() => page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_ack').length)).toBe(1);
  expect(await page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_write'))).toEqual([]);
  await ready(page);
  const writes = await page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_write'));
  expect(writes).toHaveLength(1);
  const reply = String.fromCharCode(...writes[0].data);
  expect(writes[0].id).toBe('test-pty');
  expect(reply).toMatch(/^\x1b\[\d+;\d+R$/);
});


async function typeInput(page: Page, text: string) {
  await page.locator('.terminal-pane:visible textarea').focus();
  await page.keyboard.type(text);
}

for (const failure of ['open', 'exit'] as const) {
  test(`${failure} ends input and reopening creates a fresh PTY without replaying old input`, async ({ page }) => {
    await installIpc(page);
    await typeInput(page, 'OLD-EARLY');
    await page.evaluate(failure => {
      const state = (window as any).qaIpc;
      if (failure === 'open') state.rejectOpen('TEST open failure');
      else {
        state.channel.onmessage({ kind: 'data', id: 'old-id', sequence: 1, data: [...new TextEncoder().encode('OLD-OUTPUT\r\n')] });
        state.channel.onmessage({ kind: 'exit', id: 'old-id', code: 0 });
        state.pendingOpen({ id: 'old-id' });
      }
    }, failure);
    await expect(page.locator('#terminal-state')).toContainText(failure === 'open' ? '启动失败' : '已退出');
    await expect(page.locator('#session-detail')).toContainText('不再发送输入');
    await typeInput(page, 'AFTER-END');
    const reopen = page.getByRole('button', { name: '重新打开本地终端', exact: true });
    await expect(reopen).toBeEnabled();
    // A rapid second click must not open a second replacement session.
    await reopen.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    await expect(page.getByRole('tab')).toHaveCount(3);
    await expect.poll(() => page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_open').length)).toBe(2);
    await page.evaluate(() => (window as any).qaIpc.pendingOpen({ id: 'fresh-id' }));
    await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
    await expect(reopen).toBeHidden();
    expect(await page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_write'))).toEqual([]);
    await typeInput(page, 'NEW');
    await expect.poll(() => page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_write').map((c: any) => ({ id: c.id, text: String.fromCharCode(...c.data) })))).toEqual([
      { id: 'fresh-id', text: 'N' }, { id: 'fresh-id', text: 'E' }, { id: 'fresh-id', text: 'W' },
    ]);
    await page.getByRole('tab').nth(1).click();
    await expect(page.locator('.terminal-pane:visible .xterm-accessibility-tree')).toContainText(failure === 'open' ? '本地 PTY 启动失败' : 'OLD-OUTPUT');
    await typeInput(page, 'IGNORED');
    expect(await page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_write').length)).toBe(3);
  });
}

for (const outcome of ['running', 'exit', 'disposed'] as const) {
  test(`initial resize rejection keeps the ${outcome} lifecycle`, async ({ page }) => {
    await installIpc(page);
    await page.evaluate(() => {
      const state = (window as any).qaIpc;
      state.holdResize = true;
      state.pendingOpen({ id: 'test-pty' });
    });
    await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.rejectResize)).toBe(true);
    if (outcome === 'exit') {
      await page.evaluate(() => (window as any).qaIpc.channel.onmessage({ kind: 'exit', id: 'test-pty', code: 7 }));
    } else if (outcome === 'disposed') {
      await page.locator('.tab-close').last().click();
    }
    await page.evaluate(() => (window as any).qaIpc.rejectResize('TEST resize failure'));
    if (outcome === 'running') {
      await expect(page.locator('#terminal-state')).toContainText('TEST resize failure');
      await expect(page.getByRole('button', { name: '重新打开本地终端', exact: true })).toBeHidden();
      await page.evaluate(() => (window as any).qaIpc.channel.onmessage({ kind: 'data', id: 'test-pty', sequence: 1, data: [...new TextEncoder().encode('AFTER-RESIZE\r\n')] }));
      await expect(page.locator('.terminal-pane:visible .xterm-accessibility-tree')).toContainText('AFTER-RESIZE');
      await typeInput(page, 'x');
      await expect.poll(() => page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_write').length)).toBe(1);
    } else if (outcome === 'exit') {
      await expect(page.locator('#terminal-state')).toContainText('已退出 · code 7');
      await expect(page.getByRole('button', { name: '重新打开本地终端', exact: true })).toBeEnabled();
    } else {
      await expect(page.getByRole('tab')).toHaveCount(1);
      await expect(page.locator('#terminal-state')).toContainText('演示就绪');
    }
    await expect(page.locator('.terminal-pane:visible .xterm-accessibility-tree')).not.toContainText('本地 PTY 启动失败');
  });
}

test('open rejection after an exit does not replace the exit status', async ({ page }) => {
  await installIpc(page);
  await page.evaluate(() => {
    const state = (window as any).qaIpc;
    state.channel.onmessage({ kind: 'exit', id: 'test-pty', code: 9 });
    state.rejectOpen('TEST late open rejection');
  });
  await expect(page.locator('#terminal-state')).toContainText('已退出 · code 9');
  await expect(page.locator('.terminal-pane:visible .xterm-accessibility-tree')).not.toContainText('本地 PTY 启动失败');
});

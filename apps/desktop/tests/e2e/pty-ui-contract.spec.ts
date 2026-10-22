import { test, expect, type Page } from '@playwright/test';

// Frontend contract tests with a stub IPC boundary, not native PTY integration.
async function installIpc(page: Page, openDefault = true) {
  await page.addInitScript(() => {
    const state: any = {
      shellChoices: [
        { id: 'bash', label: 'Bash', path: '/bin/bash', available: true, reason: null },
        { id: 'zsh', label: 'Zsh', path: '/bin/zsh', available: true, reason: null },
        { id: 'pwsh', label: 'PowerShell', path: null, available: false, reason: '未安装 pwsh' },
      ],
      shellError: null, holdShells: false, shellRequests: [], calls: [], pendingOpen: null, rejectOpen: null, rejectResize: null, holdResize: false, channel: null, failClose: false, holdAck: false, resolveAck: null, holdWrite: false, resolveWrite: null };
    Object.assign(window, {
      isTauri: true,
      qaIpc: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: (command: string, args: any = {}) => {
          state.calls.push({ command, id: args.id, sequence: args.sequence, data: args.data, ...(command === 'pty_open' ? { cwd: args.cwd, shell: args.shell } : {}) });
          if (command === 'pty_shells') {
            if (state.holdShells) return new Promise((resolve, reject) => state.shellRequests.push({ resolve, reject }));
            if (state.shellError) return Promise.reject(state.shellError);
            return Promise.resolve(state.shellChoices);
          }
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
  if (openDefault) {
    await page.locator('#local-open').click();
    await expect(page.getByRole('tab')).toHaveCount(2);
  }
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

test('user key, paste and insertText before the native ID are never replayed', async ({ page }) => {
  await installIpc(page);
  await page.locator('.terminal-pane:visible textarea').focus();
  await page.keyboard.type('KEY-EARLY');
  await page.locator('.terminal-pane:visible textarea').evaluate(el => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', 'PASTE-EARLY');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    const input = new InputEvent('input', { inputType: 'insertText', data: 'INSERT-EARLY', bubbles: true });
    el.dispatchEvent(input);
  });
  // A protocol reply is explicitly marked by terminal.input(data, false) and
  // remains the only pre-open input eligible for the bounded early FIFO.
  await page.evaluate(() => (window as any).qaIpc.channel.onmessage({ kind: 'data', id: 'test-pty', sequence: 1, data: [27, 91, 54, 110] }));
  await expect.poll(() => page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_ack').length)).toBe(1);
  await ready(page);
  const writes = await page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_write'));
  expect(writes).toHaveLength(1);
  expect(String.fromCharCode(...writes[0].data)).toMatch(/^\x1b\[\d+;\d+R$/);
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

async function launchWithDirectory(page: Page, cwd: string) {
  await page.locator('#local-options-open').click();
  await page.getByLabel('启动目录', { exact: true }).fill(cwd);
  await page.locator('#local-start').click();
  await expect(page.locator('#local-dialog')).not.toBeVisible();
}
async function requestedDirectories(page: Page) {
  return page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_open').map((c: any) => c.cwd));
}

test('default one-click and empty launch options both send null cwd', async ({ page }) => {
  await installIpc(page);
  await ready(page);
  await launchWithDirectory(page, '');
  expect(await requestedDirectories(page)).toEqual([null, null]);
});

for (const cwd of ['/tmp/中文 project $HOME;$(touch nope)  ', 'C:\\Users\\测试 Project\\work', '   ']) {
  test('launch options preserve exact path characters: ' + JSON.stringify(cwd), async ({ page }) => {
    await installIpc(page, false);
    await launchWithDirectory(page, cwd);
    expect(await requestedDirectories(page)).toEqual([cwd]);
    expect(await page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_write'))).toEqual([]);
  });
}

for (const cwd of [null, '/tmp/original 中文  ']) {
  test('reopen inherits its session directory independently of edited form: ' + JSON.stringify(cwd), async ({ page }) => {
    await installIpc(page, cwd === null);
    if (cwd !== null) await launchWithDirectory(page, cwd);
    await ready(page);
    await page.evaluate(() => (window as any).qaIpc.channel.onmessage({ kind: 'exit', id: 'test-pty', code: 0 }));
    await page.locator('#local-options-open').click();
    await page.locator('#local-cwd-input').fill('/tmp/another');
    await page.locator('#local-dialog').getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('#local-reopen').click();
    expect(await requestedDirectories(page)).toEqual([cwd, cwd]);
    await expect(page.getByRole('tab')).toHaveCount(3);
  });
}

test('backend rejection preserves failed tab and offers directory correction in a new session', async ({ page }) => {
  await installIpc(page, false);
  await launchWithDirectory(page, 'relative/path');
  await page.evaluate(() => (window as any).qaIpc.rejectOpen('启动目录必须是绝对路径'));
  await expect(page.locator('#terminal-state')).toContainText('启动失败：启动目录必须是绝对路径');
  await page.locator('#local-edit-cwd').click();
  await expect(page.locator('#local-cwd-input')).toHaveValue('relative/path');
  await page.locator('#local-cwd-input').fill('/tmp/corrected 中文');
  await page.locator('#local-start').click();
  await ready(page);
  expect(await requestedDirectories(page)).toEqual(['relative/path', '/tmp/corrected 中文']);
  await expect(page.getByRole('tab')).toHaveCount(3);
  await page.getByRole('tab').nth(1).click();
  await expect(page.locator('#terminal-state')).toContainText('启动失败：启动目录必须是绝对路径');
  await page.locator('#local-edit-cwd').click();
  await expect(page.locator('#local-cwd-input')).toHaveValue('relative/path');
});

test('browser launch options clearly explain that no local shell can start', async ({ page }) => {
  await page.goto('/');
  await page.locator('#local-options-open').click();
  await expect(page.locator('#local-runtime-hint')).toContainText('浏览器演示无法启动本机 shell');
  await page.locator('#local-cwd-input').fill('/tmp/example');
  await expect(page.locator('#local-start')).toBeDisabled();
  await page.locator('#local-cwd-input').press('Enter');
  await expect(page.getByRole('tab')).toHaveCount(1);
});


async function requestedShells(page: Page) {
  return page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_open').map((c: any) => c.shell));
}

test('shell discovery runs only on options open and default launch stays unchanged', async ({ page }) => {
  await installIpc(page);
  expect(await requestedShells(page)).toEqual([null]);
  expect(await page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_shells'))).toEqual([]);
  await ready(page);
  await launchWithDirectory(page, '');
  expect(await requestedShells(page)).toEqual([null, null]);
  expect(await page.evaluate(() => (window as any).qaIpc.calls.filter((c: any) => c.command === 'pty_shells').length)).toBe(1);
});

test('shell discovery shows available paths and readable missing reasons', async ({ page }) => {
  await installIpc(page, false);
  await page.locator('#local-options-open').click();
  await expect(page.locator('#local-shell-select option')).toHaveCount(4);
  await expect(page.locator('#local-shell-select option[value="pwsh"]')).toHaveJSProperty('disabled', true);
  await expect(page.locator('#local-shell-missing')).toHaveText('PowerShell：未安装 pwsh');
  await page.locator('#local-shell-select').selectOption('bash');
  await expect(page.locator('#local-shell-status')).toHaveText('Bash · /bin/bash');
  await page.locator('#local-cwd-input').fill('/tmp/中文 project');
  await page.locator('#local-start').click();
  expect(await requestedShells(page)).toEqual(['bash']);
  expect(await requestedDirectories(page)).toEqual(['/tmp/中文 project']);
});

test('discovery labels paths and missing reasons are rendered as text', async ({ page }) => {
  await installIpc(page, false);
  const unsafe = '<img src=x onerror="window.shellInjected=true">';
  await page.evaluate(unsafe => {
    (window as any).qaIpc.shellChoices = [
      { id: 'bash', label: unsafe, path: unsafe, available: true, reason: null },
      { id: 'unknown-shell', label: unsafe, path: null, available: false, reason: unsafe },
    ];
  }, unsafe);
  await page.locator('#local-options-open').click();
  await expect(page.locator('#local-shell-select option[value="bash"]')).toHaveText(unsafe);
  await expect(page.locator('#local-shell-missing')).toContainText(unsafe);
  await page.locator('#local-shell-select').selectOption('bash');
  await expect(page.locator('#local-shell-status')).toContainText(unsafe);
  await expect(page.locator('#local-dialog img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).shellInjected)).toBeUndefined();
});

test('failed discovery reports failure but permits default launch and retries next opening', async ({ page }) => {
  await installIpc(page, false);
  await page.evaluate(() => (window as any).qaIpc.shellError = 'TEST discovery denied');
  await page.locator('#local-options-open').click();
  await expect(page.locator('#local-shell-status')).toContainText('TEST discovery denied');
  await expect(page.locator('#local-start')).toBeEnabled();
  await page.locator('#local-start').click();
  expect(await requestedShells(page)).toEqual([null]);
  await page.evaluate(() => (window as any).qaIpc.shellError = null);
  await page.locator('#local-options-open').click();
  await expect(page.locator('#local-shell-select option[value="bash"]')).toHaveJSProperty('disabled', false);
  await expect(page.locator('#local-shell-status')).not.toContainText('TEST discovery denied');
});

for (const failure of ['open', 'exit'] as const) {
  test(`reopen retains shell and directory after ${failure} despite later form edits`, async ({ page }) => {
    await installIpc(page, false);
    await page.locator('#local-options-open').click();
    await page.locator('#local-shell-select').selectOption('bash');
    await page.locator('#local-cwd-input').fill('/tmp/original');
    await page.locator('#local-start').click();
    if (failure === 'open') {
      await page.evaluate(() => (window as any).qaIpc.rejectOpen('Shell unavailable'));
      await expect(page.locator('#terminal-state')).toContainText('启动失败');
    } else {
      await ready(page);
      await page.evaluate(() => (window as any).qaIpc.channel.onmessage({ kind: 'exit', id: 'test-pty', code: 7 }));
    }
    await page.locator('#local-options-open').click();
    await page.locator('#local-shell-select').selectOption('zsh');
    await page.locator('#local-cwd-input').fill('/tmp/changed');
    await page.locator('#local-dialog').getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('#local-reopen').click();
    expect(await requestedShells(page)).toEqual(['bash', 'bash']);
    expect(await requestedDirectories(page)).toEqual(['/tmp/original', '/tmp/original']);
    await expect(page.getByRole('tab')).toHaveCount(3);
  });
}

for (const unavailable of ['missing', 'removed', 'discovery-failed'] as const) {
  test(`editing ended session preserves explicit shell when ${unavailable}`, async ({ page }) => {
    await installIpc(page, false);
    await page.locator('#local-options-open').click();
    await page.locator('#local-shell-select').selectOption('bash');
    await page.locator('#local-cwd-input').fill('/tmp/original');
    await page.locator('#local-start').click();
    await page.evaluate(unavailable => {
      const state = (window as any).qaIpc;
      state.rejectOpen('TEST shell vanished');
      if (unavailable === 'removed') state.shellChoices = [];
      else if (unavailable === 'missing') state.shellChoices[0] = { ...state.shellChoices[0], available: false, path: null, reason: 'TEST executable removed' };
      else state.shellError = 'TEST unavailable discovery';
    }, unavailable);
    await expect(page.locator('#local-edit-cwd')).toHaveText('修改启动选项');
    await page.locator('#local-edit-cwd').click();
    await expect(page.locator('#local-shell-select')).toHaveValue('bash');
    await expect(page.locator('#local-cwd-input')).toHaveValue('/tmp/original');
    if (unavailable === 'discovery-failed') {
      await expect(page.locator('#local-shell-status')).toContainText('TEST unavailable discovery');
    } else {
      await expect(page.locator('#local-start')).toBeDisabled();
      await expect(page.locator('#local-shell-status')).toContainText('不可用');
    }
    await page.locator('#local-shell-select').selectOption('');
    await expect(page.locator('#local-start')).toBeEnabled();
    await page.locator('#local-start').click();
    expect(await requestedShells(page)).toEqual(['bash', null]);
    await expect(page.getByRole('tab')).toHaveCount(3);
  });
}

for (const oldOutcome of ['resolve', 'reject'] as const) {
  test(`older discovery ${oldOutcome} cannot overwrite reopened dialog`, async ({ page }) => {
    await installIpc(page, false);
    await page.evaluate(() => (window as any).qaIpc.holdShells = true);
    await page.locator('#local-options-open').click();
    await expect(page.locator('#local-shell-status')).toContainText('正在查找');
    await page.locator('#local-dialog').getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('#local-options-open').click();
    await page.evaluate(() => {
      const state = (window as any).qaIpc;
      state.shellRequests[1].resolve(state.shellChoices);
    });
    await page.locator('#local-shell-select').selectOption('zsh');
    await page.evaluate(oldOutcome => {
      const request = (window as any).qaIpc.shellRequests[0];
      if (oldOutcome === 'resolve') request.resolve([{ id: 'old', label: 'OLD', path: '/old', available: true, reason: null }]);
      else request.reject('OLD failure');
    }, oldOutcome);
    await expect(page.locator('#local-shell-select')).toHaveValue('zsh');
    await expect(page.locator('#local-shell-status')).toHaveText('Zsh · /bin/zsh');
    await expect(page.locator('#local-shell-select option[value="old"]')).toHaveCount(0);
  });
}

test('closed discovery completion does not alter form or open a session', async ({ page }) => {
  await installIpc(page, false);
  await page.evaluate(() => (window as any).qaIpc.holdShells = true);
  await page.locator('#local-options-open').click();
  await page.locator('#local-dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.evaluate(() => {
    const state = (window as any).qaIpc;
    state.shellRequests[0].resolve(state.shellChoices);
  });
  await expect(page.locator('#local-dialog')).not.toBeVisible();
  await expect(page.locator('#local-shell-select option')).toHaveCount(1);
  expect(await requestedShells(page)).toEqual([]);
});

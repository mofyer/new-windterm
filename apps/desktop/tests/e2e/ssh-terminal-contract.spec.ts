import { test, expect, type Page } from '@playwright/test';

// Browser IPC contracts. These do not assert real SSH or native network behavior.
async function setup(page: Page) {
  await page.addInitScript(() => {
    const state: any = { calls: [], probe: null, opening: null, channel: null, failClose: false, failCancel: false, holdAck: false, holdWrite: false };
    Object.assign(window, { isTauri: true, sshTerminalQa: state, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke(command: string, args: any = {}) {
        state.calls.push({ command, ...args, onEvent: undefined });
        if (command === 'ssh_context') return Promise.resolve('document-scope');
        if (command === 'ssh_probe') return new Promise(resolve => state.probe = resolve);
        if (command === 'ssh_open') {
          state.channel = args.onEvent; state.id = args.operationId;
          return new Promise((resolve, reject) => state.opening = { resolve, reject });
        }
        if (command === 'ssh_close' && state.failClose) return Promise.reject('SSH close failed');
        if (command === 'ssh_cancel' && state.failCancel) return Promise.reject('SSH cancel failed');
        if (command === 'ssh_ack' && state.holdAck) return new Promise(resolve => state.resolveAck = resolve);
        if (command === 'ssh_write' && state.holdWrite) return new Promise((resolve, reject) => { state.resolveWrite = resolve; state.rejectWrite = reject; });
        return Promise.resolve(null);
      },
    } });
  });
  await page.goto('/');
}
async function calls(page: Page, command: string) {
  return page.evaluate(command => (window as any).sshTerminalQa.calls.filter((c: any) => c.command === command), command);
}
async function challenge(page: Page, host = '127.0.0.1') {
  await page.locator('#connect-open').click();
  await page.locator('#ssh-terminal-open').click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-username').fill('fixture-user');
  await page.locator('#ssh-key-path').fill('/private/temporary/key');
  await page.locator('#ssh-probe').click();
  await page.evaluate(host => (window as any).sshTerminalQa.probe({ challengeToken: 'terminal-token', host, port: 54321, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:actual-server-key', expiresInSeconds: 60 }), host);
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:actual-server-key');
}
async function opening(page: Page) {
  const count = await page.getByRole('tab').count();
  await challenge(page);
  await page.locator('#ssh-accept').click();
  await expect(page.getByRole('tab')).toHaveCount(count + 1);
  await expect(page.locator('#ssh-verification-dialog')).toBeHidden();
}
async function ready(page: Page) {
  await page.evaluate(() => { const s = (window as any).sshTerminalQa; s.opening.resolve({ id: s.id }); });
  await expect(page.locator('#terminal-state')).toContainText('SSH 已连接');
}
async function paste(page: Page, length: number) {
  await page.locator('.terminal-pane:visible textarea').evaluate((el, length) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'a'.repeat(length));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, length);
}

test('browser terminal entry cannot probe or authenticate', async ({ page }) => {
  await page.goto('/');
  await page.locator('#connect-open').click();
  await page.locator('#ssh-terminal-open').click();
  await expect(page.locator('#ssh-verification-title')).toHaveText('连接 SSH 终端');
  await expect(page.locator('#ssh-browser-note')).toBeVisible();
  await expect(page.locator('#ssh-probe')).toBeDisabled();
  await expect(page.locator('#ssh-host')).toBeDisabled();
});

test('terminal requires explicit trust; safe host text and scoped token, no key path in open or storage', async ({ page }) => {
  await setup(page); await challenge(page, '<img src=x onerror=alert(1)>');
  expect(await calls(page, 'ssh_open')).toEqual([]);
  await expect(page.locator('#ssh-accept')).toHaveText('仅本次信任并打开终端');
  await page.locator('#ssh-accept').click();
  const opened = await calls(page, 'ssh_open');
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ scopeToken: 'document-scope', challengeToken: 'terminal-token' });
  expect(opened[0].operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(JSON.stringify(opened)).not.toContain('/private/temporary/key');
  expect(await calls(page, 'ssh_accept')).toEqual([]);
  await expect(page.getByRole('tab').last()).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#tabs img')).toHaveCount(0);
  await expect(page.locator('#ssh-key-path')).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('private/temporary');
  await ready(page);
  await expect(page.locator('#session-detail')).toContainText('远端 SSH');
  await expect(page.locator('#sample-run')).toBeDisabled();
  await page.locator('#files-toggle').click();
  await expect(page.locator('.file-inspector')).toContainText('演示');
});

test('raw split UTF-8 output parses before ordered ACKs and does not execute HTML', async ({ page }) => {
  await setup(page); await opening(page); await ready(page);
  await page.evaluate(() => {
    const s = (window as any).sshTerminalQa; s.holdAck = true;
    const bytes = [...new TextEncoder().encode('中文 🌏 <script>bad</script>\r\n')];
    s.channel.onmessage({ kind: 'data', id: s.id, sequence: 1, data: bytes.slice(0, 2) });
    s.channel.onmessage({ kind: 'data', id: s.id, sequence: 2, data: bytes.slice(2) });
  });
  await expect(page.locator('.terminal-pane:visible .xterm-accessibility-tree')).toContainText('中文 🌏 <script>bad</script>');
  expect((await calls(page, 'ssh_ack')).map(c => c.sequence)).toEqual([1]);
  await page.evaluate(() => { const s = (window as any).sshTerminalQa; s.holdAck = false; s.resolveAck(null); });
  await expect.poll(async () => (await calls(page, 'ssh_ack')).map(c => c.sequence)).toEqual([1, 2]);
  await expect(page.locator('.terminal-pane script')).toHaveCount(0);
  expect(await calls(page, 'pty_ack')).toEqual([]);
});

test('SSH input is bounded and split into ordered writes; resizing uses SSH transport', async ({ page }) => {
  await setup(page); await opening(page); await ready(page);
  await page.evaluate(() => (window as any).sshTerminalQa.holdWrite = true);
  await paste(page, 5000);
  await expect.poll(async () => (await calls(page, 'ssh_write')).map(c => c.data.length)).toEqual([4096]);
  await paste(page, 65536);
  await expect(page.locator('#toast')).toContainText('64 KiB');
  await page.evaluate(() => { const s = (window as any).sshTerminalQa; s.holdWrite = false; s.resolveWrite(null); });
  await expect.poll(async () => (await calls(page, 'ssh_write')).map(c => c.data.length)).toEqual([4096, 904]);
  const previous = (await calls(page, 'ssh_resize')).length;
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect.poll(async () => (await calls(page, 'ssh_resize')).length).toBeGreaterThan(previous);
  expect(await calls(page, 'pty_write')).toEqual([]);
  expect(await calls(page, 'pty_resize')).toEqual([]);
});

test('closing an opening session cancels then disposes and closes any late returned ID', async ({ page }) => {
  await setup(page); await opening(page);
  const id = (await calls(page, 'ssh_open'))[0].operationId;
  await page.locator('.tab-close').last().click();
  expect((await calls(page, 'ssh_cancel')).map(c => c.operationId)).toEqual([id]);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.evaluate(() => { const s = (window as any).sshTerminalQa; s.opening.resolve({ id: s.id }); });
  await expect.poll(async () => (await calls(page, 'ssh_close')).map(c => c.id)).toEqual([id]);
  await expect(page.getByRole('tab')).toHaveCount(1);
});

test('early exit cannot resurrect SSH and backend session is closed', async ({ page }) => {
  await setup(page); await opening(page);
  await page.evaluate(() => {
    const s = (window as any).sshTerminalQa;
    s.channel.onmessage({ kind: 'exit', id: s.id, code: 7 });
    s.opening.resolve({ id: s.id });
  });
  await expect(page.locator('#terminal-state')).toContainText('已退出 · code 7');
  expect(await calls(page, 'ssh_resize')).toEqual([]);
  await expect.poll(async () => (await calls(page, 'ssh_close')).length).toBeGreaterThan(0);
  await paste(page, 5);
  expect(await calls(page, 'ssh_write')).toEqual([]);
});

test('fatal SSH event before open resolves remains failed and cannot send input', async ({ page }) => {
  await setup(page); await opening(page);
  await page.evaluate(() => {
    const s = (window as any).sshTerminalQa;
    s.channel.onmessage({ kind: 'error', id: s.id, message: 'Remote transport lost' });
    s.opening.resolve({ id: s.id });
  });
  await expect(page.locator('#terminal-state')).toContainText('Remote transport lost');
  expect(await calls(page, 'ssh_resize')).toEqual([]);
  await paste(page, 8);
  expect(await calls(page, 'ssh_write')).toEqual([]);
  await page.locator('.tab-close').last().click();
  await expect(page.getByRole('tab')).toHaveCount(1);
});

test('exit while input IPC is pending stays exited after the write rejects', async ({ page }) => {
  await setup(page); await opening(page); await ready(page);
  await page.evaluate(() => (window as any).sshTerminalQa.holdWrite = true);
  await paste(page, 5000);
  await expect.poll(async () => (await calls(page, 'ssh_write')).length).toBe(1);
  await page.evaluate(() => {
    const s = (window as any).sshTerminalQa;
    s.channel.onmessage({ kind: 'exit', id: s.id, code: 7 });
    s.holdWrite = false; s.rejectWrite('Session is already closed');
  });
  await expect(page.locator('#terminal-state')).toContainText('已退出 · code 7');
  expect((await calls(page, 'ssh_write')).map(c => c.data.length)).toEqual([4096]);
});

for (const phase of ['cancel', 'close'] as const) {
  test(`failed ${phase} retains SSH tab for retry`, async ({ page }) => {
    await setup(page); await opening(page);
    if (phase === 'close') await ready(page);
    await page.evaluate(phase => (window as any).sshTerminalQa[phase === 'close' ? 'failClose' : 'failCancel'] = true, phase);
    await page.locator('.tab-close').last().click();
    await expect(page.locator('#toast')).toContainText('会话关闭失败');
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.evaluate(phase => (window as any).sshTerminalQa[phase === 'close' ? 'failClose' : 'failCancel'] = false, phase);
    await page.locator('.tab-close').last().click();
    await expect(page.getByRole('tab')).toHaveCount(1);
  });
}

test('session limit rejects terminal handoff without consuming trust or opening backend', async ({ page }) => {
  await setup(page);
  for (let i = 0; i < 7; i++) await page.locator('#demo-add').click();
  await challenge(page); await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-error')).toContainText('8 个会话');
  expect(await calls(page, 'ssh_open')).toEqual([]);
  expect(await calls(page, 'ssh_reject')).toEqual([]);
  await expect(page.locator('#ssh-accept')).toBeEnabled();
  await page.locator('#ssh-cancel').click();
  expect(await calls(page, 'ssh_reject')).toHaveLength(1);
});

test('failed open remains visibly failed and cannot accept input', async ({ page }) => {
  await setup(page); await opening(page);
  await page.evaluate(() => (window as any).sshTerminalQa.opening.reject('SSH authentication denied'));
  await expect(page.locator('#terminal-state')).toContainText('SSH authentication denied');
  await paste(page, 6);
  expect(await calls(page, 'ssh_write')).toEqual([]);
  await page.locator('.tab-close').last().click();
  await expect(page.getByRole('tab')).toHaveCount(1);
});

test('unload cancels pending opening and closes established sessions', async ({ page }) => {
  await setup(page); await opening(page); await ready(page);
  const first = (await calls(page, 'ssh_open'))[0].operationId;
  await opening(page);
  const second = (await calls(page, 'ssh_open'))[1].operationId;
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  expect((await calls(page, 'ssh_close')).map(c => c.id)).toContain(first);
  expect((await calls(page, 'ssh_cancel')).map(c => c.operationId)).toContain(second);
  await expect(page.locator('#ssh-key-path')).toHaveValue('');
});

test('reload never restores credentials, SSH tabs or trust from the preceding document', async ({ page }) => {
  await setup(page); await opening(page); await ready(page);
  await page.reload();
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect(await calls(page, 'ssh_open')).toEqual([]);
  expect(await calls(page, 'ssh_probe')).toEqual([]);
  await page.locator('#connect-open').click();
  await page.locator('#ssh-terminal-open').click();
  await expect(page.locator('#ssh-host')).toHaveValue('');
  await expect(page.locator('#ssh-key-path')).toHaveValue('');
  await expect(page.locator('#ssh-challenge')).toBeHidden();
});

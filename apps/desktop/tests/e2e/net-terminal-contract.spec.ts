import { test, expect, type Page } from '@playwright/test';

// Browser IPC contracts for Telnet / Raw TCP tabs. The stub stands in for the
// desktop backend; these tests do not exercise real TCP or Telnet.
async function setup(page: Page) {
  await page.addInitScript(() => {
    const state: any = { calls: [], channel: null, opening: null, id: null, holdAck: false, holdWrite: false, failClose: false };
    Object.assign(window, { isTauri: true, netQa: state, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke(command: string, args: any = {}) {
        state.calls.push({ command, ...args, onEvent: undefined });
        if (command === 'net_open') {
          state.channel = args.onEvent; state.id = args.id;
          return new Promise((resolve, reject) => state.opening = { resolve, reject });
        }
        if (command === 'net_close' && state.failClose) return Promise.reject('Network terminal close failed');
        if (command === 'net_ack' && state.holdAck) return new Promise(resolve => state.resolveAck = resolve);
        if (command === 'net_write' && state.holdWrite) return new Promise(resolve => state.resolveWrite = resolve);
        return Promise.resolve(null);
      },
    } });
  });
  await page.goto('/');
}
async function calls(page: Page, command: string) {
  return page.evaluate(command => (window as any).netQa.calls.filter((c: any) => c.command === command), command);
}
async function otherTransports(page: Page) {
  return page.evaluate(() => (window as any).netQa.calls.filter((c: any) => /^(pty|ssh)_/.test(c.command)));
}
async function fill(page: Page, kind: 'telnet' | 'raw', host: string, port: string) {
  await page.locator('#connect-open').click();
  await page.locator('#net-terminal-open').click();
  await expect(page.locator('#net-terminal-dialog')).toBeVisible();
  await page.locator('#net-kind').selectOption(kind);
  await page.locator('#net-host').fill(host);
  await page.locator('#net-port').fill(port);
  await page.locator('#net-open').click();
}
async function opening(page: Page, kind: 'telnet' | 'raw' = 'telnet', host = '127.0.0.1', port = '2323') {
  const count = await page.getByRole('tab').count();
  await fill(page, kind, host, port);
  await expect(page.getByRole('tab')).toHaveCount(count + 1);
  await expect(page.locator('#net-terminal-dialog')).toBeHidden();
}
async function ready(page: Page) {
  await page.evaluate(() => { const s = (window as any).netQa; s.opening.resolve({ id: s.id }); });
  await expect(page.locator('#terminal-state')).toContainText('已连接');
}
async function paste(page: Page, length: number) {
  await page.locator('.terminal-pane:visible textarea').evaluate((el, length) => {
    const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'a'.repeat(length));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, length);
}

test('browser shows Telnet and Raw TCP as desktop-only', async ({ page }) => {
  await page.goto('/');
  await page.locator('#connect-open').click();
  await page.locator('#net-terminal-open').click();
  await expect(page.locator('#net-terminal-title')).toHaveText('打开 Telnet / Raw TCP 终端');
  await expect(page.locator('#net-browser-note')).toBeVisible();
  await expect(page.locator('#net-open')).toBeDisabled();
  await expect(page.locator('#net-host')).toBeDisabled();
  await page.locator('#net-close').click();
  await expect(page.locator('#net-terminal-dialog')).toBeHidden();
  await page.locator('#palette-open').click();
  await page.locator('#command-search').fill('Telnet');
  await page.locator('#command-list .command').first().click();
  await expect(page.locator('#net-terminal-dialog')).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(1);
});

test('telnet tab opens over net IPC; split UTF-8 parses before ordered ACKs and HTML stays text', async ({ page }) => {
  await setup(page); await opening(page);
  const opened = await calls(page, 'net_open');
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ target: { kind: 'telnet', host: '127.0.0.1', port: 2323 } });
  expect(opened[0].id).toMatch(/^[a-f0-9-]{36}$/);
  expect(opened[0].cols).toBeGreaterThan(0);
  expect(opened[0].rows).toBeGreaterThan(0);
  await expect(page.getByRole('tab').last()).toContainText('Telnet 127.0.0.1:2323');
  await expect(page.locator('#terminal-state')).toContainText('正在连接 Telnet');
  await ready(page);
  await expect(page.locator('#terminal-state')).toContainText('● Telnet · Telnet 已连接');
  await expect(page.locator('#session-detail')).toContainText('远端 Telnet');
  expect((await calls(page, 'net_resize')).map(c => c.id)).toEqual([opened[0].id]);
  await expect(page.locator('#sample-run')).toBeDisabled();

  await page.evaluate(() => {
    const s = (window as any).netQa; s.holdAck = true;
    const bytes = [...new TextEncoder().encode('中文 🌏 <img src=x onerror=alert(1)>\r\n')];
    s.channel.onmessage({ kind: 'data', id: s.id, sequence: 1, data: bytes.slice(0, 2) });
    s.channel.onmessage({ kind: 'data', id: s.id, sequence: 2, data: bytes.slice(2) });
  });
  await expect(page.locator('.terminal-pane:visible .xterm-accessibility-tree')).toContainText('中文 🌏 <img src=x onerror=alert(1)>');
  expect((await calls(page, 'net_ack')).map(c => c.sequence)).toEqual([1]);
  await page.evaluate(() => { const s = (window as any).netQa; s.holdAck = false; s.resolveAck(null); });
  await expect.poll(async () => (await calls(page, 'net_ack')).map(c => [c.id, c.sequence])).toEqual([[opened[0].id, 1], [opened[0].id, 2]]);
  await expect(page.locator('.terminal-pane img, #tabs img, #session-list img')).toHaveCount(0);
  expect(await otherTransports(page)).toEqual([]);
});

test('raw TCP input is bounded and split into ordered writes; resizing uses net IPC', async ({ page }) => {
  await setup(page); await opening(page, 'raw', 'router-1.example', '7000');
  expect((await calls(page, 'net_open'))[0].target).toEqual({ kind: 'raw', host: 'router-1.example', port: 7000 });
  await ready(page);
  await expect(page.locator('#terminal-state')).toContainText('● Raw TCP');
  await expect(page.locator('.session-item.selected small')).toHaveText('Raw TCP');
  await page.evaluate(() => (window as any).netQa.holdWrite = true);
  await paste(page, 5000);
  await expect.poll(async () => (await calls(page, 'net_write')).map(c => c.data.length)).toEqual([4096]);
  await paste(page, 65536);
  await expect(page.locator('#toast')).toContainText('64 KiB');
  await page.evaluate(() => { const s = (window as any).netQa; s.holdWrite = false; s.resolveWrite(null); });
  await expect.poll(async () => (await calls(page, 'net_write')).map(c => c.data.length)).toEqual([4096, 904]);
  const previous = (await calls(page, 'net_resize')).length;
  await page.setViewportSize({ width: 1100, height: 700 });
  await expect.poll(async () => (await calls(page, 'net_resize')).length).toBeGreaterThan(previous);
  expect(await otherTransports(page)).toEqual([]);
});

test('invalid host or port is refused before any IPC and shown as text', async ({ page }) => {
  await setup(page);
  await fill(page, 'telnet', '<img src=x onerror=alert(1)>', '23');
  await expect(page.locator('#net-error')).toContainText('主机');
  await expect(page.locator('#net-terminal-dialog img')).toHaveCount(0);
  for (const port of ['0', '65536', '']) {
    await page.locator('#net-host').fill('127.0.0.1');
    await page.locator('#net-port').fill(port);
    await page.locator('#net-open').click();
    await expect(page.locator('#net-error')).toContainText('端口');
  }
  expect(await calls(page, 'net_open')).toEqual([]);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.locator('#net-cancel').click();
  await expect(page.locator('#net-terminal-dialog')).toBeHidden();
});

test('closing a connecting tab closes its ID, and a late open result is closed again', async ({ page }) => {
  await setup(page); await opening(page);
  const id = (await calls(page, 'net_open'))[0].id;
  await page.locator('.tab-close').last().click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect((await calls(page, 'net_close')).map(c => c.id)).toEqual([id]);
  await page.evaluate(() => { const s = (window as any).netQa; s.opening.resolve({ id: s.id }); });
  await expect.poll(async () => (await calls(page, 'net_close')).map(c => c.id)).toEqual([id, id]);
  expect(await calls(page, 'net_resize')).toEqual([]);
});

test('remote close ends the tab and later input is not sent', async ({ page }) => {
  await setup(page); await opening(page); await ready(page);
  await page.evaluate(() => { const s = (window as any).netQa; s.channel.onmessage({ kind: 'exit', id: s.id, code: null }); });
  await expect(page.locator('#terminal-state')).toContainText('已退出 · code unknown');
  await paste(page, 5);
  expect(await calls(page, 'net_write')).toEqual([]);
  await page.locator('.tab-close').last().click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect(await calls(page, 'net_close')).toEqual([]);
});

test('error before open resolves keeps the tab failed and closes the backend session', async ({ page }) => {
  await setup(page); await opening(page);
  await page.evaluate(() => {
    const s = (window as any).netQa;
    s.channel.onmessage({ kind: 'error', id: s.id, message: 'Telnet connection lost' });
    s.opening.resolve({ id: s.id });
  });
  await expect(page.locator('#terminal-state')).toContainText('Telnet connection lost');
  await expect.poll(async () => (await calls(page, 'net_close')).length).toBe(1);
  expect(await calls(page, 'net_resize')).toEqual([]);
  await paste(page, 8);
  expect(await calls(page, 'net_write')).toEqual([]);
});

test('failed open remains visibly failed; failed close keeps the tab for retry', async ({ page }) => {
  await setup(page); await opening(page);
  await page.evaluate(() => (window as any).netQa.opening.reject('Telnet connection failed'));
  await expect(page.locator('#terminal-state')).toContainText('Telnet connection failed');
  await paste(page, 6);
  expect(await calls(page, 'net_write')).toEqual([]);
  await page.locator('.tab-close').last().click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await opening(page); await ready(page);
  await page.evaluate(() => (window as any).netQa.failClose = true);
  await page.locator('.tab-close').last().click();
  await expect(page.locator('#toast')).toContainText('会话关闭失败');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.evaluate(() => (window as any).netQa.failClose = false);
  await page.locator('.tab-close').last().click();
  await expect(page.getByRole('tab')).toHaveCount(1);
});

test('unload closes connected and connecting net sessions', async ({ page }) => {
  await setup(page); await opening(page); await ready(page);
  await opening(page, 'raw', '::1', '9000');
  const [first, second] = (await calls(page, 'net_open')).map(c => c.id);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  expect((await calls(page, 'net_close')).map(c => c.id).sort()).toEqual([first, second].sort());
});

test('session limit keeps the dialog open without calling the backend', async ({ page }) => {
  await setup(page);
  for (let i = 0; i < 7; i++) await page.locator('#demo-add').click();
  await fill(page, 'telnet', '127.0.0.1', '23');
  await expect(page.locator('#net-error')).toContainText('8 个会话');
  await expect(page.locator('#net-terminal-dialog')).toBeVisible();
  expect(await calls(page, 'net_open')).toEqual([]);
});

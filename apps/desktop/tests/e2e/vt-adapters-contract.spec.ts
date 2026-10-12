import { test, expect, type Page } from '@playwright/test';

// Browser IPC-stub contracts for the production VT adapters: replies leave through
// Terminal.input -> onData -> the session's own *_write command (PTY, SSH, Telnet), and OSC 52
// needs a per-session opt-in. They do not exercise native PTY/SSH/TCP, WKWebView/WebView2 or the
// system clipboard.
async function stubIpc(page: Page) {
  await page.addInitScript(() => {
    const state: any = { calls: [], channel: null, pendingOpen: null, probe: null, opening: null, id: null, clipboard: [] };
    // Stand-in for the WebView clipboard so writes are observable and never touch the real one.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (text: string) => { state.clipboard.push(text); } },
    });
    Object.assign(window, { isTauri: true, vtIpc: state, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke(command: string, args: any = {}) {
        state.calls.push({ command, id: args.id, data: args.data });
        if (command === 'pty_open') { state.channel = args.onEvent; return new Promise(resolve => state.pendingOpen = resolve); }
        if (command === 'ssh_context') return Promise.resolve('document-scope');
        if (command === 'ssh_probe') return new Promise(resolve => state.probe = resolve);
        if (command === 'ssh_open') {
          state.channel = args.onEvent; state.id = args.operationId;
          return new Promise(resolve => state.opening = resolve);
        }
        if (command === 'net_open') {
          state.channel = args.onEvent; state.id = args.id;
          return new Promise(resolve => state.opening = resolve);
        }
        return Promise.resolve(null);
      },
    } });
  });
  await page.goto('/');
}
async function openPty(page: Page) {
  await page.locator('#local-open').click();
  await page.evaluate(() => { const s = (window as any).vtIpc; s.id = 'vt-pty'; s.pendingOpen({ id: 'vt-pty' }); });
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
}
async function openSsh(page: Page) {
  await page.locator('#connect-open').click();
  await page.locator('#ssh-terminal-open').click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-username').fill('fixture-user');
  await page.locator('#ssh-key-path').fill('/private/temporary/key');
  await page.locator('#ssh-probe').click();
  await page.evaluate(() => (window as any).vtIpc.probe({
    challengeToken: 'vt-token', host: '127.0.0.1', port: 54321, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:vt', expiresInSeconds: 60,
  }));
  await page.locator('#ssh-accept').click();
  await page.evaluate(() => { const s = (window as any).vtIpc; s.opening({ id: s.id }); });
  await expect(page.locator('#terminal-state')).toContainText('SSH 已连接');
}
async function openNet(page: Page) {
  await page.locator('#connect-open').click();
  await page.locator('#net-terminal-open').click();
  await page.locator('#net-kind').selectOption('telnet');
  await page.locator('#net-host').fill('127.0.0.1');
  await page.locator('#net-port').fill('2323');
  await page.locator('#net-open').click();
  await expect(page.locator('#net-terminal-dialog')).toBeHidden();
  await page.evaluate(() => { const s = (window as any).vtIpc; s.opening({ id: s.id }); });
  await expect(page.locator('#terminal-state')).toContainText('已连接');
}
let sequence = 0;
async function output(page: Page, text: string) {
  await page.evaluate(([text, seq]) => {
    const s = (window as any).vtIpc;
    s.channel.onmessage({ kind: 'data', id: s.id, sequence: seq, data: [...new TextEncoder().encode(text)] });
  }, [text, ++sequence] as [string, number]);
}
async function written(page: Page, command: string) {
  return page.evaluate(command => {
    const calls = (window as any).vtIpc.calls.filter((c: any) => c.command === command);
    return { ids: [...new Set(calls.map((c: any) => c.id))], text: calls.map((c: any) => String.fromCharCode(...c.data)).join('') };
  }, command);
}
async function palette(page: Page, name: string) {
  await page.locator('#palette-open').click();
  await page.locator('#command-search').fill(name);
  await page.locator('#command-list .command').first().click();
}

test('PTY: identity, DECRQSS SGR, DECOM CPR and XTVERSION replies reach pty_write', async ({ page }) => {
  await stubIpc(page);
  await openPty(page);
  await output(page, '\x1b[c\x1b[1;31m\x1bP$qm\x1b\\\x1b[3;5r\x1b[?6h\x1b[6n\x1b[>0q');
  const replies = '\x1b[?1;2c\x1bP1$r0;1;31m\x1b\\\x1b[1;1R\x1bP>|new-windterm(0.0.1)\x1b\\';
  await expect.poll(async () => (await written(page, 'pty_write')).text).toBe(replies);
  expect((await written(page, 'pty_write')).ids).toEqual(['vt-pty']);
  expect((await written(page, 'ssh_write')).text).toBe('');
});

test('SSH: DECSCUSR report and DA2 reach ssh_write, never pty_write', async ({ page }) => {
  await stubIpc(page);
  await openSsh(page);
  const id = await page.evaluate(() => (window as any).vtIpc.id);
  await output(page, '\x1b[4 q\x1bP$q q\x1b\\\x1b[>c');
  await expect.poll(async () => (await written(page, 'ssh_write')).text).toBe('\x1bP1$r4 q\x1b\\\x1b[>0;276;0c');
  expect((await written(page, 'ssh_write')).ids).toEqual([id]);
  expect((await written(page, 'pty_write')).text).toBe('');
});

test('Telnet: DECSCL level report and DA1 for the default type reach net_write only', async ({ page }) => {
  await stubIpc(page);
  await openNet(page);
  const id = await page.evaluate(() => (window as any).vtIpc.id);
  await output(page, '\x1bP$q"p\x1b\\\x1b[c');
  await expect.poll(async () => (await written(page, 'net_write')).text).toBe('\x1bP1$r61;1"p\x1b\\\x1b[?1;2c');
  expect((await written(page, 'net_write')).ids).toEqual([id]);
  expect((await written(page, 'pty_write')).text + (await written(page, 'ssh_write')).text).toBe('');
});

test('OSC 52 is swallowed until the session opts in; writes show a notice without content; reads stay denied', async ({ page }) => {
  await stubIpc(page);
  await openPty(page);
  const toast = page.locator('#toast');
  await output(page, '\x1b]52;c;aGVsbG8=\x07');
  await expect(toast).toContainText('已拦截 OSC 52 剪贴板写入');
  await palette(page, 'OSC 52');
  await expect(toast).toContainText('已允许');
  await expect(page.locator('#session-detail')).toContainText('OSC 52 可写剪贴板');

  const secret = 'echo 机密';
  const payload = await page.evaluate(text => btoa(String.fromCharCode(...new TextEncoder().encode(text))), secret);
  await output(page, `\x1b]52;c;${payload}\x07`);
  await expect.poll(() => page.evaluate(() => (window as any).vtIpc.clipboard)).toEqual([secret]);
  await expect(toast).toContainText('写入了剪贴板（11 字节）');
  await expect(toast).not.toContainText('机密');

  await output(page, '\x1b]52;c;?\x07');
  await expect(toast).toContainText('已拒绝终端程序读取剪贴板');

  await palette(page, 'OSC 52');
  await expect(page.locator('#session-detail')).not.toContainText('OSC 52');
  await output(page, '\x1b]52;c;aGVsbG8=\x07');
  await expect(toast).toContainText('已拦截 OSC 52 剪贴板写入');
  expect(await page.evaluate(() => (window as any).vtIpc.clipboard)).toEqual([secret]);
  // Nothing from OSC 52 is echoed or answered to the host.
  expect((await written(page, 'pty_write')).text).toBe('');
  await expect(page.locator('.terminal-pane:visible .xterm-accessibility-tree')).not.toContainText('aGVsbG8');
});

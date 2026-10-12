import { test, expect, type Page } from '@playwright/test';

// Browser IPC contracts for the SSH port forward sheet. The stub stands in for
// the desktop backend: no listener is opened and no SSH channel is relayed.
async function setup(page: Page) {
  await page.addInitScript(() => {
    const state: any = { calls: [], probe: null, opening: null, channel: null, id: null, forwards: [], next: 0, failAdd: null, holdList: false };
    Object.assign(window, { isTauri: true, forwardQa: state, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke(command: string, args: any = {}) {
        state.calls.push({ command, ...args, onEvent: undefined });
        if (command === 'ssh_context') return Promise.resolve('document-scope');
        if (command === 'ssh_probe') return new Promise(resolve => state.probe = resolve);
        if (command === 'ssh_open') {
          state.channel = args.onEvent; state.id = args.operationId;
          return new Promise((resolve, reject) => state.opening = { resolve, reject });
        }
        if (command === 'ssh_forward_list') {
          const reply = () => state.forwards.map((f: any) => ({ ...f }));
          return state.holdList ? new Promise(resolve => state.resolveList = () => resolve(reply())) : Promise.resolve(reply());
        }
        if (command === 'ssh_forward_add') {
          if (state.failAdd) return Promise.reject(state.failAdd);
          const { kind, bindHost, bindPort, targetHost, targetPort } = args.forward;
          const info = { id: `forward-${++state.next}`, kind, bindHost, bindPort: bindPort || 40000 + state.next, targetHost, targetPort, status: 'active', connections: kind === 'remote' ? null : 0 };
          const finish = () => { state.forwards.push(info); return { ...info }; };
          return state.holdAdd ? new Promise(resolve => state.resolveAdd = () => resolve(finish())) : Promise.resolve(finish());
        }
        if (command === 'ssh_forward_remove') {
          state.forwards = state.forwards.filter((f: any) => f.id !== args.forwardId);
          return Promise.resolve(null);
        }
        return Promise.resolve(null);
      },
    } });
  });
  await page.goto('/');
}
async function calls(page: Page, command: string) {
  return page.evaluate(command => (window as any).forwardQa.calls.filter((c: any) => c.command === command), command);
}
/** Opens a stubbed SSH terminal tab and reports it connected. */
async function sshTab(page: Page) {
  await page.locator('#connect-open').click();
  await page.locator('#ssh-terminal-open').click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-username').fill('fixture-user');
  await page.locator('#ssh-key-path').fill('/private/temporary/key');
  await page.locator('#ssh-probe').click();
  await page.evaluate(() => (window as any).forwardQa.probe({ challengeToken: 'terminal-token', host: '127.0.0.1', port: 54321, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:actual-server-key', expiresInSeconds: 60 }));
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-verification-dialog')).toBeHidden();
  await expect(page.locator('#forward-open')).toBeVisible();
  await expect(page.locator('#forward-open')).toBeDisabled();
  await page.evaluate(() => { const s = (window as any).forwardQa; s.opening.resolve({ id: s.id }); });
  await expect(page.locator('#terminal-state')).toContainText('SSH 已连接');
  return page.evaluate(() => (window as any).forwardQa.id as string);
}
async function openSheet(page: Page) {
  await page.locator('#forward-open').click();
  await expect(page.locator('#port-forward-dialog')).toBeVisible();
}
async function add(page: Page, kind: 'local' | 'dynamic' | 'remote', bindHost: string, bindPort: string, targetHost = '', targetPort = '') {
  await page.locator('#forward-kind').selectOption(kind);
  await page.locator('#forward-bind-host').fill(bindHost);
  await page.locator('#forward-bind-port').fill(bindPort);
  if (kind !== 'dynamic') {
    await page.locator('#forward-target-host').fill(targetHost);
    await page.locator('#forward-target-port').fill(targetPort);
  }
  await page.locator('#forward-add').click();
}

test('forward entry is only offered for a connected SSH tab', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#forward-open')).toBeHidden();
  await page.locator('#palette-open').click();
  await page.locator('#command-search').fill('端口转发');
  await page.keyboard.press('Enter');
  await expect(page.locator('#toast')).toContainText('已连接的真实 SSH 终端标签');
  await expect(page.locator('#port-forward-dialog')).toBeHidden();
});

test('local, dynamic and remote forwards are sent with the terminal ID and listed as text', async ({ page }) => {
  await setup(page);
  const id = await sshTab(page);
  await openSheet(page);
  await expect(page.locator('#forward-session')).toHaveText('127.0.0.1:54321');
  await expect.poll(async () => (await calls(page, 'ssh_forward_list')).length).toBeGreaterThan(0);
  expect((await calls(page, 'ssh_forward_list'))[0]).toMatchObject({ id });
  await expect(page.locator('#forward-list')).toContainText('暂无转发');

  await add(page, 'local', '127.0.0.1', '0', 'db.internal', '5432');
  await expect(page.locator('#forward-status')).toHaveText('已添加本地 -L：本机 127.0.0.1:40001 → db.internal:5432');
  await page.locator('#forward-kind').selectOption('dynamic');
  await expect(page.locator('#forward-target-row')).toBeHidden();
  await add(page, 'dynamic', '::1', '1080');
  await page.locator('#forward-kind').selectOption('remote');
  await expect(page.locator('#forward-bind-label')).toContainText('服务器监听地址');
  await add(page, 'remote', 'localhost', '0', '127.0.0.1', '3000');

  expect((await calls(page, 'ssh_forward_add')).map(c => ({ id: c.id, forward: c.forward }))).toEqual([
    { id, forward: { kind: 'local', bindHost: '127.0.0.1', bindPort: 0, targetHost: 'db.internal', targetPort: 5432 } },
    { id, forward: { kind: 'dynamic', bindHost: '::1', bindPort: 1080, targetHost: null, targetPort: null } },
    { id, forward: { kind: 'remote', bindHost: 'localhost', bindPort: 0, targetHost: '127.0.0.1', targetPort: 3000 } },
  ]);
  const rows = page.locator('.forward-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('本地 -L本机 127.0.0.1:40001db.internal:5432监听中 · 0 个连接');
  await expect(rows.nth(1)).toContainText('动态 -D本机 [::1]:1080SOCKS5 · 由连接方指定监听中 · 0 个连接');
  await expect(rows.nth(2)).toContainText('远端 -R服务器 localhost:40003本机 127.0.0.1:3000服务器监听中');
  await expect(page.locator('#forward-count')).toHaveText('3 / 16');

  // Live connection counts and status come from the periodic list.
  await page.evaluate(() => { const s = (window as any).forwardQa; s.forwards[0].connections = 2; s.forwards[1].status = 'stopped'; });
  await expect(rows.nth(0)).toContainText('监听中 · 2 个连接');
  await expect(rows.nth(1)).toContainText('已停止');
});

test('invalid input is refused before IPC and backend errors are shown as text', async ({ page }) => {
  await setup(page);
  await sshTab(page);
  await openSheet(page);
  const cases: [Parameters<typeof add>, string][] = [
    [[page, 'local', '0.0.0.0', '0', '127.0.0.1', '80'], '回环 IP'],
    [[page, 'dynamic', 'localhost', '0'], '回环 IP'],
    [[page, 'local', '127.0.0.1', '70000', '127.0.0.1', '80'], '0–65535'],
    [[page, 'local', '127.0.0.1', '-1', '127.0.0.1', '80'], '0–65535'],
    [[page, 'local', '127.0.0.1', '0', '', '80'], '目标主机'],
    [[page, 'local', '127.0.0.1', '0', '<img src=x>', '80'], '目标主机'],
    [[page, 'local', '127.0.0.1', '0', '127.0.0.1', '0'], '目标端口'],
    [[page, 'remote', 'a b', '0', '127.0.0.1', '80'], '服务器监听地址'],
    [[page, 'dynamic', '::ffff:127.0.0.1', '0'], '回环 IP'],
    [[page, 'local', '127.0.0.1', '0', 'a..b', '80'], '目标主机'],
    [[page, 'local', '127.0.0.1', '0', '-x', '80'], '目标主机'],
    [[page, 'local', '127.0.0.1', '0', ':::', '80'], '目标主机'],
    [[page, 'local', '127.0.0.1', '0', '[::1]', '80'], '目标主机'],
  ];
  for (const [args, message] of cases) {
    await add(...args);
    await expect(page.locator('#forward-error')).toContainText(message);
  }
  expect(await calls(page, 'ssh_forward_add')).toEqual([]);

  await page.evaluate(() => (window as any).forwardQa.failAdd = 'Cannot listen on 127.0.0.1:22: <b>AddrInUse</b>');
  await add(page, 'local', '127.0.0.1', '22', '127.0.0.1', '22');
  await expect(page.locator('#forward-error')).toHaveText('Cannot listen on 127.0.0.1:22: <b>AddrInUse</b>');
  await expect(page.locator('#port-forward-dialog b')).toHaveCount(0);
  await expect(page.locator('#forward-add')).toBeEnabled();
});

test('backend values render as text only', async ({ page }) => {
  await setup(page);
  await sshTab(page);
  await page.evaluate(() => (window as any).forwardQa.forwards.push({
    id: 'forward-x', kind: 'remote', bindHost: '<img src=x onerror=alert(1)>', bindPort: 2222,
    targetHost: '<script>bad()</script>', targetPort: 80, status: 'active', connections: null,
  }));
  await openSheet(page);
  await expect(page.locator('.forward-row')).toContainText('服务器 <img src=x onerror=alert(1)>:2222');
  await expect(page.locator('.forward-row')).toContainText('本机 <script>bad()</script>:80');
  await expect(page.locator('#port-forward-dialog img, #port-forward-dialog script')).toHaveCount(0);
});

test('removing a forward sends its ID and the list follows the backend', async ({ page }) => {
  await setup(page);
  const id = await sshTab(page);
  await openSheet(page);
  await add(page, 'local', '127.0.0.1', '0', '127.0.0.1', '5432');
  await add(page, 'dynamic', '127.0.0.1', '0');
  await expect(page.locator('.forward-row')).toHaveCount(2);
  await page.getByRole('button', { name: '移除 本机 127.0.0.1:40001' }).click();
  await expect(page.locator('.forward-row')).toHaveCount(1);
  await expect(page.locator('#forward-status')).toHaveText('已移除 本机 127.0.0.1:40001');
  expect(await calls(page, 'ssh_forward_remove')).toEqual([{ command: 'ssh_forward_remove', id, forwardId: 'forward-1' }]);
  await expect(page.locator('.forward-row')).toContainText('127.0.0.1:40002');
});

test('a stale list reply does not overwrite the list after an addition', async ({ page }) => {
  await setup(page);
  await sshTab(page);
  await openSheet(page);
  await expect(page.locator('#forward-list')).toContainText('暂无转发');
  // A poll is held with the old (empty) list while an addition completes.
  await page.evaluate(() => (window as any).forwardQa.holdList = true);
  const before = (await calls(page, 'ssh_forward_list')).length;
  await expect.poll(async () => (await calls(page, 'ssh_forward_list')).length).toBeGreaterThan(before);
  await page.evaluate(() => { const s = (window as any).forwardQa; s.stale = s.resolveList; s.holdList = false; });
  await add(page, 'dynamic', '127.0.0.1', '0');
  await expect(page.locator('.forward-row')).toHaveCount(1);
  await page.evaluate(() => { const s = (window as any).forwardQa; s.forwards = []; s.stale(); s.forwards.push({ id: 'forward-1', kind: 'dynamic', bindHost: '127.0.0.1', bindPort: 40001, targetHost: null, targetPort: null, status: 'active', connections: 0 }); });
  // A fixed wait, not a retrying assertion: the next poll (every 1000 ms)
  // would repaint the right list and hide a regression. 500 ms stays below it.
  await page.waitForTimeout(500);
  expect(await page.locator('.forward-row').count()).toBe(1);
});

test('limit of 16 forwards is enforced in the sheet', async ({ page }) => {
  await setup(page);
  await sshTab(page);
  await page.evaluate(() => {
    const s = (window as any).forwardQa;
    for (let i = 1; i <= 16; i++) s.forwards.push({ id: `forward-${i}`, kind: 'dynamic', bindHost: '127.0.0.1', bindPort: 41000 + i, targetHost: null, targetPort: null, status: 'active', connections: 0 });
  });
  await openSheet(page);
  await expect(page.locator('#forward-count')).toHaveText('16 / 16');
  await add(page, 'dynamic', '127.0.0.1', '0');
  await expect(page.locator('#forward-error')).toContainText('最多 16 个转发');
  expect(await calls(page, 'ssh_forward_add')).toEqual([]);
});

test('palette opens the sheet for the active SSH tab; the sheet ends with the session', async ({ page }) => {
  await setup(page);
  const id = await sshTab(page);
  await page.locator('#palette-open').click();
  await page.locator('#command-search').fill('端口转发');
  await page.keyboard.press('Enter');
  await expect(page.locator('#port-forward-dialog')).toBeVisible();
  await add(page, 'dynamic', '127.0.0.1', '0');
  await expect(page.locator('.forward-row')).toHaveCount(1);

  await page.evaluate(() => { const s = (window as any).forwardQa; s.channel.onmessage({ kind: 'exit', id: s.id, code: 0 }); });
  await expect(page.locator('#forward-ended')).toBeVisible();
  await expect(page.locator('.forward-row')).toHaveCount(0);
  await expect(page.locator('#forward-add')).toBeDisabled();
  await expect(page.locator('#forward-kind')).toBeDisabled();
  await expect(page.locator('#forward-bind-host')).toBeDisabled();
  const polls = (await calls(page, 'ssh_forward_list')).length;
  await page.waitForTimeout(1200);
  expect((await calls(page, 'ssh_forward_list')).length).toBe(polls);
  await page.locator('#forward-close').click();
  await expect(page.locator('#forward-open')).toBeDisabled();
  expect((await calls(page, 'ssh_forward_add')).every(c => c.id === id)).toBe(true);
});

test('closing the sheet stops polling; closing the tab closes the SSH session that owns the forwards', async ({ page }) => {
  await setup(page);
  const id = await sshTab(page);
  await openSheet(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#port-forward-dialog')).toBeHidden();
  const polls = (await calls(page, 'ssh_forward_list')).length;
  await page.waitForTimeout(1200);
  expect((await calls(page, 'ssh_forward_list')).length).toBe(polls);
  await page.locator('.tab-close').last().click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  expect((await calls(page, 'ssh_close')).map(c => c.id)).toEqual([id]);
  await expect(page.locator('#forward-open')).toBeHidden();
});

test('host rules match the backend: any spelling of ::1, underscores and IPv6 targets are accepted', async ({ page }) => {
  await setup(page);
  const id = await sshTab(page);
  await openSheet(page);
  await add(page, 'dynamic', '0:0:0:0:0:0:0:1', '0');
  await add(page, 'local', '127.0.0.2', '0', '_srv.db_1.internal', '5432');
  await add(page, 'remote', '127.0.0.1', '0', '2001:db8::1', '22');
  await expect(page.locator('.forward-row')).toHaveCount(3);
  await expect(page.locator('#forward-error')).toBeEmpty();
  expect((await calls(page, 'ssh_forward_add')).map(c => c.forward)).toEqual([
    { kind: 'dynamic', bindHost: '0:0:0:0:0:0:0:1', bindPort: 0, targetHost: null, targetPort: null },
    { kind: 'local', bindHost: '127.0.0.2', bindPort: 0, targetHost: '_srv.db_1.internal', targetPort: 5432 },
    { kind: 'remote', bindHost: '127.0.0.1', bindPort: 0, targetHost: '2001:db8::1', targetPort: 22 },
  ]);
  await expect(page.locator('.forward-row').nth(2)).toContainText('本机 [2001:db8::1]:22');
  expect((await calls(page, 'ssh_forward_add')).every(c => c.id === id)).toBe(true);
});

test('a second submit while an addition is pending sends nothing', async ({ page }) => {
  await setup(page);
  await sshTab(page);
  await openSheet(page);
  await page.evaluate(() => (window as any).forwardQa.holdAdd = true);
  await add(page, 'dynamic', '127.0.0.1', '0');
  await expect(page.locator('#forward-add')).toBeDisabled();
  await page.evaluate(() => { const form = document.querySelector<HTMLFormElement>('#forward-form')!; form.requestSubmit(); form.requestSubmit(); });
  expect(await calls(page, 'ssh_forward_add')).toHaveLength(1);
  await page.evaluate(() => (window as any).forwardQa.resolveAdd());
  await expect(page.locator('.forward-row')).toHaveCount(1);
  await expect(page.locator('#forward-add')).toBeEnabled();
  expect(await calls(page, 'ssh_forward_add')).toHaveLength(1);
});

test('a session that ends during an addition shows the ended state, not a success', async ({ page }) => {
  await setup(page);
  await sshTab(page);
  await openSheet(page);
  await page.evaluate(() => (window as any).forwardQa.holdAdd = true);
  await add(page, 'dynamic', '127.0.0.1', '0');
  await expect(page.locator('#forward-add')).toBeDisabled();
  await page.evaluate(() => { const s = (window as any).forwardQa; s.channel.onmessage({ kind: 'exit', id: s.id, code: 0 }); s.resolveAdd(); });
  await expect(page.locator('#forward-ended')).toBeVisible();
  await expect(page.locator('#forward-status')).toBeEmpty();
  await expect(page.locator('#forward-error')).toBeEmpty();
  await expect(page.locator('.forward-row')).toHaveCount(0);
  await expect(page.locator('#forward-add')).toBeDisabled();
});

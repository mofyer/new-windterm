import { test, expect, type Page } from '@playwright/test';

// Browser IPC contract for the read-only SFTP panel. Every Tauri command is a
// stub: these tests prove UI ownership of tokens, states and safe rendering,
// not Rust networking, OpenSSH interoperability or native WebView behavior.
const HOME = '/home/fixture';
async function setup(page: Page) {
  await page.addInitScript(home => {
    const encode = (text: string) => Array.from(new TextEncoder().encode(text));
    const entry = (name: string, kind: string, size: number, mode: number) => ({ name, kind, size, mode, modifiedUnixSeconds: 1_700_000_000 });
    const tree: Record<string, any[]> = {
      [home]: [
        entry('readme-中文.txt', 'file', 17, 0o100644), entry('docs', 'directory', 96, 0o40755),
        entry('binary.bin', 'file', 4, 0o100600), entry('huge.iso', 'file', 70_000, 0o100644),
        entry('link', 'symlink', 15, 0o120777), entry('<img src=x onerror=alert(1)>', 'file', 1, 0o100644),
      ],
      [`${home}/docs`]: [entry('inner.md', 'file', 5, 0o100644)],
    };
    const files: Record<string, number[]> = { [`${home}/readme-中文.txt`]: encode('你好 SFTP 🌏\n'), [`${home}/binary.bin`]: [0, 1, 2, 255] };
    const state: any = { calls: [], hold: {}, held: {}, fail: {}, truncated: false };
    const reply = (command: string, args: any) => {
      if (command === 'ssh_context') return 'document-scope';
      if (command === 'ssh_probe') return { challengeToken: 'files-token', host: '127.0.0.1', port: 2222, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:actual-server-key', expiresInSeconds: 60 };
      if (command === 'ssh_sftp_open') return { grantToken: 'grant-1', idleSeconds: 300, listing: { path: home, entries: tree[home], truncated: state.truncated } };
      if (command === 'ssh_sftp_list') return { path: args.path, entries: tree[args.path] ?? [], truncated: false };
      if (command === 'ssh_sftp_metadata') return entry('link', 'file', 17, 0o100644);
      if (command === 'ssh_sftp_read') return files[args.path];
      return null;
    };
    Object.assign(window, { isTauri: true, sftpQa: state, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke(command: string, args: any = {}) {
        state.calls.push({ command, ...args });
        if (state.fail[command]) return Promise.reject(state.fail[command]);
        if (state.hold[command]) return new Promise((resolve, reject) => { state.held[command] = { resolve, reject, args }; });
        return Promise.resolve(reply(command, args));
      },
    } });
  }, HOME);
  await page.goto('/');
}
async function calls(page: Page, command: string) {
  return page.evaluate(command => (window as any).sftpQa.calls.filter((c: any) => c.command === command), command);
}
async function trust(page: Page) {
  await page.locator('#files-toggle').click();
  await page.locator('#sftp-connect').click();
  await expect(page.locator('#ssh-verification-title')).toHaveText('只读浏览远端文件');
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-username').fill('fixture');
  await page.locator('#ssh-key-path').fill('/private/temporary/key');
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:actual-server-key');
  await expect(page.locator('#ssh-accept')).toHaveText('仅本次信任并浏览文件');
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-verification-dialog')).toBeHidden();
}
async function connected(page: Page) {
  await trust(page);
  await expect(page.locator('#sftp-path')).toHaveText(HOME);
}
const row = (page: Page, name: string) => page.locator('#sftp-list .file-row', { hasText: name });

test('browser file panel offers SFTP only as a disabled desktop entry', async ({ page }) => {
  await page.goto('/');
  await page.locator('#files-toggle').click();
  await expect(page.locator('#file-demo')).toContainText('演示');
  await page.locator('#sftp-connect').click();
  await expect(page.locator('#ssh-verification-title')).toHaveText('只读浏览远端文件');
  await expect(page.locator('#ssh-browser-note')).toBeVisible();
  await expect(page.locator('#ssh-probe')).toBeDisabled();
});

test('explicit trust hands the one-use challenge to the panel; remote names stay text', async ({ page }) => {
  await setup(page);
  await connected(page);
  const opened = await calls(page, 'ssh_sftp_open');
  expect(opened).toHaveLength(1);
  expect(opened[0]).toMatchObject({ challengeToken: 'files-token', scopeToken: 'document-scope' });
  expect(opened[0].operationId).toMatch(/^[a-f0-9-]{36}$/);
  // Only ssh_probe receives the key path; the panel and its grant never see it.
  const sftpCalls = await page.evaluate(() => (window as any).sftpQa.calls.filter((c: any) => c.command.startsWith('ssh_sftp')));
  expect(JSON.stringify(sftpCalls)).not.toContain('/private/temporary/key');
  expect(await calls(page, 'ssh_accept')).toEqual([]);
  await expect(page.locator('#file-demo')).toBeHidden();
  await expect(page.locator('#sftp-host')).toHaveText('127.0.0.1:2222');
  await expect(page.locator('#sftp-list .file-row').first()).toContainText('docs');
  await expect(row(page, '<img src=x onerror=alert(1)>')).toBeVisible();
  await expect(page.locator('.file-inspector img')).toHaveCount(0);
  await expect(page.locator('#sftp-truncated')).toBeHidden();
});

test('navigation, link resolution and previews reuse the grant, never the challenge', async ({ page }) => {
  await setup(page);
  await connected(page);
  await row(page, 'docs').click();
  await page.locator('#sftp-enter').click();
  await expect(page.locator('#sftp-path')).toHaveText(`${HOME}/docs`);
  await expect(row(page, 'inner.md')).toBeVisible();
  await page.locator('#sftp-up').click();
  await expect(page.locator('#sftp-path')).toHaveText(HOME);
  const listed = await calls(page, 'ssh_sftp_list');
  expect(listed.map((c: any) => c.path)).toEqual([`${HOME}/docs`, HOME]);
  for (const call of listed) expect(call).toMatchObject({ grantToken: 'grant-1', scopeToken: 'document-scope' });
  expect(new Set(listed.map((c: any) => c.operationId)).size).toBe(2);
  expect(listed.some((c: any) => 'challengeToken' in c)).toBe(false);

  await row(page, 'readme-中文.txt').click();
  await expect(page.locator('#sftp-properties')).toContainText('-rw-r--r--');
  await page.locator('#sftp-preview').click();
  await expect(page.locator('#sftp-preview-text')).toHaveText('你好 SFTP 🌏\n');
  await expect(page.locator('#sftp-preview-note')).toContainText('UTF-8 文本');

  await row(page, 'binary.bin').click();
  await expect(page.locator('#sftp-preview-text')).toBeHidden();
  await page.locator('#sftp-preview').click();
  await expect(page.locator('#sftp-preview-text')).toHaveText('00 01 02 ff');
  await expect(page.locator('#sftp-preview-note')).toContainText('二进制或非 UTF-8');

  await row(page, 'huge.iso').click();
  await expect(page.locator('#sftp-preview')).toBeDisabled();
  await expect(page.locator('#sftp-preview-note')).toContainText('超过 64 KiB');

  await row(page, 'link').click();
  await expect(page.locator('#sftp-preview')).toBeHidden();
  await page.locator('#sftp-resolve').click();
  await expect(page.locator('#sftp-properties')).toContainText('符号链接 → 文件');
  await expect(page.locator('#sftp-preview')).toBeEnabled();
  expect((await calls(page, 'ssh_sftp_metadata'))[0]).toMatchObject({ path: `${HOME}/link`, grantToken: 'grant-1' });
  expect((await calls(page, 'ssh_sftp_read')).map((c: any) => c.path)).toEqual([`${HOME}/readme-中文.txt`, `${HOME}/binary.bin`]);
});

test('cancel stops a slow listing and ignores its late result', async ({ page }) => {
  await setup(page);
  await connected(page);
  await page.evaluate(() => { (window as any).sftpQa.hold.ssh_sftp_list = true; });
  await row(page, 'docs').click();
  await page.locator('#sftp-enter').click();
  await expect(page.locator('#sftp-status')).toContainText('正在读取目录');
  await expect(row(page, 'readme-中文.txt')).toBeDisabled();
  await expect(page.locator('#sftp-up')).toBeDisabled();
  await page.locator('#sftp-cancel').click();
  const operationId = (await calls(page, 'ssh_sftp_list'))[0].operationId;
  expect((await calls(page, 'ssh_cancel'))[0]).toMatchObject({ operationId });
  await expect(page.locator('#sftp-status')).toContainText('已取消');
  await page.evaluate(() => (window as any).sftpQa.held.ssh_sftp_list.resolve({ path: '/late', entries: [], truncated: false }));
  await expect(page.locator('#sftp-path')).toHaveText(HOME);
  await expect(row(page, 'readme-中文.txt')).toBeEnabled();
});

test('an expired or revoked grant requires reconnecting with a new fingerprint check', async ({ page }) => {
  await setup(page);
  await connected(page);
  await page.evaluate(() => { (window as any).sftpQa.fail.ssh_sftp_list = 'SSH host key changed; authentication was not attempted; SFTP session closed; reconnect and verify the host again'; });
  await page.locator('#sftp-refresh').click();
  await expect(page.locator('#sftp-error')).toContainText('SSH host key changed');
  await expect(page.locator('#sftp-reconnect')).toBeVisible();
  await expect(page.locator('#sftp-refresh')).toBeDisabled();
  await page.locator('#sftp-reconnect').click();
  expect(await calls(page, 'ssh_sftp_close')).toEqual([]);
  await expect(page.locator('#ssh-verification-dialog')).toBeVisible();
  await expect(page.locator('#ssh-verification-title')).toHaveText('只读浏览远端文件');
  await expect(page.locator('#file-demo')).toBeVisible();
});

test('a file-level error keeps the grant usable', async ({ page }) => {
  await setup(page);
  await connected(page);
  await page.evaluate(() => { (window as any).sftpQa.fail.ssh_sftp_read = 'SFTP file read failed'; });
  await row(page, 'readme-中文.txt').click();
  await page.locator('#sftp-preview').click();
  await expect(page.locator('#sftp-error')).toHaveText('SFTP file read failed');
  await expect(page.locator('#sftp-reconnect')).toBeHidden();
  await expect(page.locator('#sftp-refresh')).toBeEnabled();
});

test('disconnect releases the grant and restores the simulated panel', async ({ page }) => {
  await setup(page);
  await connected(page);
  await page.locator('#sftp-disconnect').click();
  expect(await calls(page, 'ssh_sftp_close')).toEqual([{ command: 'ssh_sftp_close', grantToken: 'grant-1' }]);
  await expect(page.locator('#file-demo')).toBeVisible();
  await expect(page.locator('#sftp-view')).toBeHidden();
  await expect(page.getByRole('status').last()).toContainText('已断开 SFTP');
});

test('open failure and cancellation never leave a grant behind', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => { (window as any).sftpQa.fail.ssh_sftp_open = 'SSH public key authentication rejected'; });
  await trust(page);
  await expect(page.locator('#sftp-error')).toHaveText('SSH public key authentication rejected');
  await expect(page.locator('#sftp-reconnect')).toBeVisible();
  await page.locator('#sftp-disconnect').click();
  expect(await calls(page, 'ssh_sftp_close')).toEqual([]);

  await page.evaluate(() => { const s = (window as any).sftpQa; delete s.fail.ssh_sftp_open; s.hold.ssh_sftp_open = true; });
  await page.locator('#sftp-connect').click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-username').fill('fixture');
  await page.locator('#ssh-key-path').fill('/private/temporary/key');
  await page.locator('#ssh-probe').click();
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#sftp-status')).toContainText('正在认证');
  await page.locator('#sftp-cancel').click();
  const operationId = (await calls(page, 'ssh_sftp_open'))[1].operationId;
  expect((await calls(page, 'ssh_cancel')).map((c: any) => c.operationId)).toContain(operationId);
  // A late success after cancellation must be released, not adopted.
  await page.evaluate(home => (window as any).sftpQa.held.ssh_sftp_open.resolve({ grantToken: 'late-grant', idleSeconds: 300, listing: { path: home, entries: [], truncated: false } }), HOME);
  await expect.poll(async () => (await calls(page, 'ssh_sftp_close')).map((c: any) => c.grantToken)).toEqual(['late-grant']);
  await expect(page.locator('#sftp-list .file-row')).toHaveCount(0);
});

test('a second file browser cannot consume a challenge while one is active', async ({ page }) => {
  await setup(page);
  await connected(page);
  await page.keyboard.press('Control+Shift+K');
  await page.locator('#command-search').fill('只读浏览远端文件');
  await page.keyboard.press('Enter');
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-username').fill('fixture');
  await page.locator('#ssh-key-path').fill('/private/temporary/key');
  await page.locator('#ssh-probe').click();
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-error')).toContainText('已有真实文件浏览正在进行');
  expect(await calls(page, 'ssh_sftp_open')).toHaveLength(1);
});

test('truncated listings are disclosed and the panel fits a 1000px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 650 });
  await setup(page);
  await page.evaluate(() => { (window as any).sftpQa.truncated = true; });
  await connected(page);
  await expect(page.locator('#sftp-truncated')).toHaveText('仅显示前 6 项；其余条目未读取。');
  const overflow = await page.locator('.file-inspector').evaluate(el => {
    const r = el.getBoundingClientRect();
    return { right: r.right <= innerWidth + 1, bottom: r.bottom <= innerHeight + 1, horizontal: el.scrollWidth <= el.clientWidth + 1 };
  });
  expect(overflow).toEqual({ right: true, bottom: true, horizontal: true });
});

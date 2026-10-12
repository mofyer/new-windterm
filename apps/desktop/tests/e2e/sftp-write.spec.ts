import { test, expect, type Page } from '@playwright/test';

// Browser IPC contract for the SFTP write prototype. Every Tauri command is a
// stub that edits an in-page tree: these tests prove the UI asks before
// destructive changes, sends the right arguments and renders remote names as
// text. They do not prove Rust networking, OpenSSH behavior, native WebView
// raw-body IPC or that a file reaches the real Downloads folder.
const HOME = '/home/fixture';
const READ_ONLY = 'SFTP session is read-only; allow writes first';
const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');

async function setup(page: Page) {
  await page.addInitScript(home => {
    const entry = (name: string, kind: string, size: number, mode: number) => ({ name, kind, size, mode, modifiedUnixSeconds: 1_700_000_000 });
    const tree: Record<string, any[]> = {
      [home]: [
        entry('readme-中文.txt', 'file', 17, 0o100644), entry('docs', 'directory', 96, 0o40755),
        entry('binary.bin', 'file', 4, 0o100600), entry('giant.img', 'file', 70 * 1024 * 1024, 0o100644),
        entry('link', 'symlink', 15, 0o120777), entry('<img src=x onerror=alert(1)>', 'file', 1, 0o100644),
      ],
    };
    const callbacks: Record<number, (message: unknown) => void> = {};
    let nextCallback = 1;
    const state: any = { calls: [], hold: {}, held: {}, fail: {}, callbacks };
    const split = (path: string) => [path.slice(0, path.lastIndexOf('/')) || '/', path.slice(path.lastIndexOf('/') + 1)];
    const without = (path: string) => { const [dir, name] = split(path); tree[dir] = tree[dir].filter(e => e.name !== name); };
    const find = (path: string) => { const [dir, name] = split(path); return tree[dir].find(e => e.name === name); };
    const decode = (text: string) => new TextDecoder().decode(Uint8Array.from(text.match(/../g) ?? [], pair => parseInt(pair, 16)));
    const change = (c: any) => {
      if (c.kind === 'mkdir') { const [dir, name] = split(c.path); tree[dir].push(entry(name, 'directory', 64, 0o40755)); tree[c.path] = []; }
      if (c.kind === 'rename') { const old = find(c.from); without(c.from); const [dir, name] = split(c.to); tree[dir].push({ ...old, name }); }
      if (c.kind === 'removeFile' || c.kind === 'removeDir') without(c.path);
      if (c.kind === 'chmod') { const target = find(c.path); target.mode = (target.mode & ~0o777) | c.mode; return target; }
      return null;
    };
    const reply = (command: string, args: any) => {
      if (command === 'ssh_context') return 'document-scope';
      if (command === 'ssh_probe') return { challengeToken: 'files-token', host: '127.0.0.1', port: 2222, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:actual-server-key', expiresInSeconds: 60 };
      if (command === 'ssh_sftp_open') return { grantToken: `grant-${state.calls.filter((c: any) => c.command === 'ssh_sftp_open').length}`, idleSeconds: 300, listing: { path: home, entries: tree[home], truncated: false } };
      if (command === 'ssh_sftp_list') return { path: args.path, entries: tree[args.path] ?? [], truncated: false };
      if (command === 'ssh_sftp_change') return change(args.change);
      if (command === 'ssh_sftp_download') return { path: `/Users/me/Downloads/${split(args.path)[1]}`, bytes: find(args.path).size };
      if (command === 'ssh_sftp_upload') {
        const path = decode(args.headers['x-sftp-path']);
        const [dir, name] = split(path);
        if (!find(path)) tree[dir].push(entry(name, 'file', args.bytes.length, 0o100644));
        return entry(name, 'file', args.bytes.length, 0o100644);
      }
      return null;
    };
    Object.assign(window, { isTauri: true, sftpQa: state, __TAURI_INTERNALS__: {
      transformCallback(callback: (message: unknown) => void) { const id = nextCallback++; callbacks[id] = callback; return id; },
      unregisterCallback(id: number) { delete callbacks[id]; },
      invoke(command: string, args: any = {}, options?: { headers?: Record<string, string> }) {
        const call = args instanceof Uint8Array ? { command, bytes: Array.from(args), headers: options?.headers } : { command, ...args };
        // Channels arrive as objects; record them the way Tauri serializes them.
        for (const key of ['onAuth', 'onProgress']) if (call[key]) call[key] = call[key].toJSON();
        state.calls.push(call);
        if (state.fail[command]) return Promise.reject(state.fail[command]);
        if (state.hold[command]) return new Promise((resolve, reject) => { state.held[command] = { resolve, reject, call }; });
        return Promise.resolve(reply(command, call));
      },
    } });
  }, HOME);
  await page.goto('/');
}
async function calls(page: Page, command: string) {
  return page.evaluate(command => (window as any).sftpQa.calls.filter((c: any) => c.command === command), command);
}
async function connect(page: Page, openPanel = true) {
  if (openPanel) await page.locator('#files-toggle').click();
  await page.locator('#sftp-connect').click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-username').fill('fixture');
  await page.locator('#ssh-key-path').fill('/private/temporary/key');
  await page.locator('#ssh-probe').click();
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#sftp-path')).toHaveText(HOME);
}
async function allowWrites(page: Page) {
  await page.locator('#sftp-writable').click();
  await expect(page.locator('#sftp-dialog-title')).toHaveText('允许写入远端文件？');
  await page.locator('#sftp-dialog-confirm').click();
  await expect(page.locator('#sftp-mode')).toHaveText('SFTP · 可写');
}
const row = (page: Page, name: string) => page.locator('#sftp-list .file-row', { hasText: name });
const dialog = (page: Page) => page.locator('#sftp-dialog');

test('a grant starts read-only; writes need an explicit, per-grant switch', async ({ page }) => {
  await setup(page);
  await connect(page);
  await expect(page.locator('#sftp-mode')).toHaveText('SFTP · 只读');
  await expect(page.locator('#sftp-write-tools')).toBeHidden();
  await row(page, 'readme-中文.txt').click();
  await expect(page.locator('#sftp-entry-tools')).toBeHidden();
  await expect(page.locator('#sftp-download')).toBeEnabled();

  await page.locator('#sftp-writable').click();
  await expect(dialog(page)).toBeVisible();
  await expect(page.locator('#sftp-dialog-message')).toContainText('127.0.0.1:2222');
  await page.locator('#sftp-dialog-cancel').click();
  await expect(dialog(page)).toBeHidden();
  expect(await calls(page, 'ssh_sftp_set_writable')).toEqual([]);
  await expect(page.locator('#sftp-mode')).toHaveText('SFTP · 只读');

  await allowWrites(page);
  expect(await calls(page, 'ssh_sftp_set_writable')).toEqual([
    { command: 'ssh_sftp_set_writable', grantToken: 'grant-1', scopeToken: 'document-scope', writable: true },
  ]);
  await expect(page.locator('#sftp-write-tools')).toBeVisible();
  await expect(page.locator('#sftp-entry-tools')).toBeVisible();
  // Going back to read-only needs no confirmation.
  await page.locator('#sftp-writable').click();
  await expect(page.locator('#sftp-mode')).toHaveText('SFTP · 只读');
  expect((await calls(page, 'ssh_sftp_set_writable')).map((c: any) => c.writable)).toEqual([true, false]);

  // A new grant after disconnecting starts read-only again.
  await allowWrites(page);
  await page.locator('#sftp-disconnect').click();
  await connect(page, false);
  await expect(page.locator('#sftp-mode')).toHaveText('SFTP · 只读');
  await expect(page.locator('#sftp-write-tools')).toBeHidden();
});

test('download goes to the backend-chosen folder with progress and the final path', async ({ page }) => {
  await setup(page);
  await connect(page);
  await row(page, 'giant.img').click();
  await expect(page.locator('#sftp-download')).toBeDisabled();
  await expect(page.locator('#sftp-preview-note')).toContainText('超过 64 MiB');
  await row(page, 'docs').click();
  await expect(page.locator('#sftp-download')).toBeHidden();

  await page.evaluate(() => { (window as any).sftpQa.hold.ssh_sftp_download = true; });
  await row(page, 'readme-中文.txt').click();
  await page.locator('#sftp-download').click();
  const [call] = await calls(page, 'ssh_sftp_download');
  expect(call).toMatchObject({ path: `${HOME}/readme-中文.txt`, grantToken: 'grant-1', scopeToken: 'document-scope' });
  expect(call.onProgress).toMatch(/^__CHANNEL__:\d+$/);
  expect(Object.keys(call)).not.toContain('directory');
  // Progress for another operation is ignored; this one's is shown.
  await page.evaluate(({ call }) => {
    const { callbacks } = (window as any).sftpQa;
    const send = callbacks[Number(call.onProgress.split(':')[1])];
    send({ index: 0, message: { operationId: 'someone-else', transferred: 1, total: 2 } });
    send({ index: 1, message: { operationId: call.operationId, transferred: 8, total: 17 } });
  }, { call });
  await expect(page.locator('#sftp-status')).toContainText('8 B / 17 B');
  await expect(page.locator('#sftp-progress')).toBeVisible();
  await page.evaluate(() => (window as any).sftpQa.held.ssh_sftp_download.resolve({ path: '/Users/me/Downloads/readme-中文 (1).txt', bytes: 17 }));
  await expect(page.locator('#sftp-status')).toHaveText('已下载 17 B，保存为 /Users/me/Downloads/readme-中文 (1).txt');
  await expect(page.locator('#sftp-progress')).toBeHidden();

  // Cancelling a download says the partial local file is removed.
  await page.locator('#sftp-download').click();
  await page.locator('#sftp-cancel').click();
  await expect(page.locator('#sftp-status')).toContainText('未完成的本地文件会被删除');
  const second = (await calls(page, 'ssh_sftp_download'))[1];
  expect((await calls(page, 'ssh_cancel')).map((c: any) => c.operationId)).toEqual([second.operationId]);
});

test('mkdir, empty files and rename validate names and refresh the listing', async ({ page }) => {
  await setup(page);
  await connect(page);
  await allowWrites(page);
  await page.locator('#sftp-mkdir').click();
  const input = page.locator('#sftp-dialog-input');
  const confirm = page.locator('#sftp-dialog-confirm');
  for (const [value, hint] of [['a/b', '不能包含 /'], ['..', '不能是 . 或 ..'], ['docs', '已有同名项'], ['tab\there', '控制字符'], ['长'.repeat(86), '255 字节']]) {
    await input.fill(value);
    await expect(page.locator('#sftp-dialog-hint')).toContainText(hint);
    await expect(confirm).toBeDisabled();
  }
  await input.fill('新 目录');
  await confirm.click();
  await expect(row(page, '新 目录')).toBeVisible();
  await expect(page.locator('#sftp-status')).toHaveText('已新建目录“新 目录”。');
  await expect(page.locator('#sftp-properties')).toContainText('新 目录');
  expect((await calls(page, 'ssh_sftp_change')).map((c: any) => c.change)).toEqual([{ kind: 'mkdir', path: `${HOME}/新 目录` }]);

  await page.locator('#sftp-touch').click();
  await input.fill('空 文件.txt');
  await confirm.click();
  await expect(row(page, '空 文件.txt')).toBeVisible();
  const [touch] = await calls(page, 'ssh_sftp_upload');
  expect(touch.bytes).toEqual([]);
  expect(touch.headers).toMatchObject({ 'x-sftp-path': hex(`${HOME}/空 文件.txt`), 'x-sftp-overwrite': 'false' });

  await row(page, 'readme-中文.txt').click();
  await page.locator('#sftp-rename').click();
  await expect(input).toHaveValue('readme-中文.txt');
  await expect(confirm).toBeDisabled();
  await input.fill('binary.bin');
  await expect(page.locator('#sftp-dialog-hint')).toContainText('已有同名项');
  await input.fill('改名 后.txt');
  await confirm.click();
  await expect(row(page, '改名 后.txt')).toBeVisible();
  await expect(row(page, 'readme-中文.txt')).toHaveCount(0);
  await expect(page.locator('#sftp-properties')).toContainText('改名 后.txt');
  expect((await calls(page, 'ssh_sftp_change'))[1].change).toEqual({ kind: 'rename', from: `${HOME}/readme-中文.txt`, to: `${HOME}/改名 后.txt` });
});

test('delete, overwrite and chmod always ask first; cancelling sends nothing', async ({ page }) => {
  await setup(page);
  await connect(page);
  await allowWrites(page);

  // Delete: remote names stay text inside the dialog.
  await row(page, '<img src=x onerror=alert(1)>').click();
  await page.locator('#sftp-delete').click();
  await expect(page.locator('#sftp-dialog-message')).toContainText('删除远端文件“<img src=x onerror=alert(1)>”');
  await expect(page.locator('#sftp-dialog img')).toHaveCount(0);
  await expect(page.locator('#sftp-dialog-confirm')).toHaveClass(/danger/);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  expect(await calls(page, 'ssh_sftp_change')).toEqual([]);
  await page.locator('#sftp-delete').click();
  await page.locator('#sftp-dialog-confirm').click();
  await expect(row(page, '<img src=x onerror=alert(1)>')).toHaveCount(0);

  await row(page, 'docs').click();
  await page.locator('#sftp-delete').click();
  await expect(page.locator('#sftp-dialog-message')).toContainText('不递归删除');
  await page.locator('#sftp-dialog-confirm').click();
  await row(page, 'link').click();
  await expect(page.locator('#sftp-chmod')).toBeHidden();
  await page.locator('#sftp-delete').click();
  await expect(page.locator('#sftp-dialog-message')).toContainText('符号链接“link”本身');
  await page.locator('#sftp-dialog-confirm').click();
  await expect(row(page, 'link')).toHaveCount(0);

  // Chmod: the dialog shows the current and resulting bits before confirming.
  await row(page, 'readme-中文.txt').click();
  await page.locator('#sftp-chmod').click();
  await expect(page.locator('#sftp-dialog-message')).toContainText('-rw-r--r--（644）');
  const input = page.locator('#sftp-dialog-input');
  await expect(input).toHaveValue('644');
  for (const bad of ['4755', '68', 'rwx']) {
    await input.fill(bad);
    await expect(page.locator('#sftp-dialog-confirm')).toBeDisabled();
  }
  await input.fill('640');
  await expect(page.locator('#sftp-dialog-hint')).toHaveText('修改后：-rw-r-----');
  await page.locator('#sftp-dialog-cancel').click();
  expect(await calls(page, 'ssh_sftp_change')).toHaveLength(3);
  await page.locator('#sftp-chmod').click();
  await input.fill('640');
  await page.locator('#sftp-dialog-confirm').click();
  await expect(page.locator('#sftp-properties')).toContainText('-rw-r-----');
  expect((await calls(page, 'ssh_sftp_change')).map((c: any) => c.change)).toEqual([
    { kind: 'removeFile', path: `${HOME}/<img src=x onerror=alert(1)>` },
    { kind: 'removeDir', path: `${HOME}/docs` },
    { kind: 'removeFile', path: `${HOME}/link` },
    { kind: 'chmod', path: `${HOME}/readme-中文.txt`, mode: 0o640 },
  ]);

  // Overwrite: an existing name asks first; only a confirmed upload overwrites.
  const file = { name: 'binary.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([9, 8, 7]) };
  await page.locator('#sftp-upload-input').setInputFiles(file);
  await expect(page.locator('#sftp-dialog-title')).toHaveText('覆盖远端文件？');
  await page.locator('#sftp-dialog-cancel').click();
  expect(await calls(page, 'ssh_sftp_upload')).toEqual([]);
  await page.locator('#sftp-upload-input').setInputFiles(file);
  await page.locator('#sftp-dialog-confirm').click();
  await expect(page.locator('#sftp-status')).toContainText('已上传“binary.bin”');
  const [upload] = await calls(page, 'ssh_sftp_upload');
  expect(upload.bytes).toEqual([9, 8, 7]);
  expect(upload.headers['x-sftp-overwrite']).toBe('true');
});

test('uploads send raw bytes with ASCII headers, are bounded, and cancel warns about partial state', async ({ page }) => {
  await setup(page);
  await connect(page);
  await allowWrites(page);
  await page.evaluate(() => { (window as any).sftpQa.hold.ssh_sftp_upload = true; });
  await page.locator('#sftp-upload-input').setInputFiles({ name: '上传 🌏.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 255]) });
  await expect(page.locator('#sftp-status')).toContainText('正在上传“上传 🌏.bin”');
  const [upload] = await calls(page, 'ssh_sftp_upload');
  expect(upload.bytes).toEqual([0, 1, 2, 255]);
  expect(upload.headers).toMatchObject({
    'x-sftp-grant': 'grant-1', 'x-sftp-scope': 'document-scope',
    'x-sftp-path': hex(`${HOME}/上传 🌏.bin`), 'x-sftp-overwrite': 'false',
  });
  expect(upload.headers['x-sftp-operation']).toMatch(/^[a-f0-9-]{36}$/);
  expect(upload.headers['x-sftp-on-progress']).toMatch(/^__CHANNEL__:\d+$/);
  for (const value of Object.values(upload.headers) as string[]) expect(value).toMatch(/^[\x20-\x7e]*$/);
  await page.locator('#sftp-cancel').click();
  await expect(page.locator('#sftp-status')).toContainText('以 .part 结尾的隐藏临时文件');
  expect((await calls(page, 'ssh_cancel')).map((c: any) => c.operationId)).toEqual([upload.headers['x-sftp-operation']]);
  await page.evaluate(() => (window as any).sftpQa.held.ssh_sftp_upload.resolve(null));
  await expect(row(page, '上传 🌏.bin')).toHaveCount(0);

  await page.locator('#sftp-upload-input').setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(16 * 1024 * 1024 + 1) });
  await expect(page.locator('#sftp-error')).toHaveText('“big.bin”超过 16 MiB 上传上限。');
  expect(await calls(page, 'ssh_sftp_upload')).toHaveLength(1);

  // Cancelling a confirmed overwrite warns that the target may be incomplete.
  await page.locator('#sftp-upload-input').setInputFiles({ name: 'binary.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1]) });
  await page.locator('#sftp-dialog-confirm').click();
  await expect(page.locator('#sftp-cancel')).toBeVisible();
  expect((await calls(page, 'ssh_sftp_upload'))[1].headers['x-sftp-overwrite']).toBe('true');
  await page.locator('#sftp-cancel').click();
  await expect(page.locator('#sftp-status')).toContainText('被覆盖的远端文件可能已不完整');
});

test('actions wait for a running operation or an open confirmation', async ({ page }) => {
  await setup(page);
  await connect(page);
  await allowWrites(page);
  const actions = ['#sftp-writable', '#sftp-refresh', '#sftp-mkdir', '#sftp-touch', '#sftp-upload'];
  // An open confirmation disables everything behind it.
  await page.locator('#sftp-mkdir').click();
  await expect(dialog(page)).toBeVisible();
  for (const id of actions) await expect(page.locator(id)).toBeDisabled();
  await page.locator('#sftp-dialog-cancel').click();
  for (const id of actions) await expect(page.locator(id)).toBeEnabled();

  // So does a running change; cancelling it says it may already have happened.
  await page.evaluate(() => { (window as any).sftpQa.hold.ssh_sftp_change = true; });
  await page.locator('#sftp-mkdir').click();
  await page.locator('#sftp-dialog-input').fill('慢 目录');
  await page.locator('#sftp-dialog-confirm').click();
  await expect(page.locator('#sftp-cancel')).toBeVisible();
  for (const id of actions) await expect(page.locator(id)).toBeDisabled();
  await row(page, 'binary.bin').click({ force: true });
  await expect(page.locator('#sftp-download')).toBeHidden();
  await page.locator('#sftp-cancel').click();
  await expect(page.locator('#sftp-status')).toContainText('该修改可能已在服务器上完成');
  for (const id of actions) await expect(page.locator(id)).toBeEnabled();
  expect(await calls(page, 'ssh_sftp_change')).toHaveLength(1);
  expect(await calls(page, 'ssh_sftp_download')).toEqual([]);
});

test('backend refusals: read-only resets the switch, revocation requires reconnecting', async ({ page }) => {
  await setup(page);
  await connect(page);
  await allowWrites(page);
  await page.evaluate(error => { (window as any).sftpQa.fail.ssh_sftp_change = error; }, READ_ONLY);
  await page.locator('#sftp-mkdir').click();
  await page.locator('#sftp-dialog-input').fill('x');
  await page.locator('#sftp-dialog-confirm').click();
  await expect(page.locator('#sftp-error')).toHaveText(READ_ONLY);
  await expect(page.locator('#sftp-mode')).toHaveText('SFTP · 只读');
  await expect(page.locator('#sftp-write-tools')).toBeHidden();

  await allowWrites(page);
  await page.evaluate(() => { (window as any).sftpQa.fail.ssh_sftp_change = 'SFTP mkdir failed: permission denied'; });
  await page.locator('#sftp-mkdir').click();
  await page.locator('#sftp-dialog-input').fill('x');
  await page.locator('#sftp-dialog-confirm').click();
  await expect(page.locator('#sftp-error')).toHaveText('SFTP mkdir failed: permission denied');
  await expect(page.locator('#sftp-mode')).toHaveText('SFTP · 可写');
  await expect(page.locator('#sftp-reconnect')).toBeHidden();

  await page.evaluate(() => { (window as any).sftpQa.fail.ssh_sftp_change = 'SSH public key authentication rejected; SFTP session closed; reconnect and verify the host again'; });
  await row(page, 'binary.bin').click();
  await page.locator('#sftp-delete').click();
  await page.locator('#sftp-dialog-confirm').click();
  await expect(page.locator('#sftp-reconnect')).toBeVisible();
  await expect(page.locator('#sftp-writable')).toBeDisabled();
  await expect(page.locator('#sftp-mode')).toHaveText('SFTP · 只读');
  await expect(page.locator('#sftp-write-tools')).toBeHidden();
});

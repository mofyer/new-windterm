import { test, expect, type Page } from '@playwright/test';

// Browser IPC contract for legacy SCP transfers from the SFTP panel (F08/F09).
// Every command is a stub over an in-page tree: these tests prove the option
// is explicit, the right command and arguments are sent, replacing a file is
// confirmed and names render as text. They do not prove Rust networking,
// OpenSSH `scp` behavior, native raw-body IPC or a real Downloads folder.
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
        entry('<img src=x onerror=alert(1)>', 'file', 1, 0o100644),
      ],
    };
    const callbacks: Record<number, (message: unknown) => void> = {};
    let nextCallback = 1;
    const state: any = { calls: [], hold: {}, held: {}, fail: {}, callbacks };
    const split = (path: string) => [path.slice(0, path.lastIndexOf('/')) || '/', path.slice(path.lastIndexOf('/') + 1)];
    const find = (path: string) => { const [dir, name] = split(path); return tree[dir].find(e => e.name === name); };
    const decode = (text: string) => new TextDecoder().decode(Uint8Array.from(text.match(/../g) ?? [], pair => parseInt(pair, 16)));
    const reply = (command: string, args: any) => {
      if (command === 'ssh_context') return 'document-scope';
      if (command === 'ssh_probe') return { challengeToken: 'files-token', host: '127.0.0.1', port: 2222, algorithm: 'ssh-ed25519', fingerprint: 'SHA256:actual-server-key', expiresInSeconds: 60 };
      if (command === 'ssh_sftp_open') return { grantToken: `grant-${state.calls.filter((c: any) => c.command === 'ssh_sftp_open').length}`, idleSeconds: 300, listing: { path: home, entries: tree[home], truncated: false } };
      if (command === 'ssh_sftp_list') return { path: args.path, entries: tree[args.path] ?? [], truncated: false };
      if (command === 'ssh_sftp_download' || command === 'ssh_scp_download') return { path: `/Users/me/Downloads/${split(args.path)[1]}`, bytes: find(args.path).size };
      if (command === 'ssh_scp_upload') {
        const path = decode(args.headers['x-sftp-path']);
        const [dir, name] = split(path);
        const existing = find(path);
        if (existing) existing.size = args.bytes.length;
        else tree[dir].push(entry(name, 'file', args.bytes.length, 0o100644));
        return null;
      }
      return null;
    };
    Object.assign(window, { isTauri: true, scpQa: state, __TAURI_INTERNALS__: {
      transformCallback(callback: (message: unknown) => void) { const id = nextCallback++; callbacks[id] = callback; return id; },
      unregisterCallback(id: number) { delete callbacks[id]; },
      invoke(command: string, args: any = {}, options?: { headers?: Record<string, string> }) {
        const call = args instanceof Uint8Array ? { command, bytes: Array.from(args), headers: options?.headers } : { command, ...args };
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
  return page.evaluate(command => (window as any).scpQa.calls.filter((c: any) => c.command === command), command);
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
  await page.locator('#sftp-dialog-confirm').click();
  await expect(page.locator('#sftp-mode')).toHaveText('SFTP · 可写');
}
const row = (page: Page, name: string) => page.locator('#sftp-list .file-row', { hasText: name });
const scp = (page: Page) => page.locator('#sftp-scp');
const hold = (page: Page, command: string) => page.evaluate(command => { (window as any).scpQa.hold[command] = true; }, command);

test('SCP is an explicit, labelled option; downloads go through ssh_scp_download', async ({ page }) => {
  await setup(page);
  await connect(page);
  await expect(page.locator('.sftp-scp')).toHaveText('用旧版 SCP 协议传输单个文件');
  await expect(scp(page)).not.toBeChecked();
  await expect(page.locator('#sftp-scp-note')).toBeHidden();
  await row(page, 'readme-中文.txt').click();
  await expect(page.locator('#sftp-download')).toHaveText('下载到“下载”文件夹');

  await scp(page).check();
  await expect(page.locator('#sftp-scp-note')).toContainText('SCP 是旧协议');
  await expect(page.locator('#sftp-scp-note')).toContainText('同名文件会被替换');
  await expect(page.locator('#sftp-download')).toHaveText('用 SCP 下载到“下载”文件夹');
  await hold(page, 'ssh_scp_download');
  await page.locator('#sftp-download').click();
  await expect(page.locator('#sftp-status')).toContainText('正在用 SCP 下载“readme-中文.txt”');
  await expect(scp(page)).toBeDisabled();
  const [call] = await calls(page, 'ssh_scp_download');
  expect(call).toMatchObject({ path: `${HOME}/readme-中文.txt`, grantToken: 'grant-1', scopeToken: 'document-scope' });
  expect(call.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(call.onProgress).toMatch(/^__CHANNEL__:\d+$/);
  expect(Object.keys(call)).not.toContain('directory');
  expect(await calls(page, 'ssh_sftp_download')).toEqual([]);
  await page.evaluate(({ call }) => {
    const send = (window as any).scpQa.callbacks[Number(call.onProgress.split(':')[1])];
    send({ index: 0, message: { operationId: call.operationId, transferred: 8, total: 17 } });
  }, { call });
  await expect(page.locator('#sftp-status')).toContainText('8 B / 17 B');
  await page.evaluate(() => (window as any).scpQa.held.ssh_scp_download.resolve({ path: '/Users/me/Downloads/readme-中文 (1).txt', bytes: 17 }));
  await expect(page.locator('#sftp-status')).toHaveText('已用 SCP 下载 17 B，保存为 /Users/me/Downloads/readme-中文 (1).txt');
  await expect(scp(page)).toBeEnabled();

  // Same bound as SFTP; cancelling says the partial local file is removed.
  await row(page, 'giant.img').click();
  await expect(page.locator('#sftp-download')).toBeDisabled();
  await row(page, 'binary.bin').click();
  await page.locator('#sftp-download').click();
  await page.locator('#sftp-cancel').click();
  await expect(page.locator('#sftp-status')).toContainText('未完成的本地文件会被删除');
  const second = (await calls(page, 'ssh_scp_download'))[1];
  expect((await calls(page, 'ssh_cancel')).map((c: any) => c.operationId)).toEqual([second.operationId]);

  // Unchecked again, downloads use SFTP.
  await page.evaluate(() => { (window as any).scpQa.hold = {}; });
  await scp(page).uncheck();
  await page.locator('#sftp-download').click();
  await expect(page.locator('#sftp-status')).toContainText('已下载 4 B');
  expect(await calls(page, 'ssh_sftp_download')).toHaveLength(1);
  expect(await calls(page, 'ssh_scp_download')).toHaveLength(2);
});

test('SCP uploads need writes, send no overwrite header and confirm replacing a file', async ({ page }) => {
  await setup(page);
  await connect(page);
  await scp(page).check();
  await expect(page.locator('#sftp-write-tools')).toBeHidden();
  await allowWrites(page);
  await expect(page.locator('#sftp-upload')).toHaveText('用 SCP 上传文件…');

  await page.locator('#sftp-upload-input').setInputFiles({ name: '上传 🌏.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([0, 1, 2, 255]) });
  await expect(page.locator('#sftp-status')).toContainText('已用 SCP 上传“上传 🌏.bin”（4 B）');
  await expect(row(page, '上传 🌏.bin')).toBeVisible();
  const [upload] = await calls(page, 'ssh_scp_upload');
  expect(upload.bytes).toEqual([0, 1, 2, 255]);
  expect(upload.headers).toMatchObject({ 'x-sftp-grant': 'grant-1', 'x-sftp-scope': 'document-scope', 'x-sftp-path': hex(`${HOME}/上传 🌏.bin`) });
  expect(upload.headers['x-sftp-operation']).toMatch(/^[a-f0-9-]{36}$/);
  expect(upload.headers['x-sftp-on-progress']).toMatch(/^__CHANNEL__:\d+$/);
  expect(Object.keys(upload.headers)).not.toContain('x-sftp-overwrite');
  for (const value of Object.values(upload.headers) as string[]) expect(value).toMatch(/^[\x20-\x7e]*$/);
  expect(await calls(page, 'ssh_sftp_upload')).toEqual([]);

  // An existing file: SCP replaces it in place, so the dialog says so first.
  const file = { name: 'binary.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([9, 8, 7]) };
  await page.locator('#sftp-upload-input').setInputFiles(file);
  await expect(page.locator('#sftp-dialog-title')).toHaveText('覆盖远端文件？');
  await expect(page.locator('#sftp-dialog-message')).toContainText('SCP 会直接写入这个文件，没有临时文件');
  await page.locator('#sftp-dialog-cancel').click();
  expect(await calls(page, 'ssh_scp_upload')).toHaveLength(1);
  await page.locator('#sftp-upload-input').setInputFiles(file);
  await hold(page, 'ssh_scp_upload');
  await page.locator('#sftp-dialog-confirm').click();
  await expect(page.locator('#sftp-status')).toContainText('正在用 SCP 上传“binary.bin”');
  await page.locator('#sftp-cancel').click();
  await expect(page.locator('#sftp-status')).toContainText('SCP 直接写入目标文件名，远端可能留下不完整的文件');
  expect((await calls(page, 'ssh_scp_upload'))[1].bytes).toEqual([9, 8, 7]);

  // A directory is never a target; oversize files are refused before IPC.
  await page.locator('#sftp-upload-input').setInputFiles({ name: 'docs', mimeType: 'application/octet-stream', buffer: Buffer.from([1]) });
  await expect(page.locator('#sftp-error')).toContainText('P0 只覆盖普通文件');
  await page.locator('#sftp-upload-input').setInputFiles({ name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(16 * 1024 * 1024 + 1) });
  await expect(page.locator('#sftp-error')).toHaveText('“big.bin”超过 16 MiB 上传上限。');
  expect(await calls(page, 'ssh_scp_upload')).toHaveLength(2);
  // New empty files still use SFTP's exclusive create.
  await page.evaluate(() => { (window as any).scpQa.hold = {}; });
  await page.locator('#sftp-touch').click();
  await page.locator('#sftp-dialog-input').fill('空.txt');
  await page.locator('#sftp-dialog-confirm').click();
  await expect.poll(async () => (await calls(page, 'ssh_sftp_upload')).length).toBe(1);
  expect(await calls(page, 'ssh_scp_upload')).toHaveLength(2);
});

test('backend refusals, a new grant and remote names as text', async ({ page }) => {
  await setup(page);
  await connect(page);
  await allowWrites(page);
  await scp(page).check();
  await page.evaluate(error => { (window as any).scpQa.fail.ssh_scp_upload = error; }, READ_ONLY);
  await page.locator('#sftp-upload-input').setInputFiles({ name: 'x.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1]) });
  await expect(page.locator('#sftp-error')).toHaveText(READ_ONLY);
  await expect(page.locator('#sftp-mode')).toHaveText('SFTP · 只读');

  await row(page, '<img src=x onerror=alert(1)>').click();
  await page.evaluate(() => { (window as any).scpQa.fail.ssh_scp_download = 'SCP: scp: <b>denied</b>'; });
  await page.locator('#sftp-download').click();
  await expect(page.locator('#sftp-error')).toHaveText('SCP: scp: <b>denied</b>');
  await expect(page.locator('#sftp-view img, #sftp-view b')).toHaveCount(0);
  await expect(page.locator('#sftp-reconnect')).toBeHidden();
  await page.evaluate(() => { (window as any).scpQa.fail.ssh_scp_download = 'SSH host key changed; authentication was not attempted; SFTP session closed; reconnect and verify the host again'; });
  await page.locator('#sftp-download').click();
  await expect(page.locator('#sftp-reconnect')).toBeVisible();

  // A new grant starts with SFTP again.
  await page.locator('#sftp-disconnect').click();
  await connect(page, false);
  await expect(scp(page)).not.toBeChecked();
  await expect(page.locator('#sftp-scp-note')).toBeHidden();
});

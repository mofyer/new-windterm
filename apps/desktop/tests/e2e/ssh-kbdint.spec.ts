import { test, expect, type Page } from '@playwright/test';

// IPC contract for interactive keyboard-interactive. Commands are stubbed and
// rounds are pushed through the `onAuth` channel by the test; real rounds
// against the russh fixture run in `cargo test --test ssh_kbdint`.
const CONNECTING = ['ssh_accept', 'ssh_open', 'ssh_sftp_open', 'ssh_sftp_list'];

async function setup(page: Page) {
  await page.addInitScript((connecting: string[]) => {
    const state: any = { calls: [], channels: {}, pending: {} };
    Object.assign(window, {
      isTauri: true,
      kbdQa: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke(command: string, args: any = {}) {
          state.calls.push({ command, ...args, onEvent: undefined, onAuth: args.onAuth ? 'channel' : undefined });
          if (command === 'ssh_context') return Promise.resolve('document-scope');
          if (command === 'ssh_probe') return Promise.resolve({
            challengeToken: 'challenge-1', host: '127.0.0.1', port: 2222, algorithm: 'ssh-ed25519',
            fingerprint: 'SHA256:key', expiresInSeconds: 60, trust: 'new', savedFingerprint: null,
          });
          if (connecting.includes(command)) {
            state.channels[command] = args.onAuth;
            return new Promise((resolve, reject) => { state.pending[command] = { resolve, reject, operationId: args.operationId }; });
          }
          return Promise.resolve(null);
        },
      },
    });
  }, CONNECTING);
  await page.goto('/');
}

async function begin(page: Page, entry: string) {
  if (entry === '#sftp-connect') await page.locator('#files-toggle').click();
  else await page.locator('#connect-open').click();
  await page.locator(entry).click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-port').fill('2222');
  await page.locator('#ssh-username').fill('fixture');
  await page.locator('#ssh-auth').selectOption('keyboardInteractivePrompted');
  await expect(page.locator('#ssh-kbdint-prompted-note')).toBeVisible();
  await expect(page.locator('#ssh-key-path')).toBeHidden();
  await expect(page.locator('#ssh-kbdint-1')).toBeHidden();
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:key');
  await page.locator('#ssh-accept').click();
}

const calls = (page: Page, command: string) =>
  page.evaluate(command => (window as any).kbdQa.calls.filter((c: any) => c.command === command), command);

async function started(page: Page, command: string) {
  await expect.poll(async () => (await calls(page, command)).length).toBe(1);
  const call = (await calls(page, command))[0];
  expect(call.credential ?? { method: 'keyboardInteractivePrompted' }).toEqual({ method: 'keyboardInteractivePrompted' });
  expect(call.onAuth).toBe('channel');
  return call;
}

type Round = { round: number; name: string; instructions: string; prompts: { text: string; echo: boolean }[] };
function push(page: Page, command: string, round: Round, operationId?: string) {
  return page.evaluate(({ command, round, operationId }) => {
    const s = (window as any).kbdQa;
    s.channels[command].onmessage({ operationId: operationId ?? s.pending[command].operationId, expiresInSeconds: 120, ...round });
  }, { command, round, operationId });
}
function settle(page: Page, command: string, value: unknown, fail = false) {
  return page.evaluate(({ command, value, fail }) => {
    const pending = (window as any).kbdQa.pending[command];
    if (fail) pending.reject(value); else pending.resolve(value);
  }, { command, value, fail });
}

test('verification: server text renders as text, echo=false is a password input, answers go once per round', async ({ page }) => {
  await setup(page);
  await begin(page, '#ssh-verification-open');
  const accepted = await started(page, 'ssh_accept');
  const probe = (await calls(page, 'ssh_probe'))[0];
  expect(probe.request.privateKeyPath).toBe('');

  await push(page, 'ssh_accept', {
    round: 1,
    name: '<img src=x onerror="window.__kbdXss=1">',
    instructions: 'Line one\n<script>window.__kbdXss=2</script>',
    prompts: [{ text: '<b>Password:</b> ', echo: false }],
  });
  const dialog = page.locator('#ssh-kbdint-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#ssh-kbdint-context')).toHaveText('127.0.0.1:2222 · 第 1 轮');
  await expect(page.locator('#ssh-kbdint-name')).toHaveText('<img src=x onerror="window.__kbdXss=1">');
  await expect(page.locator('#ssh-kbdint-instructions')).toHaveText('Line one\n<script>window.__kbdXss=2</script>');
  await expect(dialog.locator('img, script, b')).toHaveCount(0);
  const password = dialog.getByLabel('<b>Password:</b>');
  await expect(password).toHaveAttribute('type', 'password');
  await password.fill('first-secret');
  await page.locator('#ssh-kbdint-submit').dblclick();
  await expect.poll(async () => (await calls(page, 'ssh_auth_respond')).length).toBe(1);
  await expect(page.locator('#ssh-kbdint-status')).toContainText('等待服务器');
  await expect(password).toHaveValue('');
  await expect(page.locator('#ssh-kbdint-submit')).toBeDisabled();

  await push(page, 'ssh_accept', { round: 2, name: '', instructions: '', prompts: [{ text: 'Verification code: ', echo: true }] });
  await expect(page.locator('#ssh-kbdint-context')).toHaveText('127.0.0.1:2222 · 第 2 轮');
  await expect(page.locator('#ssh-kbdint-name')).toBeHidden();
  const code = dialog.getByLabel('Verification code:');
  await expect(code).toHaveAttribute('type', 'text');
  await code.fill('123456');
  await code.press('Enter');
  await code.press('Enter');
  await expect.poll(async () => (await calls(page, 'ssh_auth_respond')).length).toBe(2);
  const answered = await calls(page, 'ssh_auth_respond');
  expect(answered.map((c: any) => [c.operationId, c.round, c.answers])).toEqual([
    [accepted.operationId, 1, ['first-secret']],
    [accepted.operationId, 2, ['123456']],
  ]);

  await settle(page, 'ssh_accept', { stdout: [], stderr: [], exitCode: 7 });
  await expect(dialog).toBeHidden();
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  expect(await page.evaluate(() => (window as any).__kbdXss)).toBeUndefined();
  // Answers travel only with ssh_auth_respond.
  const others = (await page.evaluate(() => (window as any).kbdQa.calls)).filter((c: any) => c.command !== 'ssh_auth_respond');
  expect(JSON.stringify(others)).not.toMatch(/first-secret|123456/);
});

test('terminal: cancelling a waiting round cancels that operation and sends no answer', async ({ page }) => {
  await setup(page);
  await begin(page, '#ssh-terminal-open');
  const opened = await started(page, 'ssh_open');
  await expect(page.locator('#ssh-verification-dialog')).toBeHidden();
  await push(page, 'ssh_open', { round: 1, name: 'P0 fixture', instructions: 'Two factors', prompts: [{ text: 'Password: ', echo: false }] });
  const dialog = page.locator('#ssh-kbdint-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password:').fill('typed-but-cancelled');
  await page.locator('#ssh-kbdint-cancel').click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await calls(page, 'ssh_cancel')).map((c: any) => c.operationId)).toContain(opened.operationId);
  expect(await calls(page, 'ssh_auth_respond')).toEqual([]);

  // A late round for the cancelled operation is ignored.
  await push(page, 'ssh_open', { round: 1, name: '', instructions: '', prompts: [{ text: 'Password: ', echo: false }] });
  await expect(dialog).toBeHidden();
  await settle(page, 'ssh_open', 'SSH operation cancelled', true);
  await expect(page.locator('#terminal-state')).toContainText('SSH operation cancelled');
  expect(JSON.stringify(await page.evaluate(() => (window as any).kbdQa.calls))).not.toContain('typed-but-cancelled');
});

test('sftp: open asks through the dialog, later operations ask again, Escape cancels', async ({ page }) => {
  await setup(page);
  await begin(page, '#sftp-connect');
  const opened = await started(page, 'ssh_sftp_open');
  await push(page, 'ssh_sftp_open', { round: 1, name: '', instructions: '', prompts: [{ text: 'Password: ', echo: false }, { text: 'Code: ', echo: true }] });
  const dialog = page.locator('#ssh-kbdint-dialog');
  await dialog.getByLabel('Password:').fill('pw');
  await dialog.getByLabel('Code:').fill('654321');
  await page.locator('#ssh-kbdint-submit').click();
  await expect.poll(async () => (await calls(page, 'ssh_auth_respond')).length).toBe(1);
  expect((await calls(page, 'ssh_auth_respond'))[0]).toMatchObject({ operationId: opened.operationId, round: 1, answers: ['pw', '654321'] });
  await settle(page, 'ssh_sftp_open', { grantToken: 'grant-1', idleSeconds: 300, listing: { path: '/home/fixture', entries: [], truncated: false } });
  await expect(dialog).toBeHidden();
  await expect(page.locator('#sftp-path')).toHaveText('/home/fixture');

  // The grant holds no answers: refreshing reconnects and asks again.
  await page.locator('#sftp-refresh').click();
  const listed = await started(page, 'ssh_sftp_list');
  expect(listed).toMatchObject({ grantToken: 'grant-1', path: '/home/fixture' });
  expect(JSON.stringify(listed)).not.toMatch(/654321|"pw"/);
  await push(page, 'ssh_sftp_list', { round: 1, name: '', instructions: '', prompts: [{ text: 'Code: ', echo: true }] });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await calls(page, 'ssh_cancel')).map((c: any) => c.operationId)).toContain(listed.operationId);
  expect(await calls(page, 'ssh_auth_respond')).toHaveLength(1);
});

test('other methods send no answer channel', async ({ page }) => {
  await setup(page);
  await page.locator('#connect-open').click();
  await page.locator('#ssh-verification-open').click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-username').fill('fixture');
  await page.locator('#ssh-auth').selectOption('password');
  await page.locator('#ssh-password').fill('pw');
  await page.locator('#ssh-probe').click();
  await page.locator('#ssh-accept').click();
  await expect.poll(async () => (await calls(page, 'ssh_accept')).length).toBe(1);
  expect((await calls(page, 'ssh_accept'))[0].onAuth).toBeUndefined();
});

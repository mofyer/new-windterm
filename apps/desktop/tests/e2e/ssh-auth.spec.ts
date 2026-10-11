import { test, expect, type Page } from '@playwright/test';

// IPC contract for SSH authentication methods. Commands are stubbed; real
// password, passphrase and agent authentication run in `cargo test --test ssh_terminal`.
async function open(page: Page, entry = '#ssh-verification-open') {
  await page.addInitScript(() => {
    const state: any = { calls: [] };
    Object.assign(window, {
      isTauri: true,
      authQa: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke(command: string, args: any = {}) {
          state.calls.push({ command, ...args, onEvent: undefined });
          if (command === 'ssh_context') return Promise.resolve('document-scope');
          if (command === 'ssh_probe') return Promise.resolve({
            challengeToken: 'challenge-1', host: '127.0.0.1', port: 2222, algorithm: 'ssh-ed25519',
            fingerprint: 'SHA256:key', expiresInSeconds: 60, trust: 'new', savedFingerprint: null,
          });
          if (command === 'ssh_accept') return Promise.resolve({ stdout: [], stderr: [], exitCode: 7 });
          if (command === 'ssh_open' || command === 'ssh_sftp_open') return new Promise(() => {});
          return Promise.resolve(null);
        },
      },
    });
  });
  await page.goto('/');
  if (entry === '#sftp-connect') await page.locator('#files-toggle').click();
  else await page.locator('#connect-open').click();
  await page.locator(entry).click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-port').fill('2222');
  await page.locator('#ssh-username').fill('fixture');
}
const calls = (page: Page, command: string) =>
  page.evaluate(command => (window as any).authQa.calls.filter((c: any) => c.command === command), command);

test('password: no key path, secret withheld from the probe and sent once at accept', async ({ page }) => {
  await open(page);
  await page.locator('#ssh-auth').selectOption('password');
  await expect(page.locator('#ssh-key-path')).toBeHidden();
  await page.locator('#ssh-password').fill('s3cret-value');
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:key');
  const probe = (await calls(page, 'ssh_probe'))[0];
  expect(probe.request).toEqual({ host: '127.0.0.1', port: 2222, username: 'fixture', privateKeyPath: '' });
  expect(JSON.stringify(probe)).not.toContain('s3cret-value');
  await expect(page.locator('#ssh-password')).toHaveValue('');
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  const accepted = await calls(page, 'ssh_accept');
  expect(accepted).toHaveLength(1);
  expect(accepted[0].credential).toEqual({ method: 'password', password: 's3cret-value' });
});

test('encrypted key: path in the probe, passphrase only at accept', async ({ page }) => {
  await open(page);
  await page.locator('#ssh-key-path').fill('/keys/encrypted');
  await page.locator('#ssh-passphrase').fill('pass-phrase');
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:key');
  const probe = (await calls(page, 'ssh_probe'))[0];
  expect(probe.request.privateKeyPath).toBe('/keys/encrypted');
  expect(JSON.stringify(probe)).not.toContain('pass-phrase');
  await expect(page.locator('#ssh-passphrase')).toHaveValue('');
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  expect((await calls(page, 'ssh_accept'))[0].credential).toEqual({ method: 'key', passphrase: 'pass-phrase' });
});

test('agent: no path or secret; unencrypted key sends no passphrase', async ({ page }) => {
  await open(page);
  await page.locator('#ssh-auth').selectOption('agent');
  await expect(page.locator('#ssh-key-path')).toBeHidden();
  await expect(page.locator('#ssh-password')).toBeHidden();
  await page.locator('#ssh-probe').click();
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  expect((await calls(page, 'ssh_probe'))[0].request.privateKeyPath).toBe('');
  expect((await calls(page, 'ssh_accept'))[0].credential).toEqual({ method: 'agent' });
});

test('terminal and file hand-offs carry the credential, never the key path', async ({ page }) => {
  for (const [entry, command] of [['#ssh-terminal-open', 'ssh_open'], ['#sftp-connect', 'ssh_sftp_open']] as const) {
    await page.goto('about:blank');
    await open(page, entry);
    await page.locator('#ssh-auth').selectOption('password');
    await page.locator('#ssh-password').fill('hand-off-secret');
    await page.locator('#ssh-probe').click();
    await page.locator('#ssh-accept').click();
    await expect.poll(async () => (await calls(page, command)).length).toBe(1);
    const call = (await calls(page, command))[0];
    expect(call.credential).toEqual({ method: 'password', password: 'hand-off-secret' });
    expect(JSON.stringify(call)).not.toContain('privateKeyPath');
  }
});

test('keyboard-interactive: ordered answers stay out of the probe and are cleared', async ({ page }) => {
  await open(page);
  await page.locator('#ssh-auth').selectOption('keyboardInteractive');
  await expect(page.locator('#ssh-key-path')).toBeHidden();
  await page.locator('#ssh-kbdint-1').fill('first-answer');
  await page.locator('#ssh-kbdint-2').fill('123456');
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:key');
  const probe = (await calls(page, 'ssh_probe'))[0];
  expect(probe.request.privateKeyPath).toBe('');
  expect(JSON.stringify(probe)).not.toContain('first-answer');
  await expect(page.locator('#ssh-kbdint-1')).toHaveValue('');
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  expect((await calls(page, 'ssh_accept'))[0].credential).toEqual({ method: 'keyboardInteractive', responses: ['first-answer', '123456'] });
});

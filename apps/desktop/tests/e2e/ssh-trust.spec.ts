import { test, expect, type Page } from '@playwright/test';

// IPC contract for saved host trust in the SSH dialog. Commands are stubbed;
// the Rust store, fingerprint comparison and blocking are covered by
// `cargo test --test ssh_terminal` (saved_trust_is_reused_and_a_changed_key…).
type Trust = 'new' | 'known' | 'changed';
async function open(page: Page, trust: Trust, failSave = false) {
  await page.addInitScript(({ trust, failSave }) => {
    const state: any = { calls: [] };
    Object.assign(window, {
      isTauri: true,
      trustQa: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke(command: string, args: any = {}) {
          state.calls.push({ command, ...args });
          if (command === 'ssh_context') return Promise.resolve('document-scope');
          if (command === 'ssh_probe') return Promise.resolve({
            challengeToken: 'challenge-1', host: '127.0.0.1', port: 2222, algorithm: 'ssh-ed25519',
            fingerprint: 'SHA256:presented-key', expiresInSeconds: 60, trust,
            savedFingerprint: trust === 'changed' ? 'SHA256:saved-key' : null,
          });
          if (command === 'ssh_trust_save' && failSave) return Promise.reject('Host key could not be saved');
          if (command === 'ssh_accept') return Promise.resolve({ stdout: [80, 48], stderr: [], exitCode: 7 });
          return Promise.resolve(null);
        },
      },
    });
  }, { trust, failSave });
  await page.goto('/');
  await page.locator('#connect-open').click();
  await page.locator('#ssh-verification-open').click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-port').fill('2222');
  await page.locator('#ssh-username').fill('fixture');
  await page.locator('#ssh-key-path').fill('/temporary/key');
  await page.locator('#ssh-probe').click();
}
const calls = (page: Page, command: string) =>
  page.evaluate(command => (window as any).trustQa.calls.filter((c: any) => c.command === command), command);

test('new host: nothing is saved unless the user opts in', async ({ page }) => {
  await open(page, 'new');
  await expect(page.locator('#ssh-trust-note')).toContainText('首次连接');
  await expect(page.locator('#ssh-remember')).not.toBeChecked();
  await expect(page.locator('#ssh-changed')).toBeHidden();
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  expect(await calls(page, 'ssh_trust_save')).toEqual([]);
  expect(await calls(page, 'ssh_accept')).toHaveLength(1);
});

test('new host: opting in saves before the challenge is consumed', async ({ page }) => {
  await open(page, 'new');
  await page.locator('#ssh-remember').check();
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  const order = await page.evaluate(() => (window as any).trustQa.calls.map((c: any) => c.command));
  expect(order.indexOf('ssh_trust_save')).toBeGreaterThan(-1);
  expect(order.indexOf('ssh_trust_save')).toBeLessThan(order.indexOf('ssh_accept'));
  expect((await calls(page, 'ssh_trust_save'))[0]).toEqual({ command: 'ssh_trust_save', challengeToken: 'challenge-1' });
});

test('a failed save stops the connection instead of continuing unsaved', async ({ page }) => {
  await open(page, 'new', true);
  await page.locator('#ssh-remember').check();
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-error')).toHaveText('Host key could not be saved');
  expect(await calls(page, 'ssh_accept')).toEqual([]);
});

test('known host continues without asking again', async ({ page }) => {
  await open(page, 'known');
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  expect(await calls(page, 'ssh_accept')).toHaveLength(1);
  expect(await calls(page, 'ssh_trust_save')).toEqual([]);
});

test('changed key is blocked; replacement needs a separate confirmed action', async ({ page }) => {
  await open(page, 'changed');
  await expect(page.locator('#ssh-changed')).toBeVisible();
  await expect(page.locator('#ssh-saved-fingerprint')).toHaveText('SHA256:saved-key');
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:presented-key');
  await expect(page.locator('#ssh-accept')).toBeDisabled();
  await expect(page.locator('#ssh-remember-row')).toBeHidden();
  await expect(page.locator('#ssh-replace')).toBeDisabled();
  await page.locator('#ssh-replace-confirm').check();
  await page.locator('#ssh-replace').click();
  await expect(page.locator('#ssh-changed')).toBeHidden();
  await expect(page.locator('#ssh-status')).toContainText('已替换');
  expect(await calls(page, 'ssh_accept')).toEqual([]);
  expect((await calls(page, 'ssh_trust_replace'))[0]).toEqual({ command: 'ssh_trust_replace', challengeToken: 'challenge-1' });
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  expect(await calls(page, 'ssh_trust_save')).toEqual([]);
});

test('changed key: rejecting closes without replacing', async ({ page }) => {
  await open(page, 'changed');
  await page.locator('#ssh-reject').click();
  await expect(page.locator('#ssh-verification-dialog')).toBeHidden();
  expect(await calls(page, 'ssh_trust_replace')).toEqual([]);
  expect((await calls(page, 'ssh_reject'))[0]).toMatchObject({ challengeToken: 'challenge-1' });
});

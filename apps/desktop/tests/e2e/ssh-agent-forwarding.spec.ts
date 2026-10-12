import { test, expect, type Page } from '@playwright/test';

// Browser IPC contract for the agent-forwarding opt-in (C10). Commands are
// stubbed: these tests prove what the dialog shows and sends, not that a real
// server reached a real agent. The Rust side runs in
// `cargo test --test ssh_agent_forwarding` against the loopback fixture.
async function setup(page: Page) {
  await page.addInitScript(() => {
    const state: any = { calls: [], opening: null };
    Object.assign(window, { isTauri: true, agentQa: state, __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      invoke(command: string, args: any = {}) {
        state.calls.push({ command, ...args, onEvent: undefined, onAuth: undefined });
        if (command === 'ssh_context') return Promise.resolve('document-scope');
        if (command === 'ssh_probe') return Promise.resolve({
          challengeToken: 'terminal-token', host: '127.0.0.1', port: 2222, algorithm: 'ssh-ed25519',
          fingerprint: 'SHA256:actual-server-key', expiresInSeconds: 60, trust: 'new', savedFingerprint: null,
        });
        if (command === 'ssh_open') return new Promise((resolve, reject) => { state.opening = { resolve, reject, id: args.operationId }; });
        if (command === 'ssh_sftp_open') return new Promise(() => {});
        if (command === 'ssh_accept') return Promise.resolve({ stdout: [], stderr: [], exitCode: 7 });
        return Promise.resolve(null);
      },
    } });
  });
  await page.goto('/');
}
const calls = (page: Page, command: string) =>
  page.evaluate(command => (window as any).agentQa.calls.filter((c: any) => c.command === command), command);
async function openDialog(page: Page, entry: string) {
  if (entry === '#sftp-connect') await page.locator('#files-toggle').click();
  else await page.locator('#connect-open').click();
  await page.locator(entry).click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-port').fill('2222');
  await page.locator('#ssh-username').fill('fixture');
  await page.locator('#ssh-key-path').fill('/private/temporary/key');
}
const option = (page: Page) => page.locator('#ssh-agent-forward');
const warning = (page: Page) => page.locator('#ssh-agent-forward-warning');

test('only the terminal dialog offers agent forwarding, off by default', async ({ page }) => {
  await setup(page);
  for (const entry of ['#ssh-verification-open', '#sftp-connect']) {
    await openDialog(page, entry);
    await expect(page.locator('#ssh-agent-forward-fields')).toBeHidden();
    await page.locator('#ssh-close').click();
  }
  await openDialog(page, '#ssh-terminal-open');
  await expect(page.locator('#ssh-agent-forward-fields')).toBeVisible();
  await expect(page.locator('#ssh-agent-forward-fields label')).toHaveText('转发本机 ssh-agent（仅对信任的主机）');
  await expect(option(page)).not.toBeChecked();
  await expect(warning(page)).toBeHidden();

  // Left off: neither the probe nor the open carries the choice.
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:actual-server-key');
  await expect(page.locator('#ssh-agent-forward-reminder')).toBeHidden();
  await page.locator('#ssh-accept').click();
  await expect.poll(async () => (await calls(page, 'ssh_open')).length).toBe(1);
  const [opened] = await calls(page, 'ssh_open');
  expect(Object.keys(opened)).not.toContain('agentForwarding');
  await page.evaluate(() => { const s = (window as any).agentQa; s.opening.resolve({ id: s.opening.id }); });
  await expect(page.locator('#terminal-state')).toHaveText(/SSH 已连接/);
  await expect(page.locator('#terminal-state')).not.toContainText('ssh-agent');
});

test('turning it on warns, is reminded at the fingerprint and reaches ssh_open only', async ({ page }) => {
  await setup(page);
  await openDialog(page, '#ssh-terminal-open');
  await option(page).check();
  await expect(warning(page)).toBeVisible();
  await expect(warning(page)).toContainText('全部密钥代你签名');
  await expect(warning(page)).toContainText('不保存');
  await option(page).uncheck();
  await expect(warning(page)).toBeHidden();
  await option(page).check();

  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-agent-forward-reminder')).toBeVisible();
  await expect(page.locator('#ssh-agent-forward-reminder')).toContainText('将转发本机 ssh-agent');
  const [probe] = await calls(page, 'ssh_probe');
  expect(JSON.stringify(probe)).not.toContain('agent');
  await page.locator('#ssh-accept').click();
  await expect.poll(async () => (await calls(page, 'ssh_open')).length).toBe(1);
  const [opened] = await calls(page, 'ssh_open');
  expect(opened).toMatchObject({ agentForwarding: true, challengeToken: 'terminal-token', scopeToken: 'document-scope' });
  await page.evaluate(() => { const s = (window as any).agentQa; s.opening.resolve({ id: s.opening.id }); });
  await expect(page.locator('#terminal-state')).toContainText('已转发本机 ssh-agent');

  // A refusal is reported as the backend wrote it, as text.
  await page.locator('#connect-open').click();
  await page.locator('#ssh-terminal-open').click();
  await expect(option(page)).not.toBeChecked();
  await expect(warning(page)).toBeHidden();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-username').fill('fixture');
  await page.locator('#ssh-key-path').fill('/private/temporary/key');
  await option(page).check();
  await page.locator('#ssh-probe').click();
  await page.locator('#ssh-accept').click();
  await expect.poll(async () => (await calls(page, 'ssh_open')).length).toBe(2);
  await page.evaluate(() => (window as any).agentQa.opening.reject('SSH server refused agent forwarding'));
  await expect(page.locator('#terminal-state')).toContainText('SSH server refused agent forwarding');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('agent');
});

test('the choice is cleared when the dialog closes and is never sent for files', async ({ page }) => {
  await setup(page);
  await openDialog(page, '#ssh-terminal-open');
  await option(page).check();
  await page.locator('#ssh-close').click();
  await openDialog(page, '#ssh-terminal-open');
  await expect(option(page)).not.toBeChecked();
  await expect(warning(page)).toBeHidden();
  await page.locator('#ssh-close').click();

  await openDialog(page, '#sftp-connect');
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-agent-forward-reminder')).toBeHidden();
  await page.locator('#ssh-accept').click();
  await expect.poll(async () => (await calls(page, 'ssh_sftp_open')).length).toBe(1);
  expect(JSON.stringify(await calls(page, 'ssh_sftp_open'))).not.toContain('agentForwarding');
});

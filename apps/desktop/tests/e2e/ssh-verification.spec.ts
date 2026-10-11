import { test, expect, type Page } from '@playwright/test';

// IPC contract tests only. Real SSH/host-key behavior belongs to the native fixture tests.
async function open(page: Page, desktop = true, holdContext = false) {
  if (desktop) await page.addInitScript(holdContext => {
    const state: any = { calls: [], probe: null, accept: null, context: null };
    Object.assign(window, {
      isTauri: true,
      sshQa: state,
      __TAURI_INTERNALS__: {
        invoke(command: string, args: unknown) {
          state.calls.push({ command, args });
          if (command === 'ssh_context') {
            if (holdContext) return new Promise((resolve, reject) => { state.context = { resolve, reject }; });
            return Promise.resolve('document-scope-token');
          }
          if (command === 'ssh_probe' || command === 'ssh_accept') {
            return new Promise((resolve, reject) => { state[command === 'ssh_probe' ? 'probe' : 'accept'] = { resolve, reject }; });
          }
          return Promise.resolve(null);
        },
      },
    });
  }, holdContext);
  await page.goto('/');
  await page.locator('#connect-open').click();
  await page.locator('#ssh-verification-open').click();
  await expect(page.locator('#ssh-verification-dialog')).toBeVisible();
}
async function probe(page: Page) {
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-port').fill('54321');
  await page.locator('#ssh-username').fill('fixture-user');
  await page.locator('#ssh-key-path').fill('/temporary/test-ed25519');
  await page.locator('#ssh-probe').click();
}
async function challenge(page: Page, seconds = 60) {
  await page.evaluate(seconds => (window as any).sshQa.probe.resolve({
    challengeToken: 'one-use-token', host: '127.0.0.1', port: 54321,
    algorithm: 'ssh-ed25519', fingerprint: 'SHA256:actual-fixture-test-fingerprint', expiresInSeconds: seconds,
  }), seconds);
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:actual-fixture-test-fingerprint');
}
async function calls(page: Page, command: string) {
  return page.evaluate(command => (window as any).sshQa.calls.filter((call: any) => call.command === command), command);
}

test('browser clearly disables real verification and sends no network request', async ({ page }) => {
  const external: string[] = [];
  page.on('request', request => { if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url()); });
  await open(page, false);
  await expect(page.locator('#ssh-browser-note')).toBeVisible();
  await expect(page.locator('#ssh-probe')).toBeDisabled();
  await expect(page.locator('#ssh-host')).toBeDisabled();
  expect(external).toEqual([]);
});

test('unknown host never authenticates automatically; explicit trust sends exact token once', async ({ page }) => {
  await open(page);
  await expect(page.locator('#ssh-host')).toBeFocused();
  await probe(page);
  const probeCalls = await calls(page, 'ssh_probe');
  expect(probeCalls[0].args.request).toEqual({ host: '127.0.0.1', port: 54321, username: 'fixture-user', privateKeyPath: '/temporary/test-ed25519' });
  expect(probeCalls[0].args.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(probeCalls[0].args.scopeToken).toBe('document-scope-token');
  await challenge(page);
  expect(await calls(page, 'ssh_accept')).toEqual([]);
  await expect(page.locator('#ssh-endpoint')).toHaveText('127.0.0.1:54321');
  await expect(page.locator('#ssh-key-path')).toHaveValue('');
  await expect(page.locator('#ssh-reject')).toBeFocused();
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-accept')).toBeDisabled();
  await page.locator('#ssh-accept').evaluate(el => (el as HTMLButtonElement).click());
  const accepted = await calls(page, 'ssh_accept');
  expect(accepted).toHaveLength(1);
  expect(accepted[0].args.challengeToken).toBe('one-use-token');
  expect(accepted[0].args.scopeToken).toBe('document-scope-token');
  expect(accepted[0].args.operationId).not.toBe(probeCalls[0].args.operationId);
});

test('failed desktop context cannot initiate a probe', async ({ page }) => {
  await open(page, true, true);
  await expect(page.locator('#ssh-probe')).toBeDisabled();
  await page.evaluate(() => (window as any).sshQa.context.reject('Document context unavailable'));
  await expect(page.locator('#ssh-error')).toHaveText('Document context unavailable');
  await expect(page.locator('#ssh-probe')).toBeDisabled();
  await page.locator('#ssh-verification-form').evaluate(form => form.dispatchEvent(new Event('submit', { cancelable: true })));
  expect(await calls(page, 'ssh_probe')).toEqual([]);
});

test('context arriving after close cannot enable or resurrect the dialog', async ({ page }) => {
  await open(page, true, true);
  await page.locator('#ssh-close').click();
  await page.evaluate(() => (window as any).sshQa.context.resolve('old-document-token'));
  await expect(page.locator('#ssh-verification-dialog')).toBeHidden();
  await expect(page.locator('#ssh-probe')).toBeDisabled();
  await expect(page.locator('#ssh-status')).toBeEmpty();
  expect(await calls(page, 'ssh_probe')).toEqual([]);
});

test('reject clears the challenge and sensitive fields without authentication', async ({ page }) => {
  await open(page); await probe(page); await challenge(page);
  await page.locator('#ssh-reject').click();
  await expect(page.locator('#ssh-verification-dialog')).toBeHidden();
  expect(await calls(page, 'ssh_reject')).toEqual([{ command: 'ssh_reject', args: { challengeToken: 'one-use-token' } }]);
  expect(await calls(page, 'ssh_accept')).toEqual([]);
  await expect(page.locator('#ssh-key-path')).toHaveValue('');
  await expect(page.locator('#ssh-username')).toHaveValue('');
});

test('Escape during probe cancels operation and rejects a late challenge without reopening', async ({ page }) => {
  await open(page); await probe(page);
  const operationId = (await calls(page, 'ssh_probe'))[0].args.operationId;
  await page.keyboard.press('Escape');
  expect(await calls(page, 'ssh_cancel')).toEqual([{ command: 'ssh_cancel', args: { operationId } }]);
  await page.evaluate(() => (window as any).sshQa.probe.resolve({ challengeToken: 'late-token' }));
  await expect.poll(() => calls(page, 'ssh_reject')).toEqual([{ command: 'ssh_reject', args: { challengeToken: 'late-token' } }]);
  await expect(page.locator('#ssh-verification-dialog')).toBeHidden();
  await expect(page.locator('#ssh-fingerprint')).toBeEmpty();
});

test('cancel during accept ignores late output even after reopening', async ({ page }) => {
  await open(page); await probe(page); await challenge(page);
  await page.locator('#ssh-accept').click();
  const operationId = (await calls(page, 'ssh_accept'))[0].args.operationId;
  await page.locator('#ssh-cancel').click();
  expect(await calls(page, 'ssh_cancel')).toEqual([{ command: 'ssh_cancel', args: { operationId } }]);
  await page.locator('#connect-open').click();
  await page.locator('#ssh-verification-open').click();
  await page.evaluate(() => (window as any).sshQa.accept.resolve({ stdout: [65], stderr: [], exitCode: 7 }));
  await expect(page.locator('#ssh-result')).toBeEmpty();
  await expect(page.locator('#ssh-result')).toBeHidden();
  await expect(page.locator('#ssh-host')).toHaveValue('');
});

for (const phase of ['probe', 'accept'] as const) {
  test(`${phase} error is safe accessible text and retry requires fresh input`, async ({ page }) => {
    await open(page); await probe(page);
    if (phase === 'accept') { await challenge(page); await page.locator('#ssh-accept').click(); }
    await page.evaluate(phase => (window as any).sshQa[phase].reject('<img src=x onerror=alert(1)> rejected'), phase);
    await expect(page.locator('#ssh-error')).toHaveText('<img src=x onerror=alert(1)> rejected');
    await expect(page.locator('#ssh-error img')).toHaveCount(0);
    await expect(page.locator('#ssh-error')).toHaveAttribute('role', 'alert');
    await page.locator('#ssh-retry').click();
    await expect(page.locator('#ssh-host')).toBeFocused();
    await expect(page.locator('#ssh-key-path')).toHaveValue('');
    await expect(page.locator('#ssh-probe')).toBeEnabled();
  });
}

test('expired trust cannot authenticate and rejects its challenge', async ({ page }) => {
  await open(page); await probe(page);
  await page.clock.install();
  await challenge(page, 1);
  await page.clock.runFor(1001);
  await expect(page.locator('#ssh-accept')).toBeDisabled();
  await expect(page.locator('#ssh-expiry')).toContainText('已过期');
  expect(await calls(page, 'ssh_accept')).toEqual([]);
  expect(await calls(page, 'ssh_reject')).toHaveLength(1);
});

test('exit 7 is a command result and arbitrary bytes are text with raw hex available', async ({ page }) => {
  await open(page); await probe(page); await challenge(page);
  await page.locator('#ssh-accept').click();
  await page.evaluate(() => (window as any).sshQa.accept.resolve({
    stdout: [...new TextEncoder().encode('<script>alert(1)</script> 中文 🌏'), 255], stderr: [0, 1, 65], exitCode: 7,
  }));
  await expect(page.locator('#ssh-result')).toContainText('exit 7（测试夹具预期退出码）');
  await expect(page.locator('#ssh-result')).toContainText('<script>alert(1)</script> 中文 🌏�');
  await expect(page.locator('#ssh-result script')).toHaveCount(0);
  await expect(page.locator('#ssh-error')).toBeEmpty();
  await page.locator('#ssh-result summary').first().click();
  await expect(page.locator('#ssh-result details pre').first()).toContainText('ff');
});

test('unload cancels in-flight verification and clears the private key path', async ({ page }) => {
  await open(page); await probe(page);
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')));
  expect(await calls(page, 'ssh_cancel')).toHaveLength(1);
  await expect(page.locator('#ssh-key-path')).toHaveValue('');
});

for (const theme of ['light', 'dark']) {
  test(`1000x650 ${theme} challenge stays within viewport and actions remain reachable`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1000, height: 650 });
    await page.addInitScript(theme => localStorage.setItem('windterm-p0-theme', theme), theme);
    await open(page); await probe(page); await challenge(page);
    await page.waitForTimeout(180);
    const bounds = await page.locator('#ssh-verification-dialog').boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1000);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(650);
    await expect(page.locator('#ssh-accept')).toBeInViewport();
    expect(await page.locator('#ssh-verification-dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`ssh-${theme}-1000.png`) });
  });
}

import { test, expect, type Page } from '@playwright/test';

// IPC contract for SSH connection routes (HTTP CONNECT, SOCKS5, ProxyCommand,
// one jump host). Every command is a stub: these tests prove what the dialog
// sends and shows, not proxy, ProxyCommand or jump networking in Rust.
type Trust = 'new' | 'known' | 'changed';
type Options = { entry?: string; jumpTrust?: Trust; targetTrust?: Trust; holdThrough?: boolean; holdPreview?: boolean; seconds?: number };
const ARGV = ['/usr/bin/nc', '-X', 'connect', '<img src=x onerror=alert(1)>', '127.0.0.1', '2222'];

async function open(page: Page, options: Options = {}) {
  await page.addInitScript(({ options, argv }) => {
    const state: any = { calls: [], route: null, held: {} };
    const target = (route: any) => ({
      challengeToken: 'target-token', host: '127.0.0.1', port: 2222, algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:target-key', expiresInSeconds: options.seconds ?? 60, trust: options.targetTrust ?? 'new',
      savedFingerprint: null, stage: 'target', route,
    });
    const summary = (route: any) => route.kind === 'httpConnect' || route.kind === 'socks5'
      ? { kind: route.kind, host: route.host, port: route.port, authenticated: 'username' in route }
      : route.kind === 'proxyCommand' ? { kind: 'proxyCommand', argv: route.argv } : { kind: 'direct' };
    const hold = (command: string) => new Promise((resolve, reject) => { state.held[command] = { resolve, reject }; });
    Object.assign(window, {
      isTauri: true,
      routeQa: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        invoke(command: string, args: any = {}) {
          state.calls.push({ name: command, args: JSON.parse(JSON.stringify({ ...args, onEvent: undefined, onAuth: undefined })) });
          if (command === 'ssh_context') return Promise.resolve('document-scope');
          if (command === 'ssh_proxy_command_preview') return options.holdPreview ? hold(command) : Promise.resolve(argv);
          if (command === 'ssh_probe') {
            state.route = args.route;
            if (args.route?.kind !== 'jump') return Promise.resolve(target(summary(args.route ?? { kind: 'direct' })));
            const trust = options.jumpTrust ?? 'new';
            return Promise.resolve({
              challengeToken: 'jump-token', host: args.route.host, port: args.route.port, algorithm: 'ssh-ed25519',
              fingerprint: 'SHA256:jump-key', expiresInSeconds: options.seconds ?? 60, trust,
              savedFingerprint: trust === 'changed' ? 'SHA256:old-jump-key' : null, stage: 'jump', route: { kind: 'direct' },
            });
          }
          if (command === 'ssh_probe_through') {
            if (options.holdThrough) return hold(command);
            const { host, port, username } = state.route;
            return Promise.resolve(target({ kind: 'jump', host, port, username, fingerprint: 'SHA256:jump-key' }));
          }
          if (command === 'ssh_accept') return Promise.resolve({ stdout: [], stderr: [], exitCode: 7 });
          if (command === 'ssh_open' || command === 'ssh_sftp_open') return new Promise(() => {});
          return Promise.resolve(null);
        },
      },
    });
  }, { options, argv: ARGV });
  await page.goto('/');
  await page.locator('#connect-open').click();
  await page.locator(options.entry ?? '#ssh-verification-open').click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-port').fill('2222');
  await page.locator('#ssh-username').fill('fixture');
  await page.locator('#ssh-key-path').fill('/keys/target');
}
// Arguments of each call to `command`, in order.
const calls = (page: Page, command: string) =>
  page.evaluate(command => (window as any).routeQa.calls.filter((c: any) => c.name === command).map((c: any) => c.args), command);
const commands = (page: Page) => page.evaluate(() => (window as any).routeQa.calls.map((c: any) => c.name));
async function jump(page: Page, auth: 'key' | 'password' = 'password') {
  await page.locator('#ssh-route').selectOption('jump');
  await page.locator('#ssh-jump-host').fill('bastion.example');
  await page.locator('#ssh-jump-port').fill('2200');
  await page.locator('#ssh-jump-username').fill('jumper');
  await page.locator('#ssh-jump-auth').selectOption(auth);
  if (auth === 'password') await page.locator('#ssh-jump-password').fill('jump-secret');
  else await page.locator('#ssh-jump-key-path').fill('/keys/jump');
}
async function previewed(page: Page) {
  await page.locator('#ssh-proxy-command-preview').click();
  await expect(page.locator('#ssh-proxy-argv li')).toHaveCount(ARGV.length);
  await expect(page.locator('#ssh-proxy-command-confirm')).toBeEnabled();
}
async function cleared(page: Page) {
  await expect(page.locator('#ssh-proxy-argv li')).toHaveCount(0);
  await expect(page.locator('#ssh-proxy-command-confirm')).not.toBeChecked();
  await expect(page.locator('#ssh-proxy-command-confirm')).toBeDisabled();
}

test('browser mode keeps the route section disabled', async ({ page }) => {
  await page.goto('/');
  await page.locator('#connect-open').click();
  await page.locator('#ssh-verification-open').click();
  await expect(page.locator('#ssh-route')).toBeDisabled();
  await expect(page.locator('#ssh-route')).toHaveValue('direct');
});

test('direct route is sent explicitly with the unchanged request', async ({ page }) => {
  await open(page);
  await expect(page.locator('#ssh-route')).toHaveValue('direct');
  await expect(page.locator('#ssh-proxy-fields')).toBeHidden();
  await expect(page.locator('#ssh-jump-fields')).toBeHidden();
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:target-key');
  const probe = (await calls(page, 'ssh_probe'))[0];
  expect(probe.route).toEqual({ kind: 'direct' });
  expect(probe.request).toEqual({ host: '127.0.0.1', port: 2222, username: 'fixture', privateKeyPath: '/keys/target' });
  await expect(page.locator('#ssh-route-summary')).toHaveText('直连');
  await expect(page.locator('#ssh-route-step')).toBeHidden();
});

test('HTTP CONNECT: proxy login travels only with the probe and is wiped', async ({ page }) => {
  await open(page);
  await page.locator('#ssh-route').selectOption('httpConnect');
  await expect(page.locator('#ssh-proxy-port')).toHaveValue('3128');
  await page.locator('#ssh-proxy-host').fill('proxy.example');
  await page.locator('#ssh-proxy-port').fill('8080');
  await page.locator('#ssh-proxy-username').fill('proxy-user');
  await page.locator('#ssh-proxy-password').fill('proxy-secret');
  await page.locator('#ssh-auth').selectOption('password');
  await page.locator('#ssh-password').fill('target-secret');
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:target-key');
  const probe = (await calls(page, 'ssh_probe'))[0];
  expect(probe.route).toEqual({ kind: 'httpConnect', host: 'proxy.example', port: 8080, username: 'proxy-user', password: 'proxy-secret' });
  expect(JSON.stringify(probe)).not.toContain('target-secret');
  await expect(page.locator('#ssh-proxy-password')).toHaveValue('');
  await expect(page.locator('#ssh-route-summary')).toHaveText('经 HTTP 代理 proxy.example:8080，已提供代理认证');
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  const accepted = await calls(page, 'ssh_accept');
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).not.toHaveProperty('route');
  expect(JSON.stringify(accepted[0])).not.toContain('proxy-secret');
  expect(accepted[0].credential).toEqual({ method: 'password', password: 'target-secret' });
});

test('SOCKS5: anonymous route omits login keys; a password needs a username', async ({ page }) => {
  await open(page);
  await page.locator('#ssh-route').selectOption('httpConnect');
  await page.locator('#ssh-route').selectOption('socks5');
  await expect(page.locator('#ssh-proxy-port')).toHaveValue('1080');
  await page.locator('#ssh-proxy-port').fill('1081');
  await page.locator('#ssh-route').selectOption('httpConnect');
  await expect(page.locator('#ssh-proxy-port')).toHaveValue('1081');
  await page.locator('#ssh-route').selectOption('socks5');
  await page.locator('#ssh-proxy-host').fill('socks.example');
  await page.locator('#ssh-proxy-password').fill('lonely-secret');
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-error')).toContainText('代理用户名');
  await expect(page.locator('#ssh-proxy-username')).toBeFocused();
  expect(await calls(page, 'ssh_probe')).toEqual([]);
  await page.locator('#ssh-proxy-password').fill('');
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:target-key');
  const route = (await calls(page, 'ssh_probe'))[0].route;
  expect(route).toEqual({ kind: 'socks5', host: 'socks.example', port: 1081 });
  expect(Object.keys(route)).toEqual(['kind', 'host', 'port']);
  await expect(page.locator('#ssh-route-summary')).toHaveText('经 SOCKS5 代理 socks.example:1081');
});

test('ProxyCommand: exact previewed argv must be confirmed before the probe', async ({ page }) => {
  const command = '/usr/bin/nc -X connect %h %p';
  await open(page);
  await page.locator('#ssh-route').selectOption('proxyCommand');
  await page.locator('#ssh-proxy-command').fill(command);
  await expect(page.locator('#ssh-proxy-command-confirm')).toBeDisabled();
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-error')).toContainText('预览');
  expect(await calls(page, 'ssh_probe')).toEqual([]);

  await previewed(page);
  const preview = (await calls(page, 'ssh_proxy_command_preview'))[0];
  expect(preview).toEqual({ request: { host: '127.0.0.1', port: 2222, username: 'fixture', privateKeyPath: '/keys/target' }, command });
  await expect(page.locator('#ssh-proxy-argv li').nth(3)).toHaveText('<img src=x onerror=alert(1)>');
  await expect(page.locator('#ssh-proxy-argv li').first()).toHaveText('/usr/bin/nc');
  await expect(page.locator('#ssh-verification-dialog img')).toHaveCount(0);

  await page.locator('#ssh-proxy-command-confirm').check();
  await page.locator('#ssh-proxy-command').fill(`${command} `);
  await cleared(page);
  await page.locator('#ssh-proxy-command').fill(command);
  await previewed(page);
  await page.locator('#ssh-proxy-command-confirm').check();
  await page.locator('#ssh-host').fill('127.0.0.2');
  await cleared(page);
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-probe').click();
  expect(await calls(page, 'ssh_probe')).toEqual([]);

  await previewed(page);
  await page.locator('#ssh-proxy-command-confirm').check();
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:target-key');
  const probe = (await calls(page, 'ssh_probe'))[0];
  expect(probe.route).toEqual({ kind: 'proxyCommand', command, argv: ARGV });
  await expect(page.locator('#ssh-route-summary')).toHaveText(`经 ProxyCommand：${ARGV.join(' ')}`);
  await expect(page.locator('#ssh-verification-dialog img')).toHaveCount(0);
});

test('ProxyCommand: a preview that returns after an edit is discarded', async ({ page }) => {
  await open(page, { holdPreview: true });
  await page.locator('#ssh-route').selectOption('proxyCommand');
  await page.locator('#ssh-proxy-command').fill('/usr/bin/nc %h %p');
  await page.locator('#ssh-proxy-command-preview').click();
  await expect.poll(async () => (await calls(page, 'ssh_proxy_command_preview')).length).toBe(1);
  await page.locator('#ssh-port').fill('2223');
  await page.evaluate(argv => (window as any).routeQa.held.ssh_proxy_command_preview.resolve(argv), ARGV);
  await page.waitForTimeout(50);
  await cleared(page);
  await page.locator('#ssh-probe').click();
  expect(await calls(page, 'ssh_probe')).toEqual([]);
});

test('jump host: two confirmations, jump login only after the first', async ({ page }) => {
  await open(page);
  await page.locator('#ssh-auth').selectOption('password');
  await page.locator('#ssh-password').fill('target-secret');
  await jump(page);
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:jump-key');
  const probe = (await calls(page, 'ssh_probe'))[0];
  expect(probe.route).toEqual({ kind: 'jump', host: 'bastion.example', port: 2200, username: 'jumper', privateKeyPath: '' });
  expect(JSON.stringify(probe)).not.toContain('jump-secret');
  expect(JSON.stringify(probe)).not.toContain('target-secret');
  await expect(page.locator('#ssh-jump-password')).toHaveValue('');
  await expect(page.locator('#ssh-password')).toHaveValue('');
  await expect(page.locator('#ssh-route-step')).toHaveText('第 1 步，共 2 步：核对跳板主机指纹');
  await expect(page.locator('#ssh-endpoint')).toHaveText('bastion.example:2200');
  await expect(page.locator('#ssh-route-summary')).toHaveText('直连跳板主机');
  await expect(page.locator('#ssh-accept')).toHaveText('信任跳板主机并检查目标指纹');
  expect(await calls(page, 'ssh_accept')).toEqual([]);
  expect(await calls(page, 'ssh_probe_through')).toEqual([]);

  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-route-step')).toHaveText('第 2 步，共 2 步：核对目标主机指纹（经跳板主机）');
  const through = await calls(page, 'ssh_probe_through');
  expect(through).toHaveLength(1);
  expect(through[0]).toMatchObject({ scopeToken: 'document-scope', challengeToken: 'jump-token', credential: { method: 'password', password: 'jump-secret' } });
  expect(through[0].operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(through[0].operationId).not.toBe(probe.operationId);
  expect(JSON.stringify(through[0])).not.toContain('target-secret');
  await expect(page.locator('#ssh-endpoint')).toHaveText('127.0.0.1:2222');
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:target-key');
  await expect(page.locator('#ssh-route-summary')).toHaveText('经跳板主机 jumper@bastion.example:2200（已确认指纹 SHA256:jump-key）');
  await expect(page.locator('#ssh-accept')).toHaveText('仅本次信任并验证');
  expect(await calls(page, 'ssh_accept')).toEqual([]);

  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  const accepted = await calls(page, 'ssh_accept');
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({ challengeToken: 'target-token', credential: { method: 'password', password: 'target-secret' } });
  expect(accepted[0]).not.toHaveProperty('route');
  expect(JSON.stringify(accepted[0])).not.toContain('jump-secret');
  expect(await calls(page, 'ssh_probe_through')).toHaveLength(1);
});

test('jump host: a changed jump key blocks step 2 until replaced', async ({ page }) => {
  await open(page, { jumpTrust: 'changed' });
  await jump(page, 'key');
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-changed')).toBeVisible();
  expect((await calls(page, 'ssh_probe'))[0].route.privateKeyPath).toBe('/keys/jump');
  await expect(page.locator('#ssh-jump-key-path')).toHaveValue('');
  await expect(page.locator('#ssh-saved-fingerprint')).toHaveText('SHA256:old-jump-key');
  await expect(page.locator('#ssh-accept')).toBeDisabled();
  await page.locator('#ssh-accept').evaluate(el => (el as HTMLButtonElement).click());
  expect(await calls(page, 'ssh_probe_through')).toEqual([]);
  await page.locator('#ssh-replace-confirm').check();
  await page.locator('#ssh-replace').click();
  await expect(page.locator('#ssh-changed')).toBeHidden();
  expect(await calls(page, 'ssh_trust_replace')).toEqual([{ challengeToken: 'jump-token' }]);
  expect(await calls(page, 'ssh_probe_through')).toEqual([]);
  await expect(page.locator('#ssh-accept')).toHaveText('继续检查目标指纹');
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:target-key');
  expect((await calls(page, 'ssh_probe_through'))[0].credential).toEqual({ method: 'key' });
});

test('jump host: known keys continue through both steps without asking', async ({ page }) => {
  await open(page, { jumpTrust: 'known', targetTrust: 'known' });
  await jump(page);
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-result')).toContainText('exit 7');
  const order = (await commands(page)).filter((c: string) => c !== 'ssh_context');
  expect(order).toEqual(['ssh_probe', 'ssh_probe_through', 'ssh_accept']);
});

test('jump host: saving the jump key happens before its challenge is consumed', async ({ page }) => {
  await open(page);
  await jump(page);
  await page.locator('#ssh-probe').click();
  await page.locator('#ssh-remember').check();
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-fingerprint')).toHaveText('SHA256:target-key');
  await expect(page.locator('#ssh-remember')).not.toBeChecked();
  const order = (await commands(page)).filter((c: string) => c !== 'ssh_context');
  expect(order).toEqual(['ssh_probe', 'ssh_trust_save', 'ssh_probe_through']);
  expect(await calls(page, 'ssh_trust_save')).toEqual([{ challengeToken: 'jump-token' }]);
});

test('jump host: an expired jump challenge is rejected and cannot continue', async ({ page }) => {
  await open(page, { seconds: 1 });
  await jump(page);
  await page.clock.install();
  await page.locator('#ssh-probe').click();
  await expect(page.locator('#ssh-route-step')).toHaveText('第 1 步，共 2 步：核对跳板主机指纹');
  await page.clock.runFor(1001);
  await expect(page.locator('#ssh-expiry')).toContainText('已过期');
  await expect(page.locator('#ssh-accept')).toBeDisabled();
  expect(await calls(page, 'ssh_reject')).toEqual([{ challengeToken: 'jump-token' }]);
  expect(await calls(page, 'ssh_probe_through')).toEqual([]);
});

test('terminal hand-off after a proxy route carries no route or proxy secret', async ({ page }) => {
  await open(page, { entry: '#ssh-terminal-open' });
  await page.locator('#ssh-route').selectOption('httpConnect');
  await page.locator('#ssh-proxy-host').fill('proxy.example');
  await page.locator('#ssh-proxy-username').fill('proxy-user');
  await page.locator('#ssh-proxy-password').fill('proxy-secret');
  await page.locator('#ssh-auth').selectOption('password');
  await page.locator('#ssh-password').fill('terminal-secret');
  await page.locator('#ssh-probe').click();
  await page.locator('#ssh-accept').click();
  await expect.poll(async () => (await calls(page, 'ssh_open')).length).toBe(1);
  const opened = (await calls(page, 'ssh_open'))[0];
  expect(opened).toMatchObject({ challengeToken: 'target-token', scopeToken: 'document-scope' });
  expect(opened.credential).toEqual({ method: 'password', password: 'terminal-secret' });
  expect(opened).not.toHaveProperty('route');
  expect(JSON.stringify(opened)).not.toContain('proxy-secret');
  expect(JSON.stringify(opened)).not.toContain('proxy.example');
});

test('terminal hand-off after a jump route names the target and sends no jump secret', async ({ page }) => {
  await open(page, { entry: '#ssh-terminal-open' });
  await jump(page);
  await page.locator('#ssh-probe').click();
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-accept')).toHaveText('仅本次信任并打开终端');
  await page.locator('#ssh-accept').click();
  await expect.poll(async () => (await calls(page, 'ssh_open')).length).toBe(1);
  const opened = (await calls(page, 'ssh_open'))[0];
  expect(opened).toMatchObject({ challengeToken: 'target-token', credential: { method: 'key' } });
  expect(opened).not.toHaveProperty('route');
  expect(JSON.stringify(opened)).not.toContain('jump-secret');
  await expect(page.getByRole('tab', { name: /127\.0\.0\.1:2222/ })).toBeVisible();
});

test('cancel during step 2 cancels the operation, rejects a late challenge and resets the route', async ({ page }) => {
  await open(page, { holdThrough: true });
  await jump(page);
  await page.locator('#ssh-probe').click();
  await page.locator('#ssh-accept').click();
  await expect(page.locator('#ssh-status')).toContainText('正在登录跳板主机');
  const operationId = (await calls(page, 'ssh_probe_through'))[0].operationId;
  await page.locator('#ssh-cancel').click();
  await expect(page.locator('#ssh-verification-dialog')).toBeHidden();
  expect(await calls(page, 'ssh_cancel')).toEqual([{ operationId }]);
  await page.evaluate(() => (window as any).routeQa.held.ssh_probe_through.resolve({ challengeToken: 'late-target-token' }));
  await expect.poll(() => calls(page, 'ssh_reject')).toEqual([{ challengeToken: 'late-target-token' }]);
  await page.locator('#connect-open').click();
  await page.locator('#ssh-verification-open').click();
  await expect(page.locator('#ssh-route')).toHaveValue('direct');
  await expect(page.locator('#ssh-jump-fields')).toBeHidden();
  await expect(page.locator('#ssh-jump-host')).toHaveValue('');
  await expect(page.locator('#ssh-jump-password')).toHaveValue('');
});

import { test, expect, type Page } from '@playwright/test';

// IPC contracts only. Native environment readback is covered by separate probes.
async function setup(page: Page) {
  await page.addInitScript(() => {
    const state: any = { opens: [], channels: [], error: null };
    Object.assign(window, {
      isTauri: true,
      qaEnvironment: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke: (command: string, args: any = {}) => {
          if (command === 'pty_shells') return Promise.resolve([]);
          if (command === 'pty_open') {
            state.opens.push(structuredClone({ cwd: args.cwd, shell: args.shell, env: args.env, locale: args.locale }));
            state.channels.push(args.onEvent);
            if (state.error) return Promise.reject(state.error);
            return Promise.resolve({ id: `env-${state.opens.length}` });
          }
          return Promise.resolve(null);
        },
      },
    });
  });
  await page.goto('/');
}
async function opens(page: Page) {
  return page.evaluate(() => (window as any).qaEnvironment.opens);
}
async function options(page: Page) {
  await page.locator('#local-options-open').click();
}
async function env(page: Page, name: string, value: string) {
  await page.locator('#local-env-add').click();
  await page.locator('[data-env-name]').last().fill(name);
  await page.locator('[data-env-value]').last().fill(value);
}
async function locale(page: Page, name: string, value: string) {
  await page.locator('#local-locale-mode').selectOption('custom');
  await page.locator('#local-locale-add').click();
  await page.locator('[data-locale-name]').last().selectOption(name);
  await page.locator('[data-locale-value]').last().fill(value);
}
async function exit(page: Page, index: number) {
  await page.evaluate(index => (window as any).qaEnvironment.channels[index].onmessage({ kind: 'exit', id: `env-${index + 1}`, code: 7 }), index);
  await expect(page.locator('#terminal-state')).toContainText('已退出');
}

test('default quick launch and default form preserve platform locale defaults', async ({ page }) => {
  await setup(page);
  await page.locator('#local-open').click();
  await options(page);
  await page.locator('#local-start').click();
  expect(await opens(page)).toEqual([
    { cwd: null, shell: null, env: [], locale: null },
    { cwd: null, shell: null, env: [], locale: { mode: 'default', variables: [] } },
  ]);
});

test('literal Unicode, whitespace, equals, newline, shell syntax and empty values reach IPC', async ({ page }) => {
  await setup(page);
  await options(page);
  await env(page, 'P1_ENV_SAMPLE', ' 中文 space=one\n$HOME $(echo nope); & %PATH% ');
  await env(page, 'P1_ENV_EMPTY', '');
  await env(page, 'PATH', '/controlled/bin');
  await locale(page, 'LANG', 'en_US.UTF-8');
  await page.locator('#local-start').click();
  expect((await opens(page))[0]).toMatchObject({
    env: [
      { name: 'P1_ENV_SAMPLE', value: ' 中文 space=one\n$HOME $(echo nope); & %PATH% ' },
      { name: 'P1_ENV_EMPTY', value: '' },
      { name: 'PATH', value: '/controlled/bin' },
    ],
    locale: { mode: 'custom', variables: [{ name: 'LANG', value: 'en_US.UTF-8' }] },
  });
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
  await expect(page.locator('#session-detail')).not.toContainText('space=one');
});

test('editing a separate launch and reopening old tab preserve independent deep snapshots', async ({ page }) => {
  await setup(page);
  await options(page);
  await env(page, 'P1_ENV_SAMPLE', 'old');
  await locale(page, 'LANG', 'en_US.UTF-8');
  await page.locator('#local-start').click();
  await exit(page, 0);
  await page.locator('#local-edit-cwd').click();
  await page.locator('[data-env-value]').fill('new');
  await page.locator('[data-locale-value]').fill('C');
  await page.locator('#local-start').click();
  await page.getByRole('tab', { name: /Local 2/ }).click();
  await page.locator('#local-reopen').click();
  const calls = await opens(page);
  expect(calls[0]).toEqual(calls[2]);
  expect(calls[1].env[0].value).toBe('new');
  expect(calls[1].locale.variables[0].value).toBe('C');
  expect(calls[2].env[0].value).toBe('old');
  await exit(page, 2);
  await page.locator('#local-edit-cwd').click();
  await expect(page.locator('[data-env-value]')).toHaveValue('old');
  await expect(page.locator('[data-locale-value]')).toHaveValue('en_US.UTF-8');
});

test('failed launch retains config for reopen and backend validation stays authoritative', async ({ page }) => {
  await setup(page);
  await options(page);
  await env(page, 'BASH_ENV', 'private-value');
  await page.evaluate(() => (window as any).qaEnvironment.error = '环境变量名称被保留');
  await page.locator('#local-start').click();
  await expect(page.locator('#terminal-state')).toContainText('启动失败：环境变量名称被保留');
  await options(page);
  await page.locator('[data-env-value]').fill('later-draft');
  await page.locator('#local-dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('#local-reopen').click();
  const calls = await opens(page);
  expect(calls[0]).toEqual(calls[1]);
  await expect(page.locator('#terminal-state')).not.toContainText('private-value');
});

test('custom empty clears defaults while returning to default omits drafted locale rows', async ({ page }) => {
  await setup(page);
  await options(page);
  await page.locator('#local-locale-mode').selectOption('custom');
  await page.locator('#local-start').click();
  await options(page);
  await locale(page, 'LC_CTYPE', 'UTF-8');
  await page.locator('#local-locale-mode').selectOption('default');
  await expect(page.locator('#local-locale-custom')).toBeHidden();
  await page.locator('#local-start').click();
  expect((await opens(page)).map((call: any) => call.locale)).toEqual([
    { mode: 'custom', variables: [] }, { mode: 'default', variables: [] },
  ]);
});

test('LANG plus LC_ALL allowed; LC_ALL with another category rejected', async ({ page }) => {
  await setup(page);
  await options(page);
  await locale(page, 'LANG', 'en_US.UTF-8');
  await locale(page, 'LC_ALL', 'C');
  await locale(page, 'LC_CTYPE', 'UTF-8');
  await page.locator('#local-start').click();
  await expect(page.locator('#local-options-error')).toContainText('LC_ALL 不能');
  expect(await opens(page)).toHaveLength(0);
  await page.locator('[data-locale-remove]').last().click();
  await page.locator('#local-start').click();
  expect((await opens(page))[0].locale.variables).toHaveLength(2);
});

for (const [name, value, message] of [
  ['bad=name', 'SECRET', '名称须为'],
  ['N'.repeat(65), 'SECRET', '名称须为'],
  ['LANG', 'SECRET', 'Locale 区域'],
  ['LC_CUSTOM', 'SECRET', 'Locale 区域'],
  ['GOOD', 'private\0value', 'NUL'],
  ['GOOD', '中'.repeat(1366), '4096 UTF-8'],
] as const) {
  test(`invalid environment ${name.slice(0, 15)} / ${message} stays in form`, async ({ page }) => {
    await setup(page);
    await options(page);
    await env(page, name, value);
    await page.locator('#local-start').click();
    await expect(page.locator('#local-options-error')).toContainText(message);
    await expect(page.locator('#local-options-error')).not.toContainText(value);
    await expect(page.locator('#local-options-error')).toBeFocused();
    expect(await opens(page)).toHaveLength(0);
  });
}

test('duplicates and aggregate UTF-8 budget are checked before IPC', async ({ page }) => {
  await setup(page);
  await options(page);
  await env(page, 'DUP', 'one');
  await env(page, 'DUP', 'two');
  await page.locator('#local-start').click();
  await expect(page.locator('#local-options-error')).toContainText('名称不能重复');
  await page.locator('[data-env-remove]').last().click();
  await page.locator('[data-env-value]').fill('x'.repeat(4096));
  for (const name of ['A', 'B', 'C']) await env(page, name, 'x'.repeat(4096));
  await page.locator('#local-start').click();
  await expect(page.locator('#local-options-error')).toContainText('16 KiB');
  expect(await opens(page)).toHaveLength(0);
});

test('duplicate locale rows are rejected without echoing their values', async ({ page }) => {
  await setup(page);
  await options(page);
  await locale(page, 'LANG', 'private-one');
  await locale(page, 'LANG', 'private-two');
  await page.locator('#local-start').click();
  await expect(page.locator('#local-options-error')).toHaveText('Locale名称不能重复。');
  expect(await opens(page)).toHaveLength(0);
});

test('malicious row text remains literal and is absent from status, storage and URL', async ({ page }) => {
  await setup(page);
  const messages: string[] = [];
  page.on('console', message => messages.push(message.text()));
  await options(page);
  const payload = '<img src=x onerror="window.envInjected=true">';
  await env(page, 'SAFE', payload);
  await page.locator('#local-start').click();
  await exit(page, 0);
  await page.locator('#local-edit-cwd').click();
  await expect(page.locator('[data-env-value]')).toHaveValue(payload);
  await expect(page.locator('#local-dialog img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).envInjected)).toBeUndefined();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(payload);
  expect(page.url()).not.toContain('envInjected');
  expect(messages.join('\n')).not.toContain(payload);
  await expect(page.locator('#terminal-state')).not.toContainText(payload);
});

test('Escape cancels, row removal restores focus, Enter in name submits, values retain newlines', async ({ page }) => {
  await setup(page);
  await options(page);
  await env(page, 'REMOVE', '');
  await page.locator('[data-env-remove]').click();
  await expect(page.locator('#local-env-add')).toBeFocused();
  await env(page, 'KEEP', '');
  await page.locator('[data-env-value]').press('Enter');
  await expect(page.locator('#local-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#local-dialog')).toBeHidden();
  expect(await opens(page)).toHaveLength(0);
  await options(page);
  await page.locator('[data-env-name]').press('Enter');
  await expect(page.locator('#local-dialog')).toBeHidden();
  expect((await opens(page))[0].env).toEqual([{ name: 'KEEP', value: '\n' }]);
});

test('long variable list scrolls and both groups enforce row limits', async ({ page }) => {
  await setup(page);
  await options(page);
  await page.locator('#local-env-add').evaluate(button => { for (let i = 0; i < 65; i++) (button as HTMLButtonElement).click(); });
  await expect(page.locator('[data-env-name]')).toHaveCount(64);
  await expect(page.locator('#local-env-add')).toBeDisabled();
  expect(await page.locator('#local-env-rows').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await page.locator('#local-locale-mode').selectOption('custom');
  await page.locator('#local-locale-add').evaluate(button => { for (let i = 0; i < 14; i++) (button as HTMLButtonElement).click(); });
  await expect(page.locator('[data-locale-name]')).toHaveCount(13);
  await expect(page.locator('#local-locale-add')).toBeDisabled();
  await page.setViewportSize({ width: 390, height: 600 });
  await page.locator('#local-start').scrollIntoViewIfNeeded();
  await expect(page.locator('#local-start')).toBeInViewport({ ratio: 1 });
  const bounds = await page.locator('#local-dialog').boundingBox();
  expect(bounds!.height).toBeLessThanOrEqual(552);
  expect(bounds!.width).toBeLessThanOrEqual(358);
});

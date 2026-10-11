import { test, expect, type Page } from '@playwright/test';

const screen = (page: Page) => page.locator('.terminal-pane:not([hidden]) .xterm-accessibility-tree');
async function connect(page: Page) {
  await page.locator('#connect-open').click();
  await page.getByRole('button', { name: '预览主机确认', exact: true }).click();
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab')).toHaveCount(1);
});

for (const theme of ['light', 'dark', 'system']) {
  test(`persists ${theme} theme after reload`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.locator('#theme').selectOption(theme);
    await page.reload();
    await expect(page.locator('#theme')).toHaveValue(theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme === 'system' ? 'dark' : theme);
  });
}
test('system theme responds to operating system preference changes', async ({ page }) => {
  await page.locator('#theme').selectOption('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});
test('compact toggle reduces workspace padding and can restore it', async ({ page }) => {
  const padding = await page.locator('.workspace').evaluate(el => getComputedStyle(el).paddingTop);
  await page.locator('#compact-toggle').click();
  await expect(page.locator('html')).toHaveClass(/compact/);
  expect(await page.locator('.workspace').evaluate(el => getComputedStyle(el).paddingTop)).not.toBe(padding);
  await page.locator('#compact-toggle').click();
  await expect(page.locator('html')).not.toHaveClass(/compact/);
});
test('sidebar toggle hides and restores session controls', async ({ page }) => {
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.locator('#sidebar-toggle').click();
  await expect(page.getByRole('textbox', { name: '筛选会话' })).toBeVisible();
});
test('split creates a second independent terminal and focus selects its tab', async ({ page }) => {
  await page.locator('#split-toggle').click();
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(2);
  await page.locator('.terminal-pane:visible').first().locator('textarea').focus();
  await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  await page.locator('#split-toggle').click();
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
});
test('closing last session shows empty state and disables samples', async ({ page }) => {
  await page.getByRole('button', { name: '关闭 Getting started', exact: true }).click();
  await expect(page.locator('#terminal-state')).toHaveText('无打开的会话');
  await expect(page.locator('#sample-run')).toBeDisabled();
  await expect(page.locator('#stress-run')).toBeDisabled();
  await expect(page.locator('.xterm')).toHaveCount(0);
  await page.locator('#sidebar-add').click();
  await expect(page.getByRole('tab')).toHaveCount(1);
});
test('closed sessions disconnect resize observers and remove terminal trees', async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.ResizeObserver;
    const stats = { created: 0, disconnected: 0 };
    Object.assign(window, { qaResize: stats });
    window.ResizeObserver = class extends Original {
      constructor(callback: ResizeObserverCallback) { super(callback); stats.created++; }
      disconnect() { stats.disconnected++; super.disconnect(); }
    };
  });
  await page.reload();
  for (let i = 0; i < 4; i++) {
    await page.locator('#demo-add').click();
    await page.locator('.tab-close').last().click();
  }
  await expect(page.locator('.xterm')).toHaveCount(1);
  const stats = await page.evaluate(() => (window as any).qaResize);
  expect(stats.disconnected).toBeGreaterThanOrEqual(4);
  expect(stats.created - stats.disconnected).toBeLessThanOrEqual(2);
});
test('session limit is enforced and released after close', async ({ page }) => {
  for (let i = 0; i < 7; i++) await page.locator('#demo-add').click();
  await page.locator('#demo-add').click();
  await expect(page.getByRole('tab')).toHaveCount(8);
  await expect(page.getByRole('status')).toContainText('最多同时打开 8');
  await page.locator('.tab-close').last().click();
  await page.locator('#demo-add').click();
  await expect(page.getByRole('tab')).toHaveCount(8);
});
test('session filtering handles no matches without closing the terminal', async ({ page }) => {
  await page.locator('#session-search').fill('no-such-session');
  await expect(page.locator('.session-item')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.locator('#session-search').fill('getting');
  await expect(page.locator('.session-item')).toHaveCount(1);
});
test('command palette supports keyboard selection and execution', async ({ page }) => {
  await page.keyboard.press('Control+Shift+k');
  await expect(page.locator('#command-search')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('#palette-dialog')).not.toBeVisible();
});
test('command palette no results and Escape preserve terminal focus', async ({ page }) => {
  await page.locator('#palette-open').click();
  await page.locator('#command-search').fill('does-not-exist');
  await expect(page.locator('#command-list')).toHaveText('没有匹配的操作');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('#palette-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.terminal-pane textarea')).toBeFocused();
});
test('Ctrl-C cancels sustained output and permits following commands', async ({ page }) => {
  await page.locator('#stress-run').click();
  await expect(page.locator('#terminal-state')).toContainText('持续输出中');
  await page.locator('.terminal-pane textarea').focus();
  await page.keyboard.press('Control+c');
  await expect(page.locator('#terminal-state')).toContainText('演示就绪');
  const bytes = await page.locator('#terminal-size').textContent();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await expect(screen(page)).toContainText('/home/demo/workspace');
  await expect(page.locator('#terminal-size')).toHaveText(bytes!);
});
test('chunked UTF-8 sample preserves CJK emoji combining text and ANSI output', async ({ page }) => {
  await page.locator('#sample-run').click();
  await expect(screen(page)).toContainText('中文输入 · 日本語 · café · é · 👋 🌏');
  await expect(screen(page)).toContainText('■ red  ■ green  ■ blue  ■ true color');
  await expect(screen(page)).not.toContainText('�');
});
test('rejecting simulated host confirmation creates no session', async ({ page }) => {
  await connect(page);
  await page.getByRole('button', { name: '拒绝并返回', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
});
test('accepting simulated host confirmation creates a clearly labelled demo', async ({ page }) => {
  await connect(page);
  await page.locator('#host-confirm').click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('#terminal-state')).toContainText('演示');
  await expect(page.getByRole('status')).toContainText('未建立 SSH 连接');
  expect(await page.evaluate(() => localStorage.getItem('known_hosts'))).toBeNull();
});
test('user supplied markup stays inert in host confirmation and session names', async ({ page }) => {
  const input = '<img src=x onerror=window.qaInjected=1>';
  await page.locator('#connect-open').click();
  await page.locator('[name=name]').fill(input);
  await page.locator('#connect-form [name=host]').fill(input);
  await page.getByRole('button', { name: '预览主机确认', exact: true }).click();
  await expect(page.locator('#host-name')).toContainText(input);
  await page.locator('#host-confirm').click();
  await expect(page.getByRole('tab').last()).toContainText(input);
  await expect(page.locator('#host-name img, #tabs img, #session-list img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).qaInjected)).toBeUndefined();
});
for (const invalid of ['0', '65536', '']) {
  test(`port ${invalid || 'empty'} prevents confirmation`, async ({ page }) => {
    await page.locator('#connect-open').click();
    await page.locator('#connect-form [name=port]').fill(invalid);
    await page.getByRole('button', { name: '预览主机确认', exact: true }).click();
    await expect(page.locator('#connect-dialog')).toBeVisible();
    await expect(page.locator('#host-dialog')).not.toBeVisible();
  });
}
test('empty host prevents confirmation', async ({ page }) => {
  await page.locator('#connect-open').click();
  await page.locator('#connect-form [name=host]').fill('');
  await page.getByRole('button', { name: '预览主机确认', exact: true }).click();
  await expect(page.locator('#host-dialog')).not.toBeVisible();
});
test('browser local terminal action explains desktop requirement', async ({ page }) => {
  await page.locator('#local-open').click();
  await expect(page.getByRole('status')).toContainText('仅在 Tauri 桌面程序中可用');
  await expect(page.getByRole('tab')).toHaveCount(1);
});
test('file selection displays matching simulated properties', async ({ page }) => {
  await page.locator('#files-toggle').click();
  await page.getByRole('button', { name: '部署说明.txt 1.8 KB', exact: true }).click();
  await expect(page.locator('#file-detail')).toContainText('UTF-8 文本 · 1.8 KB');
  await page.locator('#files-toggle').click();
  await expect(page.locator('.file-inspector')).toBeHidden();
});
for (const action of ['取消', '模拟失败']) {
  test(`${action} stops simulated transfer progress`, async ({ page }) => {
    await page.clock.install();
    await page.locator('#files-toggle').click();
    await page.locator('#transfer-add').click();
    await page.clock.fastForward(500);
    await page.locator('#transfer-list').getByRole('button', { name: action, exact: true }).click();
    const status = await page.locator('.transfer-row span').textContent();
    await page.clock.fastForward(20_000);
    await expect(page.locator('.transfer-row span')).toHaveText(status!);
    await expect(page.locator('.transfer-row')).toContainText(action === '取消' ? '已取消' : '未完成');
  });
}
test('completed simulated transfer explicitly reports no file was written', async ({ page }) => {
  await page.clock.install();
  await page.locator('#files-toggle').click();
  await page.locator('#transfer-add').click();
  await page.clock.runFor(10_000);
  await expect(page.locator('.transfer-row')).toContainText('模拟完成（无文件落盘）');
  await page.locator('#transfers-toggle').click();
  await expect(page.locator('#transfer-list')).toBeHidden();
});
test('simulation actions produce no external HTTP requests', async ({ page }) => {
  const external: string[] = [];
  page.on('request', r => { if (new URL(r.url()).hostname !== '127.0.0.1') external.push(r.url()); });
  await connect(page);
  await page.locator('#host-confirm').click();
  await page.locator('#files-toggle').click();
  await page.locator('#transfer-add').click();
  await page.locator('#transfer-list').getByRole('button', { name: '模拟失败' }).click();
  await page.locator('#about-open').click();
  await expect(page.locator('#about-dialog')).toContainText('真实 SSH 终端');
  await expect(page.locator('#about-dialog')).toContainText('演示会话与传输队列仍为模拟');
  await page.getByRole('button', { name: '返回工作台' }).click();
  expect(external).toEqual([]);
});
for (const width of [1000, 1280, 1440]) {
  test(`main regions remain within ${width}px viewport`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1000 ? 650 : 900 });
    await page.locator('#files-toggle').click();
    await page.locator('#split-toggle').click();
    const failures = await page.evaluate(() => {
      const selectors = ['.toolbar', '.sidebar', '.tabbar', '.terminal-tools', '.notice', '.terminal-workspace', '.terminal-status', '.transfer-panel', '.file-inspector'];
      return selectors.flatMap(selector => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1 ? [{ selector, x: r.x, y: r.y, right: r.right, bottom: r.bottom }] : [];
      });
    });
    expect(failures).toEqual([]);
    await page.screenshot({ path: `test-results/layout-${width}.png` });
  });
}

test('closing a session during sustained output leaves a responsive surviving terminal', async ({ page }) => {
  await page.locator('#demo-add').click();
  await page.locator('#stress-run').click();
  await expect(page.locator('#terminal-state')).toContainText('持续输出中');
  await page.locator('.tab-close').last().click();
  await expect(page.locator('.xterm')).toHaveCount(1);
  await page.locator('.terminal-pane textarea').focus();
  await page.keyboard.type('pwd');
  await page.keyboard.press('Enter');
  await expect(screen(page)).toContainText('/home/demo/workspace');
});
test('sidebar session selection changes active tab', async ({ page }) => {
  await page.locator('#sidebar-add').click();
  await page.locator('.session-item').first().click();
  await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
});
test('connection cancel preserves existing sessions', async ({ page }) => {
  await page.locator('#connect-open').click();
  await page.locator('#connect-dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.locator('#connect-dialog')).toBeHidden();
  await expect(page.getByRole('tab')).toHaveCount(1);
});
test('dialog close icon dismisses boundary details', async ({ page }) => {
  await page.locator('#about-open').click();
  await page.locator('#about-dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.locator('#about-dialog')).toBeHidden();
});
test('empty transfer queue explains how to start simulation', async ({ page }) => {
  await page.locator('#transfers-toggle').click();
  await expect(page.locator('#transfer-list')).toContainText('队列为空');
});
test('simulated transfer queue stops accepting tasks at eight', async ({ page }) => {
  await page.clock.install();
  await page.locator('#files-toggle').click();
  for (let i = 0; i < 9; i++) await page.locator('#transfer-add').click();
  await expect(page.locator('.transfer-row')).toHaveCount(8);
  await expect(page.getByRole('status')).toContainText('最多保留 8 项');
});

test('host confirmation at the session limit reports failure instead of false success', async ({ page }) => {
  for (let i = 0; i < 7; i++) await page.locator('#demo-add').click();
  await connect(page);
  await page.locator('#host-confirm').click();
  await expect(page.getByRole('tab')).toHaveCount(8);
  await expect(page.getByRole('status')).toContainText('最多同时打开 8');
  await expect(page.getByRole('status')).not.toContainText('已打开演示会话');
});

import { test, expect } from '@playwright/test';
import {
  CPR, ESC, accepted, exit, installStartupIpc, launch, opens, output, plan, rejectOpen, releaseHeld,
  resolveOpen, state, typeInto, writes,
} from './support/startup-harness';

// Browser IPC stub contract for "execute command after start" (P1 T34 sub-item). It proves what the
// frontend hands to pty_write and when; it does not prove Rust, a native PTY or a WebView.
const COMMAND = 'printf "P1-STARTUP %s\\n" "$$" >> "/tmp/p1 计数.txt"';
const SUBMITTED = `${COMMAND}\r`;
const commandWrites = async (page: Parameters<typeof writes>[0]) =>
  (await writes(page)).filter((w) => w.text === SUBMITTED);

test('default one-click and empty form keep the old pty_open arguments and write nothing', async ({ page }) => {
  await installStartupIpc(page);
  await page.locator('#local-open').click();
  await launch(page, null);
  await resolveOpen(page, 0, 'a');
  await resolveOpen(page, 1, 'b');
  await expect(state(page)).toHaveText('本机 PTY · 本机 shell 已启动');
  const calls = await opens(page);
  expect(calls.map((c) => c.keys)).toEqual([
    ['cols', 'cwd', 'env', 'locale', 'onEvent', 'rows', 'shell'],
    ['cols', 'cwd', 'env', 'locale', 'onEvent', 'rows', 'shell'],
  ]);
  await page.waitForTimeout(100);
  expect(await writes(page)).toEqual([]);
  await expect(page.locator('#local-reopen')).not.toHaveAttribute('title');
});

test('a configured command is never part of the pty_open arguments', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  const [call] = await opens(page);
  expect(call.keys).toEqual(['cols', 'cwd', 'env', 'locale', 'onEvent', 'rows', 'shell']);
  expect(call.json).not.toContain('P1-STARTUP');
  expect(call.json).not.toContain('command');
  expect(await writes(page)).toEqual([]);
});

test('replies produced before the native ID precede the command; built-in replies stay dropped', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  // The actual early FIFO set: VT adapter replies (CPR, DA, DECRQSS m) wait for the ID; xterm's own
  // DSR 5 reply is user-sourced to the lifecycle and is not sent for a session without an ID.
  await output(page, 0, 'early', `${ESC}[6n${ESC}[c${ESC}[5n${ESC}P$qm${ESC}\\`);
  await typeInto(page, 'TYPED-EARLY');
  expect(await writes(page)).toEqual([]);
  await resolveOpen(page, 0, 'early');
  await expect.poll(() => writes(page).then((w) => w.length)).toBe(4);
  const sent = await writes(page);
  expect(sent.map((w) => w.id)).toEqual(['early', 'early', 'early', 'early']);
  expect(sent[0].text).toMatch(CPR);
  expect(sent.slice(1).map((w) => w.text)).toEqual([`${ESC}[?1;2c`, `${ESC}P1$r0m${ESC}\\`, SUBMITTED]);
  await expect(state(page)).toHaveText('本机 PTY · 本机 shell 已启动 · 启动命令已提交');
  // Replies and keys after the ID follow the command.
  await output(page, 0, 'early', `${ESC}[6n${ESC}[5n`);
  await typeInto(page, 'k');
  await expect.poll(() => writes(page).then((w) => w.slice(4).map((x) => x.text))).toEqual([
    expect.stringMatching(CPR), `${ESC}[0n`, 'k',
  ]);
  expect(await commandWrites(page)).toHaveLength(1);
});

test('a CPR query that arrives after the native ID is answered after the command', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await resolveOpen(page, 0, 'late');
  await expect(state(page)).toHaveText('本机 PTY · 本机 shell 已启动 · 启动命令已提交');
  await output(page, 0, 'late', `${ESC}[6n`);
  await expect.poll(() => writes(page).then((w) => w.length)).toBe(2);
  const sent = await writes(page);
  expect(sent.map((w) => w.id)).toEqual(['late', 'late']);
  expect(sent[0].text).toBe(SUBMITTED);
  expect(sent[1].text).toMatch(CPR);
});

test('the command is one write behind a held early reply and is never split or interleaved', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await output(page, 0, 'held', `${ESC}[6n`);
  await plan(page, 'hold');
  await resolveOpen(page, 0, 'held');
  await typeInto(page, 'ab');
  await expect.poll(() => writes(page).then((w) => w.length)).toBe(1);
  await expect(state(page)).toHaveText('本机 PTY · 本机 shell 已启动');
  await releaseHeld(page);
  await expect.poll(() => writes(page).then((w) => w.map((x) => x.text).slice(1))).toEqual([SUBMITTED, 'a', 'b']);
  await expect(state(page)).toContainText('启动命令已提交');
});

test('rejected open sends nothing and reports the command as not sent', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await rejectOpen(page, 0, 'TEST invalid directory');
  await expect(state(page)).toHaveText('本机 PTY · 启动失败：TEST invalid directory · 启动命令未发送');
  await expect(page.locator('#session-detail')).toContainText('重新打开将再次发送启动命令');
  expect(await writes(page)).toEqual([]);
});

test('exit before the native ID arrives sends nothing', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await exit(page, 0, 'gone', 3);
  await resolveOpen(page, 0, 'gone');
  await expect(state(page)).toHaveText('本机 PTY · 已退出 · code 3 · 启动命令未发送');
  await page.waitForTimeout(100);
  expect(await writes(page)).toEqual([]);
});

test('closing the tab while starting closes the late ID and writes nothing', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await page.locator('.tab-close').last().click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await resolveOpen(page, 0, 'closed');
  await expect.poll(() => page.evaluate(() => (window as any).qaStartup.calls.filter((c: any) => c.command === 'pty_close'))).toEqual([
    { command: 'pty_close', id: 'closed' },
  ]);
  expect(await writes(page)).toEqual([]);
});

test('exit while the command waits behind another write leaves it not sent', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await output(page, 0, 'queued', `${ESC}[6n`);
  await plan(page, 'hold');
  await resolveOpen(page, 0, 'queued');
  await expect.poll(() => writes(page).then((w) => w.length)).toBe(1);
  await exit(page, 0, 'queued', 0);
  await expect(state(page)).toHaveText('本机 PTY · 已退出 · code 0 · 启动命令未发送');
  await releaseHeld(page);
  await page.waitForTimeout(100);
  expect((await writes(page)).map((w) => w.text)).toEqual([expect.stringMatching(CPR)]);
});

test('exit while the command write is outstanding is unconfirmed, even if the write later resolves', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await plan(page, 'hold');
  await resolveOpen(page, 0, 'inflight');
  await expect.poll(() => commandWrites(page).then((w) => w.length)).toBe(1);
  await exit(page, 0, 'inflight', 0);
  await expect(state(page)).toHaveText('本机 PTY · 已退出 · code 0 · 启动命令发送未确认');
  await releaseHeld(page);
  await page.waitForTimeout(100);
  await expect(state(page)).toHaveText('本机 PTY · 已退出 · code 0 · 启动命令发送未确认');
});

test('a rejected command write is unconfirmed and never retried; later typing still works', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await plan(page, 'fail');
  await resolveOpen(page, 0, 'fail');
  await expect(state(page)).toHaveText('本机 PTY · 错误：TEST write failure · 启动命令发送未确认');
  await expect(page.locator('#toast')).not.toContainText('P1-STARTUP');
  await typeInto(page, 'z');
  await expect.poll(() => writes(page).then((w) => w.map((x) => x.text))).toEqual([SUBMITTED, 'z']);
  expect(await accepted(page)).toEqual([{ id: 'fail', text: 'z' }]);
});

test('queue-full refusals are retried until the backend accepts the command exactly once', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await plan(page, 'full', 'full');
  await resolveOpen(page, 0, 'full');
  await expect(state(page)).toHaveText('本机 PTY · 本机 shell 已启动 · 启动命令已提交');
  expect(await commandWrites(page)).toHaveLength(3);
  expect(await accepted(page)).toEqual([{ id: 'full', text: SUBMITTED }]);
});

test('exit while waiting out a full queue (the quiet stop) is not sent', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await plan(page, 'full', 'full', 'full');
  // Resolve, let the first queue-full rejection settle (microtasks only), then exit before the
  // retry timer: no write request is outstanding, and the backend's last answer was a refusal.
  await page.evaluate(async () => {
    const state = (window as any).qaStartup;
    state.pending[0].resolve({ id: 'quiet' });
    for (let i = 0; i < 200; i++) await Promise.resolve();
    state.channels[0].onmessage({ kind: 'exit', id: 'quiet', code: 0 });
  });
  await expect(state(page)).toHaveText('本机 PTY · 已退出 · code 0 · 启动命令未发送');
  await page.waitForTimeout(150);
  expect(await commandWrites(page)).toHaveLength(1);
  expect(await accepted(page)).toEqual([]);
});

test('a later exit keeps the submitted result next to the exit code', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await resolveOpen(page, 0, 'done');
  await expect(state(page)).toContainText('启动命令已提交');
  await exit(page, 0, 'done', 0);
  await expect(state(page)).toHaveText('本机 PTY · 已退出 · code 0 · 启动命令已提交');
});

test('reopen warns first, then sends the original command once in the new session only', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND, '/tmp/original');
  await resolveOpen(page, 0, 'old');
  await expect(state(page)).toContainText('启动命令已提交');
  await exit(page, 0, 'old', 0);
  const reopen = page.getByRole('button', { name: '重新打开本地终端', exact: true });
  await expect(reopen).toHaveAccessibleDescription('将再次发送启动命令');
  await expect(page.locator('#session-detail')).toHaveText('本机 shell 已结束 / 不再发送输入 / 重新打开将再次发送启动命令');
  // Editing a separate draft after start must not change the session snapshot.
  await page.locator('#local-options-open').click();
  await page.locator('#local-command-input').fill('echo changed-draft');
  await page.locator('#local-dialog').getByRole('button', { name: '取消', exact: true }).click();
  // A rapid second click opens only one replacement.
  await reopen.evaluate((button) => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
  await expect(page.getByRole('tab')).toHaveCount(3);
  expect((await opens(page)).map((o) => o.cwd)).toEqual(['/tmp/original', '/tmp/original']);
  await resolveOpen(page, 1, 'new');
  await expect(state(page)).toHaveText('本机 PTY · 本机 shell 已启动 · 启动命令已提交');
  expect(await writes(page)).toEqual([{ id: 'old', text: SUBMITTED }, { id: 'new', text: SUBMITTED }]);
  // The old tab stays ended and gets nothing more.
  await page.getByRole('tab').nth(1).click();
  await typeInto(page, 'old-tab');
  await page.waitForTimeout(100);
  expect(await writes(page)).toHaveLength(2);
});

test('clearing the field through 修改启动选项 starts a session that sends nothing', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await rejectOpen(page, 0, 'TEST failed');
  await page.locator('#local-edit-cwd').click();
  await expect(page.locator('#local-command-input')).toHaveValue(COMMAND);
  await page.locator('#local-command-input').fill('');
  await page.locator('#local-start').click();
  await resolveOpen(page, 1, 'clean');
  await expect(state(page)).toHaveText('本机 PTY · 本机 shell 已启动');
  await exit(page, 1, 'clean', 0);
  await expect(page.locator('#local-reopen')).not.toHaveAttribute('title');
  await expect(page.locator('#session-detail')).toHaveText('本机 shell 已结束 / 不再发送输入');
  expect(await writes(page)).toEqual([]);
});

test('resize, tab switches, split, focus, dialogs and output never send it again', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await resolveOpen(page, 0, 'once');
  await expect(state(page)).toContainText('启动命令已提交');
  await page.setViewportSize({ width: 900, height: 600 });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('tab').first().click();
  await page.getByRole('tab').last().click();
  await page.locator('#split-toggle').click();
  await page.locator('#split-toggle').click();
  await page.locator('#session-search').focus();
  await page.locator('.terminal-pane:visible textarea').focus();
  await page.locator('#local-options-open').click();
  await page.locator('#local-dialog').getByRole('button', { name: '取消', exact: true }).click();
  for (let i = 0; i < 3; i++) await output(page, 0, 'once', `line ${i}\r\n`);
  await expect.poll(() => page.evaluate(() => (window as any).qaStartup.calls.filter((c: any) => c.command === 'pty_resize').length)).toBeGreaterThan(1);
  await page.waitForTimeout(150);
  expect(await writes(page)).toEqual([{ id: 'once', text: SUBMITTED }]);
});

test('a reloaded page starts from nothing: no stored command, no replay', async ({ page }) => {
  await installStartupIpc(page);
  await launch(page, COMMAND);
  await resolveOpen(page, 0, 'before-reload');
  await expect(state(page)).toContainText('启动命令已提交');
  await page.reload();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('P1-STARTUP');
  await page.locator('#local-open').click();
  await resolveOpen(page, 0, 'after-reload');
  await expect(state(page)).toHaveText('本机 PTY · 本机 shell 已启动');
  await page.locator('#local-options-open').click();
  await expect(page.locator('#local-command-input')).toHaveValue('');
  await page.waitForTimeout(100);
  expect(await writes(page)).toEqual([]);
});

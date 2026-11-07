import { test, expect } from '@playwright/test';
import { exit, installStartupIpc, launch, opens, resolveOpen, state, writes } from './support/startup-harness';

// Form validation, privacy and the one-shot primitives behind the startup command. Browser only:
// IPC is stubbed, nothing here reaches Rust, a native PTY or a WebView other than Chrome.
const SECRET = 'P1SECRET-7f3a';

const invalid: [string, string, string][] = [
  ['line feed', `echo ${SECRET}\necho two`, '只能是一行'],
  ['carriage return', `echo ${SECRET}\recho two`, '只能是一行'],
  ['tab', `echo\t${SECRET}`, '制表符'],
  ['escape', `echo ${SECRET}\x1b[31m`, '控制字符'],
  ['ctrl-d', `echo ${SECRET}\x04`, '控制字符'],
  ['nul', `echo ${SECRET}\0`, '控制字符'],
  ['delete', `echo ${SECRET}\x7f`, '控制字符'],
  ['c1 next line', `echo ${SECRET}\u0085`, '控制字符'],
  ['c1 csi', `echo ${SECRET}\u009b`, '控制字符'],
  ['lone high surrogate', `echo ${SECRET}\ud83d`, '孤立的代理项'],
  ['lone low surrogate', `echo \ude00${SECRET}`, '孤立的代理项'],
  ['bidi override', `echo ${SECRET}‮`, '双向文本'],
  ['bidi isolate', `echo ⁦${SECRET}⁩`, '双向文本'],
  ['only spaces', '   ', '只包含空白'],
  ['only ideographic space', '　', '只包含空白'],
  ['1001 bytes', `${'中'.repeat(333)}${SECRET.slice(0, 2)}`, '1000 UTF-8'],
];
for (const [name, value, message] of invalid) {
  test(`invalid startup command stays in the form without echo: ${name}`, async ({ page }) => {
    await installStartupIpc(page);
    await page.locator('#local-options-open').click();
    // Set from UTF-16 code units in the page: the protocol would turn a lone surrogate into U+FFFD.
    const units = Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
    await page.locator('#local-command-input').evaluate((el, units) => {
      (el as HTMLTextAreaElement).value = String.fromCharCode(...units);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, units);
    expect(await page.locator('#local-command-input').evaluate((el) => (el as HTMLTextAreaElement).value.length)).toBe(value.length);
    await page.locator('#local-start').click();
    await expect(page.locator('#local-options-error')).toContainText(message);
    await expect(page.locator('#local-options-error')).toBeFocused();
    await expect(page.locator('#local-command-input')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#local-dialog')).toBeVisible();
    const error = await page.locator('#local-options-error').textContent();
    expect(error).not.toContain(SECRET);
    if (value.trim()) expect(error).not.toContain(value);
    expect(await opens(page)).toEqual([]);
    // Editing clears the error and its invalid mark.
    await page.locator('#local-command-input').fill('echo ok');
    await expect(page.locator('#local-options-error')).toBeEmpty();
    await expect(page.locator('#local-command-input')).not.toHaveAttribute('aria-invalid');
  });
}

test('exactly 1000 UTF-8 bytes with a multi-byte boundary and edge spaces is sent unchanged', async ({ page }) => {
  await installStartupIpc(page);
  const value = ` ${'中'.repeat(332)}${'x'.repeat(2)} `; // 1 + 996 + 2 + 1 bytes
  expect(new TextEncoder().encode(value).length).toBe(1000);
  await launch(page, value);
  await resolveOpen(page, 0, 'edge');
  await expect(state(page)).toContainText('启动命令已提交');
  expect(await writes(page)).toEqual([{ id: 'edge', text: `${value}\r` }]);
  expect(new TextEncoder().encode((await writes(page))[0].text).length).toBe(1001);
});

test('shell syntax, quotes, emoji and Unicode reach the shell literally', async ({ page }) => {
  await installStartupIpc(page);
  const value = `echo "$HOME" '%PATH%' $(id) && cd ~ ; 🙂 é 中文 \\n`;
  await launch(page, value);
  await resolveOpen(page, 0, 'literal');
  await expect.poll(() => writes(page)).toEqual([{ id: 'literal', text: `${value}\r` }]);
});

test('an inserted multi-line command is kept for the error instead of being flattened', async ({ page }) => {
  // Browser editing insertion (the path a paste takes), not a clipboard write: the clipboard is
  // shared by every test in the worker's browser, and Shift+Insert in the key regressions reads it.
  await installStartupIpc(page);
  await page.locator('#local-options-open').click();
  // Contrast: a single-line <input> silently strips the line break; that is why a textarea is used.
  await page.locator('#local-cwd-input').focus();
  await page.keyboard.insertText('/tmp/a\n/tmp/b');
  expect(await page.locator('#local-cwd-input').inputValue()).not.toContain('\n');
  await page.locator('#local-cwd-input').fill('');
  await page.locator('#local-command-input').focus();
  await page.keyboard.insertText('echo first\necho second');
  await expect(page.locator('#local-command-input')).toHaveValue('echo first\necho second');
  await page.locator('#local-start').click();
  await expect(page.locator('#local-options-error')).toContainText('粘贴的多行文本也会被拒绝');
  expect(await opens(page)).toEqual([]);
});

test('Return submits like a single-line field; Return while an IME composes does not', async ({ page }) => {
  await installStartupIpc(page);
  await page.locator('#local-options-open').click();
  const field = page.locator('#local-command-input');
  await field.fill('echo 输入法');
  await field.evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })));
  await expect(page.locator('#local-dialog')).toBeVisible();
  await expect(field).toHaveValue('echo 输入法');
  expect(await opens(page)).toEqual([]);
  await field.press('Enter');
  await expect(page.locator('#local-dialog')).toBeHidden();
  expect(await opens(page)).toHaveLength(1);
  await resolveOpen(page, 0, 'ime');
  await expect.poll(() => writes(page)).toEqual([{ id: 'ime', text: 'echo 输入法\r' }]);
});

test('dialog explains one send, no readiness check, reopen resend and memory-only storage', async ({ page }) => {
  await installStartupIpc(page);
  await page.locator('#local-options-open').click();
  const field = page.getByLabel('启动后执行命令', { exact: true });
  await expect(field).toHaveValue('');
  await expect(field).toHaveAccessibleDescription(/发送一次.*不等待提示符.*重新打开会再次发送.*1000 UTF-8.*内存.*请勿填写密码/);
  await expect(field).not.toHaveAttribute('maxlength');
});

test('browser demo cannot start a local shell even with a command', async ({ page }) => {
  await page.goto('/');
  await page.locator('#local-options-open').click();
  await page.locator('#local-command-input').fill('echo demo');
  await expect(page.locator('#local-start')).toBeDisabled();
  await page.locator('#local-command-input').press('Enter');
  await expect(page.getByRole('tab')).toHaveCount(1);
});

test('malicious command text stays literal and never reaches DOM, status, toast, title, storage, URL or console', async ({ page }) => {
  const messages: string[] = [];
  page.on('console', (message) => messages.push(message.text()));
  await installStartupIpc(page);
  const payload = `echo ${SECRET} <img src=x onerror="window.cmdInjected=1"></p><script>window.cmdInjected=2</script>`;
  await launch(page, payload);
  await resolveOpen(page, 0, 'xss');
  await expect(state(page)).toContainText('启动命令已提交');
  await exit(page, 0, 'xss', 0);
  await expect(page.locator('#local-reopen')).toBeVisible();
  const leaks = async () => page.evaluate((secret) => ({
    html: document.documentElement.outerHTML.includes(secret),
    title: document.title.includes(secret),
    storage: JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret),
    url: location.href.includes(secret),
    injected: (window as any).cmdInjected,
    images: document.querySelectorAll('img[src="x"]').length,
  }), SECRET);
  expect(await leaks()).toEqual({ html: false, title: false, storage: false, url: false, injected: undefined, images: 0 });
  await page.locator('#local-edit-cwd').click();
  await expect(page.locator('#local-command-input')).toHaveValue(payload);
  expect(await leaks()).toEqual({ html: false, title: false, storage: false, url: false, injected: undefined, images: 0 });
  await page.locator('#local-dialog').getByRole('button', { name: '取消', exact: true }).click();
  await page.locator('#local-reopen').click();
  await resolveOpen(page, 1, 'xss-2');
  await expect(state(page)).toContainText('启动命令已提交');
  expect(await leaks()).toEqual({ html: false, title: false, storage: false, url: false, injected: undefined, images: 0 });
  expect(messages.join('\n')).not.toContain(SECRET);
  expect((await writes(page)).map((w) => w.text)).toEqual([`${payload}\r`, `${payload}\r`]);
});

test('startup state only moves forward and its notice never carries the command', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/startup-command.ts';
    const m = await import(/* @vite-ignore */ path);
    const states = ['none', 'pending', 'queued', 'submitted', 'not-sent', 'unconfirmed'];
    const table: Record<string, string[]> = {};
    for (const from of states) table[from] = states.filter((to) => to !== from && m.advanceStartup(from, to) === to);
    return {
      table,
      notices: states.map((s) => m.startupNotice(s)),
      bytes: Array.from(m.startupCommandBytes('é')),
      empty: m.validateStartupCommand(''),
      max: m.STARTUP_COMMAND_MAX_BYTES,
    };
  });
  expect(result.table).toEqual({
    none: [], pending: ['queued', 'not-sent'], queued: ['submitted', 'not-sent', 'unconfirmed'],
    submitted: [], 'not-sent': [], unconfirmed: [],
  });
  expect(result.notices).toEqual(['', '', '', '启动命令已提交', '启动命令未发送', '启动命令发送未确认']);
  expect(result.bytes).toEqual([0xc3, 0xa9, 0x0d]);
  expect(result.empty).toBeNull();
  expect(result.max).toBe(1000);
});

test('input queue settles a tracked chunk exactly once for every path', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const path = '/src/input-queue.ts';
    const { InputQueue } = await import(/* @vite-ignore */ path);
    const full = 'PTY input queue is full; retry after drain';
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const settleOf = async (scenario: (queue: any, hooks: any) => Promise<void> | void, write: (call: number, hooks: any) => Promise<unknown>, retryLimitMs = 1000) => {
      const outcomes: string[] = [];
      const failures: string[] = [];
      const hooks: any = { calls: 0, writable: true, held: [] as any[] };
      const queue = new InputQueue({
        write: () => write(++hooks.calls, hooks),
        writable: () => hooks.writable,
        failed: (error: unknown) => failures.push(String(error)),
        retryLimitMs,
      });
      hooks.queue = queue;
      await scenario(queue, (bytes: Uint8Array) => queue.push(bytes, (o: string) => outcomes.push(o)));
      for (let i = 0; i < 20 && hooks.held.length === 0 && queue.pendingBytes; i++) await tick();
      return { outcomes, failures, calls: hooks.calls };
    };
    const one = Uint8Array.of(65);
    const hold = (_call: number, hooks: any) => new Promise((resolve, reject) => hooks.held.push({ resolve, reject }));
    const written = await settleOf((_q, push) => { push(one); }, async () => null);
    // Queued behind a held write, then cleared: never requested.
    const queuedCleared = await settleOf(async (q, push) => { q.push(Uint8Array.of(1)); push(one); await tick(); q.clear(); }, hold);
    // Its own request outstanding when cleared: unknown; a later success cannot change that.
    const inflight: any = {};
    const inflightCleared = await settleOf(async (q, push) => { push(one); await tick(); q.clear(); inflight.q = q; }, (c, h) => { inflight.h = h; return hold(c, h); });
    inflight.h.held[0].resolve(null);
    await tick();
    // Cleared while waiting between queue-full retries: no request outstanding.
    const waitingCleared = await settleOf(async (q, push) => {
      push(one);
      while (q.requesting) await Promise.resolve();
      q.clear();
    }, async () => { throw full; });
    const rejected = await settleOf((_q, push) => { push(one); }, async () => { throw 'PTY session is closed'; });
    const deadline = await settleOf((_q, push) => { push(one); }, async () => { throw full; }, 30);
    const retried = await settleOf((_q, push) => { push(one); }, async (call) => { if (call < 3) throw full; return null; });
    const unwritable = await settleOf((q, push) => { q.push(Uint8Array.of(1)); push(one); }, async (_c, h) => { h.writable = false; return null; });
    let tooLarge = '';
    try { new InputQueue({ write: async () => null, writable: () => true, failed: () => {} }).push(new Uint8Array(4097), () => {}); } catch (e) { tooLarge = String(e); }
    return { written, queuedCleared, inflightCleared, waitingCleared, rejected, deadline, retried, unwritable, tooLarge };
  });
  expect(result.written).toEqual({ outcomes: ['written'], failures: [], calls: 1 });
  expect(result.queuedCleared.outcomes).toEqual(['not-sent']);
  expect(result.queuedCleared.calls).toBe(1);
  expect(result.inflightCleared.outcomes).toEqual(['unconfirmed']);
  expect(result.waitingCleared).toEqual({ outcomes: ['not-sent'], failures: [], calls: 1 });
  expect(result.rejected).toEqual({ outcomes: ['unconfirmed'], failures: ['PTY session is closed'], calls: 1 });
  expect(result.deadline.outcomes).toEqual(['not-sent']);
  expect(result.deadline.failures).toEqual(['PTY input queue is full; retry after drain']);
  expect(result.retried).toEqual({ outcomes: ['written'], failures: [], calls: 3 });
  expect(result.unwritable.outcomes).toEqual(['not-sent']);
  expect(result.unwritable.calls).toBe(1);
  expect(result.tooLarge).toContain('RangeError');
});

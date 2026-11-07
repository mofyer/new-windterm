import { test, expect, type Page } from '@playwright/test';
import { Session } from './support/session-harness';
import { fromHex, observe, openEncoded, writtenBytes } from './support/encoding-harness';

// T28/T29/T33 part 1, input side and runtime switching (docs/p1/SESSION_ENCODING_PLAN.zh-CN.md).
// Keys, CDP text insertion / IME composition and synthetic pastes go through terminal-input.ts ->
// session-lifecycle.ts (SessionCodec.encode) -> InputQueue -> the stubbed `*_write`. Chrome and its
// simulated input only: not a native IME, keyboard layout, WebView, PTY or remote program.

const hex = (text: string) => fromHex(text).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
const toast = (page: Page) => page.locator('#toast');

async function expectWritten(t: Session, bytes: string, command = `${t.transport}_write`) {
  await expect.poll(async () => (await writtenBytes(t.page)).hex).toBe(hex(bytes));
  expect((await writtenBytes(t.page)).commands).toEqual(bytes ? [command] : []);
}

test('pty Big5: typed keys, inserted text, an IME commit and a bracketed paste are sent as Big5', async ({ page }) => {
  const t = await openEncoded(page, 'pty', 'big5');
  // First, while xterm's textarea is still empty: CDP's composition reuses earlier inserted text.
  await t.mark();
  await t.cdp.send('Input.imeSetComposition', { text: 'xu', selectionStart: 2, selectionEnd: 2 });
  await t.cdp.send('Input.imeSetComposition', { text: '許', selectionStart: 1, selectionEnd: 1 });
  await t.cdp.send('Input.insertText', { text: '許' });
  await expectWritten(t, 'B35C');
  await t.mark();
  await page.keyboard.type('ls -l');
  await page.keyboard.press('Enter');
  await expectWritten(t, '6C73202D6C 0D');
  await t.mark();
  await t.cdp.send('Input.insertText', { text: '中文' });
  await expectWritten(t, 'A4A4 A4E5');
  // With bracketed paste on, the markers stay ASCII and the text between them is Big5; LF becomes CR.
  await t.send(`\x1b[?2004h`);
  await t.mark();
  await t.paste('許功\n中');
  await expectWritten(t, '1B5B3230307E B35CA55C 0D A4A4 1B5B3230317E');
});

test('input with a character the encoding cannot represent is refused whole, with a count-only notice', async ({ page }) => {
  const t = await openEncoded(page, 'pty', 'big5');
  await t.mark();
  await t.paste('中😀文');
  await expect(toast(page)).toContainText('1 个字符无法用 Big5 表示；本次输入未发送');
  // The notice never repeats the input.
  await expect(toast(page)).not.toContainText('😀');
  await expect(toast(page)).not.toContainText('文');
  await t.cdp.send('Input.insertText', { text: 'ｱｲ' });
  await expect(toast(page)).toContainText('2 个字符无法用 Big5 表示');
  await t.settle();
  expect((await writtenBytes(page)).hex).toBe('');
  // Nothing is stuck: the next representable input is sent normally.
  await t.cdp.send('Input.insertText', { text: '中' });
  await expectWritten(t, 'A4A4');
});

test('EUC-JP refuses the lossy ¥ / ‾ mappings and JIS X 0212, and sends JIS X 0208 and half-width katakana', async ({ page }) => {
  const t = await openEncoded(page, 'pty', 'euc-jp');
  await t.mark();
  for (const text of ['¥', '‾', '丂', '−']) {
    await t.cdp.send('Input.insertText', { text });
    await expect(toast(page)).toContainText('无法用 EUC-JP 表示');
    await page.evaluate(() => { document.querySelector('#toast')!.textContent = ''; });
  }
  await t.settle();
  expect((await writtenBytes(page)).hex).toBe('');
  await t.cdp.send('Input.insertText', { text: '日本ｱ' });
  await expectWritten(t, 'C6FC CBDC 8EB1');
});

test('terminal replies are unchanged ASCII in a Big5 session', async ({ page }) => {
  const t = await openEncoded(page, 'pty', 'big5');
  await t.mark();
  await t.send('\x1b[c\x1b[6n');
  await expect.poll(async () => (await writtenBytes(page)).hex.length).toBeGreaterThan(0);
  const replies = await page.evaluate(() => (window as any).qa.data.join(''));
  expect(replies).toMatch(/^\x1b\[\?[\d;]+c\x1b\[\d+;\d+R$/);
  await expectWritten(t, Buffer.from(replies, 'latin1').toString('hex'));
});

test('SSH EUC-JP and Telnet Shift_JIS input reach their own transports encoded', async ({ browser }) => {
  for (const [transport, encoding, text, bytes] of [
    ['ssh', 'euc-jp', '日本語', 'C6FC CBDC B8EC'],
    ['net', 'shift_jis', '日本ソ', '93FA 967B 835C'],
  ] as const) {
    const page = await browser.newPage();
    const t = await openEncoded(page, transport, encoding);
    await t.mark();
    await t.cdp.send('Input.insertText', { text });
    await expectWritten(t, bytes);
    await page.close();
  }
});

test('the startup command is typed in the session encoding, and one it cannot represent is refused in the form', async ({ page }) => {
  await Session.open(page, 'pty', {}, false);
  await page.locator('#local-options-open').click();
  await page.locator('#local-encoding').selectOption('big5');
  await page.locator('#local-command-input').fill('echo 😀');
  await page.locator('#local-start').click();
  await expect(page.locator('#local-options-error')).toContainText('1 个字符无法用 Big5 表示');
  await expect(page.locator('#local-dialog')).toBeVisible();
  expect(await page.evaluate(() => (window as any).qaIpc.calls.some((c: any) => c.command === 'pty_open'))).toBe(false);
  await page.locator('#local-command-input').fill('echo 中文');
  await page.locator('#local-start').click();
  await expect(page.locator('#local-dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.pendingOpen)).toBe(true);
  await page.evaluate(() => (window as any).qaIpc.pendingOpen());
  await expect(page.locator('#terminal-state')).toContainText('启动命令已提交');
  expect((await writtenBytes(page)).hex).toBe(hex('6563686F20 A4A4A4E5 0D'));
});

/** Runs the palette command and applies `encoding` in its sheet. */
async function switchEncoding(page: Page, encoding: string) {
  await page.locator('#palette-open').click();
  await page.locator('#command-search').fill('字符编码');
  await page.locator('#command-search').press('Enter');
  await expect(page.locator('#encoding-dialog')).toBeVisible();
  await page.locator('#encoding-switch-encoding').selectOption(encoding);
  await page.locator('#encoding-apply').click();
  await expect(page.locator('#encoding-dialog')).toBeHidden();
}

const row = (page: Page, y: number) => page.evaluate((y) => {
  const t = (window as any).qa.terminal;
  return t.buffer.active.getLine(t.buffer.active.viewportY + y).translateToString(true) as string;
}, y);

test('switching Big5 → EUC-JP while running ends the unfinished character and applies to later output and input only', async ({ page }) => {
  const t = await openEncoded(page, 'pty', 'big5');
  await t.send([0x41, ...fromHex('A4A4'), 0xa4]);
  expect(await row(page, 0)).toBe('A中');
  await switchEncoding(page, 'euc-jp');
  await expect(toast(page)).toContainText('之后的输出与输入改用 EUC-JP');
  await expect(page.locator('#terminal-size')).toContainText('B 接收 · EUC-JP');
  // Already shown text keeps its Big5 decoding; the pending Big5 lead byte became U+FFFD.
  await t.send(fromHex('C6FC CBDC'));
  expect(await row(page, 0)).toBe('A中�日本');
  await t.mark();
  await t.cdp.send('Input.insertText', { text: '日' });
  await expectWritten(t, 'C6FC');
  await t.drained();
  expect(await t.acks()).toEqual(['pty_ack:1', 'pty_ack:2']);
});

test('a default UTF-8 session can switch to Big5; reopening a local session uses its launch encoding', async ({ page }) => {
  const t = await Session.open(page, 'pty', { size: { cols: 60, rows: 8 } });
  await t.send([0x41, 0xe4, 0xb8]);
  await switchEncoding(page, 'big5');
  await t.send(fromHex('A4A4'));
  expect(await row(page, 0)).toBe('A�中');
  // The local tab was opened with UTF-8: reopening ignores the runtime switch.
  await page.evaluate(() => {
    const ipc = (window as any).qaIpc;
    ipc.channel.onmessage({ kind: 'exit', id: ipc.id, code: 0 });
  });
  await expect(page.locator('#local-reopen')).toBeVisible();
  await page.locator('#local-reopen').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.pendingOpen)).toBe(true);
  await page.evaluate(() => (window as any).qaIpc.pendingOpen());
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
  await expect(page.locator('#terminal-size')).toHaveText(/B 接收$/);
});

test('reopening a Big5 local session keeps Big5 even after a runtime switch', async ({ page }) => {
  await openEncoded(page, 'pty', 'big5');
  await switchEncoding(page, 'euc-jp');
  await page.evaluate(() => {
    const ipc = (window as any).qaIpc;
    ipc.channel.onmessage({ kind: 'exit', id: ipc.id, code: 0 });
  });
  await page.locator('#local-reopen').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.pendingOpen)).toBe(true);
  await page.evaluate(() => (window as any).qaIpc.pendingOpen());
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
  await expect(page.locator('#terminal-size')).toContainText('B 接收 · Big5');
  await observe(page, { cols: 60, rows: 8 });
  await page.evaluate(() => {
    const ipc = (window as any).qaIpc;
    ipc.channel.onmessage({ kind: 'data', id: ipc.id, sequence: ++ipc.sequence, data: [0xa4, 0xa4] });
  });
  await expect.poll(() => row(page, 0)).toBe('中');
});

test('the switch is refused for demo and ended sessions', async ({ page }) => {
  await openEncoded(page, 'pty', 'big5');
  await page.evaluate(() => {
    const ipc = (window as any).qaIpc;
    ipc.channel.onmessage({ kind: 'exit', id: ipc.id, code: 0 });
  });
  await expect(page.locator('#local-reopen')).toBeVisible();
  await page.locator('#palette-open').click();
  await page.locator('#command-search').fill('字符编码');
  await page.locator('#command-search').press('Enter');
  await expect(toast(page)).toContainText('字符编码只适用于正在运行的');
  await expect(page.locator('#encoding-dialog')).toBeHidden();
  // The demo tab created at start-up.
  await page.getByRole('tab', { name: 'Getting started' }).click();
  await page.locator('#palette-open').click();
  await page.locator('#command-search').fill('字符编码');
  await page.locator('#command-search').press('Enter');
  await expect(toast(page)).toContainText('字符编码只适用于正在运行的');
});

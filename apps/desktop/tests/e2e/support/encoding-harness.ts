import { expect, type Page } from '@playwright/test';
import { Session, type Transport } from './session-harness';

/**
 * Opens a stubbed native session with a chosen character encoding through the same dialogs a user
 * would (local launch options, SSH terminal, Telnet / Raw TCP), then installs the session harness's
 * `window.qa` observation exactly like `Session.start`. Everything stays in Chrome with the IPC
 * stub from session-harness.ts: no Rust, native PTY, SSH server, TCP peer or native WebView.
 */
export async function openEncoded(page: Page, transport: Transport, encoding: string, size = { cols: 60, rows: 8 }): Promise<Session> {
  const session = await Session.open(page, transport, {}, false);
  await recordOpenArguments(page);
  if (transport === 'pty') {
    await page.locator('#local-options-open').click();
    await page.locator('#local-encoding').selectOption(encoding);
    await page.locator('#local-start').click();
    await expect(page.locator('#local-dialog')).toBeHidden();
  } else if (transport === 'ssh') {
    await page.locator('#connect-open').click();
    await page.locator('#ssh-terminal-open').click();
    await page.locator('#ssh-host').fill('127.0.0.1');
    await page.locator('#ssh-username').fill('qa');
    await page.locator('#ssh-key-path').fill('/qa/key');
    await page.locator('#ssh-encoding').selectOption(encoding);
    await page.locator('#ssh-probe').click();
    await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.probe)).toBe(true);
    await page.evaluate(() => (window as any).qaIpc.probe({
      challengeToken: 'qa-token', host: '127.0.0.1', port: 22, algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:qa', expiresInSeconds: 60,
    }));
    await page.locator('#ssh-accept').click();
  } else {
    await page.locator('#connect-open').click();
    await page.locator('#net-terminal-open').click();
    await page.locator('#net-kind').selectOption('telnet');
    await page.locator('#net-host').fill('127.0.0.1');
    await page.locator('#net-port').fill('2323');
    await page.locator('#net-encoding').selectOption(encoding);
    await page.locator('#net-open').click();
    await expect(page.locator('#net-terminal-dialog')).toBeHidden();
  }
  await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.pendingOpen)).toBe(true);
  await page.evaluate(() => (window as any).qaIpc.pendingOpen());
  await expect(page.locator('#terminal-state')).toContainText(
    transport === 'pty' ? '本机 shell 已启动' : transport === 'ssh' ? 'SSH 已连接' : 'Telnet 已连接',
  );
  await observe(page, size);
  await session.textarea.focus();
  return session;
}

/** The observation `Session.start` installs, for the newest workspace terminal. */
export async function observe(page: Page, size?: { cols: number; rows: number }): Promise<void> {
  await page.evaluate(async (size) => {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const sessions = (window as any).__qaSessions as any[];
    const { terminal, vt } = sessions[sessions.length - 1];
    const qa = { terminal, vt, titles: [] as string[], data: [] as string[] };
    terminal.onTitleChange((title: string) => qa.titles.push(title));
    terminal.onData((data: string) => qa.data.push(data));
    terminal.onBinary((data: string) => qa.data.push(data));
    if (size) terminal.resize(size.cols, size.rows);
    (window as any).qa = qa;
  }, size);
}

/** Wraps the stub's `invoke` to keep the argument names (and non-channel values) of every `*_open`. */
export async function recordOpenArguments(page: Page): Promise<void> {
  await page.evaluate(() => {
    const internals = (window as any).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    (window as any).qaOpenArgs = [];
    internals.invoke = (command: string, args: any = {}) => {
      if (command.endsWith('_open')) {
        const { onEvent, onAuth, ...rest } = args;
        (window as any).qaOpenArgs.push({ command, keys: Object.keys(args).sort(), json: JSON.stringify(rest) });
      }
      return invoke(command, args);
    };
  });
}

export function openArguments(page: Page): Promise<{ command: string; keys: string[]; json: string }[]> {
  return page.evaluate(() => (window as any).qaOpenArgs);
}

/** Bytes given to `*_write` since the last `mark`, as upper-case hex, and the commands used. */
export function writtenBytes(page: Page): Promise<{ hex: string; commands: string[] }> {
  return page.evaluate(() => {
    const ipc = (window as any).qaIpc;
    const writes = ipc.writes.slice(ipc.mark ?? 0);
    return {
      hex: writes.flatMap((w: any) => w.data).map((b: number) => b.toString(16).padStart(2, '0').toUpperCase()).join(''),
      commands: [...new Set(writes.map((w: any) => w.command))] as string[],
    };
  });
}

/** Bytes from hex; spaces are ignored. */
export const fromHex = (hex: string): number[] => (hex.replace(/\s+/g, '').match(/../g) ?? []).map((h) => parseInt(h, 16));
/** ASCII text (controls included) as bytes. */
export const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

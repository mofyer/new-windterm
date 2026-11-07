import { expect, type Page } from '@playwright/test';
import { Session, type OpenOptions, type Transport } from './session-harness';
import { observe, recordOpenArguments } from './encoding-harness';

/**
 * Opens a stubbed native session with chosen keyboard options through the dialog a user would use
 * (local launch options, SSH terminal, Telnet / Raw TCP), then installs the session harness's
 * `window.qa` observation. Chrome with the IPC stub from session-harness.ts only: no Rust, native
 * PTY, SSH server, TCP peer, native WebView, OS keyboard layout or input method.
 */
export interface KeyboardChoice {
  backspace?: 'del' | 'bs';
  delete?: 'vt220' | 'del' | 'bs';
  optionAsMeta?: boolean;
  cursorKeys?: 'normal' | 'application';
}

const PREFIX: Record<Transport, string> = { pty: 'local', ssh: 'ssh', net: 'net' };

/** Expands the dialog's collapsed keyboard field and selects `choice`; omitted fields stay as shown. */
export async function chooseKeyboard(page: Page, transport: Transport, choice: KeyboardChoice): Promise<void> {
  const prefix = PREFIX[transport];
  const field = page.locator(`#${prefix}-keyboard`);
  if (!(await field.evaluate((el) => (el as HTMLDetailsElement).open))) await field.locator('summary').click();
  if (choice.backspace) await page.locator(`#${prefix}-backspace`).selectOption(choice.backspace);
  if (choice.delete) await page.locator(`#${prefix}-delete`).selectOption(choice.delete);
  if (choice.optionAsMeta !== undefined) await page.locator(`#${prefix}-option-meta`).selectOption(String(choice.optionAsMeta));
  if (choice.cursorKeys) await page.locator(`#${prefix}-cursor-keys`).selectOption(choice.cursorKeys);
}

/** Opens the transport's dialog, fills the connection fields and, if given, the keyboard options. */
export async function fillDialog(page: Page, transport: Transport, choice?: KeyboardChoice): Promise<void> {
  if (transport === 'pty') {
    await page.locator('#local-options-open').click();
  } else if (transport === 'ssh') {
    await page.locator('#connect-open').click();
    await page.locator('#ssh-terminal-open').click();
    await page.locator('#ssh-host').fill('127.0.0.1');
    await page.locator('#ssh-username').fill('qa');
    await page.locator('#ssh-key-path').fill('/qa/key');
  } else {
    await page.locator('#connect-open').click();
    await page.locator('#net-terminal-open').click();
    await page.locator('#net-kind').selectOption('telnet');
    await page.locator('#net-host').fill('127.0.0.1');
    await page.locator('#net-port').fill('2323');
  }
  if (choice) await chooseKeyboard(page, transport, choice);
}

/** Submits the dialog filled by {@link fillDialog} and resolves the stubbed native open. */
export async function submitDialog(page: Page, transport: Transport, size?: { cols: number; rows: number }): Promise<void> {
  if (transport === 'pty') {
    await page.locator('#local-start').click();
    await expect(page.locator('#local-dialog')).toBeHidden();
  } else if (transport === 'ssh') {
    await page.locator('#ssh-probe').click();
    await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.probe)).toBe(true);
    await page.evaluate(() => (window as any).qaIpc.probe({
      challengeToken: 'qa-token', host: '127.0.0.1', port: 22, algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:qa', expiresInSeconds: 60,
    }));
    await page.locator('#ssh-accept').click();
  } else {
    await page.locator('#net-open').click();
    await expect(page.locator('#net-terminal-dialog')).toBeHidden();
  }
  await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.pendingOpen)).toBe(true);
  await page.evaluate(() => {
    const ipc = (window as any).qaIpc;
    const resolve = ipc.pendingOpen;
    ipc.pendingOpen = null;
    resolve();
  });
  await expect(page.locator('#terminal-state')).toContainText(
    transport === 'pty' ? '本机 shell 已启动' : transport === 'ssh' ? 'SSH 已连接' : 'Telnet 已连接',
  );
  await observe(page, size);
}

/** A page with the stub loaded and one session opened through its dialog with `choice`. */
export async function openWithKeyboard(
  page: Page, transport: Transport, choice?: KeyboardChoice, options: OpenOptions = {},
): Promise<Session> {
  const session = await Session.open(page, transport, options, false);
  await recordOpenArguments(page);
  await fillDialog(page, transport, choice);
  await submitDialog(page, transport, options.size);
  await session.textarea.focus();
  return session;
}

/** Every byte given to `*_write` so far, including any sent before the first mark. */
export function allWrites(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as any).qaIpc.writes.flatMap((w: any) => w.data));
}

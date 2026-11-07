import { expect, type Page } from '@playwright/test';

/**
 * Stub IPC for the startup command contract (browser only; nothing reaches Rust or a native PTY).
 * Every `pty_open` is held until the test resolves or rejects it, so the order of the native ID,
 * early terminal replies and the command can be chosen. `writePlan` scripts the answers to the next
 * `pty_write` calls: `ok` (default), `full` (the backend's queue-full refusal), `fail` (any other
 * rejection) or `hold` (pending until released). `accepted` lists only writes the backend took.
 */
export async function installStartupIpc(page: Page) {
  await page.addInitScript(() => {
    const decoder = new TextDecoder();
    const state: any = {
      calls: [], opens: [], channels: [], pending: [], writes: [], accepted: [], held: [], writePlan: [],
    };
    Object.assign(window, {
      isTauri: true,
      qaStartup: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke(command: string, args: any = {}) {
          state.calls.push({ command, id: args.id });
          if (command === 'pty_shells') return Promise.resolve([]);
          if (command === 'pty_open') {
            const { onEvent, ...rest } = args;
            state.opens.push({ keys: Object.keys(args).sort(), json: JSON.stringify(rest), cwd: args.cwd, shell: args.shell });
            state.channels.push(onEvent);
            return new Promise((resolve, reject) => state.pending.push({ resolve, reject }));
          }
          if (command === 'pty_write') {
            const entry = { id: args.id, text: decoder.decode(Uint8Array.from(args.data as number[])) };
            state.writes.push(entry);
            const plan = state.writePlan.shift() ?? 'ok';
            if (plan === 'full') return Promise.reject('PTY input queue is full; retry after drain');
            if (plan === 'fail') return Promise.reject('TEST write failure');
            if (plan === 'hold') {
              return new Promise((resolve, reject) => state.held.push({
                resolve: () => { state.accepted.push(entry); resolve(null); },
                reject,
              }));
            }
            state.accepted.push(entry);
            return Promise.resolve(null);
          }
          return Promise.resolve(null);
        },
      },
    });
  });
  await page.goto('/');
}

export const ESC = '\x1b';
export const CPR = /^\x1b\[\d+;\d+R$/;

export async function launch(page: Page, command: string | null, cwd = '') {
  await page.locator('#local-options-open').click();
  await page.locator('#local-cwd-input').fill(cwd);
  await page.locator('#local-command-input').fill(command ?? '');
  await page.locator('#local-start').click();
  await expect(page.locator('#local-dialog')).toBeHidden();
}
export function resolveOpen(page: Page, index: number, id: string) {
  return page.evaluate(([index, id]) => (window as any).qaStartup.pending[index].resolve({ id }), [index, id] as const);
}
export function rejectOpen(page: Page, index: number, error: string) {
  return page.evaluate(([index, error]) => (window as any).qaStartup.pending[index].reject(error), [index, error] as const);
}
/** Delivers output to session `index` and waits until xterm parsed it (its ACK was requested). */
export async function output(page: Page, index: number, id: string, text: string) {
  const acks = await ackCount(page);
  await page.evaluate(([index, id, text]) => {
    const state = (window as any).qaStartup;
    state.sequence = (state.sequence ?? 0) + 1;
    state.channels[index].onmessage({ kind: 'data', id, sequence: state.sequence, data: [...new TextEncoder().encode(text)] });
  }, [index, id, text] as const);
  await expect.poll(() => ackCount(page)).toBe(acks + 1);
}
export function exit(page: Page, index: number, id: string, code = 0) {
  return page.evaluate(([index, id, code]) => (window as any).qaStartup.channels[index].onmessage({ kind: 'exit', id, code }), [index, id, code] as const);
}
function ackCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).qaStartup.calls.filter((c: any) => c.command === 'pty_ack').length);
}
export function writes(page: Page): Promise<{ id: string; text: string }[]> {
  return page.evaluate(() => (window as any).qaStartup.writes);
}
export function accepted(page: Page): Promise<{ id: string; text: string }[]> {
  return page.evaluate(() => (window as any).qaStartup.accepted);
}
export function opens(page: Page): Promise<{ keys: string[]; json: string; cwd: string | null; shell: string | null }[]> {
  return page.evaluate(() => (window as any).qaStartup.opens);
}
export function releaseHeld(page: Page) {
  return page.evaluate(() => { for (const held of (window as any).qaStartup.held.splice(0)) held.resolve(); });
}
export function plan(page: Page, ...answers: string[]) {
  return page.evaluate(answers => { (window as any).qaStartup.writePlan.push(...answers); }, answers);
}
export const state = (page: Page) => page.locator('#terminal-state');
export async function typeInto(page: Page, text: string) {
  await page.locator('.terminal-pane:visible textarea').focus();
  await page.keyboard.type(text);
}

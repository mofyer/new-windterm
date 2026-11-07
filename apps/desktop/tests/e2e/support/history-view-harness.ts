import { expect, type CDPSession, type Page } from '@playwright/test';
import { installModules } from './history-harness';

/**
 * Shared helpers of the read-only history view specs (history-view.spec.ts, history-regex.spec.ts;
 * docs/p1/HISTORY_VIEW_PLAN.zh-CN.md). Bytes go from an in-page Tauri IPC stub through the real
 * `Channel` index/end protocol, session-lifecycle.ts and the workbench xterm into each session's
 * archive; the view is read through its DOM.
 *
 * Environment: Chrome + Vite dev server + IPC stub. Nothing here reaches WKWebView, WebView2,
 * WebKitGTK, Tauri IPC or a Rust PTY.
 */

/** Stub IPC for local PTY tabs, each with its own Channel, sequence and ACK order check. */
export async function installIpc(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const callbacks = new Map<number, (message: unknown) => void>();
    let nextCallback = 1;
    const sessions = new Map<string, any>();
    const state: any = { callbacks, sessions, opened: 0, closes: 0, last: '', writes: [] as number[][] };
    state.send = (id: string, message: unknown) => {
      const s = sessions.get(id);
      callbacks.get(s.channelId)?.({ index: s.index++, message });
    };
    state.end = (id: string) => {
      const s = sessions.get(id);
      callbacks.get(s.channelId)?.({ index: s.index++, end: true });
    };
    /** Sends bytes as Rust would, in 4096 B data events; keeps them for a reference terminal. */
    state.stream = (id: string, bytes: Uint8Array, chunk = 4096) => {
      const s = sessions.get(id);
      s.sent.push(bytes);
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        state.send(id, { kind: 'data', id, sequence: ++s.sequence, data: Array.from(bytes.slice(offset, offset + chunk)) });
      }
      return s.sequence;
    };
    Object.assign(window, {
      isTauri: true,
      viewIpc: state,
      __TAURI_INTERNALS__: {
        transformCallback: (callback: (message: unknown) => void) => {
          const id = nextCallback++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: (command: string, args: any = {}) => {
          if (command === 'pty_open') {
            const id = `view-pty-${++state.opened}`;
            sessions.set(id, { channelId: args.onEvent.id, index: 0, sequence: 0, acks: 0, ackOrder: true, sent: [] });
            state.last = id;
            return Promise.resolve({ id });
          }
          if (command === 'pty_ack') {
            const s = sessions.get(args.id);
            s.ackOrder &&= args.sequence === s.acks + 1;
            s.acks = args.sequence;
          }
          if (command === 'pty_write') state.writes.push(args.data);
          if (command === 'pty_close') state.closes++;
          if (command === 'pty_shells') return Promise.resolve([]);
          return Promise.resolve(null);
        },
      },
    });
  });
}

/** Loads the workbench (optionally with a development query) and opens one stubbed local tab. */
export async function openLocal(page: Page, query = ''): Promise<{ cdp: CDPSession; id: string }> {
  await installIpc(page);
  await page.goto(`/${query}`);
  await expect(page.getByRole('tab')).toHaveCount(1);
  await installModules(page);
  await page.locator('#local-open').click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
  const id = await page.evaluate(() => (window as any).viewIpc.last as string);
  return { cdp: await page.context().newCDPSession(page), id };
}

/** Streams the lines built by `script` (page side, `qa` and `ipc` in scope) and waits for every ACK. */
export async function stream(page: Page, id: string, script: string): Promise<void> {
  const sent = await page.evaluate(`(() => { const qa = window.captureQa; const ipc = window.viewIpc; const id = ${JSON.stringify(id)};
    const bytes = (text) => new TextEncoder().encode(text);
    ${script} })()`) as number;
  await expect.poll(() => page.evaluate((id) => (window as any).viewIpc.sessions.get(id).acks, id), { timeout: 60_000 }).toBe(sent);
  expect(await page.evaluate((id) => (window as any).viewIpc.sessions.get(id).ackOrder, id)).toBe(true);
}

/** Plain text of the mixed test line `i` (support/history-harness.ts). */
export const plainLines = (page: Page, from: number, to: number) =>
  page.evaluate(([from, to]) => Array.from({ length: to - from }, (_, i) => (window as any).captureQa.line(from + i).plain), [from, to]);

export const view = (page: Page) => page.locator('.terminal-pane:not([hidden]) .history-view');

export async function openView(page: Page): Promise<void> {
  await page.locator('#history-view-toggle').click();
  await expect(view(page)).toBeVisible();
  await expect(view(page).locator('.history-search')).toBeFocused();
}

/** Status line of the open view's search. */
export const status = (page: Page) => view(page).locator('.history-status');
export const currentLine = (page: Page) =>
  view(page).locator('.history-row:has(.history-match-current)').getAttribute('data-line').then(Number);

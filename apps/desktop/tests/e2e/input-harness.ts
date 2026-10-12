import { expect, type CDPSession, type Locator, type Page } from '@playwright/test';

/**
 * Shared harness for the input path probes. It drives the real application page in one of three
 * modes: the browser demo, and `pty` / `ssh` tabs whose Tauri IPC is replaced by an in-page stub.
 * The stub records every `*_write` byte and acknowledges output at once; it never reaches a native
 * PTY, an SSH server or the macOS input method. CDP input (`Input.imeSetComposition`,
 * `Input.insertText`, `Input.dispatchKeyEvent`) is Chromium's simulation, not a native IME.
 */
export const MODES = ['demo', 'pty', 'ssh'] as const;
export type Mode = (typeof MODES)[number];

export interface OpenOptions {
  /** Overrides `navigator.platform` before xterm.js reads it, e.g. `Win32` or `Linux x86_64`. */
  platform?: string;
}

/**
 * Test-only instrumentation: the dev server's `/src/terminal.ts` is rewritten in flight so every
 * workspace terminal is also pushed to `window.__qaTerminals`. Application code is unchanged.
 */
async function exposeTerminals(page: Page) {
  await page.route(/\/src\/terminal\.ts(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = 'return terminal;';
    if (!body.includes(marker)) throw new Error('terminal.ts no longer returns `terminal`; update the input harness');
    await route.fulfill({
      response,
      body: body.replace(marker, '(globalThis.__qaTerminals ??= []).push(terminal);\n  ' + marker),
    });
  });
}

async function installIpc(page: Page) {
  await page.addInitScript(() => {
    const state: any = {
      calls: [], writes: [], acks: [], channel: null, id: null, sequence: 0,
      pendingOpen: null, probe: null, holdWrite: false, released: [], writeDelay: 0,
      bound: null, fullRejections: 0, failWriteAt: 0,
    };
    /**
     * Models the Rust input side: at most `capacity` chunks queued (PTY and SSH: 16 x 4 KiB) and
     * drained by a slow consumer; a write that finds it full is refused, not queued.
     */
    const offerBounded = (data: Uint8Array) => {
      const bound = state.bound;
      if (bound.queue.length >= bound.capacity) {
        state.fullRejections++;
        return false;
      }
      bound.queue.push(data);
      bound.timer ||= setInterval(() => {
        bound.queue.splice(0, bound.drain);
        if (!bound.queue.length) { clearInterval(bound.timer); bound.timer = 0; }
      }, bound.every);
      return true;
    };
    Object.assign(window, {
      isTauri: true,
      qaIpc: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke(command: string, args: any = {}) {
          state.calls.push({ command, id: args.id, sequence: args.sequence });
          if (command.endsWith('_write')) {
            const data = Uint8Array.from(args.data);
            if (state.failWriteAt && state.writes.length + 1 === state.failWriteAt)
              return Promise.reject('PTY input write failed or timed out');
            if (state.bound && !offerBounded(data))
              return Promise.reject(`${command.startsWith('ssh') ? 'SSH' : 'PTY'} input queue is full; retry after drain`);
            state.writes.push(data);
            if (state.holdWrite) return new Promise(resolve => state.released.push(resolve));
            if (state.writeDelay) return new Promise(resolve => setTimeout(resolve, Math.random() * state.writeDelay));
            return Promise.resolve(null);
          }
          if (command.endsWith('_ack')) { state.acks.push(args.sequence); return Promise.resolve(null); }
          if (command === 'pty_open') {
            state.channel = args.onEvent; state.id = 'qa-pty';
            return new Promise(resolve => state.pendingOpen = () => resolve({ id: state.id }));
          }
          if (command === 'ssh_context') return Promise.resolve('qa-scope');
          if (command === 'ssh_probe') return new Promise(resolve => state.probe = resolve);
          if (command === 'ssh_open') {
            state.channel = args.onEvent; state.id = args.operationId;
            return new Promise(resolve => state.pendingOpen = () => resolve({ id: state.id }));
          }
          return Promise.resolve(null);
        },
      },
    });
  });
}

async function openPty(page: Page) {
  await page.locator('#local-open').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.pendingOpen)).toBe(true);
  await page.evaluate(() => (window as any).qaIpc.pendingOpen());
  await expect(page.locator('#terminal-state')).toContainText('本机 shell 已启动');
}

async function openSsh(page: Page) {
  await page.locator('#connect-open').click();
  await page.locator('#ssh-terminal-open').click();
  await page.locator('#ssh-host').fill('127.0.0.1');
  await page.locator('#ssh-username').fill('qa');
  await page.locator('#ssh-key-path').fill('/qa/key');
  await page.locator('#ssh-probe').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.probe)).toBe(true);
  await page.evaluate(() => (window as any).qaIpc.probe({
    challengeToken: 'qa-token', host: '127.0.0.1', port: 22, algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:qa', expiresInSeconds: 60,
  }));
  await page.locator('#ssh-accept').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.pendingOpen)).toBe(true);
  await page.evaluate(() => (window as any).qaIpc.pendingOpen());
  await expect(page.locator('#terminal-state')).toContainText('SSH 已连接');
}

export class Term {
  private constructor(readonly page: Page, readonly mode: Mode, readonly cdp: CDPSession) {}

  static async open(page: Page, mode: Mode, options: OpenOptions = {}): Promise<Term> {
    await exposeTerminals(page);
    if (options.platform) {
      await page.addInitScript((platform) => {
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => platform, configurable: true });
      }, options.platform);
    }
    if (mode !== 'demo') await installIpc(page);
    await page.goto('/');
    if (mode === 'pty') await openPty(page);
    if (mode === 'ssh') await openSsh(page);
    const term = new Term(page, mode, await page.context().newCDPSession(page));
    await page.evaluate(() => {
      const terminals = (window as any).__qaTerminals as any[];
      const terminal = terminals[terminals.length - 1];
      const qa = { terminal, data: [] as string[] };
      terminal.onData((data: string) => qa.data.push(data));
      (window as any).qa = qa;
    });
    await term.textarea.focus();
    return term;
  }

  get textarea(): Locator {
    return this.page.locator('.terminal-pane:not([hidden]) textarea');
  }

  /** Everything the active xterm emitted through `onData` since the last {@link reset}. */
  data(): Promise<string> {
    return this.page.evaluate(() => (window as any).qa.data.join(''));
  }

  /** The `onData` events one by one, to tell one send from several. */
  dataEvents(): Promise<string[]> {
    return this.page.evaluate(() => (window as any).qa.data.slice());
  }

  /** UTF-8 decoding of every byte handed to `*_write`, in call order (pty / ssh only). */
  sent(): Promise<string> {
    return this.page.evaluate(() => {
      const writes = (window as any).qaIpc.writes as Uint8Array[];
      const all = new Uint8Array(writes.reduce((n, w) => n + w.length, 0));
      let at = 0;
      for (const w of writes) { all.set(w, at); at += w.length; }
      return new TextDecoder('utf-8', { fatal: true }).decode(all);
    });
  }

  /** What reached the transport: IPC writes for pty / ssh, `onData` for the demo. */
  delivered(): Promise<string> {
    return this.mode === 'demo' ? this.data() : this.sent();
  }

  async reset(): Promise<void> {
    await this.page.evaluate(() => {
      (window as any).qa.data = [];
      const ipc = (window as any).qaIpc;
      if (ipc) ipc.writes = [];
    });
  }

  /** Writes host output: raw UTF-8 through the IPC channel, or straight into xterm for the demo. */
  async output(text: string, chunk = 4096): Promise<void> {
    await this.page.evaluate(async ({ text, chunk }) => {
      const qa = (window as any).qa;
      const ipc = (window as any).qaIpc;
      if (!ipc) {
        await new Promise<void>(resolve => qa.terminal.write(text, resolve));
        return;
      }
      const bytes = new TextEncoder().encode(text);
      for (let at = 0; at < bytes.length; at += chunk)
        ipc.channel.onmessage({ kind: 'data', id: ipc.id, sequence: ++ipc.sequence, data: [...bytes.subarray(at, at + chunk)] });
      await new Promise<void>(resolve => qa.terminal.write('', resolve));
    }, { text, chunk });
  }

  /**
   * Heavy host output in the background: `lines` numbered lines (CJK and emoji included) sent as
   * 4 KiB IPC chunks, one per timer tick, so CDP input interleaves with parsing. pty / ssh only;
   * the demo has its own `stress` command.
   */
  async startStream(lines: number): Promise<void> {
    await this.page.evaluate((lines) => {
      const ipc = (window as any).qaIpc;
      const text = Array.from({ length: lines }, (_, n) => `line ${String(n).padStart(6, '0')} 输出 🌏 output\r\n`).join('') + 'STREAM-END';
      const bytes = new TextEncoder().encode(text);
      ipc.streamDone = false;
      let at = 0;
      const tick = () => {
        ipc.channel.onmessage({ kind: 'data', id: ipc.id, sequence: ++ipc.sequence, data: [...bytes.subarray(at, at + 4096)] });
        at += 4096;
        if (at < bytes.length) setTimeout(tick, 1);
        else ipc.streamDone = true;
      };
      tick();
    }, lines);
  }

  async streamFinished(): Promise<void> {
    await expect.poll(() => this.page.evaluate(() => (window as any).qaIpc.streamDone), { timeout: 15_000 }).toBe(true);
    await this.drained();
  }

  /** Waits until every chunk sent through the IPC channel was parsed and acknowledged. */
  async drained(): Promise<void> {
    if (this.mode === 'demo') return;
    await expect.poll(() => this.page.evaluate(() => {
      const ipc = (window as any).qaIpc;
      return ipc.acks.length === ipc.sequence;
    })).toBe(true);
  }

  cursor(): Promise<{ x: number; y: number }> {
    return this.page.evaluate(() => {
      const b = (window as any).qa.terminal.buffer.active;
      return { x: b.cursorX, y: b.cursorY };
    });
  }

  /** Cells of one viewport row: the characters and the width of each column. */
  cells(row?: number, count = 24): Promise<{ chars: string; width: number }[]> {
    return this.page.evaluate(({ row, count }) => {
      const b = (window as any).qa.terminal.buffer.active;
      const line = b.getLine(b.viewportY + (row ?? b.cursorY));
      return Array.from({ length: count }, (_, x) => {
        const cell = line.getCell(x);
        return { chars: cell.getChars(), width: cell.getWidth() };
      });
    }, { row, count });
  }

  /** Text of a viewport row (default: the cursor row), trailing blanks trimmed. */
  row(row?: number): Promise<string> {
    return this.page.evaluate((row) => {
      const b = (window as any).qa.terminal.buffer.active;
      return b.getLine(b.viewportY + (row ?? b.cursorY)).translateToString(true);
    }, row);
  }

  async compose(text: string, selection = text.length): Promise<void> {
    await this.cdp.send('Input.imeSetComposition', { text, selectionStart: selection, selectionEnd: selection });
  }

  /** A key the IME consumes (keyCode 229), e.g. Enter picking a candidate or Escape cancelling. */
  async imeKey(key: string): Promise<void> {
    for (const type of ['rawKeyDown', 'keyUp'] as const)
      await this.cdp.send('Input.dispatchKeyEvent', { type, key, code: key, windowsVirtualKeyCode: 229 });
  }

  async insertText(text: string): Promise<void> {
    await this.cdp.send('Input.insertText', { text });
  }

  /** Makes `*_write` behave like the Rust bounded input queue, drained `drain` chunks per `every` ms. */
  async boundBackend(capacity = 16, drain = 1, every = 1): Promise<void> {
    await this.page.evaluate(({ capacity, drain, every }) => {
      (window as any).qaIpc.bound = { capacity, drain, every, queue: [], timer: 0 };
    }, { capacity, drain, every });
  }

  /** Every `*_write` call's byte length, in order (pty / ssh only). */
  writeSizes(): Promise<number[]> {
    return this.page.evaluate(() => (window as any).qaIpc.writes.map((w: Uint8Array) => w.length));
  }

  /** Lets xterm's zero-delay composition timers and the IPC promise chain run. */
  async settle(): Promise<void> {
    await this.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)));
  }

  /** A synthetic clipboard paste on the terminal textarea; the system clipboard is untouched. */
  async paste(text: string): Promise<void> {
    await this.textarea.evaluate((el, text) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, text);
  }

  /** The composition overlay and where it sits, relative to the cursor cell. */
  compositionView(): Promise<{ text: string; active: boolean; left: number; top: number; cellLeft: number; cellTop: number }> {
    return this.page.evaluate(() => {
      const { terminal } = (window as any).qa;
      const pane = document.querySelector('.terminal-pane:not([hidden])')!;
      const view = pane.querySelector<HTMLElement>('.composition-view')!;
      const screen = pane.querySelector<HTMLElement>('.xterm-screen')!.getBoundingClientRect();
      const box = view.getBoundingClientRect();
      const b = terminal.buffer.active;
      return {
        text: view.textContent ?? '',
        active: view.classList.contains('active'),
        left: box.left - screen.left,
        top: box.top - screen.top,
        cellLeft: (Math.min(b.cursorX, terminal.cols - 1) * screen.width) / terminal.cols,
        cellTop: (b.cursorY * screen.height) / terminal.rows,
      };
    });
  }
}

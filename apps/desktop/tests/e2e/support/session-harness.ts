import { expect, type CDPSession, type Locator, type Page } from '@playwright/test';

/**
 * Harness for the terminal regression specs. It drives the real workbench page through the
 * production session path: an in-page Tauri IPC stub -> `Channel` -> `session-lifecycle.ts`
 * (`Utf8Boundary`, ordered ACK, VT adapters) -> xterm.js, and back out through
 * `terminal-input.ts` -> `queueInput` -> the stubbed `pty_write` / `ssh_write` / `net_write`.
 * Nothing here reaches Rust, a native PTY, an SSH server, TCP or a native WebView.
 */
export const TRANSPORTS = ['pty', 'ssh', 'net'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export interface OpenOptions {
  /** Overrides `navigator.platform` before xterm.js reads it, e.g. `Win32` or `Linux x86_64`. */
  platform?: string;
  /** Resize the terminal after opening, so screen snapshots stay small and stable. */
  size?: { cols: number; rows: number };
}

export interface Snapshot {
  size: string;
  type: string;
  cursor: string;
  baseY: number;
  rows: string[];
  cells: string[];
  modes: Record<string, unknown>;
  titles: string;
  /** What the terminal emitted through `onData` / `onBinary` while the chunks were parsed. */
  replies: string;
}

/**
 * Test-only instrumentation: the dev server's `/src/terminal.ts` is rewritten in flight so every
 * workspace session `{ terminal, vt }` is also pushed to `window.__qaSessions`. Application code
 * is unchanged; the objects are the ones `session-lifecycle.ts` uses.
 */
async function exposeSessions(page: Page) {
  await page.route(/\/src\/terminal\.ts(\?.*)?$/, async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const marker = /return\s*\{\s*terminal,\s*vt:\s*attachVtAdapters\(terminal,\s*vt\)\s*\};/;
    if (!marker.test(body)) throw new Error('terminal.ts no longer returns `{ terminal, vt }`; update session-harness.ts');
    await route.fulfill({
      response,
      body: body.replace(marker, 'const qaSession = { terminal, vt: attachVtAdapters(terminal, vt) };\n'
        + '\t(globalThis.__qaSessions ??= []).push(qaSession);\n\treturn qaSession;'),
    });
  });
}

async function installIpc(page: Page) {
  await page.addInitScript(() => {
    const state: any = {
      calls: [], writes: [], acks: [], clipboard: [], channel: null, id: null, sequence: 0,
      pendingOpen: null, probe: null, holdAck: false, heldAcks: [], holdWrite: false, heldWrites: [],
    };
    // Stand-in for the WebView clipboard so OSC 52 writes are observable and never touch the real one.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true, value: { writeText: async (text: string) => { state.clipboard.push(text); } },
    });
    Object.assign(window, {
      isTauri: true,
      qaIpc: state,
      __TAURI_INTERNALS__: {
        transformCallback: () => 1,
        unregisterCallback: () => {},
        invoke(command: string, args: any = {}) {
          state.calls.push({ command, id: args.id, sequence: args.sequence });
          if (command.endsWith('_write')) {
            state.writes.push({ command, id: args.id, data: Array.from(args.data as number[]) });
            if (state.holdWrite) return new Promise(resolve => state.heldWrites.push(resolve));
            return Promise.resolve(null);
          }
          if (command.endsWith('_ack')) {
            state.acks.push({ command, id: args.id, sequence: args.sequence });
            if (state.holdAck) return new Promise(resolve => state.heldAcks.push(resolve));
            return Promise.resolve(null);
          }
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
          if (command === 'net_open') {
            state.channel = args.onEvent; state.id = args.id;
            return new Promise(resolve => state.pendingOpen = () => resolve({ id: state.id }));
          }
          return Promise.resolve(null);
        },
      },
    });
  });
}

/** Page-side helpers; self-contained because Playwright serialises the function. */
function installTools() {
  const w = window as any;
  const flush = () => new Promise<void>(resolve => w.qa.terminal.write('', resolve));
  w.qaTools = {
    /** Delivers raw chunks as `PtyEvent` data, then waits until xterm parsed all of them. */
    async send(chunks: number[][]) {
      const ipc = w.qaIpc;
      for (const data of chunks) ipc.channel.onmessage({ kind: 'data', id: ipc.id, sequence: ++ipc.sequence, data });
      await flush();
    },
    snapshot() {
      const t = w.qa.terminal;
      const b = t.buffer.active;
      const rows: string[] = [];
      const cells: string[] = [];
      for (let y = 0; y < t.rows; y++) {
        const line = b.getLine(b.viewportY + y);
        rows.push((line.isWrapped ? '~' : '') + line.translateToString(true));
        for (let x = 0; x < t.cols; x++) {
          const c = line.getCell(x);
          const attrs = [
            c.getChars(), c.getWidth(),
            c.getFgColorMode() ? `${c.getFgColorMode()}:${c.getFgColor()}` : '', c.getBgColorMode() ? `${c.getBgColorMode()}:${c.getBgColor()}` : '',
            +!!c.isBold(), +!!c.isDim(), +!!c.isItalic(), +!!c.isUnderline(), +!!c.isBlink(), +!!c.isInverse(),
            +!!c.isInvisible(), +!!c.isStrikethrough(), +!!c.isOverline(),
          ].join(',');
          if (attrs !== ',1,,,0,0,0,0,0,0,0,0,0') cells.push(`${x},${y}:${attrs}`);
        }
      }
      return {
        size: `${t.cols}x${t.rows}`, type: b.type, cursor: `${b.cursorX},${b.cursorY}`, baseY: b.baseY,
        rows, cells, modes: { ...t.modes }, titles: w.qa.titles.join('|'), replies: w.qa.data.join(''),
      };
    },
    /**
     * Runs one sample once per cut list. Before each run a separate RIS chunk returns the terminal
     * to its initial state; the run's own bytes are then cut at the given offsets. xterm.js 6.0.0's
     * RIS keeps DECTCEM, LNM and OSC 4/10/11/12 colours (terminal-regressions-reset.spec.ts), so a
     * sample must not leave those changed unless every run reports them the same way.
     */
    async splits(sample: number[], cutLists: number[][], probe: number[]) {
      const out = [];
      for (const cuts of cutLists) {
        // RIS emits no title or data, so the observation can start before it is parsed.
        w.qa.titles = [];
        w.qa.data = [];
        const chunks: number[][] = [[0x1b, 0x63]];
        let at = 0;
        for (const cut of [...cuts, sample.length]) {
          chunks.push(sample.slice(at, cut));
          at = cut;
        }
        if (probe.length) chunks.push(probe);
        await w.qaTools.send(chunks);
        out.push({ cuts: cuts.join(','), ...w.qaTools.snapshot() });
      }
      return out;
    },
  };
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

async function openNet(page: Page) {
  await page.locator('#connect-open').click();
  await page.locator('#net-terminal-open').click();
  await page.locator('#net-kind').selectOption('telnet');
  await page.locator('#net-host').fill('127.0.0.1');
  await page.locator('#net-port').fill('2323');
  await page.locator('#net-open').click();
  await expect(page.locator('#net-terminal-dialog')).toBeHidden();
  await expect.poll(() => page.evaluate(() => !!(window as any).qaIpc.pendingOpen)).toBe(true);
  await page.evaluate(() => (window as any).qaIpc.pendingOpen());
  await expect(page.locator('#terminal-state')).toContainText('Telnet 已连接');
}

const bytes = (chunk: string | number[]) => (typeof chunk === 'string' ? [...Buffer.from(chunk, 'utf8')] : chunk);

export class Session {
  private constructor(readonly page: Page, readonly transport: Transport, readonly cdp: CDPSession) {}

  /** Installs the stub and instrumentation, loads the page and, unless `open` is false, opens a session. */
  static async open(page: Page, transport: Transport, options: OpenOptions = {}, open = true): Promise<Session> {
    await exposeSessions(page);
    if (options.platform) {
      await page.addInitScript((platform) => {
        Object.defineProperty(Navigator.prototype, 'platform', { get: () => platform, configurable: true });
      }, options.platform);
    }
    await installIpc(page);
    await page.addInitScript(installTools);
    await page.goto('/');
    const session = new Session(page, transport, await page.context().newCDPSession(page));
    if (open) await session.start(options);
    return session;
  }

  /** Opens the transport's tab; with `resolve: false` the native open stays pending. */
  async start(options: OpenOptions = {}, resolve = true): Promise<void> {
    if (!resolve) {
      if (this.transport !== 'pty') throw new Error('only pty opens can be left pending');
      await this.page.locator('#local-open').click();
      await expect.poll(() => this.page.evaluate(() => !!(window as any).qaIpc.pendingOpen)).toBe(true);
    } else if (this.transport === 'pty') await openPty(this.page);
    else if (this.transport === 'ssh') await openSsh(this.page);
    else await openNet(this.page);
    await this.page.evaluate(async (size) => {
      // Let the pane's first ResizeObserver fit and the workbench repaint run before resizing.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const sessions = (window as any).__qaSessions as any[];
      const { terminal, vt } = sessions[sessions.length - 1];
      const qa = { terminal, vt, titles: [] as string[], data: [] as string[] };
      terminal.onTitleChange((title: string) => qa.titles.push(title));
      terminal.onData((data: string) => qa.data.push(data));
      terminal.onBinary((data: string) => qa.data.push(data));
      if (size) terminal.resize(size.cols, size.rows);
      (window as any).qa = qa;
    }, options.size);
    await this.textarea.focus();
  }

  /** Resolves a pending `pty_open` left by `start(options, false)`. */
  async resolveOpen(): Promise<void> {
    await this.page.evaluate(() => (window as any).qaIpc.pendingOpen());
    await expect(this.page.locator('#terminal-state')).toContainText('本机 shell 已启动');
  }

  get textarea(): Locator {
    return this.page.locator('.terminal-pane:not([hidden]) textarea');
  }

  /** Delivers host output chunks (strings are UTF-8 encoded) and waits until xterm parsed them. */
  async send(...chunks: (string | number[])[]): Promise<void> {
    const data = chunks.map(bytes);
    await this.page.evaluate((data) => (window as any).qaTools.send(data), data);
  }

  /** Waits until every delivered chunk was acknowledged. */
  async drained(): Promise<void> {
    await expect.poll(() => this.page.evaluate(() => {
      const ipc = (window as any).qaIpc;
      return ipc.acks.length === ipc.sequence;
    })).toBe(true);
  }

  /** Every ACK so far, as `command:sequence`. */
  acks(): Promise<string[]> {
    return this.page.evaluate(() => (window as any).qaIpc.acks.map((a: any) => `${a.command}:${a.sequence}`));
  }

  /** Sequence numbers delivered so far. */
  sequence(): Promise<number> {
    return this.page.evaluate(() => (window as any).qaIpc.sequence);
  }

  /** Bytes handed to `*_write` since the last {@link mark}, decoded as UTF-8, with the commands used. */
  written(): Promise<{ text: string; commands: string[]; ids: string[] }> {
    return this.page.evaluate(() => {
      const ipc = (window as any).qaIpc;
      const writes = ipc.writes.slice(ipc.mark ?? 0);
      const all = Uint8Array.from(writes.flatMap((w: any) => w.data));
      return {
        text: new TextDecoder().decode(all),
        commands: [...new Set(writes.map((w: any) => w.command))] as string[],
        ids: [...new Set(writes.map((w: any) => w.id))] as string[],
      };
    });
  }

  /** Each `*_write` call's text since the last {@link mark}. */
  writeCalls(): Promise<string[]> {
    return this.page.evaluate(() => {
      const ipc = (window as any).qaIpc;
      return ipc.writes.slice(ipc.mark ?? 0).map((w: any) => new TextDecoder().decode(Uint8Array.from(w.data)));
    });
  }

  /** Starts a new observation window for {@link written} and `onData`. */
  async mark(): Promise<void> {
    await this.page.evaluate(() => {
      const ipc = (window as any).qaIpc;
      ipc.mark = ipc.writes.length;
      (window as any).qa.data = [];
    });
  }

  /** Waits until the transport received exactly `text` since the last mark. */
  async expectWritten(text: string): Promise<void> {
    await expect.poll(async () => (await this.written()).text).toBe(text);
    expect((await this.written()).commands).toEqual(text ? [`${this.transport}_write`] : []);
  }

  snapshot(): Promise<Snapshot> {
    return this.page.evaluate(() => (window as any).qaTools.snapshot());
  }

  /** Lets xterm's zero-delay timers and the IPC promise chain run. */
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

  /** One key press dispatched through CDP, for keys and layouts Playwright cannot express. */
  async cdpKey(key: { key: string; code: string; keyCode: number; text?: string; modifiers?: number }): Promise<void> {
    const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, modifiers: key.modifiers ?? 0 };
    await this.cdp.send('Input.dispatchKeyEvent', key.text
      ? { type: 'keyDown', text: key.text, unmodifiedText: key.text, ...base }
      : { type: 'rawKeyDown', ...base });
    await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await this.settle();
  }

  /** Presses each key on a fresh mark and returns what reached the transport for each. */
  async pressEach(keys: string[]): Promise<Record<string, string>> {
    const sent: Record<string, string> = {};
    for (const key of keys) {
      await this.mark();
      await this.page.keyboard.press(key);
      await this.settle();
      sent[key] = (await this.written()).text;
    }
    return sent;
  }

  /** Dispatches a mouse event on the visible terminal's screen at a cell. */
  async mouse(type: string, col: number, row: number, init: { button?: number } = {}): Promise<void> {
    await this.page.evaluate(({ type, col, row, init }) => {
      const { terminal } = (window as any).qa;
      const screen = document.querySelector('.terminal-pane:not([hidden]) .xterm-screen') as HTMLElement;
      const rect = screen.getBoundingClientRect();
      screen.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, ...init,
        clientX: rect.left + (col + 0.5) * rect.width / terminal.cols,
        clientY: rect.top + (row + 0.5) * rect.height / terminal.rows,
      }));
    }, { type, col, row, init });
  }

  /**
   * Runs `sample` whole, cut at every offset, one byte per chunk and at `extra` cut lists; returns
   * the snapshot of each run (taken after `probe`, if given, is delivered as its own chunk).
   */
  async splits(sample: string | number[], probe: string | number[] = [], extra: number[][] = []): Promise<(Snapshot & { cuts: string })[]> {
    const data = bytes(sample);
    const cutLists: number[][] = [[]];
    for (let cut = 1; cut < data.length; cut++) cutLists.push([cut]);
    cutLists.push(Array.from({ length: data.length - 1 }, (_, i) => i + 1));
    cutLists.push(...extra);
    return this.page.evaluate(
      ({ data, cutLists, probe }) => (window as any).qaTools.splits(data, cutLists, probe) as Promise<(Snapshot & { cuts: string })[]>,
      { data, cutLists, probe: bytes(probe) },
    );
  }
}

/** Seeded cut lists with 2–8 random cuts, so runs are reproducible. */
export function randomCuts(length: number, count: number, seed = 7): number[][] {
  let state = seed;
  const next = (n: number) => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state % n; };
  return Array.from({ length: count }, () => {
    const cuts = new Set<number>();
    const wanted = 2 + next(7);
    while (cuts.size < Math.min(wanted, length - 1)) cuts.add(1 + next(length - 1));
    return [...cuts].sort((a, b) => a - b);
  });
}

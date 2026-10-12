import { test, type Page, type TestInfo } from '@playwright/test';

// Page-side harness for the VT matrix specs: one real, independent @xterm/xterm instance per
// probe, plus helpers that observe it only through public xterm APIs, onData / onBinary replies
// and the rendered DOM rows. By default the production VT adapters
// (src/terminal-compat/vt-adapters.ts) are attached, exactly as the workspace factory does;
// `vt: false` measures raw xterm.js instead.

export type Status = 'supported' | 'partial' | 'unsupported';
export interface Meta {
  id: string;
  status: Status;
  title: string;
  sequence: string;
  expected: string;
  features: string[];
}
export interface VtOptions { terminalType?: string; clipboardWrite?: boolean }
export interface HarnessOptions { cols?: number; rows?: number; options?: Record<string, unknown>; vt?: false | VtOptions }
export interface VtControl {
  terminalType: string;
  clipboardWrite: boolean;
  setTerminalType(type: string): void;
  setClipboardWrite(enabled: boolean): void;
  reset(): void;
  dispose(): void;
}
export interface Cell {
  ch: string; width: number; fg: string; bg: string;
  bold: boolean; dim: boolean; italic: boolean; underline: boolean; blink: boolean;
  inverse: boolean; invisible: boolean; strike: boolean; overline: boolean;
}
export interface Span { text: string; className: string; decorationColor: string; animation: string }
// The page-side xterm instance; typed loosely because the module is imported at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Term = any;
export interface Harness {
  term: Term;
  holder: HTMLElement;
  titles: string[];
  /** Production adapters, or null for raw xterm.js. */
  vt: VtControl | null;
  /** Adapter notices and what the stub clipboard sink received. */
  notices: { kind: string }[];
  clipboard: string[];
  write(data: string): Promise<void>;
  take(): string;
  takeBinary(): string;
  query(sequence: string): Promise<string>;
  cursor(): { x: number; y: number };
  lines(): string[];
  wrapped(y: number): boolean;
  cell(x: number, y: number): Cell;
  bufferType(): string;
  frame(): Promise<void>;
  mouse(type: string, col: number, row: number, init?: MouseEventInit): { x: number; y: number };
  spans(y: number): Span[];
  dispose(): void;
}
export type VtWindow = Window & { vtHarness(options: HarnessOptions): Promise<Harness> };

// Installed into the page; must stay self-contained because Playwright serialises it.
export function installHarness() {
  const target = window as unknown as { vtHarness?: unknown };
  if (target.vtHarness) return;
  target.vtHarness = async ({ cols = 20, rows = 6, options = {}, vt = {} }: HarnessOptions) => {
    const modulePath = '/node_modules/@xterm/xterm/lib/xterm.mjs';
    const adapterPath = '/src/terminal-compat/vt-adapters.ts';
    const { Terminal } = await import(/* @vite-ignore */ modulePath);
    const term = new Terminal({ cols, rows, allowProposedApi: true, ...options });
    const notices: { kind: string }[] = [];
    const clipboard: string[] = [];
    const adapters = vt === false ? null : (await import(/* @vite-ignore */ adapterPath)).attachVtAdapters(term, {
      ...vt,
      onNotice: (notice: { kind: string }) => notices.push(notice),
      writeClipboard: async (text: string) => { clipboard.push(text); },
    });
    const holder = document.createElement('div');
    // On-screen: xterm pauses DOM rendering for terminals outside the viewport.
    holder.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;background:#000;width:900px;height:400px';
    document.body.append(holder);
    term.open(holder);
    const data: string[] = [];
    const binary: string[] = [];
    const titles: string[] = [];
    const subscriptions = [
      term.onData((value: string) => data.push(value)),
      term.onBinary((value: string) => binary.push(value)),
      term.onTitleChange((value: string) => titles.push(value)),
    ];
    const buffer = () => term.buffer.active;
    const row = (y: number) => buffer().getLine(buffer().viewportY + y);
    const color = (mode: number, value: number) => {
      if (mode === 0) return 'default';
      if (mode === 0x1000000) return `p16:${value}`;
      if (mode === 0x2000000) return `p256:${value}`;
      return `rgb:${value.toString(16).padStart(6, '0')}`;
    };
    const write = (value: string) => new Promise<void>(resolve => term.write(value, resolve));
    const take = () => data.splice(0).join('');
    return {
      term, holder, titles, write, take, vt: adapters, notices, clipboard,
      takeBinary: () => binary.splice(0).join(''),
      async query(sequence: string) { take(); await write(sequence); return take(); },
      cursor: () => ({ x: buffer().cursorX, y: buffer().cursorY }),
      lines: () => Array.from({ length: term.rows }, (_, y) => row(y).translateToString(true)),
      wrapped: (y: number) => row(y).isWrapped,
      bufferType: () => buffer().type,
      cell(x: number, y: number) {
        const c = row(y).getCell(x);
        return {
          ch: c.getChars(), width: c.getWidth(),
          fg: color(c.getFgColorMode(), c.getFgColor()), bg: color(c.getBgColorMode(), c.getBgColor()),
          bold: !!c.isBold(), dim: !!c.isDim(), italic: !!c.isItalic(), underline: !!c.isUnderline(),
          blink: !!c.isBlink(), inverse: !!c.isInverse(), invisible: !!c.isInvisible(),
          strike: !!c.isStrikethrough(), overline: !!c.isOverline(),
        };
      },
      frame: () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      mouse(type: string, col: number, rowIndex: number, init: MouseEventInit = {}) {
        const screen = holder.querySelector('.xterm-screen') as HTMLElement;
        const rect = screen.getBoundingClientRect();
        const x = Math.floor((col + 0.5) * rect.width / term.cols);
        const y = Math.floor((rowIndex + 0.5) * rect.height / term.rows);
        const EventType = type === 'wheel' ? WheelEvent : MouseEvent;
        // Dispatch on the screen: the linkifier listens there; mouse reporting sees it bubble up.
        screen.dispatchEvent(new EventType(type, {
          bubbles: true, cancelable: true, clientX: rect.left + x, clientY: rect.top + y, ...init,
        }));
        return { x, y };
      },
      spans(y: number) {
        const rowElement = holder.querySelectorAll('.xterm-rows > div')[y];
        return Array.from(rowElement?.querySelectorAll('span') ?? [], span => ({
          text: span.textContent ?? '', className: span.className,
          decorationColor: span.style.textDecorationColor, animation: getComputedStyle(span).animationName,
        }));
      },
      dispose() { subscriptions.forEach(s => s.dispose()); adapters?.dispose(); term.dispose(); holder.remove(); },
    };
  };
}

export async function run<T>(page: Page, body: (h: Harness) => Promise<T>, options: HarnessOptions = {}): Promise<T> {
  return page.evaluate(async ([source, harnessOptions]) => {
    const h = await (window as unknown as VtWindow).vtHarness(harnessOptions);
    try {
      const fn = (0, eval)(`(${source})`) as (h: Harness) => Promise<unknown>;
      return await fn(h);
    } finally {
      h.dispose();
    }
  }, [body.toString(), options] as [string, HarnessOptions]) as Promise<T>;
}

const ADAPTERS = 'src/terminal-compat/vt-adapters.ts attached unless the probe passes vt: false ("raw")';

/** Run the same body on raw xterm.js (`vt: false`) and with the production adapters. */
export async function rawAndAdapted<T>(page: Page, body: (h: Harness) => Promise<T>, options: HarnessOptions = {}) {
  return { raw: await run(page, body, { ...options, vt: false }), adapted: await run(page, body, options) };
}

export function probe<T>(meta: Meta, body: (page: Page) => Promise<T>, check: (observed: T) => void) {
  const gap = meta.status === 'supported' ? '' : 'known gap: ';
  test(`[${meta.status}] ${meta.id} ${gap}${meta.title}`, async ({ page }, info: TestInfo) => {
    const observed = await body(page);
    await info.attach(`${meta.id}.json`, {
      body: JSON.stringify({ ...meta, observed, xterm: '@xterm/xterm 6.0.0', adapters: ADAPTERS }, null, 2),
      contentType: 'application/json',
    });
    check(observed);
  });
}

export const ESC = '\x1b';
export const ST = '\x1b\\';

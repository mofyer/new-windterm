import { expect, type Page } from '@playwright/test';
import { exposeSessions } from './session-harness';

/**
 * Harness for the terminal bell specs. Host output goes through the production session path: an
 * in-page Tauri IPC stub -> `Channel` -> `session-lifecycle.ts` (`Utf8Boundary`, ordered ACK) ->
 * xterm.js `onBell` -> `terminal-bell.ts`. Unlike `session-harness.ts`, the stub keeps one channel
 * per `pty_open`, so several local tabs can receive output. `AudioContext` is replaced by a
 * counting double: no sound is played and no audio device is opened. Nothing here reaches Rust,
 * a native PTY or a native WebView, and nothing proves a WebView would actually make a sound.
 */
export type AudioMode = 'running' | 'suspended' | 'missing';

export interface BellPageOptions {
  audio?: AudioMode;
}

export interface Cue {
  pane: string;
  kind: 'flash' | 'steady';
  on: boolean;
}

function installStubs(mode: AudioMode) {
  const w = window as any;
  const ipc: any = { channels: {}, terminals: {}, writes: [], acks: [], sequence: {}, next: 0, toasts: [] };
  const audio: any = { contexts: 0, tones: 0, resumes: 0, allow: false };
  w.qaBell = { ipc, audio, cues: [] };
  if (mode === 'missing') {
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
  } else {
    class CountingAudioContext {
      state = mode;
      currentTime = 0;
      destination = {};
      constructor() { audio.contexts++; }
      resume() {
        audio.resumes++;
        if (this.state === 'running' || audio.allow) {
          this.state = 'running';
          return Promise.resolve();
        }
        return new Promise(() => {});
      }
      close() { this.state = 'closed'; return Promise.resolve(); }
      createOscillator() {
        const node = { type: '', onended: null, frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, stop() {},
          start() { audio.tones++; } };
        return node;
      }
      createGain() {
        return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} };
      }
    }
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: CountingAudioContext });
  }
  Object.assign(window, {
    isTauri: true,
    __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      unregisterCallback: () => {},
      invoke(command: string, args: any = {}) {
        if (command === 'pty_open') {
          const id = `qa-pty-${++ipc.next}`;
          ipc.channels[id] = args.onEvent;
          ipc.sequence[id] = 0;
          return Promise.resolve({ id });
        }
        if (command.endsWith('_write')) ipc.writes.push({ id: args.id, data: Array.from(args.data as number[]) });
        if (command.endsWith('_ack')) ipc.acks.push({ id: args.id, sequence: args.sequence });
        return Promise.resolve(null);
      },
    },
  });
  // Observers only: what the workbench shows, recorded without touching application code.
  window.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((records) => {
      // A batch can hold several records per pane: the states are each record's old value,
      // then the current class list; a cue is a change of a bell class between neighbours.
      const states = new Map<HTMLElement, string[]>();
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (!el.classList?.contains('terminal-pane')) continue;
        if (!states.has(el)) states.set(el, []);
        states.get(el)!.push(r.oldValue ?? '');
      }
      for (const [el, olds] of states) {
        const seq = [...olds, el.className].map((value) => value.split(/\s+/));
        for (let i = 1; i < seq.length; i++) {
          for (const kind of ['flash', 'steady'] as const) {
            const cls = `bell-${kind}`;
            const on = seq[i].includes(cls);
            if (on !== seq[i - 1].includes(cls)) w.qaBell.cues.push({ pane: el.getAttribute('aria-label'), kind, on });
          }
        }
      }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    const toast = document.querySelector('#toast');
    if (toast) new MutationObserver(() => ipc.toasts.push(toast.textContent)).observe(toast, { childList: true, characterData: true, subtree: true });
  });
}

export class BellPage {
  private constructor(readonly page: Page) {}

  static async open(page: Page, options: BellPageOptions = {}): Promise<BellPage> {
    await exposeSessions(page);
    await page.addInitScript(installStubs, options.audio ?? 'running');
    await page.goto('/');
    await expect(page.locator('#tabs [role="tab"]')).toHaveCount(1);
    return new BellPage(page);
  }

  /** Opens a local tab through the toolbar; it becomes the active tab. Returns its native ID. */
  async openPty(): Promise<string> {
    const before = await this.page.evaluate(() => (window as any).qaBell.ipc.next);
    await this.page.locator('#local-open').click();
    await expect(this.page.locator('#terminal-state')).toContainText('本机 shell 已启动');
    return this.page.evaluate((before) => {
      const { ipc } = (window as any).qaBell;
      const id = `qa-pty-${before + 1}`;
      const sessions = (window as any).__qaSessions as any[];
      ipc.terminals[id] = sessions[sessions.length - 1].terminal;
      ipc.terminals[id].onBell(() => { ipc.raw = (ipc.raw ?? {}); ipc.raw[id] = (ipc.raw[id] ?? 0) + 1; });
      return id;
    }, before);
  }

  /** Delivers output chunks (strings are UTF-8 encoded) to one tab and waits until xterm parsed them. */
  async send(id: string, ...chunks: (string | number[])[]): Promise<void> {
    const data = chunks.map((c) => (typeof c === 'string' ? [...Buffer.from(c, 'utf8')] : c));
    await this.page.evaluate(async ({ id, data }) => {
      const { ipc } = (window as any).qaBell;
      for (const bytes of data) ipc.channels[id].onmessage({ kind: 'data', id, sequence: ++ipc.sequence[id], data: bytes });
      await new Promise<void>((resolve) => ipc.terminals[id].write('', resolve));
    }, { id, data });
  }

  /**
   * Delivers `sample` whole, cut at every offset and one byte per chunk; returns the BEL events
   * xterm.js fired in each run. One page round trip per sample.
   */
  async splits(id: string, sample: string): Promise<{ cuts: string; bells: number }[]> {
    const data = [...Buffer.from(sample, 'utf8')];
    const cutLists: number[][] = [[]];
    for (let cut = 1; cut < data.length; cut++) cutLists.push([cut]);
    cutLists.push(Array.from({ length: data.length - 1 }, (_, i) => i + 1));
    return this.page.evaluate(async ({ id, data, cutLists }) => {
      const { ipc } = (window as any).qaBell;
      const out = [];
      for (const cuts of cutLists) {
        const before = ipc.raw?.[id] ?? 0;
        let at = 0;
        for (const cut of [...cuts, data.length]) {
          ipc.channels[id].onmessage({ kind: 'data', id, sequence: ++ipc.sequence[id], data: data.slice(at, cut) });
          at = cut;
        }
        await new Promise<void>((resolve) => ipc.terminals[id].write('', resolve));
        out.push({ cuts: cuts.length > 1 ? 'bytes' : cuts.join(','), bells: (ipc.raw?.[id] ?? 0) - before });
      }
      return out;
    }, { id, data, cutLists });
  }

  /** The tab's screen text from xterm's buffer (not the renderer). */
  text(id: string): Promise<string> {
    return this.page.evaluate((id) => {
      const buffer = (window as any).qaBell.ipc.terminals[id].buffer.active;
      const rows: string[] = [];
      for (let y = 0; y < buffer.length; y++) rows.push(buffer.getLine(y)?.translateToString(true) ?? '');
      return rows.join('\n');
    }, id);
  }

  /** Output chunks delivered to the tab so far. */
  sequence(id: string): Promise<number> {
    return this.page.evaluate((id) => (window as any).qaBell.ipc.sequence[id], id);
  }

  /** BEL events xterm.js fired for the tab, before any throttling. */
  raw(id: string): Promise<number> {
    return this.page.evaluate((id) => (window as any).qaBell.ipc.raw?.[id] ?? 0, id);
  }

  /** Visual cue class changes on terminal panes, in order. */
  cues(): Promise<Cue[]> {
    return this.page.evaluate(() => (window as any).qaBell.cues);
  }

  /** How many cues of `kind` were started. */
  async started(kind: Cue['kind'] = 'flash'): Promise<number> {
    return (await this.cues()).filter((c) => c.kind === kind && c.on).length;
  }

  audio(): Promise<{ contexts: number; tones: number; resumes: number }> {
    return this.page.evaluate(() => {
      const { contexts, tones, resumes } = (window as any).qaBell.audio;
      return { contexts, tones, resumes };
    });
  }

  async allowAudio(): Promise<void> {
    await this.page.evaluate(() => { (window as any).qaBell.audio.allow = true; });
  }

  toasts(): Promise<string[]> {
    return this.page.evaluate(() => (window as any).qaBell.ipc.toasts.filter((t: string) => t));
  }

  /** Every ACK so far for the tab, in order. */
  acks(id: string): Promise<number[]> {
    return this.page.evaluate((id) => (window as any).qaBell.ipc.acks.filter((a: any) => a.id === id).map((a: any) => a.sequence), id);
  }

  /** Names of tabs and sidebar rows whose status dot carries the bell mark. */
  marks(): Promise<{ tabs: string[]; rows: string[]; notes: string[] }> {
    return this.page.evaluate(() => {
      const names = (selector: string) => [...document.querySelectorAll(selector)]
        .filter((el) => el.querySelector('.status-dot[data-bell="pending"]'))
        .map((el) => el.querySelector('.tab-label, span:not(.bell-note)')!.textContent!);
      return {
        tabs: names('#tabs [role="tab"]'),
        rows: names('#session-list .session-item'),
        notes: [...document.querySelectorAll('.bell-note')].map((el) => el.textContent!),
      };
    });
  }

  async selectTab(name: string): Promise<void> {
    await this.page.locator('#tabs [role="tab"]', { hasText: name }).click();
    await expect(this.page.locator('#tabs [role="tab"][aria-selected="true"]')).toContainText(name);
  }

  /** Opens the bell settings through the command palette, the only entry. */
  async openSettings(): Promise<void> {
    await this.page.locator('#palette-open').click();
    await this.page.locator('#command-search').fill('响铃');
    await this.page.keyboard.press('Enter');
    await expect(this.page.locator('#bell-dialog')).toBeVisible();
  }

  async configure(style: 'off' | 'visual' | 'sound', interval: string): Promise<void> {
    await this.openSettings();
    await this.page.locator('#bell-style').selectOption(style);
    await this.page.locator('#bell-interval').fill(interval);
    await this.page.locator('#bell-apply').click();
    await expect(this.page.locator('#bell-dialog')).toBeHidden();
  }

  async wait(ms: number): Promise<void> {
    await this.page.evaluate((ms) => new Promise((resolve) => setTimeout(resolve, ms)), ms);
  }
}

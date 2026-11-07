import type { IDisposable, IEvent } from "@xterm/xterm";
import { createBellSound, type BellSound, type SoundBlock } from "./bell-sound";

/**
 * Terminal bell (T27). xterm.js parses the bytes and fires `onBell` once per BEL it executes; it
 * does not fire for the BEL that ends an OSC string, nor inside DCS, SOS, PM or APC strings. This
 * module decides what such a bell does: nothing, a visual cue on the pane, or a synthesised tone
 * (see `bell-sound.ts`). Each session has its own throttle: after an accepted bell, the session's
 * further bells are ignored for the configured interval, measured from that accepted bell, and
 * never closer than {@link BELL_MIN_GAP_MS}. An accepted bell of a session other than the active
 * one marks its tab and sidebar row until the workbench reports it as seen.
 *
 * Settings live in memory only and apply to every open and new session at once. Nothing here keeps
 * terminal text, and the handler never throws into xterm's parser.
 */

export type BellStyle = "off" | "visual" | "sound";
export interface BellSettings {
  readonly style: BellStyle;
  /** Bells of the same session within this many seconds after an accepted one are ignored. */
  readonly intervalSeconds: number;
}
export const BELL_STYLES: readonly BellStyle[] = Object.freeze(["off", "visual", "sound"]);
export const BELL_STYLE_LABELS: Readonly<Record<BellStyle, string>> = Object.freeze({
  off: "关闭",
  visual: "视觉提示",
  sound: "声音",
});
/** Upstream ships `terminal.bellInterval: 2`; its unit is assumed to be seconds (unverified). */
export const DEFAULT_BELL_SETTINGS: BellSettings = Object.freeze({ style: "visual", intervalSeconds: 2 });
export const BELL_INTERVAL_MAX_SECONDS = 60;
/** Floor between two accepted bells of one session, also with interval 0: at most 2.5 per second. */
export const BELL_MIN_GAP_MS = 400;
/** How long the pane keeps the flash class; shorter than the floor so every cue can restart it. */
export const BELL_FLASH_MS = 300;
/** With reduced motion: a steady outline, held this long after the session's last accepted bell. */
export const BELL_STEADY_MS = 1000;

/** Validates the settings form; returns the settings or a message for the user. */
export function parseBellSettings(style: string, interval: string): BellSettings | string {
  if (!(BELL_STYLES as readonly string[]).includes(style)) return "请选择响铃样式";
  const text = interval.trim();
  if (!/^\d{1,2}$/.test(text) || Number(text) > BELL_INTERVAL_MAX_SECONDS)
    return `重复间隔须为 0–${BELL_INTERVAL_MAX_SECONDS} 的整数秒`;
  return Object.freeze({ style: style as BellStyle, intervalSeconds: Number(text) });
}

export interface BellHost {
  /** Whether `key` is the session in front; only other sessions get a tab mark. */
  isActive(key: number): boolean;
  /** The mark of `key` turned on or off; repaint that session's tab and row in place. */
  marked(key: number): void;
  /** A short notice; used at most once per reason after each settings change. */
  notify(message: string): void;
}

/** What a bell needs from a session's terminal. */
export interface BellSource {
  readonly onBell: IEvent<void>;
}

export interface TerminalBell {
  readonly settings: BellSettings;
  /** Applies to every open and new session; turning bells off clears the marks. */
  configure(next: BellSettings): void;
  /** Subscribes to one session's bells; its cues go to `pane`. */
  attach(key: number, terminal: BellSource, pane: HTMLElement): void;
  /** Whether the session has an unseen bell. */
  pending(key: number): boolean;
  /** The session is in front; its mark is dropped (the caller repaints). */
  seen(key: number): void;
  /** The session was closed. */
  forget(key: number): void;
  /** One tone now, from a user gesture (settings preview). */
  preview(): void;
}

export interface BellOptions {
  now?: () => number;
  sound?: BellSound;
  reducedMotion?: () => boolean;
}

interface Entry {
  readonly pane: HTMLElement;
  readonly subscription: IDisposable;
  /** Time of the last accepted bell. */
  last: number;
  pending: boolean;
  timer?: number;
}

const BLOCK_NOTICES: Readonly<Record<SoundBlock, string>> = Object.freeze({
  suspended: "响铃声音未播放：WebView 尚未允许播放音频。请先在窗口中点击或按键一次；也可在命令面板「终端响铃设置」改用视觉提示。",
  unsupported: "响铃声音不可用：当前 WebView 不支持 Web Audio。可在命令面板「终端响铃设置」改用视觉提示。",
});

export function createTerminalBell(host: BellHost, options: BellOptions = {}): TerminalBell {
  const now = options.now ?? (() => performance.now());
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const reducedMotion = options.reducedMotion ?? (() => motion.matches);
  const told = new Set<SoundBlock>();
  const sound = options.sound ?? createBellSound((reason) => {
    if (told.has(reason)) return;
    told.add(reason);
    host.notify(BLOCK_NOTICES[reason]);
  });
  const entries = new Map<number, Entry>();
  let settings = DEFAULT_BELL_SETTINGS;

  // A gesture anywhere in the window lets a suspended context start before the next bell.
  const unlock = () => {
    if (settings.style === "sound" && sound.locked) sound.unlock();
  };
  window.addEventListener("pointerdown", unlock, { capture: true, passive: true });
  window.addEventListener("keydown", unlock, { capture: true, passive: true });

  function cue(entry: Entry) {
    const { pane } = entry;
    window.clearTimeout(entry.timer);
    if (reducedMotion()) {
      // No flashing: one steady outline that stays while bells keep coming.
      pane.classList.remove("bell-flash");
      pane.classList.add("bell-steady");
      entry.timer = window.setTimeout(() => pane.classList.remove("bell-steady"), BELL_STEADY_MS);
    } else {
      pane.classList.remove("bell-steady");
      pane.classList.add("bell-flash");
      entry.timer = window.setTimeout(() => pane.classList.remove("bell-flash"), BELL_FLASH_MS);
    }
  }
  function ring(key: number) {
    const entry = entries.get(key);
    if (!entry || settings.style === "off") return;
    const at = now();
    if (at - entry.last < Math.max(settings.intervalSeconds * 1000, BELL_MIN_GAP_MS)) return;
    entry.last = at;
    if (settings.style === "sound") sound.play();
    else if (!entry.pane.hidden) cue(entry);
    if (!entry.pending && !host.isActive(key)) {
      entry.pending = true;
      host.marked(key);
    }
  }
  function clearCue(entry: Entry) {
    window.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.pane.classList.remove("bell-flash", "bell-steady");
  }

  return {
    get settings() {
      return settings;
    },
    configure(next) {
      settings = Object.freeze({ style: next.style, intervalSeconds: next.intervalSeconds });
      told.clear();
      if (settings.style === "sound") sound.unlock();
      if (settings.style !== "off") return;
      for (const [key, entry] of entries) {
        clearCue(entry);
        if (!entry.pending) continue;
        entry.pending = false;
        host.marked(key);
      }
    },
    attach(key, terminal, pane) {
      entries.get(key)?.subscription.dispose();
      const subscription = terminal.onBell(() => {
        try {
          ring(key);
        } catch {
          /* A cue must never break xterm's parser or the output ACK that follows it. */
        }
      });
      entries.set(key, { pane, subscription, last: -Infinity, pending: false });
    },
    pending: (key) => entries.get(key)?.pending ?? false,
    seen(key) {
      const entry = entries.get(key);
      if (entry) entry.pending = false;
    },
    forget(key) {
      const entry = entries.get(key);
      if (!entry) return;
      clearCue(entry);
      entry.subscription.dispose();
      entries.delete(key);
    },
    preview() {
      sound.unlock();
      sound.play();
    },
  };
}

/** Accessible text of a mark; static, never built from session or terminal data. */
const MARK_NOTE = "，有新响铃";

/**
 * Paints or removes the mark on a tab button or sidebar row that holds a `.status-dot`: a ring
 * around the dot plus visually hidden text for screen readers. Uses `textContent` only.
 */
export function paintBellMark(holder: HTMLElement, pending: boolean): void {
  const dot = holder.querySelector<HTMLElement>(".status-dot");
  if (pending) dot?.setAttribute("data-bell", "pending");
  else dot?.removeAttribute("data-bell");
  const note = holder.querySelector<HTMLElement>(":scope > .bell-note");
  if (pending && !note) {
    const text = document.createElement("span");
    text.className = "bell-note";
    text.textContent = MARK_NOTE;
    holder.append(text);
  } else if (!pending) note?.remove();
}

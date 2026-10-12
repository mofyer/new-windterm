import type { IDisposable, Terminal } from "@xterm/xterm";
import {
  EMULATOR_NAME, EMULATOR_VERSION, MIN_CONFORMANCE_LEVEL, terminalProfile,
  type TerminalProfile, type TerminalType,
} from "./vt-profiles";
import {
  DEFAULT_SGR, applySgr, normalizeParams, reportSgr, restoreSgr, saveSgr,
  type CsiParams, type SavedSgr, type SgrState,
} from "./sgr-state";
import { classifyOsc52, decodeOsc52 } from "./osc52-clipboard";

/**
 * Production VT adapters for xterm.js 6.0.0, attached to every workspace
 * terminal by terminal.ts. They only use the public parser hooks and send
 * replies with `Terminal.input(data, false)`, so replies travel through
 * `onData` into the same PTY/SSH/Telnet input path as keystrokes.
 *
 * - DA1/DA2/DA3/XTVERSION follow the selected terminal type; DECSCL changes
 *   the level reported by DECRQSS `"p`. Replies are always 7-bit (no S8C1T).
 * - DECRQSS answers SGR and DECSCUSR from shadow state; CPR/DECXCPR report the
 *   row relative to the top margin while DECOM is set.
 * - OSC 52: reads are always denied; writes are swallowed unless this session
 *   opted in. Clipboard text is never logged or passed to notices.
 *
 * Shadow state follows the sequences parsed by this terminal. Calling the
 * public `terminal.reset()` directly bypasses the parser; call `vt.reset()` too.
 */

export type VtNotice =
  | { readonly kind: "clipboard-written"; readonly bytes: number }
  | { readonly kind: "clipboard-blocked" }
  | { readonly kind: "clipboard-read-denied" }
  | { readonly kind: "clipboard-rejected"; readonly reason: "too-large" | "invalid" }
  | { readonly kind: "clipboard-failed" };

export interface VtAdapterOptions {
  /** Defaults to xterm-256color; unknown values fall back to the default. */
  readonly terminalType?: TerminalType;
  /** OSC 52 clipboard writes for this session; off unless explicitly true. */
  readonly clipboardWrite?: boolean;
  /** Clipboard sink; defaults to navigator.clipboard.writeText. */
  readonly writeClipboard?: (text: string) => Promise<void>;
  /** Visible-notice hook (toast/indicator). Notices never contain clipboard text. */
  readonly onNotice?: (notice: VtNotice) => void;
}

export interface VtAdapters extends IDisposable {
  readonly terminalType: TerminalType;
  readonly clipboardWrite: boolean;
  setTerminalType(type: TerminalType): void;
  setClipboardWrite(enabled: boolean): void;
  /** Resync shadow state after an out-of-band `terminal.reset()`. */
  reset(): void;
}

type BufferKind = "normal" | "alternate";
interface Margins { readonly top: number; readonly bottom: number }
type CursorStyle = "block" | "underline" | "bar";
interface CursorShadow { readonly style?: CursorStyle; readonly blink?: boolean }
interface ClipboardWrite { readonly text: string; readonly bytes: number }

const CSI = "\x1b[";
const DCS = "\x1bP";
const ST = "\x1b\\";
const CURSOR_CODES: Readonly<Record<CursorStyle, number>> = { block: 2, underline: 4, bar: 6 };
const DECSCUSR_STYLES: readonly (CursorStyle | undefined)[] = [undefined, "block", "block", "underline", "underline", "bar", "bar"];
/** Notices that would repeat on every sequence are shown once per opt-in state. */
const ONCE: ReadonlySet<VtNotice["kind"]> = new Set(["clipboard-blocked", "clipboard-read-denied", "clipboard-rejected"]);

/** First parameter (xterm always supplies at least one, defaulting to 0). */
const first = (params: CsiParams): number => (typeof params[0] === "number" ? params[0] : 0);
const defaultClipboard = (text: string): Promise<void> =>
  navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error("clipboard unavailable"));

export function attachVtAdapters(terminal: Terminal, options: VtAdapterOptions = {}): VtAdapters {
  let profile: TerminalProfile = terminalProfile(options.terminalType);
  let level = profile.level;
  let clipboardWrite = options.clipboardWrite === true;
  let disposed = false;
  let noticed = new Set<VtNotice["kind"]>();
  let sgr: SgrState = DEFAULT_SGR;
  let saved: Record<BufferKind, SavedSgr> = { normal: saveSgr(DEFAULT_SGR), alternate: saveSgr(DEFAULT_SGR) };
  let margins: Record<BufferKind, Margins | null> = { normal: null, alternate: null };
  let cursor: CursorShadow = {};
  // At most one clipboard write in flight and one waiting (the latest wins).
  let clipboardBusy = false;
  let clipboardNext: ClipboardWrite | null = null;
  const writeClipboard = options.writeClipboard ?? defaultClipboard;

  const reply = (data: string) => terminal.input(data, false);
  const active = (): BufferKind => (terminal.buffer.active.type === "alternate" ? "alternate" : "normal");
  const notify = (notice: VtNotice) => {
    if (disposed || (ONCE.has(notice.kind) && noticed.has(notice.kind))) return;
    noticed = new Set(noticed).add(notice.kind);
    options.onNotice?.(notice);
  };
  const resetAll = () => {
    level = profile.level;
    sgr = DEFAULT_SGR;
    saved = { normal: saveSgr(DEFAULT_SGR), alternate: saveSgr(DEFAULT_SGR) };
    margins = { normal: null, alternate: null };
    cursor = {};
  };
  // DECSTR: xterm.js resets SGR, the active buffer's margins and DECSC data, and DECSCUSR.
  const softReset = () => {
    const kind = active();
    sgr = DEFAULT_SGR;
    saved = { ...saved, [kind]: saveSgr(DEFAULT_SGR) };
    margins = { ...margins, [kind]: null };
    cursor = {};
    return false;
  };
  const save = (kind: BufferKind) => { saved = { ...saved, [kind]: saveSgr(sgr) }; return false; };
  const restore = (kind: BufferKind) => { sgr = restoreSgr(sgr, saved[kind]); return false; };

  // Mirrors xterm.js DECSET/DECRST side effects that touch the shadow, in parameter order.
  const privateModes = (params: CsiParams, set: boolean) => {
    let kind = active();
    for (const { value } of normalizeParams(params)) {
      if (value === 3 && terminal.options.windowOptions?.setWinLines) {
        resetAll(); // DECCOLM resizes and then fully resets the terminal
        kind = "normal";
      } else if (value === 1048) {
        if (set) save(kind); else restore(kind);
      } else if (value === 1049 || value === 47 || value === 1047) {
        if (set) {
          if (value === 1049) save(kind);
          kind = "alternate";
        } else {
          if (kind === "alternate") margins = { ...margins, alternate: null }; // leaving clears the alternate buffer
          kind = "normal";
          if (value === 1049) restore("normal");
        }
      }
    }
    return false;
  };

  const scrollRegion = (params: CsiParams) => {
    const list = normalizeParams(params);
    const rows = terminal.rows;
    const top = list[0]?.value || 1;
    let bottom = list.length < 2 ? rows : list[1].value;
    if (bottom > rows || bottom === 0) bottom = rows;
    if (bottom > top) margins = { ...margins, [active()]: { top: top - 1, bottom: bottom - 1 } };
    return false;
  };

  const cursorStyle = (params: CsiParams) => {
    const param = first(params);
    if (param === 0) cursor = {};
    else cursor = { style: DECSCUSR_STYLES[param] ?? cursor.style, blink: param % 2 === 1 };
    return false;
  };

  // CPR/DECXCPR: only answered here while DECOM is set; otherwise xterm.js replies itself.
  const cursorReport = (prefix: string) => (params: CsiParams) => {
    if (first(params) !== 6 || !terminal.modes.originMode) return false;
    const buffer = terminal.buffer.active;
    const top = margins[active()]?.top ?? 0;
    reply(`${CSI}${prefix}${Math.max(1, buffer.cursorY - top + 1)};${buffer.cursorX + 1}R`);
    return true;
  };

  const statusString = (data: string) => {
    if (data === "m") {
      reply(`${DCS}1$r${reportSgr(sgr)}m${ST}`);
      return true;
    }
    if (data === "\"p") {
      reply(`${DCS}1$r${level};1"p${ST}`);
      return true;
    }
    if (data === " q" && cursor.blink !== undefined) {
      const style = cursor.style ?? terminal.options.cursorStyle ?? "block";
      reply(`${DCS}1$r${CURSOR_CODES[style] - (cursor.blink ? 1 : 0)} q${ST}`);
      return true;
    }
    return false; // DECSTBM, DECSCA, unset DECSCUSR and unknown requests keep xterm's answers
  };

  const flushClipboard = () => {
    const next = clipboardNext;
    if (!next || clipboardBusy || disposed) return;
    clipboardNext = null;
    clipboardBusy = true;
    Promise.resolve()
      // Re-check: the opt-in may have been withdrawn (or the session closed) since parsing.
      .then(() => (clipboardWrite && !disposed ? Promise.resolve(writeClipboard(next.text)).then(() => true) : false))
      .then(written => { if (written) notify({ kind: "clipboard-written", bytes: next.bytes }); }, () => notify({ kind: "clipboard-failed" }))
      .finally(() => {
        clipboardBusy = false;
        flushClipboard();
      });
  };

  const clipboard = (data: string) => {
    const request = classifyOsc52(data);
    if (request.kind === "query") notify({ kind: "clipboard-read-denied" });
    else if (!clipboardWrite) notify({ kind: "clipboard-blocked" }); // nothing else is inspected without the opt-in
    else if (request.kind === "invalid") notify({ kind: "clipboard-rejected", reason: "invalid" });
    else {
      const decoded = decodeOsc52(request.payload);
      if (decoded.kind === "rejected") notify({ kind: "clipboard-rejected", reason: decoded.reason });
      else {
        clipboardNext = { text: decoded.text, bytes: decoded.bytes };
        flushClipboard();
      }
    }
    return true; // always swallowed: never echoed and never answered
  };

  // Identity requests answer only Ps = 0 (or omitted); anything else is swallowed
  // so xterm.js's fixed built-in identity can never leak through.
  const identity = (body: () => string | null) => (params: CsiParams) => {
    const text = first(params) === 0 ? body() : null;
    if (text !== null) reply(text);
    return true;
  };
  const primary = identity(() => `${CSI}${profile.primary}`);
  const secondary = identity(() => (profile.secondary === null ? null : `${CSI}${profile.secondary}`));
  const tertiary = identity(() => (profile.tertiary ? `${DCS}!|00000000${ST}` : null));
  const version = identity(() => (profile.xtversion ? `${DCS}>|${EMULATOR_NAME}(${EMULATOR_VERSION})${ST}` : null));
  const conformance = (params: CsiParams) => {
    const requested = first(params);
    if (requested >= MIN_CONFORMANCE_LEVEL && requested <= profile.level) level = requested;
    return true; // no soft reset and no 8-bit controls: only the reported level changes
  };

  const parser = terminal.parser;
  const handlers: IDisposable[] = [
    // Identity and conformance level.
    parser.registerCsiHandler({ final: "c" }, primary),
    parser.registerCsiHandler({ prefix: ">", final: "c" }, secondary),
    parser.registerCsiHandler({ prefix: "=", final: "c" }, tertiary),
    parser.registerCsiHandler({ prefix: ">", final: "q" }, version),
    parser.registerCsiHandler({ intermediates: "\"", final: "p" }, conformance),
    parser.registerDcsHandler({ intermediates: "$", final: "q" }, statusString),
    // Reports derived from shadow state.
    parser.registerCsiHandler({ final: "n" }, cursorReport("")),
    parser.registerCsiHandler({ prefix: "?", final: "n" }, cursorReport("?")),
    // Shadow-state trackers: observe, then let xterm.js run its own handler (return false).
    parser.registerCsiHandler({ final: "m" }, params => { sgr = applySgr(sgr, params); return false; }),
    parser.registerCsiHandler({ final: "r" }, scrollRegion),
    parser.registerCsiHandler({ intermediates: " ", final: "q" }, cursorStyle),
    parser.registerCsiHandler({ intermediates: "!", final: "p" }, softReset),
    parser.registerCsiHandler({ final: "s" }, () => save(active())),
    parser.registerCsiHandler({ final: "u" }, () => restore(active())),
    parser.registerCsiHandler({ prefix: "?", final: "h" }, params => privateModes(params, true)),
    parser.registerCsiHandler({ prefix: "?", final: "l" }, params => privateModes(params, false)),
    parser.registerEscHandler({ final: "7" }, () => save(active())),
    parser.registerEscHandler({ final: "8" }, () => restore(active())),
    parser.registerEscHandler({ final: "c" }, () => { resetAll(); return false; }),
    parser.registerOscHandler(52, clipboard),
    // Any resize resets both buffers' margins in xterm.js.
    terminal.onResize(() => { margins = { normal: null, alternate: null }; }),
  ];

  return {
    get terminalType() { return profile.type; },
    get clipboardWrite() { return clipboardWrite; },
    setTerminalType(type: TerminalType) {
      profile = terminalProfile(type);
      level = profile.level;
    },
    setClipboardWrite(enabled: boolean) {
      clipboardWrite = enabled === true;
      if (!clipboardWrite) clipboardNext = null; // a queued write never outlives the opt-in
      noticed = new Set();
    },
    reset: resetAll,
    dispose() {
      if (disposed) return;
      disposed = true;
      clipboardNext = null;
      for (const handler of handlers) handler.dispose();
    },
  };
}

import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * Per-session keyboard and initial-mode options (T31 part 1; scope, upstream evidence and the
 * reasons for every choice are in docs/p1/KEYBOARD_MODES_PLAN.zh-CN.md).
 *
 * The defaults are exactly the behaviour before this option existed, and a default session takes
 * none of the code paths below: no option is set, no listener is added and nothing is written.
 * xterm.js stays the only keyboard and mode state. It still decides whether a key sends anything
 * (IME composition, dead keys, AltGr / third-level shift, screen reader handling); a remap only
 * replaces the bytes of a Backspace or Delete that xterm.js has already decided to send. An initial
 * mode is a fixed sequence parsed by the session's own local xterm before any host output; it is
 * never sent to the host, and every later mode change from the host takes effect as usual.
 */
export type BackspaceSends = "del" | "bs";
export type DeleteSends = "vt220" | "del" | "bs";
export type CursorKeysMode = "normal" | "application";

export type KeyboardOptions = Readonly<{
  /** Backspace: DEL (0x7F, xterm.js default) or BS (Ctrl+H, 0x08); Ctrl+Backspace sends the other. */
  backspace: BackspaceSends;
  /** Unmodified Delete: `ESC [ 3 ~` (xterm.js default), DEL or BS. Modified Delete is unchanged. */
  delete: DeleteSends;
  /** macOS only: Option sends ESC + key, through xterm.js `macOptionIsMeta`. */
  optionAsMeta: boolean;
  /** DECCKM when the session starts; the host may switch it at any time. */
  cursorKeys: CursorKeysMode;
}>;

export const DEFAULT_KEYBOARD: KeyboardOptions = Object.freeze({
  backspace: "del", delete: "vt220", optionAsMeta: false, cursorKeys: "normal",
});

const BACKSPACE: readonly BackspaceSends[] = ["del", "bs"];
const DELETE: readonly DeleteSends[] = ["vt220", "del", "bs"];
const CURSOR_KEYS: readonly CursorKeysMode[] = ["normal", "application"];

const pick = <T extends string>(allowed: readonly T[], value: unknown, fallback: T): T =>
  allowed.includes(value as T) ? (value as T) : fallback;

/** A frozen copy with every field checked; anything unexpected keeps the default, never a guess. */
export function snapshotKeyboard(options?: Partial<KeyboardOptions> | null): KeyboardOptions {
  return Object.freeze({
    backspace: pick(BACKSPACE, options?.backspace, DEFAULT_KEYBOARD.backspace),
    delete: pick(DELETE, options?.delete, DEFAULT_KEYBOARD.delete),
    optionAsMeta: options?.optionAsMeta === true,
    cursorKeys: pick(CURSOR_KEYS, options?.cursorKeys, DEFAULT_KEYBOARD.cursorKeys),
  });
}

/** How many options differ from the default. */
export function changedKeyboardOptions(options: KeyboardOptions): number {
  return (Object.keys(DEFAULT_KEYBOARD) as (keyof KeyboardOptions)[])
    .filter((name) => options[name] !== DEFAULT_KEYBOARD[name]).length;
}

/**
 * The local sequence that puts a fresh xterm into the session's initial modes: empty for the
 * defaults. Also appended to the user's own hard reset (terminal-actions.ts), so it ends in the
 * same state as a new session; a host RIS or DECSTR is parsed unchanged.
 */
export function initialModeSequence(options?: KeyboardOptions): string {
  return options?.cursorKeys === "application" ? "\x1b[?1h" : "";
}

const C0_BS = "\b";
const DEL = "\x7f";
/** What xterm.js 6.0.0 sends for Backspace: DEL, BS with Ctrl, and an ESC prefix with Alt. */
const XTERM_BACKSPACE = /^\x1b?[\b\x7f]$/;
const XTERM_DELETE = "\x1b[3~";

/**
 * The bytes to send instead of `key`, the sequence xterm.js chose for the keydown `event`, or
 * undefined to send `key` unchanged. Pure, so the mapping can be checked on its own.
 */
export function remapKey(event: Pick<KeyboardEvent, "type" | "keyCode">, key: string, options: KeyboardOptions): string | undefined {
  if (event.type !== "keydown") return undefined;
  // xterm.js reads Backspace and Delete by keyCode (8 and 46) as well.
  if (event.keyCode === 8 && options.backspace === "bs" && XTERM_BACKSPACE.test(key))
    return key.slice(0, -1) + (key.endsWith(DEL) ? C0_BS : DEL);
  // A single byte cannot carry modifiers: Shift/Ctrl/Alt/Meta+Delete keep xterm.js's CSI 3 ; n ~.
  if (event.keyCode === 46 && options.delete !== "vt220" && key === XTERM_DELETE)
    return options.delete === "del" ? DEL : C0_BS;
  return undefined;
}

export interface SessionKeyboard extends IDisposable {
  readonly options: KeyboardOptions;
  /**
   * For the session's `onData` handler: the bytes to send for `data`. Returns `data` itself unless
   * it is the sequence of the remapped key xterm.js has just reported through `onKey`.
   */
  rewrite(data: string): string;
}

/**
 * Applies `options` to a new session's terminal, before any host output reaches it. Must be
 * called once, right after the terminal is created.
 */
export function attachKeyboard(terminal: Terminal, options: KeyboardOptions): SessionKeyboard {
  if (options.optionAsMeta) terminal.options.macOptionIsMeta = true;
  const modes = initialModeSequence(options);
  // Queued ahead of the first host chunk, which can only arrive after the native open returns.
  if (modes) terminal.write(modes);
  if (options.backspace === DEFAULT_KEYBOARD.backspace && options.delete === DEFAULT_KEYBOARD.delete)
    return { options, rewrite: (data) => data, dispose: () => {} };
  let pending: { from: string; to: string } | undefined;
  // xterm.js fires onKey and then, synchronously, onData with the same key; nothing else runs in
  // between. The microtask drops a remap whose data never came (for example, stdin disabled).
  const subscription = terminal.onKey(({ key, domEvent }) => {
    const to = remapKey(domEvent, key, options);
    const remap = to === undefined ? undefined : { from: key, to };
    pending = remap;
    if (remap) queueMicrotask(() => { if (pending === remap) pending = undefined; });
  });
  return {
    options,
    rewrite(data) {
      const remap = pending;
      pending = undefined;
      return remap && remap.from === data ? remap.to : data;
    },
    dispose: () => subscription.dispose(),
  };
}

import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * Pasted text is data, not keystrokes. Like XTerm's default `allowPasteControls: false`, keep only
 * the formatting controls HT, LF and CR, and drop every other C0 control, DEL and every C1 control.
 * Without ESC (or the 8-bit CSI U+009B) a paste can never contain `ESC [ 201 ~`, so it cannot end
 * bracketed paste early and have the rest run as typed commands.
 */
const PASTE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export interface SanitizedPaste {
  text: string;
  removed: number;
}

export function sanitizePaste(text: string): SanitizedPaste {
  let removed = 0;
  const clean = text.replace(PASTE_CONTROLS, () => {
    removed++;
    return "";
  });
  return { text: clean, removed };
}

/**
 * Routes every clipboard paste, and every text drag-and-drop, into `host` through
 * {@link sanitizePaste} and then `terminal.paste()`. xterm 6.0.0 itself only rewrites line endings
 * (CR LF / LF to CR) and adds the bracketed-paste markers; it forwards ESC and other controls
 * unchanged. A drop is treated as a paste, so dropped text never lands unsanitised in xterm's
 * hidden textarea.
 */
export function attachPasteGuard(host: HTMLElement, terminal: Terminal, onRemoved: (removed: number) => void): () => void {
  const deliver = (event: Event, data: DataTransfer | null) => {
    // Capture phase on an ancestor: xterm's textarea and element listeners never see the event,
    // and the browser does not copy a possibly huge text into the hidden textarea.
    event.preventDefault();
    event.stopPropagation();
    const { text, removed } = sanitizePaste(data?.getData("text/plain") ?? "");
    if (removed) onRemoved(removed);
    if (text) terminal.paste(text);
  };
  const paste = (event: ClipboardEvent) => deliver(event, event.clipboardData);
  const dragover = (event: DragEvent) => {
    // Accept text anywhere over the terminal, not only over the 1-pixel textarea.
    if (event.dataTransfer?.types.includes("text/plain")) event.preventDefault();
  };
  const drop = (event: DragEvent) => deliver(event, event.dataTransfer);
  const listeners: [string, EventListener][] = [
    ["paste", paste as EventListener],
    ["dragover", dragover as EventListener],
    ["drop", drop as EventListener],
  ];
  for (const [type, listener] of listeners) host.addEventListener(type, listener, true);
  return () => {
    for (const [type, listener] of listeners) host.removeEventListener(type, listener, true);
  };
}

/**
 * xterm 6.0.0 ignores `insertText` input events while `screenReaderMode` is on, so text that
 * arrives without a key press (the macOS emoji and symbol viewer, dictation, automation such as
 * CDP `Input.insertText`) never reached the shell. Forward exactly the events xterm forwards when
 * screen reader mode is off: `insertText` with data, outside a composition, and not produced by a
 * key that xterm already sent from keydown or keypress.
 */
export function attachInsertTextBridge(terminal: Terminal): () => void {
  const textarea = terminal.textarea;
  if (!textarea) return () => {};
  let keyDownSeen = false;
  const keydown = () => {
    keyDownSeen = true;
  };
  const reset = () => {
    keyDownSeen = false;
  };
  const input = (event: Event) => {
    const e = event as InputEvent;
    if (!terminal.options.screenReaderMode) return; // xterm handles these itself
    if (e.inputType !== "insertText" || !e.data || e.isComposing) return;
    // Mirrors xterm's `!ev.composed || !_keyDownSeen`; user-agent input events are always composed.
    if (e.composed && keyDownSeen) return;
    terminal.input(e.data, true);
  };
  const listeners: [string, EventListener][] = [
    ["keydown", keydown],
    ["keyup", reset],
    // A key released while focus was elsewhere (a picker window) must not suppress later input.
    ["blur", reset],
    ["input", input],
  ];
  for (const [type, listener] of listeners) textarea.addEventListener(type, listener, true);
  return () => {
    for (const [type, listener] of listeners) textarea.removeEventListener(type, listener, true);
  };
}

const FUNCTION_KEY = /^F([1-9]|1[0-9]|2[0-4])$/;

/**
 * With `screenReaderMode` xterm 6.0.0 sends some keys' sequences but leaves the keydown
 * uncancelled, so the host still runs its default action:
 * - Shift+Tab (`ESC [ Z`) also moves focus out of the terminal, and every later key is lost;
 * - F5 reloads the page in Chrome and WebView2 (closing every session), F7 offers caret browsing,
 *   F3 opens find.
 * These keys put no text in the textarea for a screen reader, so once xterm has sent them the
 * default action is suppressed.
 */
export function attachKeyDefaultGuard(terminal: Terminal): IDisposable {
  return terminal.onKey(({ domEvent }) => {
    if (domEvent.type === "keydown" && (domEvent.key === "Tab" || FUNCTION_KEY.test(domEvent.key)))
      domEvent.preventDefault();
  });
}

/**
 * xterm 6.0.0 maps Ctrl with letters, Space, 2-8, `[ \ ]` and `_`, but sends nothing for Ctrl+/
 * (readline and Emacs undo). Like XTerm, send US (0x1F). For use inside the terminal's custom key
 * handler: returns true when it sent the byte, and xterm must then skip it.
 */
export function sendUnmappedControl(terminal: Terminal, event: KeyboardEvent): boolean {
  if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return false;
  if (event.key !== "/") return false;
  event.preventDefault();
  terminal.input("\x1f", true);
  return true;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Removes the last user-perceived character: a whole ZWJ sequence, flag, skin tone or base + marks. */
export function dropLastGrapheme(text: string): string {
  let start = 0;
  for (const { index } of graphemes.segment(text)) start = index;
  return text.slice(0, start);
}

/** The longest prefix of `text` with at most `limit` UTF-16 units that ends on a grapheme boundary. */
export function clipToGraphemes(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > limit) break;
    end = index + segment.length;
  }
  return text.slice(0, end);
}

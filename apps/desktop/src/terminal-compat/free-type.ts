/**
 * Isolated P0 experiment for G03 (Free Type input mode). Not wired into
 * production terminals.
 *
 * While active, keystrokes, pastes and IME composition go to a local draft (a
 * textarea overlaid at the terminal cursor) instead of the shell. Enter sends
 * the whole draft once; Shift+Enter inserts a newline; Escape discards it.
 * Nothing reaches the PTY until the user submits.
 */
import type { IDisposable, Terminal } from "@xterm/xterm";

export interface FreeTypeOptions {
  /** Receives the submitted draft; the caller writes it to the PTY. */
  submit(text: string): void;
  /** Draft size bound, mirroring the 64 KiB PTY input queue. */
  maxLength?: number;
}

export class FreeTypeDraft {
  readonly editor: HTMLTextAreaElement;
  private readonly subscriptions: IDisposable[] = [];
  private active = false;

  constructor(private readonly terminal: Terminal, private readonly host: HTMLElement, private readonly options: FreeTypeOptions) {
    const editor = document.createElement("textarea");
    editor.className = "free-type-draft";
    editor.setAttribute("aria-label", "Free Type 草稿");
    editor.spellcheck = false;
    editor.maxLength = options.maxLength ?? 64 * 1024;
    editor.hidden = true;
    Object.assign(editor.style, { position: "absolute", resize: "none", margin: "0", border: "0", padding: "0", outline: "1px solid currentColor", background: "inherit", color: "inherit", font: "inherit", lineHeight: "inherit", zIndex: "10", overflow: "hidden" });
    editor.addEventListener("keydown", event => this.key(event));
    editor.addEventListener("input", () => this.place());
    host.style.position ||= "relative";
    host.append(editor);
    this.editor = editor;
    this.subscriptions.push(terminal.onResize(() => this.place()), terminal.onCursorMove(() => this.place()));
  }

  isActive(): boolean {
    return this.active;
  }

  /** Starts drafting at the terminal cursor; optional initial text. */
  start(text = ""): void {
    this.active = true;
    this.editor.hidden = false;
    this.editor.value = text;
    this.place();
    this.editor.focus();
    this.editor.setSelectionRange(text.length, text.length);
  }

  cancel(): void {
    this.stop();
  }

  private stop(): void {
    this.active = false;
    this.editor.value = "";
    this.editor.hidden = true;
    this.terminal.focus();
  }

  private key(event: KeyboardEvent): void {
    if (event.isComposing) return; // IME owns Enter/Escape while composing
    if (event.key === "Escape") {
      event.preventDefault();
      this.cancel();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const text = this.editor.value;
      this.stop();
      // Shells read CR as Enter; embedded newlines are sent as CR too, one
      // command per line, exactly as typed. Nothing was sent before this.
      this.options.submit(text.replace(/\r?\n/g, "\r") + "\r");
    }
  }

  /** Overlays the editor from the cursor cell to the end of the row. */
  private place(): void {
    if (!this.active) return;
    const screen = this.host.querySelector<HTMLElement>(".xterm-screen");
    if (!screen) return;
    const cellWidth = screen.clientWidth / this.terminal.cols;
    const cellHeight = screen.clientHeight / this.terminal.rows;
    const buffer = this.terminal.buffer.active;
    const lines = Math.max(1, this.editor.value.split("\n").length);
    const top = Math.min(buffer.cursorY, this.terminal.rows - lines);
    Object.assign(this.editor.style, {
      left: `${screen.offsetLeft + buffer.cursorX * cellWidth}px`,
      top: `${screen.offsetTop + Math.max(0, top) * cellHeight}px`,
      width: `${(this.terminal.cols - buffer.cursorX) * cellWidth}px`,
      height: `${lines * cellHeight}px`,
    });
  }

  dispose(): void {
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.editor.remove();
  }
}

import type { Terminal } from "@xterm/xterm";
import { clipToGraphemes, dropLastGrapheme } from "./terminal-input";
import { runTerminalAction } from "./terminal-actions";

/**
 * The part of a session the browser demo reads and updates. The demo never runs a command and
 * keeps no copy of the screen: xterm.js stays the only terminal state, `line` is just the text
 * being edited after the prompt.
 */
export interface DemoState {
  readonly key: number;
  readonly terminal: Terminal;
  readonly disposed: boolean;
  line: string;
  /** Bumped to stop a running output sample. */
  outputRun: number;
  status: string;
  bytes: number;
}

/** What the demo asks of the workbench; it never touches workbench DOM itself. */
export interface DemoView {
  /** Refresh the status bar now. */
  status(): void;
  /** Output for session `key` was parsed; a throttled refresh suffices while it is visible. */
  progress(key: number): void;
}

const encoder = new TextEncoder();

/** The banner and first prompt of a new demo session. */
export function demoWelcome(s: DemoState) {
  s.terminal.write(
    "\r\n  \x1b[1mNew WindTerm\x1b[0m\r\n\r\n  Terminal workspace  /  P0 preview\r\n\r\n  \x1b[34mP0 交互原型\x1b[0m\r\n  这是本地演示，不会连接远端或执行系统命令。\r\n  输入 \x1b[32mhelp\x1b[0m 查看命令，或从上方运行字符与输出样本。\r\n",
  );
  prompt(s);
}
function prompt(s: DemoState, newline = true) {
  s.terminal.write(`${newline ? "\r\n" : ""}\x1b[32mdemo\x1b[0m \x1b[34m~/workspace\x1b[0m % `);
}
export function sample(s: DemoState) {
  s.outputRun++;
  s.terminal.write("\r\n\x1b[1m字符 / 列宽 / ANSI 样本\x1b[0m\r\n");
  const bytes = encoder.encode(
    "中文输入 · 日本語 · café · e\u0301 · 👋 🌏\r\n",
  );
  for (let i = 0; i < bytes.length; i += 3)
    s.terminal.write(bytes.slice(i, i + 3));
  s.terminal.write(
    "\x1b[31m■ red  \x1b[32m■ green  \x1b[34m■ blue  \x1b[38;2;145;90;190m■ true color\x1b[0m\r\n┌───────────────┐\r\n│  Terminal P0  │\r\n└───────────────┘",
  );
  prompt(s);
}
export function stress(s: DemoState, view: DemoView) {
  const run = ++s.outputRun;
  let n = 0;
  const start = performance.now();
  s.status = "持续输出中 · Ctrl-C 可停止";
  const step = () => {
    if (s.disposed || s.outputRun !== run) return;
    const block = Array.from(
      { length: 80 },
      () =>
        `${String(++n).padStart(6, "0")}  P0 bounded write · 中文 / UTF-8 / \x1b[32mOK\x1b[0m\r\n`,
    ).join("");
    const bytes = encoder.encode(block);
    s.bytes += bytes.length;
    s.terminal.write(bytes, () => {
      view.progress(s.key);
      if (n < 20000 && s.outputRun === run) window.setTimeout(step, 8);
      else if (s.outputRun === run) {
        s.status = `20,000 行样本结束 · ${(performance.now() - start).toFixed(0)} ms（非性能验收）`;
        view.status();
        prompt(s);
      }
    });
  };
  s.terminal.write("\r\n");
  step();
}
/** Demo line length bound, in UTF-16 code units (cut back to a whole grapheme). */
const DEMO_LINE_LIMIT = 4096;
/** The demo echoes like a line editor: a paste may hold several lines; escape sequences are not emulated. */
export function demoInput(s: DemoState, data: string, view: DemoView) {
  if (data.startsWith("\x1b")) return;
  for (const [token] of data.matchAll(/[\x00-\x1f\x7f]|[^\x00-\x1f\x7f]+/g)) demoToken(s, token, view);
}
/** Redraws the prompt row(s) after an erase; wide characters can make the line wrap early. */
function demoRedraw(s: DemoState) {
  const buffer = s.terminal.buffer.active;
  let up = 0;
  while (up < buffer.cursorY && buffer.getLine(buffer.baseY + buffer.cursorY - up)?.isWrapped) up++;
  s.terminal.write(
    `${up ? `\x1b[${up}A` : ""}\r\x1b[J\x1b[32mdemo\x1b[0m \x1b[34m~/workspace\x1b[0m % ${s.line}`,
  );
}
function demoToken(s: DemoState, data: string, view: DemoView) {
  if (data === "\x03") {
    s.outputRun++;
    s.line = "";
    s.status = "演示就绪";
    s.terminal.write("^C");
    prompt(s);
    view.status();
    return;
  }
  if (data === "\r") {
    const command = s.line.trim();
    s.line = "";
    if (command === "clear") {
      // Like a shell's `clear`: the same local write as 全部清除 (T32), then a prompt at the top.
      // The xterm write queue keeps the order; the result (it never rejects) is not needed here.
      void runTerminalAction(s, "clear-all");
      prompt(s, false);
      return;
    } else if (command === "help")
      s.terminal.write(
        "\r\n演示命令: help · clear · pwd · ls · sample · stress\r\n此会话不执行真实命令。使用「本地终端」启动本机 shell。",
      );
    else if (command === "pwd") s.terminal.write("\r\n/home/demo/workspace");
    else if (command === "ls")
      s.terminal.write(
        "\r\n\x1b[34mdocuments/  projects/\x1b[0m  README.md  部署说明.txt",
      );
    else if (command === "sample") {
      sample(s);
      return;
    } else if (command === "stress") {
      stress(s, view);
      return;
    } else if (command)
      s.terminal.write("\r\n演示模式：输入 help 查看支持的演示命令。");
    prompt(s);
    return;
  }
  if (data === "\x7f") {
    if (s.line) {
      // One Backspace removes one visible character, not one code point of it.
      s.line = dropLastGrapheme(s.line);
      demoRedraw(s);
    }
    return;
  }
  if (!/[\x00-\x1f\x7f]/.test(data)) {
    const input = clipToGraphemes(data, Math.max(0, DEMO_LINE_LIMIT - s.line.length));
    s.line += input;
    s.terminal.write(input);
  }
}

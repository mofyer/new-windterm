import type { Terminal, ITheme } from "@xterm/xterm";
import { createWorkspaceSession, describeVtNotice } from "./terminal";
import type { VtAdapters } from "./terminal-compat/vt-adapters";
import { authPromptsFor, createSshVerification, type SshTerminalRequest } from "./ssh-verification";
import { createSftpPanel } from "./sftp-panel";
import { createNetTerminalDialog, netLabel, type NetTerminalRequest } from "./net-terminal";
import { createPortForwardSheet } from "./port-forward";
import { responsivenessDiagnostics as diagnostics } from "./responsiveness";
import { INPUT_BACKLOG_BYTES, InputQueue } from "./input-queue";
import { Utf8Boundary } from "./utf8-boundary";
import {
  attachInsertTextBridge, attachKeyDefaultGuard, attachPasteGuard, clipToGraphemes, dropLastGrapheme,
  sendUnmappedControl,
} from "./terminal-input";
import { FitAddon } from "@xterm/addon-fit";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

type PtyEvent =
  | { kind: "data"; id: string; sequence: number; data: number[] }
  | { kind: "exit"; id: string; code: number | null }
  | { kind: "error"; id: string; message: string };
type Mode = "demo" | "pty" | "ssh" | "net";
type Session = {
  key: number;
  name: string;
  mode: Mode;
  /** Telnet or Raw TCP, for "net" sessions. */
  netKind?: string;
  terminal: Terminal;
  /** VT adapters: terminal type, OSC 52 opt-in (off by default). */
  vt: VtAdapters;
  fit: FitAddon;
  element: HTMLElement;
  observer: ResizeObserver;
  ptyId?: string;
  operationId?: string;
  closing: boolean;
  line: string;
  disposed: boolean;
  outputRun: number;
  status: string;
  ended: boolean;
  bytes: number;
  // Input produced before the native ID exists, e.g. xterm's automatic reply
  // to ConPTY's startup cursor-position query. Flushed in order once opened.
  early: Uint8Array[];
  earlyBytes: number;
  ack: Promise<unknown>;
  input: InputQueue;
};
const EARLY_INPUT_LIMIT = 4096;
const icon = (name: string) => {
  const paths: Record<string, string> = {
    sidebar:
      '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>',
    terminal: '<path d="m5 6 5 6-5 6m8 0h6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
    split:
      '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M12 4v16"/>',
    folder: '<path d="M3 7V5h6l2 2h10v12H3Z"/>',
    arrow: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9S4 17 4 12V6Zm-4 9 3 3 5-6"/>',
    settings:
      '<path d="M5 5h14M5 12h14M5 19h14"/><circle cx="9" cy="5" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="9" cy="19" r="2"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? paths.terminal}</svg>`;
};
const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
$("#app").innerHTML = `
<header class="toolbar">
  <div class="toolbar-leading"><button id="sidebar-toggle" class="icon-button" aria-label="切换会话侧栏" title="会话侧栏">${icon("sidebar")}</button><div class="brand"><strong>New WindTerm</strong><span class="badge">P0</span></div></div>
  <div class="toolbar-actions"><button id="connect-open" class="toolbar-connect">${icon("plus")}新建连接</button><button id="local-open">${icon("terminal")}本地终端</button><span class="toolbar-divider"></span><button id="palette-open" class="search-button" aria-label="搜索命令与操作">${icon("search")}<span>搜索命令</span><kbd>⌘ K</kbd></button><button id="split-toggle" class="icon-button" aria-label="切换分屏" title="分屏">${icon("split")}</button><button id="files-toggle" class="icon-button" aria-label="切换文件面板" title="文件面板">${icon("folder")}</button></div>
</header>
<div class="app-body">
  <aside class="sidebar"><div class="sidebar-top"><span>会话</span><button id="sidebar-add" class="icon-button" aria-label="新建演示会话">${icon("plus")}</button></div><label class="session-search">${icon("search")}<input id="session-search" aria-label="筛选会话" placeholder="筛选会话"/></label><div class="section-label">已打开 <span id="session-count"></span></div><div id="session-list"></div><div class="sidebar-bottom"><label>${icon("settings")}外观<select id="theme" aria-label="外观主题"><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label><button id="compact-toggle">紧凑布局 <span>关</span></button></div></aside>
  <main class="workspace"><section class="terminal-workspace" aria-label="终端工作区"><div class="tabbar"><div id="tabs" role="tablist" aria-label="终端标签"></div><button id="demo-add" class="icon-button" aria-label="添加演示终端">${icon("plus")}</button></div><div class="terminal-tools"><span id="session-detail"></span><div><button type="button" id="forward-open" hidden>端口转发</button><button id="sample-run">字符与颜色样本</button><button id="stress-run">持续输出样本</button></div></div><div class="terminal-row"><div id="terminals"></div><aside class="file-inspector" hidden><div id="file-demo"><div class="inspector-title"><strong>文件浏览器</strong><span class="badge">演示</span></div><div class="file-path">${icon("folder")} /home/demo/project</div><div class="file-head"><span>名称</span><span>大小</span></div><div id="file-list"></div><div id="file-detail">选择文件查看模拟属性。</div><button id="transfer-add">${icon("arrow")}模拟下载所选文件</button><p class="caption">以上为模拟数据，不读取本机或服务器文件。</p><button type="button" id="sftp-connect" class="ssh-verification-entry">${icon("shield")}只读连接 SFTP · 仅桌面</button></div><div id="sftp-view" hidden></div></aside></div><div class="terminal-status"><span id="terminal-state"></span><span id="terminal-size"></span></div></section><section class="transfer-panel"><button id="transfers-toggle" aria-expanded="false"><span>${icon("arrow")}传输队列 <span class="badge" id="transfer-count">0</span></span><span id="transfer-summary">暂无任务 · 模拟交互 ${icon("chevron")}</span></button><div id="transfer-list" hidden><p class="empty">队列为空。打开文件面板可体验模拟下载、取消与失败反馈。</p></div></section><div class="notice"><span class="notice-dot"></span><span id="runtime-note">交互原型 · 演示会话不会连接服务器，文件列表与传输均为模拟数据。</span><button id="about-open">查看边界 ${icon("chevron")}</button></div></main>
</div>
<dialog id="connect-dialog"><form id="connect-form"><div class="dialog-heading"><div class="sheet-title"><div class="dialog-icon">${icon("terminal")}</div><div><h2>新建连接</h2><span class="caption">SSH 会话配置 <span class="badge">演示</span></span></div></div><button type="button" class="icon-button dialog-close" aria-label="关闭">${icon("close")}</button></div><p class="sheet-description">配置连接信息，预览主机身份确认流程。</p><div class="form-section"><label>会话名称<input name="name" value="Development" maxlength="48" required/></label><div class="form-row"><label>主机<input name="host" value="demo.example.com" maxlength="253" required/></label><label class="port">端口<input name="port" type="number" value="22" min="1" max="65535" required/></label></div><label>用户名<input name="user" value="developer" maxlength="64" required/></label></div><div class="form-info">${icon("shield")}<span>仅预览，不发起网络连接。<br/>真实 SSH 请使用下方独立入口；只读 SFTP 在文件面板中连接。</span></div><button type="button" id="ssh-terminal-open" class="ssh-verification-entry">打开真实 SSH 终端 · 仅桌面</button><button type="button" id="ssh-verification-open" class="ssh-verification-entry">打开真实 SSH 验证 · 仅桌面</button><button type="button" id="net-terminal-open" class="ssh-verification-entry">打开 Telnet / Raw TCP 终端 · 仅桌面</button><div class="dialog-actions"><button type="button" class="dialog-close">取消</button><button class="primary" type="submit">预览主机确认</button></div></form></dialog>
<dialog id="host-dialog"><div class="dialog-heading"><div class="dialog-icon amber">${icon("shield")}</div><button class="icon-button dialog-close" aria-label="关闭">${icon("close")}</button></div><span class="eyebrow">HOST VERIFICATION · 模拟</span><h2>确认主机身份</h2><p>真实连接必须通过可信渠道核对服务器指纹。以下是固定的演示数据，确认不会保存到 known_hosts。</p><div class="host-card"><strong id="host-name"></strong><span>算法 · ssh-ed25519</span><code>SHA256:DEMO-ONLY-NOT-A-REAL-HOST-FINGERPRINT</code></div><div class="dialog-actions"><button class="dialog-close">拒绝并返回</button><button id="host-confirm" class="primary">仅打开演示会话</button></div></dialog>
<dialog id="palette-dialog"><div class="palette-search">${icon("search")}<input id="command-search" aria-label="搜索命令" placeholder="你想执行什么操作？"/><kbd>ESC</kbd></div><div id="command-list"></div><p class="caption">↑ ↓ 选择 · Enter 执行 · Esc 返回终端</p></dialog>
<dialog id="about-dialog"><div class="dialog-heading"><span class="badge">P0 验证边界</span><button class="icon-button dialog-close" aria-label="关闭">${icon("close")}</button></div><h2>一个可交互的起点</h2><p>当前已接入真实 xterm.js；桌面构建可启动本机 PTY。浏览器中的会话是确定性演示，无法执行系统命令。</p><p>桌面的真实 SSH 终端入口支持核对指纹、未加密 Ed25519 密钥认证与交互 shell；独立验证入口仍只执行固定测试命令。Telnet 与 Raw TCP 终端为明文连接，仅按 UTF-8 显示，尚未与真实 telnetd 或网络设备验收。文件面板可另行只读连接 SFTP（列目录、属性、64 KiB 预览），不上传、删除或改名；演示会话与传输队列仍为模拟。历史暂保留 5,000 行，未实现无限历史与压缩。</p><p>请勿在演示会话输入真实密码。中文输入法、VoiceOver、Retina 与全量终端兼容性仍需实机验收。</p><div class="dialog-actions"><button class="primary dialog-close">返回工作台</button></div></dialog><div id="toast" role="status" aria-live="polite"></div>`;
const sessions = new Map<number, Session>();
let nextKey = 1,
  activeKey = 0,
  split = false,
  compact = false,
  selectedFile = 1;
const encoder = new TextEncoder();
const native = isTauri();
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
let themeChoice = "light";
try {
  themeChoice = localStorage.getItem("windterm-p0-theme") ?? "light";
} catch {
  /* Storage can be disabled by the browser. */
}
if (!["light", "dark", "system"].includes(themeChoice)) themeChoice = "light";
($("#theme") as HTMLSelectElement).value = themeChoice;
const colors = (): ITheme =>
  document.documentElement.dataset.theme === "dark"
    ? {
        background: "#111315", foreground: "#dce0e6", cursor: "#a5c5cc",
        selectionBackground: "#34434c", black: "#757c87", red: "#d99999",
        green: "#a4bfa2", yellow: "#c7b78c", blue: "#a2b7d2", magenta: "#b7a4c6",
        cyan: "#9fbdc4", white: "#dce0e6", brightBlack: "#a1a8b3", brightRed: "#e7aaaa",
        brightGreen: "#b7cfb4", brightYellow: "#d9c99e", brightBlue: "#b5c8df",
        brightMagenta: "#cbb6d8", brightCyan: "#b5d1d7", brightWhite: "#f0f2f5",
      }
    : {
        background: "#ffffff", foreground: "#2d3748", cursor: "#16834b",
        selectionBackground: "#d3eadf", black: "#2d3748", red: "#ad3f46",
        green: "#187549", yellow: "#856013", blue: "#35648d", magenta: "#805487",
        cyan: "#247676", white: "#526865", brightBlack: "#647673", brightRed: "#a4383e",
        brightGreen: "#12633c", brightYellow: "#785712", brightBlue: "#275985",
        brightMagenta: "#75497c", brightCyan: "#196768", brightWhite: "#425652",
      };
function setTheme() {
  document.documentElement.dataset.theme =
    themeChoice === "system"
      ? systemTheme.matches
        ? "dark"
        : "light"
      : themeChoice;
  for (const s of sessions.values()) s.terminal.options.theme = colors();
}
setTheme();
systemTheme.addEventListener("change", setTheme);
$("#theme").addEventListener("change", () => {
  themeChoice = ($("#theme") as HTMLSelectElement).value;
  try {
    localStorage.setItem("windterm-p0-theme", themeChoice);
  } catch {
    /* Optional preference persistence. */
  }
  setTheme();
});
function toast(message: string) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(
    () => $("#toast").classList.remove("visible"),
    4500,
  );
}
let toastTimer = 0;
function active() {
  return sessions.get(activeKey);
}
/** IPC command prefix of the session's terminal transport. */
const transport = (s: Session) => (s.mode === "ssh" || s.mode === "net" ? s.mode : "pty");
const modeName = (s: Session) =>
  s.mode === "demo" ? "演示" : s.mode === "ssh" ? "SSH" : s.mode === "net" ? s.netKind ?? "TCP" : "本机";
const statusElements = {
  state: $("#terminal-state"),
  size: $("#terminal-size"),
  detail: $("#session-detail"),
  sample: $("#sample-run") as HTMLButtonElement,
  stress: $("#stress-run") as HTMLButtonElement,
  forward: $("#forward-open") as HTMLButtonElement,
};
let statusTimer: number | undefined;
function scheduleStatusUpdate() {
  if (statusTimer !== undefined) return;
  statusTimer = window.setTimeout(updateStatus, 100);
}
function updateStatus() {
  window.clearTimeout(statusTimer);
  statusTimer = undefined;
  if (diagnostics) diagnostics.statusFlushes++;
  const s = active();
  const state = s
    ? `${s.mode === "demo" ? "◌ 演示" : s.mode === "pty" ? "● 本机 PTY" : `● ${modeName(s)}`} · ${s.status}`
    : "无打开的会话";
  const size = s
    ? `${s.terminal.cols} × ${s.terminal.rows} · ${s.bytes.toLocaleString()} B 接收`
    : "";
  const detail = s
    ? s.mode === "demo"
      ? "演示环境 / 不执行系统命令"
      : s.mode === "pty" ? "本机 shell / 输入将实际执行"
      : s.mode === "ssh" ? "远端 SSH / 输入将实际执行" : `远端 ${modeName(s)} / 输入将实际发送`
    : "";
  const clipboard = s?.vt.clipboardWrite ? " · OSC 52 可写剪贴板" : "";
  if (statusElements.state.textContent !== state) statusElements.state.textContent = state;
  if (statusElements.size.textContent !== size) statusElements.size.textContent = size;
  if (statusElements.detail.textContent !== detail + clipboard) statusElements.detail.textContent = detail + clipboard;
  const disabled = !s || s.mode !== "demo";
  if (statusElements.sample.disabled !== disabled) statusElements.sample.disabled = disabled;
  if (statusElements.stress.disabled !== disabled) statusElements.stress.disabled = disabled;
  const forwardHidden = s?.mode !== "ssh";
  if (statusElements.forward.hidden !== forwardHidden) statusElements.forward.hidden = forwardHidden;
  const forwardDisabled = !s || !forwardable(s);
  if (statusElements.forward.disabled !== forwardDisabled) statusElements.forward.disabled = forwardDisabled;
}

function paintSessions() {
  const query = ($("#session-search") as HTMLInputElement).value.toLowerCase();
  $("#tabs").replaceChildren();
  $("#session-list").replaceChildren();
  for (const s of sessions.values()) {
    const tab = document.createElement("div");
    tab.className = `tab ${s.key === activeKey ? "active" : ""}`;
    const button = document.createElement("button");
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(s.key === activeKey));
    button.textContent = `${s.mode !== "demo" ? "›_" : "◌"}  ${s.name}`;
    button.onclick = () => selectSession(s.key);
    const close = document.createElement("button");
    close.className = "tab-close";
    close.setAttribute("aria-label", `关闭 ${s.name}`);
    close.innerHTML = icon("close");
    close.onclick = () => void closeSession(s.key);
    tab.append(button, close);
    $("#tabs").append(tab);
    if (s.name.toLowerCase().includes(query)) {
      const row = document.createElement("button");
      row.className = `session-item ${s.key === activeKey ? "selected" : ""}`;
      row.innerHTML = `${icon("terminal")}<span></span><small></small>`;
      row.querySelector("span")!.textContent = s.name;
      row.querySelector("small")!.textContent = modeName(s);
      row.onclick = () => selectSession(s.key);
      $("#session-list").append(row);
    }
  }
  $("#session-count").textContent = String(sessions.size);
  const others = [...sessions.values()].filter((s) => s.key !== activeKey);
  for (const s of sessions.values()) {
    s.element.hidden = s.key !== activeKey && !(split && s === others[0]);
    s.element.classList.toggle("focused-pane", s.key === activeKey);
  }
  $("#terminals").classList.toggle("split", split && others.length > 0);
  $("#split-toggle").setAttribute("aria-pressed", String(split));
  requestAnimationFrame(() => {
    for (const s of sessions.values()) if (!s.element.hidden) s.fit.fit();
    updateStatus();
  });
}
function selectSession(key: number) {
  activeKey = key;
  paintSessions();
  sessions.get(key)?.terminal.focus();
}
function prompt(s: Session) {
  s.terminal.write("\r\n\x1b[32mdemo\x1b[0m \x1b[34m~/workspace\x1b[0m % ");
}
function sample(s: Session) {
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
function stress(s: Session) {
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
      if (s.key === activeKey) scheduleStatusUpdate();
      if (n < 20000 && s.outputRun === run) window.setTimeout(step, 8);
      else if (s.outputRun === run) {
        s.status = `20,000 行样本结束 · ${(performance.now() - start).toFixed(0)} ms（非性能验收）`;
        updateStatus();
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
function demoInput(s: Session, data: string) {
  if (data.startsWith("\x1b")) return;
  for (const [token] of data.matchAll(/[\x00-\x1f\x7f]|[^\x00-\x1f\x7f]+/g)) demoToken(s, token);
}
/** Redraws the prompt row(s) after an erase; wide characters can make the line wrap early. */
function demoRedraw(s: Session) {
  const buffer = s.terminal.buffer.active;
  let up = 0;
  while (up < buffer.cursorY && buffer.getLine(buffer.baseY + buffer.cursorY - up)?.isWrapped) up++;
  s.terminal.write(
    `${up ? `\x1b[${up}A` : ""}\r\x1b[J\x1b[32mdemo\x1b[0m \x1b[34m~/workspace\x1b[0m % ${s.line}`,
  );
}
function demoToken(s: Session, data: string) {
  if (data === "\x03") {
    s.outputRun++;
    s.line = "";
    s.status = "演示就绪";
    s.terminal.write("^C");
    prompt(s);
    updateStatus();
    return;
  }
  if (data === "\r") {
    const command = s.line.trim();
    s.line = "";
    if (command === "clear") s.terminal.clear();
    else if (command === "help")
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
      stress(s);
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
function sendInput(s: Session, bytes: Uint8Array) {
  if (!s.ptyId || s.disposed || s.ended || s.closing) return;
  if (!s.input.push(bytes))
    toast(`输入队列已满（${INPUT_BACKLOG_BYTES / 1024 / 1024} MiB）；本次输入未发送，请等待前面的内容发送完成。`);
}
function inputQueue(s: () => Session) {
  return new InputQueue({
    write: (chunk) => invoke(`${transport(s())}_write`, { id: s().ptyId, data: Array.from(chunk) }),
    writable: () => {
      const session = s();
      return !!session.ptyId && !session.disposed && !session.ended && !session.closing;
    },
    failed: (error, discarded) => {
      const session = s();
      if (session.ended || session.disposed) return;
      backendError(session, error);
      if (discarded) toast(`输入发送失败；已丢弃其后尚未发送的 ${discarded.toLocaleString()} B，避免内容出现缺口。`);
    },
  });
}
function queueInput(s: Session, bytes: Uint8Array) {
  if (s.ptyId) {
    sendInput(s, bytes);
    return;
  }
  // Only a local shell needs early input (ConPTY's cursor query). Keystrokes
  // typed while an SSH connection authenticates are not replayed remotely.
  if (s.mode !== "pty" || s.disposed || s.ended || s.closing) return;
  if (s.earlyBytes + bytes.length > EARLY_INPUT_LIMIT) {
    toast("会话仍在启动，输入暂未发送；请稍后重试。");
    return;
  }
  s.early.push(bytes);
  s.earlyBytes += bytes.length;
}
function flushEarlyInput(s: Session) {
  const queued = s.early;
  s.early = [];
  s.earlyBytes = 0;
  for (const bytes of queued) sendInput(s, bytes);
}
function backendError(s: Session, error: unknown) {
  if (s.disposed) return;
  s.status = `错误：${String(error)}`;
  updateStatus();
}
function createSession(name: string, mode: Mode): Session | undefined {
  if (sessions.size >= 8) {
    toast("P0 最多同时打开 8 个会话。");
    return;
  }
  const element = document.createElement("section");
  element.className = "terminal-pane";
  element.setAttribute("aria-label", `${name} 终端`);
  $("#terminals").append(element);
  // Set once the session exists, so a notice can never touch `s` before its declaration.
  let owner: Session | undefined;
  const { terminal, vt } = createWorkspaceSession(colors(), {
    onNotice: (notice) => { if (owner && !owner.disposed) toast(`「${owner.name}」${describeVtNotice(notice)}`); },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  const s: Session = {
    key: nextKey++,
    name,
    mode,
    terminal,
    vt,
    fit,
    element,
    observer: new ResizeObserver(() => {
      if (!element.hidden && !s.disposed) fit.fit();
    }),
    line: "",
    disposed: false,
    closing: false,
    outputRun: 0,
    status: mode === "demo" ? "演示就绪" : "正在启动…",
    ended: false,
    bytes: 0,
    early: [],
    earlyBytes: 0,
    ack: Promise.resolve(),
    input: inputQueue(() => s),
  };
  owner = s;
  s.observer.observe(element);
  attachPasteGuard(element, terminal, (removed) =>
    toast(`已从粘贴内容中移除 ${removed} 个控制字符（仅保留制表符和换行）。`),
  );
  attachInsertTextBridge(terminal);
  attachKeyDefaultGuard(terminal);
  sessions.set(s.key, s);
  activeKey = s.key;
  terminal.onData((data) => {
    if (mode === "demo") demoInput(s, data);
    else queueInput(s, encoder.encode(data));
  });
  terminal.onBinary((data) => {
    if (mode !== "demo")
      queueInput(
        s,
        Uint8Array.from(data, (c) => c.charCodeAt(0) & 255),
      );
  });
  terminal.onResize(({ cols, rows }) => {
    updateStatus();
    if (s.ptyId && !s.ended && !s.closing)
      void invoke(`${transport(s)}_resize`, { id: s.ptyId, cols, rows }).catch((error) => {
        if (!s.ended) backendError(s, error);
      });
  });
  terminal.attachCustomKeyEventHandler(
    (event) =>
      !(
        event.key.toLowerCase() === "k" &&
        (event.metaKey || (event.ctrlKey && event.shiftKey))
      ) && !sendUnmappedControl(terminal, event),
  );
  element.addEventListener("focusin", () => {
    if (activeKey !== s.key) {
      activeKey = s.key;
      paintSessions();
    }
  });
  paintSessions();
  if (mode === "demo") {
    terminal.write(
      "\r\n  \x1b[1mNew WindTerm\x1b[0m\r\n\r\n  Terminal workspace  /  P0 preview\r\n\r\n  \x1b[34mP0 交互原型\x1b[0m\r\n  这是本地演示，不会连接远端或执行系统命令。\r\n  输入 \x1b[32mhelp\x1b[0m 查看命令，或从上方运行字符与输出样本。\r\n",
    );
    prompt(s);
  } else if (mode === "pty") void openPty(s);
  terminal.focus();
  return s;
}
/** Shows a character the stream ended in the middle of as U+FFFD; output is over. */
function endOutput(s: Session, utf8: Utf8Boundary) {
  const tail = utf8.flush();
  if (tail.length) s.terminal.write(tail);
}
function terminalChannel(s: Session) {
  const onEvent = new Channel<PtyEvent>();
  const utf8 = new Utf8Boundary();
  onEvent.onmessage = (event) => {
    if (s.disposed) return;
    if (event.kind === "data") {
      s.bytes += event.data.length;
      const receivedAt = diagnostics ? performance.now() : 0;
      if (diagnostics) {
        diagnostics.receivedChunks++;
        diagnostics.receivedBytes += event.data.length;
      }
      s.terminal.write(utf8.take(new Uint8Array(event.data)), () => {
        if (s.disposed) return;
        const parsedAt = diagnostics ? performance.now() : 0;
        if (diagnostics) {
          diagnostics.parsedChunks++;
          diagnostics.maxParseWaitMs = Math.max(diagnostics.maxParseWaitMs, parsedAt - receivedAt);
        }
        s.ack = s.ack
          .then(async () => {
            if (diagnostics) {
              diagnostics.ackSubmitted++;
              diagnostics.maxAckQueueWaitMs = Math.max(diagnostics.maxAckQueueWaitMs, performance.now() - parsedAt);
            }
            if (s.disposed) return;
            await invoke(`${transport(s)}_ack`, { id: event.id, sequence: event.sequence });
            if (diagnostics) diagnostics.ackCompleted++;
          })
          .catch((error) => { if (!s.ended) backendError(s, error); });
        if (s.key === activeKey) scheduleStatusUpdate();
      });
    } else if (event.kind === "exit") {
      endOutput(s, utf8);
      s.ended = true;
      s.early = [];
      s.earlyBytes = 0;
      s.input.clear();
      s.status = `已退出 · code ${event.code ?? "unknown"}`;
      s.ptyId = undefined;
      updateStatus();
    } else {
      // Network errors are terminal lifecycle events; the backend releases the session.
      if (s.mode === "ssh" || s.mode === "net") {
        endOutput(s, utf8);
        s.ended = true;
        s.ptyId = undefined;
        s.input.clear();
      }
      backendError(s, event.message);
    }
  };
  return onEvent;
}
async function openPty(s: Session) {
  const onEvent = terminalChannel(s);
  try {
    const { id } = await invoke<{ id: string }>("pty_open", {
      onEvent,
      cols: s.terminal.cols,
      rows: s.terminal.rows,
    });
    if (s.disposed) {
      await invoke("pty_close", { id });
      return;
    }
    if (s.ended) return;
    s.ptyId = id;
    flushEarlyInput(s);
    s.status = "本机 shell 已启动";
    await invoke("pty_resize", {
      id,
      cols: s.terminal.cols,
      rows: s.terminal.rows,
    });
    updateStatus();
  } catch (error) {
    s.early = [];
    s.earlyBytes = 0;
    if (s.disposed) return;
    backendError(s, error);
    s.terminal.write("\r\n本地 PTY 启动失败。请查看底部状态。\r\n");
  }
}
function startSshTerminal(request: SshTerminalRequest): boolean {
  if (!native) return false;
  const s = createSession(request.name, "ssh");
  if (!s) return false;
  s.operationId = request.operationId;
  s.status = "正在认证并打开 SSH…";
  updateStatus();
  void openSsh(s, request);
  return true;
}
async function openSsh(s: Session, request: SshTerminalRequest) {
  // Prompted keyboard-interactive asks in a dialog; closing the tab cancels it.
  const prompts = authPromptsFor(request.credential, request.operationId, request.name);
  if (prompts) {
    s.status = "正在连接；请在弹出的对话框中回答服务器提示…";
    updateStatus();
  }
  try {
    const { id } = await invoke<{ id: string }>("ssh_open", {
      challengeToken: request.challengeToken, operationId: request.operationId,
      scopeToken: request.scopeToken, credential: request.credential, onEvent: terminalChannel(s),
      cols: s.terminal.cols, rows: s.terminal.rows, onAuth: prompts?.channel,
      ...(request.agentForwarding ? { agentForwarding: true } : {}),
    }).finally(() => prompts?.finish());
    if (s.disposed || s.ended) {
      await invoke("ssh_close", { id });
      return;
    }
    s.ptyId = id;
    flushEarlyInput(s);
    s.status = request.agentForwarding ? "SSH 已连接 · 已转发本机 ssh-agent" : "SSH 已连接";
    if (!s.closing) await invoke("ssh_resize", { id, cols: s.terminal.cols, rows: s.terminal.rows });
    updateStatus();
  } catch (error) {
    if (s.disposed || s.ended) return;
    s.ended = true;
    backendError(s, error);
    s.terminal.write("\r\nSSH 连接失败。请查看底部状态，再从真实 SSH 入口重新连接。\r\n");
  } finally {
    s.operationId = undefined;
  }
}
function startNetTerminal(request: NetTerminalRequest): boolean {
  if (!native) return false;
  const s = createSession(request.name, "net");
  if (!s) return false;
  s.netKind = netLabel(request.kind);
  // The client-chosen ID can be closed while the connection is still pending.
  s.operationId = crypto.randomUUID();
  s.status = `正在连接 ${s.netKind}…`;
  paintSessions();
  void openNet(s, request);
  return true;
}
async function openNet(s: Session, { kind, host, port }: NetTerminalRequest) {
  const id = s.operationId!;
  try {
    await invoke<{ id: string }>("net_open", {
      target: { kind, host, port }, id, onEvent: terminalChannel(s),
      cols: s.terminal.cols, rows: s.terminal.rows,
    });
    if (s.disposed || s.ended) {
      await invoke("net_close", { id });
      return;
    }
    s.ptyId = id;
    s.status = `${s.netKind} 已连接`;
    updateStatus();
    // Resizes during connect were not sent; a peer that already hung up is not a failed open.
    if (!s.closing)
      void invoke("net_resize", { id, cols: s.terminal.cols, rows: s.terminal.rows }).catch((error) => {
        if (!s.ended) backendError(s, error);
      });
  } catch (error) {
    if (s.disposed || s.ended) return;
    s.ended = true;
    backendError(s, error);
    s.terminal.write("\r\n连接失败。请查看底部状态，再从「新建连接」重新打开。\r\n");
  } finally {
    s.operationId = undefined;
  }
}
async function closeSession(key: number) {
  const s = sessions.get(key);
  if (!s || s.closing) return;
  s.closing = true;
  try {
    if (s.mode === "ssh" && s.operationId) {
      await invoke("ssh_cancel", { operationId: s.operationId });
    } else if (s.ptyId ?? s.operationId) {
      // A pending network terminal is cancelled by closing its client-chosen ID.
      await invoke(`${transport(s)}_close`, { id: s.ptyId ?? s.operationId });
    }
  } catch (error) {
    s.closing = false;
    backendError(s, error);
    toast("会话关闭失败，请重试。");
    return;
  }
  s.disposed = true;
  s.early = [];
  s.earlyBytes = 0;
  s.input.clear();
  s.outputRun++;
  s.observer.disconnect();
  s.vt.dispose();
  s.terminal.dispose();
  s.element.remove();
  sessions.delete(key);
  if (activeKey === key) activeKey = sessions.keys().next().value ?? 0;
  paintSessions();
}
function toggleClipboardWrite() {
  const s = active();
  if (!s) return;
  s.vt.setClipboardWrite(!s.vt.clipboardWrite);
  toast(s.vt.clipboardWrite
    ? `已允许「${s.name}」通过 OSC 52 写入剪贴板；读取仍被禁止。`
    : `已关闭「${s.name}」的 OSC 52 剪贴板写入。`);
  updateStatus();
}
function showDialog(id: string) {
  ($(id) as HTMLDialogElement).showModal();
}
const sftpPanel = createSftpPanel($(".file-inspector"), toast);
function startSftpBrowser(request: SshTerminalRequest): boolean {
  if (!native) return false;
  const panel = $(".file-inspector");
  panel.hidden = false;
  $("#files-toggle").setAttribute("aria-pressed", "true");
  return sftpPanel.open(request);
}
const sshVerification = createSshVerification(startSshTerminal, startSftpBrowser);
const netTerminal = createNetTerminalDialog(startNetTerminal);
const forwardSheet = createPortForwardSheet();
/** A connected SSH tab; its port forwards live and end with it in the backend. */
function forwardable(s: Session) {
  return s.mode === "ssh" && !!s.ptyId && !s.ended && !s.closing && !s.disposed;
}
function openForwards() {
  const s = active();
  const id = s?.ptyId;
  if (!s || !id || !forwardable(s)) {
    toast("端口转发需要一个已连接的真实 SSH 终端标签；请先切换到该标签。");
    return;
  }
  forwardSheet.open({ id, name: s.name, alive: () => forwardable(s) && s.ptyId === id });
}
$("#forward-open").onclick = openForwards;
$("#sftp-connect").onclick = () => sshVerification.open("files");
$(".file-inspector").addEventListener("sftp-reconnect", () => sshVerification.open("files"));
for (const button of document.querySelectorAll<HTMLButtonElement>(
  ".dialog-close",
))
  button.onclick = () => button.closest("dialog")!.close();
for (const dialog of document.querySelectorAll("dialog"))
  dialog.addEventListener("close", () => {
    if (!document.querySelector("dialog[open]")) active()?.terminal.focus();
  });
$("#ssh-terminal-open").onclick = () => {
  ($("#connect-dialog") as HTMLDialogElement).close();
  sshVerification.open("terminal");
};
$("#ssh-verification-open").onclick = () => {
  ($("#connect-dialog") as HTMLDialogElement).close();
  sshVerification.open();
};
$("#net-terminal-open").onclick = () => {
  ($("#connect-dialog") as HTMLDialogElement).close();
  netTerminal.open();
};
$("#sidebar-toggle").onclick = () => {
  $(".app-body").classList.toggle("no-sidebar");
  $("#sidebar-toggle").setAttribute(
    "aria-expanded",
    String(!$(".app-body").classList.contains("no-sidebar")),
  );
};
$("#compact-toggle").onclick = () => {
  compact = !compact;
  document.documentElement.classList.toggle("compact", compact);
  $("#compact-toggle span").textContent = compact ? "开" : "关";
};
$("#connect-open").onclick = () => showDialog("#connect-dialog");
$("#sidebar-add").onclick = $("#demo-add").onclick = () =>
  createSession(`Demo ${nextKey}`, "demo");
$("#local-open").onclick = () => {
  if (!native) {
    toast("本地 PTY 仅在 Tauri 桌面程序中可用。请使用 npm run tauri dev。");
    return;
  }
  createSession(`Local ${nextKey}`, "pty");
};
$("#split-toggle").onclick = () => {
  if (!split && sessions.size < 2) createSession(`Demo ${nextKey}`, "demo");
  split = !split;
  paintSessions();
};
$("#files-toggle").onclick = () => {
  const panel = $(".file-inspector");
  panel.hidden = !panel.hidden;
  $("#files-toggle").setAttribute("aria-pressed", String(!panel.hidden));
};
$("#session-search").addEventListener("input", paintSessions);
$("#sample-run").onclick = () => {
  const s = active();
  if (s?.mode === "demo") sample(s);
};
$("#stress-run").onclick = () => {
  const s = active();
  if (s?.mode === "demo") stress(s);
};
$("#about-open").onclick = () => showDialog("#about-dialog");
let pendingName = "";
$("#connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData($("#connect-form") as HTMLFormElement);
  pendingName = String(form.get("name"));
  $("#host-name").textContent =
    `${String(form.get("user"))}@${String(form.get("host"))}:${String(form.get("port"))}`;
  ($("#connect-dialog") as HTMLDialogElement).close();
  showDialog("#host-dialog");
});
$("#host-confirm").onclick = () => {
  ($("#host-dialog") as HTMLDialogElement).close();
  if (createSession(pendingName, "demo")) {
    toast("已打开演示会话；未建立 SSH 连接，未保存主机信任。");
  }
};
const files = [
  { name: "documents", size: "文件夹", type: "目录" },
  { name: "README.md", size: "2.4 KB", type: "Markdown" },
  { name: "部署说明.txt", size: "1.8 KB", type: "UTF-8 文本" },
  { name: "release.tar.gz", size: "24.8 MB", type: "压缩包" },
];
function paintFiles() {
  $("#file-list").replaceChildren();
  files.forEach((file, index) => {
    const button = document.createElement("button");
    button.className = `file-row ${index === selectedFile ? "selected" : ""}`;
    button.innerHTML = `<span>${icon(index === 0 ? "folder" : "terminal")}<span></span></span><small></small>`;
    button.querySelector("span span")!.textContent = file.name;
    button.querySelector("small")!.textContent = file.size;
    button.onclick = () => {
      selectedFile = index;
      paintFiles();
    };
    $("#file-list").append(button);
  });
  $("#file-detail").textContent =
    `${files[selectedFile].type} · ${files[selectedFile].size} · 示例属性`;
}
paintFiles();
type Transfer = {
  id: number;
  name: string;
  progress: number;
  state: string;
  timer?: number;
};
const transfers: Transfer[] = [];
function paintTransfers() {
  $("#transfer-count").textContent = String(transfers.length);
  $("#transfer-list").replaceChildren();
  for (const t of transfers) {
    const row = document.createElement("div");
    row.className = "transfer-row";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = t.name;
    const state = document.createElement("span");
    state.textContent = `${t.state} · ${t.progress}% · 模拟`;
    const progress = document.createElement("progress");
    progress.max = 100;
    progress.value = t.progress;
    info.append(title, state, progress);
    row.append(info);
    if (t.state === "模拟传输中") {
      const cancel = document.createElement("button");
      cancel.textContent = "取消";
      cancel.onclick = () => {
        clearInterval(t.timer);
        t.state = "已取消（模拟）";
        paintTransfers();
      };
      const fail = document.createElement("button");
      fail.textContent = "模拟失败";
      fail.onclick = () => {
        clearInterval(t.timer);
        t.state = "连接中断（模拟），未完成";
        paintTransfers();
      };
      row.append(cancel, fail);
    }
    $("#transfer-list").append(row);
  }
  $("#transfer-summary").textContent = transfers.some(
    (t) => t.state === "模拟传输中",
  )
    ? "模拟传输进行中"
    : "模拟队列 · 未进行真实文件操作";
}
$("#transfers-toggle").onclick = () => {
  const list = $("#transfer-list");
  list.hidden = !list.hidden;
  $("#transfers-toggle").setAttribute("aria-expanded", String(!list.hidden));
};
$("#transfer-add").onclick = () => {
  if (transfers.length >= 8) {
    toast("P0 演示队列最多保留 8 项；刷新页面可重置。");
    return;
  }
  const t: Transfer = {
    id: transfers.length + 1,
    name: files[selectedFile].name,
    progress: 0,
    state: "模拟传输中",
  };
  transfers.push(t);
  $("#transfer-list").hidden = false;
  $("#transfers-toggle").setAttribute("aria-expanded", "true");
  t.timer = window.setInterval(() => {
    t.progress = Math.min(100, t.progress + 5);
    if (t.progress === 100) {
      t.state = "模拟完成（无文件落盘）";
      clearInterval(t.timer);
    }
    paintTransfers();
  }, 500);
  paintTransfers();
};
const commands = [
  {
    name: "新建连接 · 配置与主机确认演示",
    action: () => showDialog("#connect-dialog"),
  },
  {
    name: "新建演示终端",
    action: () => createSession(`Demo ${nextKey}`, "demo"),
  },
  {
    name: "打开本地终端 · 仅桌面",
    action: () => ($("#local-open") as HTMLButtonElement).click(),
  },
  {
    name: "切换会话侧栏",
    action: () => ($("#sidebar-toggle") as HTMLButtonElement).click(),
  },
  {
    name: "切换分屏",
    action: () => ($("#split-toggle") as HTMLButtonElement).click(),
  },
  {
    name: "切换文件面板",
    action: () => ($("#files-toggle") as HTMLButtonElement).click(),
  },
  {
    name: "切换传输队列 · 模拟任务",
    action: () => ($("#transfers-toggle") as HTMLButtonElement).click(),
  },
  {
    name: "切换紧凑布局",
    action: () => ($("#compact-toggle") as HTMLButtonElement).click(),
  },
  { name: "查看 P0 验证边界", action: () => showDialog("#about-dialog") },
  { name: "打开真实 SSH 终端 · 仅桌面", action: () => sshVerification.open("terminal") },
  { name: "SSH 验证 · 真实指纹与固定命令 · 仅桌面", action: () => sshVerification.open() },
  { name: "只读浏览远端文件 · SFTP · 仅桌面", action: () => sshVerification.open("files") },
  { name: "打开 Telnet / Raw TCP 终端 · 仅桌面", action: () => netTerminal.open() },
  { name: "切换当前会话 OSC 52 剪贴板写入 · 默认关闭", action: toggleClipboardWrite },
  { name: "SSH 端口转发 · 当前 SSH 标签 · 仅桌面", action: openForwards },
];
let commandIndex = 0;
function paintCommands() {
  const query = ($("#command-search") as HTMLInputElement).value.toLowerCase();
  const matches = commands.filter((c) => c.name.toLowerCase().includes(query));
  commandIndex = Math.min(commandIndex, Math.max(0, matches.length - 1));
  $("#command-list").replaceChildren();
  matches.forEach((command, index) => {
    const button = document.createElement("button");
    button.className = index === commandIndex ? "command selected" : "command";
    button.textContent = command.name;
    button.onclick = () => {
      ($("#palette-dialog") as HTMLDialogElement).close();
      command.action();
    };
    $("#command-list").append(button);
  });
  if (!matches.length) $("#command-list").textContent = "没有匹配的操作";
}
function openPalette() {
  ($("#command-search") as HTMLInputElement).value = "";
  commandIndex = 0;
  paintCommands();
  showDialog("#palette-dialog");
  $("#command-search").focus();
}
$("#palette-open").onclick = openPalette;
$("#command-search").addEventListener("input", () => {
  commandIndex = 0;
  paintCommands();
});
$("#command-search").addEventListener("keydown", (event) => {
  const key = (event as KeyboardEvent).key;
  if (key === "ArrowDown" || key === "ArrowUp") {
    event.preventDefault();
    const count = $("#command-list").children.length;
    commandIndex =
      (commandIndex + (key === "ArrowDown" ? 1 : -1) + count) %
      Math.max(count, 1);
    paintCommands();
  } else if (key === "Enter") {
    event.preventDefault();
    ($("#command-list .selected") as HTMLButtonElement | null)?.click();
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.key.toLowerCase() === "k" &&
    (event.metaKey || (event.ctrlKey && event.shiftKey))
  ) {
    event.preventDefault();
    if (!document.querySelector("dialog[open]")) openPalette();
  }
});
window.addEventListener("beforeunload", () => {
  window.clearTimeout(statusTimer);
  for (const s of sessions.values()) {
    s.disposed = true;
    s.outputRun++;
    s.observer.disconnect();
    s.vt.dispose();
    s.terminal.dispose();
    if (s.mode === "ssh" && s.operationId) void invoke("ssh_cancel", { operationId: s.operationId }).catch(() => {});
    else if (s.ptyId ?? s.operationId) void invoke(`${transport(s)}_close`, { id: s.ptyId ?? s.operationId }).catch(() => {});
  }
  for (const t of transfers) clearInterval(t.timer);
  sftpPanel.dispose();
});
$("#runtime-note").textContent = native
  ? "桌面原型 · 本地、真实 SSH、Telnet 与 Raw TCP 终端会实际执行或发送输入；文件面板可只读连接 SFTP；演示会话与传输队列仍为模拟数据。"
  : "交互原型 · 演示会话不会连接服务器，文件列表与传输均为模拟数据。";
createSession("Getting started", "demo");

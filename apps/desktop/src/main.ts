import type { ITheme } from "@xterm/xterm";
import { createSshVerification, type SshTerminalRequest } from "./ssh-verification";
import { createSftpPanel } from "./sftp-panel";
import { createNetTerminalDialog, type NetTerminalRequest } from "./net-terminal";
import { createPortForwardSheet } from "./port-forward";
import { createLocalLaunchOptions } from "./local-launch";
import { responsivenessDiagnostics as diagnostics } from "./responsiveness";
import { icon } from "./icons";
import {
  createSessionLifecycle, forwardable, reopenable, type Session, type SessionHost,
} from "./session-lifecycle";
import { sample, stress } from "./demo-session";
import { isTauri } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

const $ = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
$("#app").innerHTML = `
<header class="toolbar">
  <div class="toolbar-leading"><button id="sidebar-toggle" class="icon-button" aria-label="切换会话侧栏" title="会话侧栏">${icon("sidebar")}</button><div class="brand"><strong>New WindTerm</strong><span class="badge">P0</span></div></div>
  <div class="toolbar-actions"><button id="connect-open" class="toolbar-connect">${icon("plus")}新建连接</button><button id="local-open">${icon("terminal")}本地终端</button><button id="local-options-open" class="icon-button" aria-label="本地终端启动选项" title="启动选项">${icon("settings")}</button><span class="toolbar-divider"></span><button id="palette-open" class="search-button" aria-label="搜索命令与操作">${icon("search")}<span>搜索命令</span><kbd>⌘K</kbd></button><button id="split-toggle" class="icon-button" aria-label="切换分屏" title="分屏">${icon("split")}</button><button id="files-toggle" class="icon-button" aria-label="切换文件面板" title="文件面板">${icon("folder")}</button></div>
</header>
<div class="app-body">
  <aside class="sidebar"><div class="sidebar-top"><span>会话</span><button id="sidebar-add" class="icon-button" aria-label="新建演示会话">${icon("plus")}</button></div><label class="session-search">${icon("search")}<input id="session-search" aria-label="筛选会话" placeholder="筛选会话"/></label><div class="section-label"><span>已打开</span><span id="session-count" class="count"></span></div><div id="session-list"></div><div class="sidebar-bottom"><label class="setting-row">${icon("settings")}外观<select id="theme" aria-label="外观主题"><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label><button id="compact-toggle" class="setting-row">紧凑布局 <span>关</span></button></div></aside>
  <main class="workspace"><section class="terminal-workspace" aria-label="终端工作区"><div class="tabbar"><div id="tabs" role="tablist" aria-label="终端标签"></div><button id="demo-add" class="icon-button" aria-label="添加演示终端">${icon("plus")}</button></div><div class="terminal-tools"><span id="session-detail"></span><div><button type="button" id="local-reopen" aria-label="重新打开本地终端" hidden>重新打开</button><button type="button" id="local-edit-cwd" hidden>修改启动选项</button><button type="button" id="forward-open" hidden>端口转发</button><button id="sample-run">字符与颜色样本</button><button id="stress-run">持续输出样本</button></div></div><div class="terminal-row"><div id="terminals"></div><aside class="file-inspector" hidden><div id="file-demo"><div class="inspector-title"><strong>文件浏览器</strong><span class="badge">演示</span></div><div class="file-path">${icon("folder")}<span>/home/demo/project</span></div><div class="file-head"><span>名称</span><span>大小</span></div><div id="file-list"></div><div id="file-detail">选择文件查看模拟属性</div><button id="transfer-add">${icon("arrow")}模拟下载所选文件</button><p class="caption">以上为模拟数据，不读取本机或服务器文件</p><button type="button" id="sftp-connect" class="ssh-verification-entry">${icon("shield")}只读连接 SFTP · 仅桌面</button></div><div id="sftp-view" hidden></div></aside></div><div class="terminal-status"><i id="terminal-dot" class="status-dot" data-state="none" aria-hidden="true"></i><span id="terminal-state"></span><span id="terminal-size"></span></div></section><section class="transfer-panel"><button id="transfers-toggle" aria-expanded="false"><span>${icon("arrow")}传输队列<span class="count" id="transfer-count">0</span></span><span class="transfer-meta"><span id="transfer-summary">暂无任务 · 模拟交互</span>${icon("chevron")}</span></button><div id="transfer-list" hidden><p class="empty">队列为空。打开文件面板可体验模拟下载、取消与失败反馈。</p></div></section><div class="notice"><span class="notice-dot"></span><span id="runtime-note">交互原型 · 演示会话不会连接服务器，文件列表与传输均为模拟数据。</span><button id="about-open">查看边界 ${icon("chevron")}</button></div></main>
</div>
<dialog id="local-dialog" aria-labelledby="local-title"><form id="local-form"><div class="dialog-heading"><div class="sheet-title"><div class="dialog-icon">${icon("folder")}</div><h2 id="local-title">本地终端启动选项</h2></div><button type="button" class="icon-button dialog-close" aria-label="关闭">${icon("close")}</button></div><label for="local-shell-select">Shell<select id="local-shell-select" aria-describedby="local-shell-status local-shell-missing"><option value="">默认 Shell</option></select></label><p id="local-shell-status" role="status" aria-live="polite"></p><ul id="local-shell-missing"></ul><label for="local-cwd-input">启动目录<input id="local-cwd-input" type="text" autocomplete="off" spellcheck="false" aria-describedby="local-cwd-hint" placeholder="留空使用默认目录"/></label><p id="local-cwd-hint">请输入当前系统的绝对目录路径；留空使用默认目录。路径按原样使用，不展开 ~、环境变量或命令。</p><section class="local-config-section" aria-labelledby="local-env-title"><div class="local-config-heading"><h3 id="local-env-title">环境变量</h3><button type="button" id="local-env-add">添加变量</button></div><p>名称和值分开填写，值按原样传入，不展开变量或命令。PATH 可覆盖；启动脚本、加载器及运行时保留变量由后端拒绝。</p><div id="local-env-rows" class="local-variable-rows"></div></section><section class="local-config-section" aria-labelledby="local-locale-title"><h3 id="local-locale-title">Locale</h3><label for="local-locale-mode">语言环境<select id="local-locale-mode"><option value="default">平台默认</option><option value="custom">自定义变量</option></select></label><div id="local-locale-custom" hidden><p>自定义会先清除默认 LANG / LC_*；不添加变量即保持未设置。LC_ALL 优先于 LANG，不能与其他 LC_* 同时设置。Windows 仅传递变量，不切换代码页或界面语言。</p><button type="button" id="local-locale-add">添加 Locale 变量</button><div id="local-locale-rows" class="local-variable-rows"></div></div></section><p id="local-runtime-hint">配置只用于当前会话，不保存到磁盘；重新打开沿用初始配置。在新的标签中启动本机 shell，不更改已有会话。</p><p id="local-options-error" role="alert" tabindex="-1"></p><div class="dialog-actions"><button type="button" class="dialog-close">取消</button><button id="local-start" type="submit" class="primary">打开终端</button></div></form></dialog>
<dialog id="connect-dialog"><form id="connect-form"><div class="dialog-heading"><div class="sheet-title"><div class="dialog-icon">${icon("terminal")}</div><div><h2>新建连接</h2><span class="caption">SSH 会话配置 <span class="badge">演示</span></span></div></div><button type="button" class="icon-button dialog-close" aria-label="关闭">${icon("close")}</button></div><p class="sheet-description">配置连接信息，预览主机身份确认流程</p><div class="form-section"><label>会话名称<input name="name" value="Development" maxlength="48" required/></label><div class="form-row"><label>主机<input name="host" value="demo.example.com" maxlength="253" required/></label><label class="port">端口<input name="port" type="number" value="22" min="1" max="65535" required/></label></div><label>用户名<input name="user" value="developer" maxlength="64" required/></label></div><div class="form-info">${icon("shield")}<span>仅预览，不发起网络连接<br/>真实连接请使用下方入口，只读 SFTP 在文件面板中连接</span></div><section class="alt-connect" aria-labelledby="alt-connect-title"><h3 id="alt-connect-title">桌面真实连接</h3><button type="button" id="ssh-terminal-open" class="alt-connect-row">${icon("terminal")}<span>打开真实 SSH 终端</span><small>仅桌面</small></button><button type="button" id="ssh-verification-open" class="alt-connect-row">${icon("shield")}<span>打开真实 SSH 验证</span><small>仅桌面</small></button><button type="button" id="net-terminal-open" class="alt-connect-row">${icon("terminal")}<span>打开 Telnet / Raw TCP 终端</span><small>仅桌面</small></button></section><div class="dialog-actions"><button type="button" class="dialog-close">取消</button><button class="primary" type="submit">预览主机确认</button></div></form></dialog>
<dialog id="host-dialog"><div class="dialog-heading"><div class="dialog-icon amber">${icon("shield")}</div><button class="icon-button dialog-close" aria-label="关闭">${icon("close")}</button></div><span class="eyebrow">主机验证 · 模拟</span><h2>确认主机身份</h2><p>真实连接必须通过可信渠道核对服务器指纹。以下是固定的演示数据，确认不会保存到 known_hosts。</p><div class="host-card"><strong id="host-name"></strong><span>算法 · ssh-ed25519</span><code>SHA256:DEMO-ONLY-NOT-A-REAL-HOST-FINGERPRINT</code></div><div class="dialog-actions"><button class="dialog-close">拒绝并返回</button><button id="host-confirm" class="primary">仅打开演示会话</button></div></dialog>
<dialog id="palette-dialog"><div class="palette-search">${icon("search")}<input id="command-search" aria-label="搜索命令" placeholder="搜索命令"/><kbd>Esc</kbd></div><div id="command-list"></div><p class="caption">↑ ↓ 选择 · Enter 执行 · Esc 返回终端</p></dialog>
<dialog id="about-dialog"><div class="dialog-heading"><span class="badge">P0 验证边界</span><button class="icon-button dialog-close" aria-label="关闭">${icon("close")}</button></div><h2>原型能力与边界</h2><p>当前已接入真实 xterm.js；桌面构建可启动本机 PTY。浏览器中的会话是确定性演示，无法执行系统命令。</p><p>桌面的真实 SSH 终端入口支持核对指纹、未加密 Ed25519 密钥认证与交互 shell；独立验证入口仍只执行固定测试命令。Telnet 与 Raw TCP 终端为明文连接，仅按 UTF-8 显示，尚未与真实 telnetd 或网络设备验收。文件面板可另行只读连接 SFTP（列目录、属性、64 KiB 预览），不上传、删除或改名；演示会话与传输队列仍为模拟。历史暂保留 5,000 行，未实现无限历史与压缩。</p><p>请勿在演示会话输入真实密码。中文输入法、VoiceOver、Retina 与全量终端兼容性仍需实机验收。</p><div class="dialog-actions"><button class="primary dialog-close">返回工作台</button></div></dialog><div id="toast" role="status" aria-live="polite"></div>`;
let activeKey = 0,
  split = false,
  compact = false,
  selectedFile = 1;
/** The workbench side of the session lifecycle: selection, painting, status and notices. */
const sessionHost: SessionHost = {
  theme: () => colors(),
  mount: (pane) => $("#terminals").append(pane),
  notify: (message) => toast(message),
  registered: (s) => {
    activeKey = s.key;
  },
  focused: (s) => {
    if (activeKey !== s.key) {
      activeKey = s.key;
      paintSessions();
    }
  },
  changed: () => paintSessions(),
  status: () => updateStatus(),
  progress: (key) => {
    if (key === activeKey) scheduleStatusUpdate();
  },
  removed: (key) => {
    if (activeKey === key) activeKey = sessions.keys().next().value ?? 0;
    paintSessions();
  },
};
const lifecycle = createSessionLifecycle(sessionHost);
const sessions = lifecycle.sessions;
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
const modeName = (s: Session) =>
  s.mode === "demo" ? "演示" : s.mode === "ssh" ? "SSH" : s.mode === "net" ? s.netKind ?? "TCP" : "本机";
type DotState = "demo" | "live" | "ended" | "none";
/** The workbench signature: one dot per session, shared by tab, sidebar row and status bar. */
const dotState = (s: Session | undefined): DotState =>
  !s ? "none" : s.mode === "demo" ? "demo" : s.ended ? "ended" : "live";
function statusDot(s: Session) {
  const dot = document.createElement("i");
  dot.className = "status-dot";
  dot.setAttribute("aria-hidden", "true");
  dot.dataset.key = String(s.key);
  dot.dataset.state = dotState(s);
  return dot;
}
function syncDot(dot: HTMLElement, state: DotState) {
  if (dot.dataset.state !== state) dot.dataset.state = state;
}
const statusElements = {
  dot: $("#terminal-dot"),
  state: $("#terminal-state"),
  size: $("#terminal-size"),
  detail: $("#session-detail"),
  sample: $("#sample-run") as HTMLButtonElement,
  stress: $("#stress-run") as HTMLButtonElement,
  forward: $("#forward-open") as HTMLButtonElement,
  reopen: $("#local-reopen") as HTMLButtonElement,
  editCwd: $("#local-edit-cwd") as HTMLButtonElement,
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
    ? `${s.mode === "pty" ? "本机 PTY" : modeName(s)} · ${s.status}`
    : "无打开的会话";
  const size = s
    ? `${s.terminal.cols} × ${s.terminal.rows} · ${s.bytes.toLocaleString()} B 接收`
    : "";
  const detail = s
    ? s.mode === "demo"
      ? "演示环境 / 不执行系统命令"
      : s.mode === "pty" ? s.ended ? "本机 shell 已结束 / 不再发送输入" : "本机 shell / 输入将实际执行"
      : s.mode === "ssh" ? "远端 SSH / 输入将实际执行" : `远端 ${modeName(s)} / 输入将实际发送`
    : "";
  const clipboard = s?.vt.clipboardWrite ? " · OSC 52 可写剪贴板" : "";
  syncDot(statusElements.dot, dotState(s));
  for (const dot of document.querySelectorAll<HTMLElement>(".status-dot[data-key]"))
    syncDot(dot, dotState(sessions.get(Number(dot.dataset.key))));
  if (statusElements.state.textContent !== state) statusElements.state.textContent = state;
  if (statusElements.size.textContent !== size) statusElements.size.textContent = size;
  if (statusElements.detail.textContent !== detail + clipboard) statusElements.detail.textContent = detail + clipboard;
  const disabled = !s || s.mode !== "demo";
  if (statusElements.sample.disabled !== disabled) statusElements.sample.disabled = disabled;
  if (statusElements.stress.disabled !== disabled) statusElements.stress.disabled = disabled;
  statusElements.reopen.hidden = s?.mode !== "pty" || !s.ended;
  statusElements.reopen.disabled = !s || !s.ended || s.closing || s.disposed;
  statusElements.editCwd.hidden = statusElements.reopen.hidden;
  statusElements.editCwd.disabled = statusElements.reopen.disabled;
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
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = s.name;
    button.append(statusDot(s), label);
    button.onclick = () => selectSession(s.key);
    const close = document.createElement("button");
    close.className = "tab-close";
    close.setAttribute("aria-label", `关闭 ${s.name}`);
    close.innerHTML = icon("close");
    close.onclick = () => void lifecycle.close(s.key);
    tab.append(button, close);
    $("#tabs").append(tab);
    if (s.name.toLowerCase().includes(query)) {
      const row = document.createElement("button");
      row.className = `session-item ${s.key === activeKey ? "selected" : ""}`;
      const name = document.createElement("span");
      name.textContent = s.name;
      const mode = document.createElement("small");
      mode.textContent = modeName(s);
      row.append(statusDot(s), name, mode);
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
function startSshTerminal(request: SshTerminalRequest): boolean {
  if (!native) return false;
  return lifecycle.openSsh(request);
}
function startNetTerminal(request: NetTerminalRequest): boolean {
  if (!native) return false;
  return lifecycle.openNet(request);
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
  lifecycle.openDemo(`Demo ${lifecycle.nextKey}`);
$("#local-open").onclick = () => {
  if (!native) {
    toast("本地 PTY 仅在 Tauri 桌面程序中可用。请使用 npm run tauri dev。");
    return;
  }
  lifecycle.openLocal(`Local ${lifecycle.nextKey}`);
};
const localOptions = createLocalLaunchOptions(
  $("#local-dialog") as HTMLDialogElement,
  native,
  (options) => !!lifecycle.openLocal(`Local ${lifecycle.nextKey}`, options),
);
$("#local-options-open").onclick = () => localOptions.open();
$("#local-edit-cwd").onclick = () => {
  const s = active();
  if (!s || !reopenable(s)) return;
  localOptions.open(s.launch);
};
$("#local-reopen").onclick = () => {
  const s = active();
  if (!native || !s || !reopenable(s)) return;
  lifecycle.reopenLocal(s, `Local ${lifecycle.nextKey}`);
  updateStatus();
};
$("#split-toggle").onclick = () => {
  if (!split && sessions.size < 2) lifecycle.openDemo(`Demo ${lifecycle.nextKey}`);
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
  if (s?.mode === "demo") stress(s, sessionHost);
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
  if (lifecycle.openDemo(pendingName)) {
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
    button.innerHTML = `<span>${icon(index === 0 ? "folder" : "file")}<span></span></span><small></small>`;
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
    action: () => lifecycle.openDemo(`Demo ${lifecycle.nextKey}`),
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
  lifecycle.shutdown();
  for (const t of transfers) clearInterval(t.timer);
  sftpPanel.dispose();
});
$("#runtime-note").textContent = native
  ? "桌面原型 · 本地、真实 SSH、Telnet 与 Raw TCP 终端会实际执行或发送输入；文件面板可只读连接 SFTP；演示会话与传输队列仍为模拟数据。"
  : "交互原型 · 演示会话不会连接服务器，文件列表与传输均为模拟数据。";
lifecycle.openDemo("Getting started");

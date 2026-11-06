import type { ITheme, Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Channel, invoke } from "@tauri-apps/api/core";
import { createWorkspaceSession, describeVtNotice } from "./terminal";
import type { VtAdapters } from "./terminal-compat/vt-adapters";
import { authPromptsFor, type SshTerminalRequest } from "./ssh-verification";
import { netLabel, type NetTerminalRequest } from "./net-terminal";
import { snapshotLaunchOptions, type LaunchOptions } from "./local-launch";
import { responsivenessDiagnostics as diagnostics } from "./responsiveness";
import { INPUT_BACKLOG_BYTES, InputQueue } from "./input-queue";
import { Utf8Boundary } from "./utf8-boundary";
import { attachInsertTextBridge, attachKeyDefaultGuard, attachPasteGuard, sendUnmappedControl } from "./terminal-input";
import { demoInput, demoWelcome, type DemoView } from "./demo-session";
import { MAX_WORKSPACE_SESSIONS } from "./history-budget";

/**
 * Session lifecycle and terminal transport. Each session has one entry per action: open
 * (`openDemo` / `openLocal` / `openSsh` / `openNet`), input (`queueInput`), resize (`resize`),
 * output ACK (`acknowledge`), close (`close`), reopen (`reopenLocal`) and unload (`shutdown`).
 * The workbench is reached only through {@link SessionHost}; this module never reads or writes
 * workbench DOM. xterm.js remains the only screen state: output bytes go straight into it and
 * nothing here keeps a copy of the screen or the scrollback.
 */

type PtyEvent =
  | { kind: "data"; id: string; sequence: number; data: number[] }
  | { kind: "exit"; id: string; code: number | null }
  | { kind: "error"; id: string; message: string };
export type Mode = "demo" | "pty" | "ssh" | "net";
type InputSource = "user" | "reply";
export type Session = {
  key: number;
  name: string;
  mode: Mode;
  /** Deep immutable local launch configuration, held in memory only. */
  launch: LaunchOptions;
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
  /** Output channel of a native session; detached on close so it cannot keep the session alive. */
  channel?: Channel<PtyEvent>;
  input: InputQueue;
};

/** What the lifecycle asks of the workbench. Every call is synchronous and must not throw. */
export interface SessionHost extends DemoView {
  /** Colours for a new terminal. */
  theme(): ITheme;
  /** Places a new session's terminal pane in the workbench. */
  mount(pane: HTMLElement): void;
  /** A short user-facing notice. */
  notify(message: string): void;
  /** A session was registered; the workbench selects it without repainting yet. */
  registered(s: Session): void;
  /** The session's pane received focus. */
  focused(s: Session): void;
  /** Sessions or their labels changed; repaint tabs and the session list. */
  changed(): void;
  /** The session was disposed and removed from the registry. */
  removed(key: number): void;
}

export interface SessionLifecycle {
  /** Open sessions, in creation order. Read-only: only lifecycle entries add or remove. */
  readonly sessions: ReadonlyMap<number, Session>;
  /** The key the next session will receive. */
  readonly nextKey: number;
  openDemo(name: string): Session | undefined;
  /** Starts a local shell with an immutable snapshot of `options`. */
  openLocal(name: string, options?: LaunchOptions): Session | undefined;
  /** A new tab for an ended local session with its original launch options; the old tab stays. */
  reopenLocal(s: Session, name: string): Session | undefined;
  openSsh(request: SshTerminalRequest): boolean;
  openNet(request: NetTerminalRequest): boolean;
  /** Closes the backend session first; the tab is kept for retry if that fails. */
  close(key: number): Promise<void>;
  /** Page unload: disposes every terminal and best-effort closes or cancels its backend. */
  shutdown(): void;
}

/** At most this many sessions exist at once. */
const EARLY_INPUT_LIMIT = 4096;

/** IPC command prefix of the session's terminal transport. */
export const transport = (s: Session) => (s.mode === "ssh" || s.mode === "net" ? s.mode : "pty");
/** A connected SSH tab; its port forwards live and end with it in the backend. */
export function forwardable(s: Session) {
  return s.mode === "ssh" && !!s.ptyId && !s.ended && !s.closing && !s.disposed;
}
/** An ended local session whose launch options can be edited or started again. */
export function reopenable(s: Session) {
  return s.mode === "pty" && s.ended && !s.closing && !s.disposed;
}

export function createSessionLifecycle(host: SessionHost): SessionLifecycle {
  const sessions = new Map<number, Session>();
  let nextKey = 1;
  const encoder = new TextEncoder();

  function sendInput(s: Session, bytes: Uint8Array) {
    if (!s.ptyId || s.disposed || s.ended || s.closing) return;
    if (!s.input.push(bytes))
      host.notify(`输入队列已满（${INPUT_BACKLOG_BYTES / 1024 / 1024} MiB）；本次输入未发送，请等待前面的内容发送完成。`);
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
        if (discarded) host.notify(`输入发送失败；已丢弃其后尚未发送的 ${discarded.toLocaleString()} B，避免内容出现缺口。`);
      },
    });
  }
  /** Input entry: ordered writes once the native ID exists, else only a local shell's reply waits. */
  function queueInput(s: Session, bytes: Uint8Array, source: InputSource = "user") {
    if (s.ptyId) {
      sendInput(s, bytes);
      return;
    }
    // Only a local shell's explicit terminal reply is safe to replay. User
    // input must never sit in the early FIFO and execute after a delayed open.
    if (source !== "reply" || s.mode !== "pty" || s.disposed || s.ended || s.closing) return;
    if (s.earlyBytes + bytes.length > EARLY_INPUT_LIMIT) {
      host.notify("会话仍在启动，输入暂未发送；请稍后重试。");
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
  /** Resize entry for an open backend; resizes before the native ID exists are not sent. */
  function resize(s: Session, cols: number, rows: number) {
    if (s.ptyId && !s.ended && !s.closing)
      void invoke(`${transport(s)}_resize`, { id: s.ptyId, cols, rows }).catch((error) => {
        if (!s.ended) backendError(s, error);
      });
  }
  function backendError(s: Session, error: unknown) {
    if (s.disposed) return;
    s.status = `错误：${String(error)}`;
    host.status();
  }

  function createSession(name: string, mode: Mode, options?: LaunchOptions): Session | undefined {
    if (sessions.size >= MAX_WORKSPACE_SESSIONS) {
      host.notify(`P0 最多同时打开 ${MAX_WORKSPACE_SESSIONS} 个会话。`);
      return;
    }
    const element = document.createElement("section");
    element.className = "terminal-pane";
    element.setAttribute("aria-label", `${name} 终端`);
    host.mount(element);
    // Set once the session exists, so a notice can never touch `s` before its declaration.
    let owner: Session | undefined;
    let replyInputDepth = 0;
    const { terminal, vt } = createWorkspaceSession(host.theme(), {
      onNotice: (notice) => { if (owner && !owner.disposed) host.notify(`「${owner.name}」${describeVtNotice(notice)}`); },
      onReply: (active) => {
        replyInputDepth += active ? 1 : -1;
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    const s: Session = {
      key: nextKey++,
      name,
      mode,
      launch: snapshotLaunchOptions(options),
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
      host.notify(`已从粘贴内容中移除 ${removed} 个控制字符（仅保留制表符和换行）。`),
    );
    attachInsertTextBridge(terminal);
    attachKeyDefaultGuard(terminal);
    sessions.set(s.key, s);
    host.registered(s);
    terminal.onData((data) => {
      if (mode === "demo") demoInput(s, data, host);
      else queueInput(s, encoder.encode(data), replyInputDepth > 0 ? "reply" : "user");
    });
    terminal.onBinary((data) => {
      if (mode !== "demo")
        queueInput(
          s,
          Uint8Array.from(data, (c) => c.charCodeAt(0) & 255),
        );
    });
    terminal.onResize(({ cols, rows }) => {
      host.status();
      resize(s, cols, rows);
    });
    // ⌘K / Ctrl-Shift-K stay with the workbench command palette.
    terminal.attachCustomKeyEventHandler(
      (event) =>
        !(
          event.key.toLowerCase() === "k" &&
          (event.metaKey || (event.ctrlKey && event.shiftKey))
        ) && !sendUnmappedControl(terminal, event),
    );
    element.addEventListener("focusin", () => host.focused(s));
    host.changed();
    if (mode === "demo") demoWelcome(s);
    else if (mode === "pty") void startPty(s);
    terminal.focus();
    return s;
  }

  /** Shows a character the stream ended in the middle of as U+FFFD; output is over. */
  function endOutput(s: Session, utf8: Utf8Boundary) {
    const tail = utf8.flush();
    if (tail.length) s.terminal.write(tail);
  }
  /**
   * ACK entry: each chunk is acknowledged only after xterm parsed it and the preceding ACK
   * completed, so the backend's unacknowledged budget is never released early.
   */
  function acknowledge(s: Session, id: string, sequence: number, parsedAt: number) {
    s.ack = s.ack
      .then(async () => {
        if (diagnostics) {
          diagnostics.ackSubmitted++;
          diagnostics.maxAckQueueWaitMs = Math.max(diagnostics.maxAckQueueWaitMs, performance.now() - parsedAt);
        }
        if (s.disposed) return;
        await invoke(`${transport(s)}_ack`, { id, sequence });
        if (diagnostics) diagnostics.ackCompleted++;
      })
      .catch((error) => { if (!s.ended) backendError(s, error); });
  }
  function terminalChannel(s: Session) {
    const onEvent = new Channel<PtyEvent>();
    s.channel = onEvent;
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
          acknowledge(s, event.id, event.sequence, parsedAt);
          host.progress(s.key);
        });
      } else if (event.kind === "exit") {
        endOutput(s, utf8);
        s.ended = true;
        s.early = [];
        s.earlyBytes = 0;
        s.input.clear();
        s.status = `已退出 · code ${event.code ?? "unknown"}`;
        s.ptyId = undefined;
        host.status();
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

  async function startPty(s: Session) {
    const onEvent = terminalChannel(s);
    try {
      const { id } = await invoke<{ id: string }>("pty_open", {
        ...s.launch,
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
      host.status();
      // A resize failure is recoverable; it must not turn a live or exited shell
      // into a failed launch, including when exit arrives while resize is pending.
      void invoke("pty_resize", {
        id,
        cols: s.terminal.cols,
        rows: s.terminal.rows,
      }).catch((error) => {
        if (!s.ended && !s.disposed && !s.closing) backendError(s, error);
      });
    } catch (error) {
      if (s.disposed || s.ended) return;
      s.ended = true;
      s.early = [];
      s.earlyBytes = 0;
      s.input.clear();
      s.status = `启动失败：${String(error)}`;
      host.status();
      s.terminal.write("\r\n本地 PTY 启动失败。请查看底部状态，或点击「修改启动目录」修正后重试。\r\n");
    }
  }
  function openSsh(request: SshTerminalRequest): boolean {
    const s = createSession(request.name, "ssh");
    if (!s) return false;
    s.operationId = request.operationId;
    s.status = "正在认证并打开 SSH…";
    host.status();
    void startSsh(s, request);
    return true;
  }
  async function startSsh(s: Session, request: SshTerminalRequest) {
    // Prompted keyboard-interactive asks in a dialog; closing the tab cancels it.
    const prompts = authPromptsFor(request.credential, request.operationId, request.name);
    if (prompts) {
      s.status = "正在连接；请在弹出的对话框中回答服务器提示…";
      host.status();
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
      host.status();
    } catch (error) {
      if (s.disposed || s.ended) return;
      s.ended = true;
      backendError(s, error);
      s.terminal.write("\r\nSSH 连接失败。请查看底部状态，再从真实 SSH 入口重新连接。\r\n");
    } finally {
      s.operationId = undefined;
    }
  }
  function openNet(request: NetTerminalRequest): boolean {
    const s = createSession(request.name, "net");
    if (!s) return false;
    s.netKind = netLabel(request.kind);
    // The client-chosen ID can be closed while the connection is still pending.
    s.operationId = crypto.randomUUID();
    s.status = `正在连接 ${s.netKind}…`;
    host.changed();
    void startNet(s, request);
    return true;
  }
  async function startNet(s: Session, { kind, host: address, port }: NetTerminalRequest) {
    const id = s.operationId!;
    try {
      await invoke<{ id: string }>("net_open", {
        target: { kind, host: address, port }, id, onEvent: terminalChannel(s),
        cols: s.terminal.cols, rows: s.terminal.rows,
      });
      if (s.disposed || s.ended) {
        await invoke("net_close", { id });
        return;
      }
      s.ptyId = id;
      s.status = `${s.netKind} 已连接`;
      host.status();
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

  async function close(key: number) {
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
      host.notify("会话关闭失败，请重试。");
      return;
    }
    s.disposed = true;
    // The backend may still hold its channel clone until `end`; drop the handler so the
    // registered callback no longer reaches this session, its xterm or its history.
    if (s.channel) s.channel.onmessage = () => {};
    s.channel = undefined;
    s.early = [];
    s.earlyBytes = 0;
    s.input.clear();
    s.outputRun++;
    s.observer.disconnect();
    s.vt.dispose();
    s.terminal.dispose();
    s.element.remove();
    sessions.delete(key);
    host.removed(key);
  }
  function shutdown() {
    for (const s of sessions.values()) {
      s.disposed = true;
      s.outputRun++;
      s.observer.disconnect();
      s.vt.dispose();
      s.terminal.dispose();
      if (s.mode === "ssh" && s.operationId) void invoke("ssh_cancel", { operationId: s.operationId }).catch(() => {});
      else if (s.ptyId ?? s.operationId) void invoke(`${transport(s)}_close`, { id: s.ptyId ?? s.operationId }).catch(() => {});
    }
  }

  return {
    sessions,
    get nextKey() {
      return nextKey;
    },
    openDemo: (name) => createSession(name, "demo"),
    openLocal: (name, options) => createSession(name, "pty", options),
    // Keep the old terminal for inspection. A new Session owns fresh queues and
    // becomes active synchronously, so a second click cannot reopen it again.
    reopenLocal: (s, name) => (reopenable(s) ? createSession(name, "pty", s.launch) : undefined),
    openSsh,
    openNet,
    close,
    shutdown,
  };
}

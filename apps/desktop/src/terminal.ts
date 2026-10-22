import { Terminal, type ITheme } from "@xterm/xterm";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import {
  attachVtAdapters, type VtAdapterOptions, type VtAdapters, type VtNotice,
} from "./terminal-compat/vt-adapters";

export interface WorkspaceTerminal {
  readonly terminal: Terminal;
  /** Per-session VT adapters: terminal type, OSC 52 opt-in, report fixes. */
  readonly vt: VtAdapters;
}

export type WorkspaceInputSource = "user" | "reply";
export type WorkspaceInputSourceHook = (source: WorkspaceInputSource, active: boolean) => void;

/** Keep every workspace terminal on the same tested width provider and VT adapters. */
export function createWorkspaceSession(
  theme?: ITheme,
  vt: VtAdapterOptions = {},
  onInputSource?: WorkspaceInputSourceHook,
): WorkspaceTerminal {
  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: '"SFMono-Regular", Menlo, Monaco, "Cascadia Code", monospace',
    fontSize: 14,
    lineHeight: 1.45,
    scrollback: 5000,
    theme,
    // The official Unicode provider API is still marked experimental in xterm 6.
    allowProposedApi: true,
    screenReaderMode: true,
  });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = "11";
  // xterm's public onData event omits its wasUserInput flag. Preserve that
  // explicit parser/reply source before adapters capture terminal.input.
  type CoreDataService = { triggerDataEvent: (data: string, wasUserInput?: boolean) => void };
  const coreService = (terminal as unknown as { _core?: { coreService?: CoreDataService } })._core?.coreService;
  if (!coreService) throw new Error("xterm core data service unavailable");
  const triggerDataEvent = coreService.triggerDataEvent.bind(coreService);
  coreService.triggerDataEvent = (data: string, wasUserInput = false) => {
    const source: WorkspaceInputSource = wasUserInput ? "user" : "reply";
    onInputSource?.(source, true);
    try {
      return triggerDataEvent(data, wasUserInput);
    } finally {
      onInputSource?.(source, false);
    }
  };
  return { terminal, vt: attachVtAdapters(terminal, vt) };
}

export function createWorkspaceTerminal(theme?: ITheme): Terminal {
  return createWorkspaceSession(theme).terminal;
}

/** User-facing text for an adapter notice; never includes clipboard content. */
export function describeVtNotice(notice: VtNotice): string {
  switch (notice.kind) {
    case "clipboard-written":
      return `终端程序通过 OSC 52 写入了剪贴板（${notice.bytes.toLocaleString()} 字节）。可在命令面板关闭。`;
    case "clipboard-blocked":
      return "已拦截 OSC 52 剪贴板写入（默认关闭）。如信任此会话，可在命令面板为当前会话开启。";
    case "clipboard-read-denied":
      return "已拒绝终端程序读取剪贴板（OSC 52 查询在 P0 中始终禁止）。";
    case "clipboard-rejected":
      return notice.reason === "too-large"
        ? "已丢弃超过 1 MiB 的 OSC 52 剪贴板数据。"
        : "已丢弃格式无效或含控制字符的 OSC 52 剪贴板数据。";
    case "clipboard-failed":
      return "OSC 52 剪贴板写入失败：WebView 未允许写入剪贴板。";
  }
}

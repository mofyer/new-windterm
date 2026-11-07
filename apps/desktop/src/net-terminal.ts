import { isTauri } from "@tauri-apps/api/core";
import { icon } from "./icons";
import { MAX_WORKSPACE_SESSIONS } from "./history-budget";
import { DEFAULT_ENCODING, type EncodingId } from "./text-encoding";
import { createEncodingField, ENCODING_HINT, readEncoding } from "./session-encoding-ui";
import { DEFAULT_KEYBOARD, type KeyboardOptions } from "./terminal-keyboard";
import { createKeyboardField } from "./terminal-keyboard-ui";

export type NetKind = "telnet" | "raw";
/** What the desktop backend's `net_open` receives as `target`. */
export type NetTarget = { kind: NetKind; host: string; port: number };
/** `encoding` and `keyboard` stay in the frontend; `net_open` receives only the target. */
export type NetTerminalRequest = NetTarget & { name: string; encoding: EncodingId; keyboard: KeyboardOptions };

export const netLabel = (kind: NetKind) => (kind === "telnet" ? "Telnet" : "Raw TCP");

// Same character set as the backend check; anything else is refused before IPC.
const HOST = /^[A-Za-z0-9.:-]{1,253}$/;
const NOTES: Record<NetKind, string> = {
  telnet:
    "Telnet 为明文协议，输入（包括密码）不加密。终端类型报告为 xterm-256color，窗口大小通过 NAWS 告知服务器；默认按 UTF-8 显示，可在下方选择其他字符编码。",
  raw: "Raw TCP 原样收发字节，不做协议协商、不在本地回显；回车按 CR 发送，默认按 UTF-8 显示，可在下方选择其他字符编码。",
};

/**
 * Connection sheet for Telnet (C02) and raw TCP (C03) terminals. Values are
 * not saved. `openTerminal` reserves a tab and returns false when it cannot.
 */
export function createNetTerminalDialog(
  openTerminal: (request: NetTerminalRequest) => boolean,
): { open: () => void } {
  const dialog = document.createElement("dialog");
  dialog.id = "net-terminal-dialog";
  dialog.setAttribute("aria-labelledby", "net-terminal-title");
  dialog.innerHTML = `
    <div class="dialog-heading"><div><span class="eyebrow">Telnet · Raw TCP · P0</span><h2 id="net-terminal-title">打开 Telnet / Raw TCP 终端</h2></div><button type="button" id="net-close" class="icon-button" aria-label="关闭 Telnet / Raw TCP 窗口">${icon("close")}</button></div>
    <p id="net-browser-note" hidden>Telnet 与 Raw TCP 仅在 Tauri 桌面程序中可用。浏览器不会发起连接。</p>
    <form id="net-terminal-form" autocomplete="off" novalidate>
      <fieldset id="net-fields">
        <label>连接类型<select id="net-kind"><option value="telnet">Telnet</option><option value="raw">Raw TCP</option></select></label>
        <div class="form-row"><label>主机<input id="net-host" maxlength="253" placeholder="127.0.0.1" spellcheck="false"/></label><label class="port">端口<input id="net-port" type="number" value="23" min="1" max="65535"/></label></div>
        <p class="caption" id="net-note"></p>
      </fieldset>
      <p id="net-error" role="alert" aria-live="assertive"></p>
      <div class="dialog-actions"><button type="button" id="net-cancel">取消</button><button type="submit" id="net-open" class="primary">连接</button></div>
    </form>`;
  document.body.append(dialog);
  const get = <T extends HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const kind = get<HTMLSelectElement>("net-kind");
  const host = get<HTMLInputElement>("net-host");
  const port = get<HTMLInputElement>("net-port");
  const error = get("net-error");
  const { field: encodingField, select: encoding } = createEncodingField("net", ENCODING_HINT);
  get("net-note").after(encodingField);
  const keyboard = createKeyboardField("net");
  encodingField.after(keyboard.field);
  const desktop = isTauri();
  const showNote = () => {
    get("net-note").textContent = NOTES[kind.value as NetKind];
  };
  const close = () => {
    host.value = "";
    error.textContent = "";
    dialog.close();
  };
  kind.addEventListener("change", showNote);
  get("net-close").addEventListener("click", close);
  get("net-cancel").addEventListener("click", close);
  get<HTMLFormElement>("net-terminal-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!desktop) return;
    const target: NetTarget = {
      kind: kind.value === "raw" ? "raw" : "telnet",
      host: host.value.trim(),
      port: Number(port.value),
    };
    if (!HOST.test(target.host)) {
      error.textContent = "主机只能包含字母、数字、点、短横线和冒号（IPv6 不加方括号）。";
      return;
    }
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      error.textContent = "端口须为 1–65535 的整数。";
      return;
    }
    const name = `${netLabel(target.kind)} ${target.host}:${target.port}`;
    if (!openTerminal({ ...target, name, encoding: readEncoding(encoding), keyboard: keyboard.read() })) {
      error.textContent = `无法打开新标签：P0 最多同时打开 ${MAX_WORKSPACE_SESSIONS} 个会话。`;
      return;
    }
    close();
  });
  return {
    open() {
      kind.value = "telnet";
      port.value = "23";
      host.value = "";
      encoding.value = DEFAULT_ENCODING;
      keyboard.set(DEFAULT_KEYBOARD);
      error.textContent = "";
      showNote();
      get("net-browser-note").hidden = desktop;
      get<HTMLFieldSetElement>("net-fields").disabled = !desktop;
      get<HTMLButtonElement>("net-open").disabled = !desktop;
      dialog.showModal();
      (desktop ? host : get("net-close")).focus();
    },
  };
}

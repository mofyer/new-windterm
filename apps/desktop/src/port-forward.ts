import { invoke } from "@tauri-apps/api/core";

export type ForwardKind = "local" | "dynamic" | "remote";
/** One forward as `ssh_forward_add` / `ssh_forward_list` return it. */
export interface ForwardInfo {
  id: string;
  kind: ForwardKind;
  bindHost: string;
  bindPort: number;
  targetHost: string | null;
  targetPort: number | null;
  status: "active" | "stopped";
  /** Open relayed connections; null where the backend does not count them (remote). */
  connections: number | null;
}
/** What the desktop backend's `ssh_forward_add` receives as `forward`. */
export interface ForwardRequest {
  kind: ForwardKind;
  bindHost: string;
  bindPort: number;
  targetHost: string | null;
  targetPort: number | null;
}
/** The connected SSH terminal tab the sheet manages; `alive` turns false once it ends. */
export interface ForwardSession {
  id: string;
  name: string;
  alive: () => boolean;
}
export interface PortForwardSheet {
  open(session: ForwardSession): void;
}

export const MAX_FORWARDS = 16;
const POLL_MS = 1000;
// Same rules as the backend check; anything else is refused before IPC.
const LABEL = /^(?!-)[A-Za-z0-9_-]{1,63}$/;
const OCTET = /^(0|[1-9]\d{0,2})$/;
const KIND_LABEL: Record<ForwardKind, string> = { local: "本地 -L", dynamic: "动态 -D", remote: "远端 -R" };
const NOTES: Record<ForwardKind, string> = {
  local: "在本机回环地址监听；每个连接经这条 SSH 连接由服务器连到目标（目标名由服务器解析）。端口填 0 由系统分配。",
  dynamic: "在本机回环地址提供 SOCKS5 代理（无认证、仅 CONNECT），目标由连接方指定。端口填 0 由系统分配。",
  remote: "请服务器在其监听地址开放端口，连接经 SSH 回到本机的目标。端口填 0 由服务器选择；能否监听非回环地址取决于服务器设置。",
};

/** `host:port`, with IPv6 literals in brackets. */
export function formatEndpoint(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** The canonical form of an IPv6 literal (no brackets), or undefined. */
function ipv6(host: string): string | undefined {
  if (!/^[0-9A-Fa-f:.]+$/.test(host)) return undefined;
  try {
    return new URL(`http://[${host}]/`).hostname.slice(1, -1);
  } catch {
    return undefined;
  }
}

/** A host name (dot-separated labels of letters, digits, `-`, `_`) or an IP literal; IPv6 without brackets. */
export function isValidHost(host: string): boolean {
  if (host.includes(":")) return ipv6(host) !== undefined;
  return host.length <= 253 && host.split(".").every((label) => LABEL.test(label));
}

/** A loopback IP literal (127.0.0.0/8 or any spelling of ::1), as the backend requires for local listeners. */
export function isLoopbackLiteral(host: string): boolean {
  if (host.includes(":")) return ipv6(host) === "::1";
  const octets = host.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((o) => OCTET.test(o) && Number(o) <= 255);
}

function port(text: string, min: number): number | undefined {
  const value = Number(text);
  return text.trim() !== "" && Number.isInteger(value) && value >= min && value <= 65535 ? value : undefined;
}

/** Validates form text into a request, or returns a message for the user. */
export function forwardRequest(
  kind: ForwardKind,
  bindHost: string,
  bindPortText: string,
  targetHost: string,
  targetPortText: string,
): ForwardRequest | string {
  const bindPort = port(bindPortText, 0);
  if (bindPort === undefined) return "监听端口须为 0–65535 的整数（0 表示自动分配）。";
  if (kind === "remote" ? !isValidHost(bindHost) : !isLoopbackLiteral(bindHost)) {
    return kind === "remote"
      ? "服务器监听地址须为主机名或 IP 地址（IPv6 不加方括号）。"
      : "本地与动态转发只能监听回环 IP（127.x.x.x 或 ::1）。";
  }
  if (kind === "dynamic") return { kind, bindHost, bindPort, targetHost: null, targetPort: null };
  const target = port(targetPortText, 1);
  if (!isValidHost(targetHost)) return "目标主机须为主机名或 IP 地址（IPv6 不加方括号）。";
  if (target === undefined) return "目标端口须为 1–65535 的整数。";
  return { kind, bindHost, bindPort, targetHost, targetPort: target };
}

function describe(forward: ForwardInfo): { bind: string; target: string; status: string } {
  const bind = formatEndpoint(forward.bindHost, forward.bindPort);
  const target =
    forward.targetHost === null || forward.targetPort === null
      ? "SOCKS5 · 由连接方指定"
      : formatEndpoint(forward.targetHost, forward.targetPort);
  const status =
    forward.status === "stopped"
      ? "已停止"
      : forward.connections === null
        ? "服务器监听中"
        : `监听中 · ${forward.connections} 个连接`;
  return {
    bind: forward.kind === "remote" ? `服务器 ${bind}` : `本机 ${bind}`,
    target: forward.kind === "remote" ? `本机 ${target}` : target,
    status,
  };
}

const failure = (reason: unknown) => (typeof reason === "string" ? reason : "端口转发操作失败。");

/**
 * "端口转发" sheet for one connected SSH terminal (C16/C17/C18). The backend
 * owns the forwards and closes them with the terminal; nothing is saved.
 * Every value is rendered as text.
 */
export function createPortForwardSheet(): PortForwardSheet {
  const dialog = document.createElement("dialog");
  dialog.id = "port-forward-dialog";
  dialog.setAttribute("aria-labelledby", "forward-title");
  dialog.innerHTML = `
    <div class="dialog-heading"><div><span class="eyebrow">SSH · 端口转发 · P0</span><h2 id="forward-title">端口转发</h2></div><button type="button" id="forward-close" aria-label="关闭端口转发">✕</button></div>
    <strong id="forward-session"></strong>
    <p id="forward-ended" hidden>SSH 会话已结束，它的端口转发已随之关闭。</p>
    <section aria-label="当前转发"><div class="forward-head"><span>类型</span><span>监听</span><span>目标</span><span>状态</span><span id="forward-count" aria-label="当前转发数"></span></div><div id="forward-list" role="list"></div></section>
    <form id="forward-form" autocomplete="off" novalidate>
      <fieldset id="forward-fields">
        <label>转发类型<select id="forward-kind"><option value="local">本地转发（-L）</option><option value="dynamic">动态转发 · SOCKS5（-D）</option><option value="remote">远端转发（-R）</option></select></label>
        <div class="form-row"><label id="forward-bind-label">本机监听地址<input id="forward-bind-host" maxlength="253" spellcheck="false"/></label><label class="port">端口<input id="forward-bind-port" type="number" min="0" max="65535"/></label></div>
        <div class="form-row" id="forward-target-row"><label>目标主机<input id="forward-target-host" maxlength="253" placeholder="127.0.0.1" spellcheck="false"/></label><label class="port">端口<input id="forward-target-port" type="number" min="1" max="65535"/></label></div>
        <p class="caption" id="forward-note"></p>
      </fieldset>
      <p id="forward-status" role="status" aria-live="polite"></p>
      <p id="forward-error" role="alert" aria-live="assertive"></p>
      <div class="dialog-actions"><button type="button" id="forward-refresh">刷新</button><button type="submit" id="forward-add" class="primary">添加转发</button></div>
    </form>
    <p class="caption">转发只属于这个 SSH 标签：关闭标签、刷新页面、关闭窗口或退出应用都会关闭监听并取消远端转发。配置不保存。</p>`;
  document.body.append(dialog);
  const get = <T extends HTMLElement = HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const kind = get<HTMLSelectElement>("forward-kind");
  const bindHost = get<HTMLInputElement>("forward-bind-host");
  const bindPort = get<HTMLInputElement>("forward-bind-port");
  const targetHost = get<HTMLInputElement>("forward-target-host");
  const targetPort = get<HTMLInputElement>("forward-target-port");
  const list = get("forward-list");
  const status = get("forward-status");
  const error = get("forward-error");
  const addButton = get<HTMLButtonElement>("forward-add");

  let session: ForwardSession | undefined;
  let forwards: ForwardInfo[] = [];
  let revision = 0; // Bumped on open and close; stale replies are dropped.
  let listing = 0; // Newest list request; replies to older ones are dropped.
  // True while the newest list request is pending. A superseded request does
  // not clear it, so a poll tick may be skipped until the newest one returns.
  let listInFlight = false;
  let busy = false;
  let ended = false;
  let timer: number | undefined;

  const kindValue = (): ForwardKind =>
    kind.value === "dynamic" || kind.value === "remote" ? kind.value : "local";
  function paintForm() {
    const current = kindValue();
    get("forward-target-row").hidden = current === "dynamic";
    get("forward-bind-label").firstChild!.textContent = current === "remote" ? "服务器监听地址" : "本机监听地址";
    get("forward-note").textContent = NOTES[current];
    get<HTMLFieldSetElement>("forward-fields").disabled = ended;
    addButton.disabled = ended || busy;
    get<HTMLButtonElement>("forward-refresh").disabled = ended;
  }
  function paintList() {
    list.replaceChildren();
    get("forward-count").textContent = ended ? "" : `${forwards.length} / ${MAX_FORWARDS}`;
    for (const forward of forwards) {
      const { bind, target, status: state } = describe(forward);
      const row = document.createElement("div");
      row.className = "forward-row";
      row.setAttribute("role", "listitem");
      row.dataset.kind = forward.kind;
      for (const text of [KIND_LABEL[forward.kind], bind, target, state]) {
        const cell = document.createElement("span");
        cell.textContent = text;
        row.append(cell);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "移除";
      remove.setAttribute("aria-label", `移除 ${bind}`);
      remove.disabled = busy || ended;
      remove.onclick = () => void removeForward(forward);
      row.append(remove);
      list.append(row);
    }
    if (!forwards.length) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = ended ? "会话已结束。" : "暂无转发。";
      list.append(empty);
    }
  }
  function paint() {
    paintForm();
    paintList();
  }
  function markEnded() {
    if (ended) return;
    ended = true;
    forwards = [];
    status.textContent = "";
    get("forward-ended").hidden = false;
    stopPolling();
    paint();
  }
  /** False (and the sheet shows the ended state) once the terminal is gone. */
  function current(): ForwardSession | undefined {
    if (session && !session.alive()) markEnded();
    return ended ? undefined : session;
  }
  /** Polls skip while a list is pending; `force` (after a change) supersedes it. */
  async function refresh(force = false) {
    const target = current();
    if (!target || (listInFlight && !force)) return;
    const version = revision;
    const sequence = ++listing;
    listInFlight = true;
    try {
      const result = await invoke<ForwardInfo[]>("ssh_forward_list", { id: target.id });
      if (version === revision && sequence === listing && Array.isArray(result)) {
        forwards = result.slice(0, MAX_FORWARDS);
        paintList();
      }
    } catch (reason) {
      if (version !== revision || sequence !== listing) return;
      if (!target.alive()) markEnded();
      else error.textContent = failure(reason);
    } finally {
      if (sequence === listing) listInFlight = false;
    }
  }
  function stopPolling() {
    window.clearInterval(timer);
    timer = undefined;
  }
  async function run(action: () => Promise<string>) {
    const version = revision;
    busy = true;
    error.textContent = "";
    paint();
    try {
      const message = await action();
      // `current()` shows the ended state instead if the session ended meanwhile.
      if (version === revision && current()) status.textContent = message;
    } catch (reason) {
      if (version === revision && current()) error.textContent = failure(reason);
    } finally {
      if (version === revision) {
        busy = false;
        paint();
        await refresh(true);
      }
    }
  }
  async function removeForward(forward: ForwardInfo) {
    const target = current();
    if (!target || busy) return;
    const { bind } = describe(forward);
    await run(async () => {
      await invoke("ssh_forward_remove", { id: target.id, forwardId: forward.id });
      forwards = forwards.filter((item) => item.id !== forward.id);
      return `已移除 ${bind}`;
    });
  }

  kind.addEventListener("change", () => {
    error.textContent = "";
    paintForm();
  });
  get<HTMLFormElement>("forward-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const target = current();
    if (!target || busy) return;
    if (forwards.length >= MAX_FORWARDS) {
      error.textContent = `每个 SSH 会话最多 ${MAX_FORWARDS} 个转发；请先移除一个。`;
      return;
    }
    const request = forwardRequest(kindValue(), bindHost.value.trim(), bindPort.value, targetHost.value.trim(), targetPort.value);
    if (typeof request === "string") {
      error.textContent = request;
      return;
    }
    void run(async () => {
      const added = await invoke<ForwardInfo>("ssh_forward_add", { id: target.id, forward: request });
      const { bind, target: to } = describe(added);
      return `已添加${KIND_LABEL[added.kind]}：${bind} → ${to}`;
    });
  });
  get("forward-refresh").addEventListener("click", () => void refresh(true));
  get("forward-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    revision++;
    stopPolling();
    session = undefined;
    busy = listInFlight = false;
  });

  return {
    open(next) {
      revision++;
      session = next;
      forwards = [];
      busy = listInFlight = ended = false;
      get("forward-session").textContent = next.name;
      get("forward-ended").hidden = true;
      status.textContent = error.textContent = "";
      kind.value = "local";
      bindHost.value = "127.0.0.1";
      bindPort.value = "0";
      targetHost.value = "";
      targetPort.value = "";
      paint();
      dialog.showModal();
      targetHost.focus();
      stopPolling();
      timer = window.setInterval(() => void refresh(), POLL_MS);
      void refresh();
    },
  };
}

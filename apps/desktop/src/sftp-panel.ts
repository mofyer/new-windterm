import { invoke } from "@tauri-apps/api/core";
import type { SshTerminalRequest } from "./ssh-verification";

type RemoteKind = "directory" | "file" | "symlink" | "other";
interface RemoteEntry {
  name: string;
  kind: RemoteKind;
  size: number;
  mode: number | null;
  modifiedUnixSeconds: number | null;
}
interface RemoteListing { path: string; entries: RemoteEntry[]; truncated: boolean }
interface SftpOpened { grantToken: string; idleSeconds: number; listing: RemoteListing }
interface Selection { entry: RemoteEntry; path: string; resolved?: RemoteEntry }

export interface SftpPanel {
  /** Takes ownership of a confirmed challenge; false when a browser is already active. */
  open(request: SshTerminalRequest): boolean;
  dispose(): void;
}

const MAX_PREVIEW_BYTES = 64 * 1024;
const HEX_PREVIEW_BYTES = 512;
// Shared suffix of backend errors after the grant was expired or revoked.
const RECONNECT_MARKER = "reconnect and verify the host again";
const KIND_LABEL: Record<RemoteKind, string> = { directory: "目录", file: "文件", symlink: "符号链接", other: "其他" };

export function joinRemotePath(parent: string, name: string): string {
  return parent.endsWith("/") ? `${parent}${name}` : `${parent}/${name}`;
}
export function parentRemotePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : trimmed.slice(0, index);
}
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}
export function formatMode(kind: RemoteKind, mode: number | null): string {
  if (mode === null) return "未知";
  const type = kind === "directory" ? "d" : kind === "symlink" ? "l" : "-";
  const bits = [0o400, 0o200, 0o100, 0o40, 0o20, 0o10, 0o4, 0o2, 0o1];
  return type + bits.map((bit, index) => (mode & bit ? "rwx"[index % 3] : "-")).join("");
}

// Mirrors the main workspace inspector. Every remote string is rendered with
// textContent; the backend owns trust, keys and the grant lifetime.
export function createSftpPanel(root: HTMLElement, toast: (message: string) => void): SftpPanel {
  const demo = root.querySelector<HTMLElement>("#file-demo")!;
  const view = root.querySelector<HTMLElement>("#sftp-view")!;
  view.innerHTML = `
    <div class="inspector-title"><strong>文件浏览器</strong><span class="badge">SFTP · 只读</span></div>
    <div class="sftp-host"><span id="sftp-host"></span><button type="button" id="sftp-disconnect">断开</button></div>
    <div class="sftp-toolbar"><button type="button" id="sftp-up" aria-label="上级目录">上级</button><button type="button" id="sftp-refresh">刷新</button></div>
    <code id="sftp-path"></code>
    <div class="sftp-status"><span id="sftp-status" role="status" aria-live="polite"></span><button type="button" id="sftp-cancel" hidden>取消</button></div>
    <p id="sftp-error" role="alert" aria-live="assertive"></p>
    <button type="button" id="sftp-reconnect" class="ssh-verification-entry" hidden>重新连接并核对指纹</button>
    <div class="file-head"><span>名称</span><span>大小</span></div>
    <div id="sftp-list" aria-label="远端文件"></div>
    <p id="sftp-truncated" class="caption" hidden></p>
    <section id="sftp-detail" hidden aria-label="远端文件属性"><dl id="sftp-properties"></dl>
      <div class="sftp-actions"><button type="button" id="sftp-enter">打开目录</button><button type="button" id="sftp-resolve">解析链接</button><button type="button" id="sftp-preview">预览前 64 KiB</button></div>
      <p id="sftp-preview-note" class="caption"></p><pre id="sftp-preview-text" hidden></pre></section>
    <p class="caption">只读：不提供上传、删除、改名或权限修改；预览不写入本机文件。</p>`;
  const get = <T extends HTMLElement = HTMLElement>(id: string) => view.querySelector<T>(`#${id}`)!;
  const status = get("sftp-status");
  const error = get("sftp-error");
  const cancel = get<HTMLButtonElement>("sftp-cancel");
  const list = get("sftp-list");
  const detail = get("sftp-detail");
  const previewText = get("sftp-preview-text");
  const previewNote = get("sftp-preview-note");
  const actionButtons = ["sftp-up", "sftp-refresh", "sftp-enter", "sftp-resolve", "sftp-preview"].map(id => get<HTMLButtonElement>(id));

  let scopeToken: string | undefined;
  let grantToken: string | undefined;
  let listing: RemoteListing | undefined;
  let selection: Selection | undefined;
  let busy: string | undefined; // In-flight operation ID; one at a time.
  let revision = 0;

  const show = (real: boolean) => {
    demo.hidden = real;
    view.hidden = !real;
  };
  const setBusy = (operationId: string | undefined, message = "") => {
    busy = operationId;
    cancel.hidden = !operationId;
    status.textContent = message;
    view.toggleAttribute("aria-busy", Boolean(operationId));
    paintActions();
    for (const row of list.querySelectorAll<HTMLButtonElement>("button")) row.disabled = Boolean(operationId);
  };
  const expired = (message: string) => {
    grantToken = undefined;
    error.textContent = message;
    status.textContent = "SFTP 授权已失效；请重新连接并再次核对主机指纹。";
    get("sftp-reconnect").hidden = false;
    paintActions();
  };
  const failed = (reason: unknown) => {
    const message = typeof reason === "string" ? reason : "SFTP 操作失败。";
    if (message.includes(RECONNECT_MARKER)) expired(message);
    else error.textContent = message;
  };

  function target(): RemoteEntry | undefined {
    return selection?.resolved ?? selection?.entry;
  }
  function paintActions() {
    const idle = !busy && Boolean(grantToken);
    const current = target();
    const [up, refresh, enter, resolve, preview] = actionButtons;
    up.disabled = !idle || !listing || listing.path === "/";
    refresh.disabled = !idle || !listing;
    enter.hidden = current?.kind !== "directory";
    enter.disabled = !idle;
    resolve.hidden = selection?.entry.kind !== "symlink" || Boolean(selection.resolved);
    resolve.disabled = !idle;
    preview.hidden = current?.kind !== "file";
    preview.disabled = !idle || !current || current.size > MAX_PREVIEW_BYTES;
    if (current?.kind === "file" && current.size > MAX_PREVIEW_BYTES && !previewText.textContent) {
      previewNote.textContent = "文件超过 64 KiB，P0 不提供预览或下载。";
    }
  }
  function paintList() {
    list.replaceChildren();
    if (!listing) return;
    const directory = listing.path;
    get("sftp-path").textContent = directory;
    get("sftp-path").title = directory;
    const entries = [...listing.entries].sort((a, b) =>
      Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
    for (const entry of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `file-row ${selection?.entry === entry ? "selected" : ""}`;
      row.dataset.kind = entry.kind;
      const name = document.createElement("span");
      const label = document.createElement("span");
      label.textContent = entry.name;
      name.append(document.createTextNode(entry.kind === "directory" ? "▸ " : entry.kind === "symlink" ? "↪ " : "· "), label);
      const size = document.createElement("small");
      size.textContent = entry.kind === "directory" ? "目录" : entry.kind === "file" ? formatSize(entry.size) : KIND_LABEL[entry.kind];
      row.append(name, size);
      row.disabled = Boolean(busy);
      row.onclick = () => select(entry);
      row.ondblclick = () => { if (entry.kind === "directory") void navigate(joinRemotePath(directory, entry.name)); };
      list.append(row);
    }
    if (!entries.length) list.textContent = "目录为空";
    const truncated = get("sftp-truncated");
    truncated.hidden = !listing.truncated;
    truncated.textContent = listing.truncated ? `仅显示前 ${listing.entries.length} 项；其余条目未读取。` : "";
  }
  function paintDetail() {
    detail.hidden = !selection;
    const properties = get("sftp-properties");
    properties.replaceChildren();
    if (!selection) return;
    const current = target()!;
    const rows: [string, string][] = [
      ["名称", selection.entry.name],
      ["类型", selection.resolved ? `符号链接 → ${KIND_LABEL[current.kind]}` : KIND_LABEL[current.kind]],
      ["大小", current.kind === "directory" ? "—" : `${formatSize(current.size)}（${current.size.toLocaleString()} B）`],
      ["权限", formatMode(current.kind, current.mode)],
      ["修改时间", current.modifiedUnixSeconds === null ? "未知" : new Date(current.modifiedUnixSeconds * 1000).toLocaleString("zh-CN", { hour12: false })],
    ];
    for (const [term, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = value;
      properties.append(dt, dd);
    }
    paintActions();
  }
  function clearPreview() {
    previewText.hidden = true;
    previewText.textContent = previewNote.textContent = "";
  }
  function select(entry: RemoteEntry) {
    // The backend already rejects such names; never build a path from one.
    if (busy || !listing || entry.name.includes("/") || entry.name === "." || entry.name === "..") return;
    selection = { entry, path: joinRemotePath(listing.path, entry.name) };
    error.textContent = "";
    clearPreview();
    paintList();
    paintDetail();
  }

  async function run<T>(command: string, args: Record<string, unknown>, message: string): Promise<T | undefined> {
    if (busy || !grantToken || !scopeToken) return;
    const version = ++revision;
    const operationId = crypto.randomUUID();
    error.textContent = "";
    setBusy(operationId, message);
    try {
      const result = await invoke<T>(command, { ...args, grantToken, scopeToken, operationId });
      return version === revision ? result : undefined;
    } catch (reason) {
      if (version === revision) failed(reason);
      return;
    } finally {
      if (version === revision) setBusy(undefined);
    }
  }
  async function navigate(path: string) {
    const result = await run<RemoteListing>("ssh_sftp_list", { path }, "正在读取目录…可随时取消。");
    if (!result) return;
    listing = result;
    selection = undefined;
    clearPreview();
    paintList();
    paintDetail();
    paintActions();
  }
  async function resolveLink() {
    if (!selection) return;
    const current = selection;
    const result = await run<RemoteEntry>("ssh_sftp_metadata", { path: current.path }, "正在解析链接目标…");
    if (!result || selection !== current) return;
    selection = { ...current, resolved: result };
    paintDetail();
  }
  async function preview() {
    const current = selection;
    const file = target();
    if (!current || file?.kind !== "file") return;
    const bytes = await run<number[]>("ssh_sftp_read", { path: current.path }, "正在读取文件预览…可随时取消。");
    if (!bytes || selection !== current) return;
    const data = Uint8Array.from(bytes);
    let text: string | undefined;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { text = undefined; }
    if (text !== undefined && !text.includes("\u0000")) {
      previewText.textContent = text || "（空文件）";
      previewNote.textContent = `UTF-8 文本 · ${data.length.toLocaleString()} B`;
    } else {
      previewText.textContent = Array.from(data.subarray(0, HEX_PREVIEW_BYTES), byte => byte.toString(16).padStart(2, "0")).join(" ");
      previewNote.textContent = `二进制或非 UTF-8 内容 · 显示前 ${Math.min(data.length, HEX_PREVIEW_BYTES)} / ${data.length.toLocaleString()} 字节（十六进制）`;
    }
    previewText.hidden = false;
  }
  function cancelCurrent() {
    if (!busy) return;
    const operationId = busy;
    revision++;
    setBusy(undefined, "已取消；远端未修改任何文件。");
    if (!grantToken) get("sftp-reconnect").hidden = false;
    void invoke("ssh_cancel", { operationId }).catch(() => toast("取消请求失败；操作将在 15 秒期限内结束。"));
  }
  function reset() {
    revision++;
    grantToken = scopeToken = listing = selection = undefined;
    setBusy(undefined);
    error.textContent = "";
    get("sftp-reconnect").hidden = true;
    clearPreview();
    paintList();
    paintDetail();
    show(false);
  }
  function release() {
    if (busy) void invoke("ssh_cancel", { operationId: busy }).catch(() => {});
    const token = grantToken;
    reset();
    if (token) {
      void invoke("ssh_sftp_close", { grantToken: token }).catch(() =>
        toast("SFTP 授权未能立即释放；它会在 5 分钟空闲后失效。"));
    }
  }

  get("sftp-up").onclick = () => { if (listing) void navigate(parentRemotePath(listing.path)); };
  get("sftp-refresh").onclick = () => { if (listing) void navigate(listing.path); };
  get("sftp-enter").onclick = () => { if (selection) void navigate(selection.path); };
  get("sftp-resolve").onclick = () => void resolveLink();
  get("sftp-preview").onclick = () => void preview();
  cancel.onclick = cancelCurrent;
  get("sftp-disconnect").onclick = () => { release(); toast("已断开 SFTP 文件浏览；未保存主机信任。"); };
  get("sftp-reconnect").onclick = () => { release(); root.dispatchEvent(new CustomEvent("sftp-reconnect")); };

  return {
    open(request) {
      if (busy || grantToken) return false;
      reset();
      show(true);
      scopeToken = request.scopeToken;
      get("sftp-host").textContent = request.name;
      const version = ++revision;
      setBusy(request.operationId, "正在认证并读取登录目录…可随时取消。");
      void invoke<SftpOpened>("ssh_sftp_open", {
        challengeToken: request.challengeToken, operationId: request.operationId, scopeToken: request.scopeToken,
        credential: request.credential,
      }).then(opened => {
        if (version !== revision) {
          // Cancelled or disconnected while opening: release the late grant.
          void invoke("ssh_sftp_close", { grantToken: opened.grantToken }).catch(() => {});
          return;
        }
        grantToken = opened.grantToken;
        listing = opened.listing;
        setBusy(undefined, `已连接 · 空闲 ${Math.round(opened.idleSeconds / 60)} 分钟后需重新核对指纹`);
        paintList();
        paintDetail();
      }, reason => {
        if (version !== revision) return;
        setBusy(undefined);
        failed(reason);
        get("sftp-reconnect").hidden = false;
      });
      return true;
    },
    dispose: release,
  };
}

import { Channel, invoke } from "@tauri-apps/api/core";
import type { AuthPrompt } from "./ssh-kbdint";
import { authPromptsFor, type SshCredential, type SshTerminalRequest } from "./ssh-verification";
import {
  askSftp, dismissSftpDialog, parseMode, remoteNameError, uploadHeaders,
  MAX_DOWNLOAD_BYTES, MAX_UPLOAD_BYTES, READ_ONLY_ERROR, type AskOptions, type Downloaded, type TransferProgress,
} from "./sftp-write";
import { scpUploadHeaders, SCP_NOTE, SCP_OPTION_LABEL, SCP_UPLOAD_CANCELLED } from "./sftp-scp";

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
/** Arguments every grant-based command needs. */
interface Common { grantToken: string; scopeToken: string; operationId: string; onAuth?: Channel<AuthPrompt> }
type Change =
  | { kind: "mkdir"; path: string }
  | { kind: "rename"; from: string; to: string }
  | { kind: "removeFile"; path: string }
  | { kind: "removeDir"; path: string }
  | { kind: "chmod"; path: string; mode: number };

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
// What cancelling may have left behind, per kind of operation.
const READ_CANCELLED = "已取消；远端未修改任何文件。";
const CHANGE_CANCELLED = "已取消；该修改可能已在服务器上完成，请刷新核对。";
const UPLOAD_CANCELLED = "已取消；目标文件名不会出现不完整内容，但远端可能留下以 .part 结尾的隐藏临时文件，请刷新核对。";
const OVERWRITE_CANCELLED = "已取消；被覆盖的远端文件可能已不完整，请刷新核对。";
const DOWNLOAD_CANCELLED = "已取消；未完成的本地文件会被删除（取消前已完成的下载会完整保留在“下载”文件夹），远端未修改。";

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
    <div class="inspector-title"><strong>文件浏览器</strong><span class="badge" id="sftp-mode">SFTP · 只读</span></div>
    <div class="sftp-host"><span id="sftp-host"></span><button type="button" id="sftp-disconnect">断开</button></div>
    <div class="sftp-toolbar"><button type="button" id="sftp-up" aria-label="上级目录">上级</button><button type="button" id="sftp-refresh">刷新</button><button type="button" id="sftp-writable" aria-pressed="false">允许写入…</button></div>
    <label class="sftp-scp"><input type="checkbox" id="sftp-scp" /><span id="sftp-scp-label"></span></label>
    <p id="sftp-scp-note" class="caption" hidden></p>
    <div class="sftp-toolbar" id="sftp-write-tools" hidden><button type="button" id="sftp-mkdir">新建目录…</button><button type="button" id="sftp-touch">新建空文件…</button><button type="button" id="sftp-upload">上传文件…</button><input type="file" id="sftp-upload-input" hidden /></div>
    <code id="sftp-path"></code>
    <div class="sftp-status"><span id="sftp-status" role="status" aria-live="polite"></span><button type="button" id="sftp-cancel" hidden>取消</button></div>
    <progress id="sftp-progress" max="1" value="0" hidden></progress>
    <p id="sftp-error" role="alert" aria-live="assertive"></p>
    <button type="button" id="sftp-reconnect" class="ssh-verification-entry" hidden>重新连接并核对指纹</button>
    <div class="file-head"><span>名称</span><span>大小</span></div>
    <div id="sftp-list" aria-label="远端文件"></div>
    <p id="sftp-truncated" class="caption" hidden></p>
    <section id="sftp-detail" hidden aria-label="远端文件属性"><dl id="sftp-properties"></dl>
      <div class="sftp-actions"><button type="button" id="sftp-enter">打开目录</button><button type="button" id="sftp-resolve">解析链接</button><button type="button" id="sftp-preview">预览前 64 KiB</button><button type="button" id="sftp-download">下载到“下载”文件夹</button></div>
      <div class="sftp-actions" id="sftp-entry-tools" hidden><button type="button" id="sftp-rename">重命名…</button><button type="button" id="sftp-chmod">修改权限…</button><button type="button" id="sftp-delete">删除…</button></div>
      <p id="sftp-preview-note" class="caption"></p><pre id="sftp-preview-text" hidden></pre></section>
    <p class="caption" id="sftp-boundary"></p>`;
  const get = <T extends HTMLElement = HTMLElement>(id: string) => view.querySelector<T>(`#${id}`)!;
  const status = get("sftp-status");
  const error = get("sftp-error");
  const cancel = get<HTMLButtonElement>("sftp-cancel");
  const list = get("sftp-list");
  const detail = get("sftp-detail");
  const previewText = get("sftp-preview-text");
  const previewNote = get("sftp-preview-note");
  const progress = get<HTMLProgressElement>("sftp-progress");
  const uploadInput = get<HTMLInputElement>("sftp-upload-input");
  const scpToggle = get<HTMLInputElement>("sftp-scp");
  get("sftp-scp-label").textContent = SCP_OPTION_LABEL;
  get("sftp-scp-note").textContent = SCP_NOTE;
  const actionButtons = ["sftp-up", "sftp-refresh", "sftp-enter", "sftp-resolve", "sftp-preview"].map(id => get<HTMLButtonElement>(id));
  const writeButtons = ["sftp-mkdir", "sftp-touch", "sftp-upload", "sftp-rename", "sftp-chmod", "sftp-delete"].map(id => get<HTMLButtonElement>(id));

  let scopeToken: string | undefined;
  let grantToken: string | undefined;
  let listing: RemoteListing | undefined;
  let selection: Selection | undefined;
  let busy: string | undefined; // In-flight operation ID; one at a time.
  let cancelNote = READ_CANCELLED;
  // Mirrors the backend switch; a new grant always starts read-only.
  let writable = false;
  // A confirmation is open: actions wait for it like for a busy operation.
  let asking = false;
  // Single-file transfers use legacy SCP instead of SFTP; off for every new grant.
  let scp = false;
  let revision = 0;
  // A prompted grant keeps no answers, so every reconnect asks the user again.
  let credential: SshCredential | undefined;
  let hostName = "";

  const show = (real: boolean) => {
    demo.hidden = real;
    view.hidden = !real;
  };
  const setBusy = (operationId: string | undefined, message = "") => {
    busy = operationId;
    cancel.hidden = !operationId;
    status.textContent = message;
    progress.hidden = true;
    view.toggleAttribute("aria-busy", Boolean(operationId));
    paintActions();
    for (const row of list.querySelectorAll<HTMLButtonElement>("button")) row.disabled = Boolean(operationId);
  };
  const expired = (message: string) => {
    grantToken = undefined;
    setWritable(false);
    error.textContent = message;
    status.textContent = "SFTP 授权已失效；请重新连接并再次核对主机指纹。";
    get("sftp-reconnect").hidden = false;
    paintActions();
  };
  const failed = (reason: unknown) => {
    const message = typeof reason === "string" ? reason : "SFTP 操作失败。";
    if (message.includes(RECONNECT_MARKER)) expired(message);
    else error.textContent = message;
    if (message === READ_ONLY_ERROR) setWritable(false);
  };
  function setWritable(value: boolean) {
    writable = value;
    get("sftp-mode").textContent = value ? "SFTP · 可写" : "SFTP · 只读";
    get("sftp-boundary").textContent = value
      ? "已允许写入（仅本次授权）：删除、覆盖和权限修改仍逐项确认；不递归删除。"
      : "只读：允许写入前不会修改远端文件。下载保存到本机“下载”文件夹，不覆盖已有文件。";
    paintActions();
  }

  async function ask(options: AskOptions): Promise<string | null> {
    asking = true;
    paintActions();
    try {
      return await askSftp(options);
    } finally {
      asking = false;
      paintActions();
    }
  }

  function target(): RemoteEntry | undefined {
    return selection?.resolved ?? selection?.entry;
  }
  function paintActions() {
    const idle = !busy && !asking && Boolean(grantToken);
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
      previewNote.textContent = current.size > MAX_DOWNLOAD_BYTES
        ? "文件超过 64 KiB，P0 不提供预览；超过 64 MiB，也不提供下载。"
        : "文件超过 64 KiB，P0 不提供预览；可下载到本机。";
    }
    const download = get<HTMLButtonElement>("sftp-download");
    download.hidden = current?.kind !== "file";
    download.disabled = !idle || !current || current.size > MAX_DOWNLOAD_BYTES;
    download.textContent = scp ? "用 SCP 下载到“下载”文件夹" : "下载到“下载”文件夹";
    get("sftp-upload").textContent = scp ? "用 SCP 上传文件…" : "上传文件…";
    scpToggle.checked = scp;
    scpToggle.disabled = !idle;
    get("sftp-scp-note").hidden = !scp;
    const writableButton = get<HTMLButtonElement>("sftp-writable");
    writableButton.textContent = writable ? "恢复只读" : "允许写入…";
    writableButton.setAttribute("aria-pressed", String(writable));
    writableButton.disabled = !idle;
    get("sftp-write-tools").hidden = !writable;
    get("sftp-entry-tools").hidden = !writable || !selection || selection.entry.kind === "other";
    get("sftp-chmod").hidden = selection?.entry.kind === "symlink";
    for (const button of writeButtons) button.disabled = !idle || !writable || !listing;
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
    if (busy || asking || !listing || entry.name.includes("/") || entry.name === "." || entry.name === "..") return;
    selection = { entry, path: joinRemotePath(listing.path, entry.name) };
    error.textContent = "";
    clearPreview();
    paintList();
    paintDetail();
  }

  // Resolves undefined after a failure, cancellation or a newer operation.
  async function run<T>(message: string, perform: (common: Common) => Promise<T>, cancelled = READ_CANCELLED): Promise<T | undefined> {
    if (busy || asking || !grantToken || !scopeToken) return;
    const version = ++revision;
    const operationId = crypto.randomUUID();
    const prompts = credential && authPromptsFor(credential, operationId, hostName);
    error.textContent = "";
    cancelNote = cancelled;
    setBusy(operationId, prompts ? `${message}（服务器要求重新回答键盘交互提示）` : message);
    try {
      const result = await perform({ grantToken, scopeToken, operationId, onAuth: prompts?.channel });
      return version === revision ? result : undefined;
    } catch (reason) {
      if (version === revision) failed(reason);
      return;
    } finally {
      prompts?.finish();
      if (version === revision) setBusy(undefined);
    }
  }
  const command = <T>(name: string, args: Record<string, unknown>) =>
    (common: Common) => invoke<T>(name, { ...args, ...common });
  async function navigate(path: string, reselect?: string): Promise<boolean> {
    const result = await run("正在读取目录…可随时取消。", command<RemoteListing>("ssh_sftp_list", { path }));
    if (!result) return false;
    listing = result;
    const again = reselect === undefined ? undefined : result.entries.find(entry => entry.name === reselect);
    selection = again && { entry: again, path: joinRemotePath(result.path, again.name) };
    clearPreview();
    paintList();
    paintDetail();
    paintActions();
    return true;
  }
  async function resolveLink() {
    if (!selection) return;
    const current = selection;
    const result = await run("正在解析链接目标…", command<RemoteEntry>("ssh_sftp_metadata", { path: current.path }));
    if (!result || selection !== current) return;
    selection = { ...current, resolved: result };
    paintDetail();
  }
  async function preview() {
    const current = selection;
    const file = target();
    if (!current || file?.kind !== "file") return;
    const bytes = await run("正在读取文件预览…可随时取消。", command<number[]>("ssh_sftp_read", { path: current.path }));
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
  function transferProgress(operationId: string, verb: string, name: string): Channel<TransferProgress> {
    const channel = new Channel<TransferProgress>();
    channel.onmessage = event => {
      if (busy !== operationId || event?.operationId !== operationId) return;
      const { transferred, total } = event;
      if (!Number.isFinite(transferred) || !Number.isFinite(total)) return;
      progress.hidden = false;
      progress.value = total > 0 ? Math.min(transferred / total, 1) : 1;
      status.textContent = `正在${verb}“${name}”… ${formatSize(transferred)} / ${formatSize(total)}，可随时取消。`;
    };
    return channel;
  }
  async function download() {
    const current = selection;
    const file = target();
    if (busy || asking || !current || file?.kind !== "file" || file.size > MAX_DOWNLOAD_BYTES) return;
    const name = current.entry.name;
    const viaScp = scp;
    const verb = viaScp ? "用 SCP 下载" : "下载";
    const result = await run(`正在${verb}“${name}”…可随时取消。`, common => invoke<Downloaded>(viaScp ? "ssh_scp_download" : "ssh_sftp_download", {
      ...common, path: current.path, onProgress: transferProgress(common.operationId, verb, name),
    }), DOWNLOAD_CANCELLED);
    if (result) status.textContent = `已${verb} ${formatSize(result.bytes)}，保存为 ${result.path}`;
  }
  async function toggleWritable() {
    const token = grantToken;
    const scope = scopeToken;
    if (busy || asking || !token || !scope) return;
    const next = !writable;
    if (next) {
      const answer = await ask({
        title: "允许写入远端文件？",
        message: `允许后，本次 SFTP 授权（${hostName}）可以新建、上传、重命名、删除和修改权限。断开、重新加载或授权过期后恢复只读；删除、覆盖和权限修改仍会逐项确认。`,
        confirm: "允许写入",
      });
      if (answer === null) return;
    }
    if (busy || grantToken !== token) return;
    try {
      await invoke("ssh_sftp_set_writable", { grantToken: token, scopeToken: scope, writable: next });
      if (grantToken !== token) return;
      setWritable(next);
      status.textContent = next ? "已允许写入；仅对本次授权有效。" : "已恢复只读。";
    } catch (reason) {
      if (grantToken === token) failed(reason);
    }
  }
  async function refresh(directory: string, reselect: string | undefined, done: string) {
    if (await navigate(directory, reselect)) status.textContent = done;
    else if (grantToken && !busy) status.textContent = `${done}目录未能刷新。`;
  }
  async function apply(directory: string, change: Change, message: string, done: string, reselect?: string) {
    const result = await run(message, command<RemoteEntry | null>("ssh_sftp_change", { change }), CHANGE_CANCELLED);
    if (result !== undefined) await refresh(directory, reselect, done);
  }
  async function send(directory: string, name: string, bytes: Uint8Array, overwrite: boolean, message: string, done: string) {
    const path = joinRemotePath(directory, name);
    const result = await run(message, common => invoke<RemoteEntry>("ssh_sftp_upload", bytes, {
      headers: uploadHeaders({ ...common, path, overwrite, onProgress: transferProgress(common.operationId, "上传", name) }),
    }), overwrite ? OVERWRITE_CANCELLED : UPLOAD_CANCELLED);
    if (result) await refresh(directory, name, done);
  }
  // SCP replaces the target in place; the caller has confirmed any existing file.
  async function sendScp(directory: string, name: string, bytes: Uint8Array, message: string, done: string) {
    const path = joinRemotePath(directory, name);
    const result = await run(message, common => invoke<null>("ssh_scp_upload", bytes, {
      headers: scpUploadHeaders({ ...common, path, onProgress: transferProgress(common.operationId, "用 SCP 上传", name) }),
    }), SCP_UPLOAD_CANCELLED);
    if (result !== undefined) await refresh(directory, name, done);
  }
  const taken = (name: string) => listing?.entries.some(entry => entry.name === name) ? "当前目录已有同名项。" : undefined;
  async function create(kind: "directory" | "file") {
    const directory = listing?.path;
    if (busy || asking || !directory || !writable) return;
    const label = kind === "directory" ? "目录" : "空文件";
    const name = await ask({
      title: `新建${label}`, message: `在 ${directory} 中新建${label}。同名项已存在时不会覆盖。`, confirm: "创建",
      input: { label: "名称", value: "", validate: value => remoteNameError(value) ?? taken(value) },
    });
    if (name === null || busy || listing?.path !== directory) return;
    if (kind === "directory") {
      await apply(directory, { kind: "mkdir", path: joinRemotePath(directory, name) }, `正在新建目录“${name}”…`, `已新建目录“${name}”。`, name);
    } else {
      await send(directory, name, new Uint8Array(), false, `正在新建空文件“${name}”…`, `已新建空文件“${name}”。`);
    }
  }
  async function upload(file: File) {
    const directory = listing?.path;
    if (busy || asking || !directory || !writable) return;
    const name = file.name;
    const viaScp = scp;
    const problem = remoteNameError(name);
    if (problem) { error.textContent = `无法上传“${name}”：${problem}`; return; }
    if (file.size > MAX_UPLOAD_BYTES) { error.textContent = `“${name}”超过 16 MiB 上传上限。`; return; }
    const existing = listing?.entries.find(entry => entry.name === name);
    let overwrite = false;
    if (existing) {
      if (existing.kind !== "file") {
        error.textContent = `远端已有同名${KIND_LABEL[existing.kind]}“${name}”；P0 只覆盖普通文件。`;
        return;
      }
      const answer = await ask({
        title: "覆盖远端文件？", confirm: "覆盖", danger: true,
        message: viaScp
          ? `“${name}”已存在（${formatSize(existing.size)}）。SCP 会直接写入这个文件，没有临时文件；覆盖后无法恢复原内容，失败或取消会留下不完整的文件。`
          : `“${name}”已存在（${formatSize(existing.size)}）。覆盖后无法恢复原内容；失败或取消可能留下不完整的文件。`,
      });
      if (answer === null) return;
      overwrite = true;
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch {
      error.textContent = `无法读取本机文件“${name}”。`;
      return;
    }
    if (busy || listing?.path !== directory || bytes.length > MAX_UPLOAD_BYTES) return;
    if (viaScp) {
      await sendScp(directory, name, bytes, `正在用 SCP 上传“${name}”…可随时取消。`, `已用 SCP 上传“${name}”（${formatSize(bytes.length)}）。`);
      return;
    }
    await send(directory, name, bytes, overwrite, `正在上传“${name}”…可随时取消。`, `已上传“${name}”（${formatSize(bytes.length)}）。`);
  }
  async function rename() {
    const current = selection;
    const directory = listing?.path;
    if (busy || asking || !current || !directory || !writable) return;
    const old = current.entry.name;
    const name = await ask({
      title: "重命名", message: `重命名“${old}”。目标名称已存在时不会覆盖。`, confirm: "重命名",
      input: { label: "新名称", value: old, validate: value => remoteNameError(value) ?? (value === old ? "名称未改变。" : taken(value)) },
    });
    if (name === null || busy || selection !== current) return;
    await apply(directory, { kind: "rename", from: current.path, to: joinRemotePath(directory, name) },
      `正在重命名“${old}”…`, `已将“${old}”重命名为“${name}”。`, name);
  }
  async function chmod() {
    const current = selection;
    const directory = listing?.path;
    if (busy || asking || !current || !directory || !writable) return;
    const { kind, mode, name } = current.entry;
    if (kind !== "file" && kind !== "directory") return;
    const octal = mode === null ? "" : (mode & 0o777).toString(8).padStart(3, "0");
    const answer = await ask({
      title: "修改权限", confirm: "修改权限",
      message: `修改“${name}”的权限。当前：${formatMode(kind, mode)}${octal ? `（${octal}）` : ""}。只支持三位八进制 rwx 位，不支持 setuid、setgid 和 sticky。`,
      input: {
        label: "新权限（八进制）", value: octal,
        validate: value => parseMode(value) === undefined ? "请输入三位八进制数字，例如 644。" : undefined,
        hint: value => `修改后：${formatMode(kind, parseMode(value) ?? null)}`,
      },
    });
    const next = answer === null ? undefined : parseMode(answer);
    if (next === undefined || busy || selection !== current) return;
    await apply(directory, { kind: "chmod", path: current.path, mode: next },
      `正在修改“${name}”的权限…`, `已将“${name}”的权限改为 ${formatMode(kind, next)}。`, name);
  }
  async function remove() {
    const current = selection;
    const directory = listing?.path;
    if (busy || asking || !current || !directory || !writable) return;
    const { kind, name, size } = current.entry;
    if (kind === "other") return;
    const message = kind === "directory"
      ? `删除空目录“${name}”？P0 不递归删除；目录不为空时服务器会拒绝。`
      : kind === "symlink"
        ? `删除符号链接“${name}”本身？它指向的目标不受影响。`
        : `删除远端文件“${name}”（${formatSize(size)}）？此操作无法撤销。`;
    const answer = await ask({ title: "确认删除", message, confirm: "删除", danger: true });
    if (answer === null || busy || selection !== current) return;
    await apply(directory, { kind: kind === "directory" ? "removeDir" : "removeFile", path: current.path },
      `正在删除“${name}”…`, `已删除“${name}”。`);
  }
  function cancelCurrent() {
    if (!busy) return;
    const operationId = busy;
    revision++;
    setBusy(undefined, cancelNote);
    if (!grantToken) get("sftp-reconnect").hidden = false;
    void invoke("ssh_cancel", { operationId }).catch(() => toast("取消请求失败；操作将在其期限内结束。"));
  }
  function reset() {
    revision++;
    dismissSftpDialog();
    setWritable(false);
    scp = false;
    grantToken = scopeToken = listing = selection = credential = undefined;
    hostName = "";
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
  get("sftp-download").onclick = () => void download();
  get("sftp-writable").onclick = () => void toggleWritable();
  scpToggle.onchange = () => {
    scp = scpToggle.checked && !busy && !asking;
    error.textContent = "";
    paintActions();
  };
  get("sftp-mkdir").onclick = () => void create("directory");
  get("sftp-touch").onclick = () => void create("file");
  get("sftp-upload").onclick = () => { uploadInput.value = ""; uploadInput.click(); };
  uploadInput.onchange = () => { const file = uploadInput.files?.[0]; if (file) void upload(file); };
  get("sftp-rename").onclick = () => void rename();
  get("sftp-chmod").onclick = () => void chmod();
  get("sftp-delete").onclick = () => void remove();
  cancel.onclick = cancelCurrent;
  get("sftp-disconnect").onclick = () => { release(); toast("已断开 SFTP 文件浏览；未保存主机信任。"); };
  get("sftp-reconnect").onclick = () => { release(); root.dispatchEvent(new CustomEvent("sftp-reconnect")); };
  setWritable(false);

  return {
    open(request) {
      if (busy || grantToken) return false;
      reset();
      show(true);
      scopeToken = request.scopeToken;
      hostName = request.name;
      get("sftp-host").textContent = request.name;
      const version = ++revision;
      const prompts = authPromptsFor(request.credential, request.operationId, request.name);
      // Only the method is kept for later reconnects, never a secret.
      credential = prompts ? { method: "keyboardInteractivePrompted" } : undefined;
      setBusy(request.operationId, prompts
        ? "正在连接；请在弹出的对话框中回答服务器提示…可随时取消。"
        : "正在认证并读取登录目录…可随时取消。");
      void invoke<SftpOpened>("ssh_sftp_open", {
        challengeToken: request.challengeToken, operationId: request.operationId, scopeToken: request.scopeToken,
        credential: request.credential, onAuth: prompts?.channel,
      }).finally(() => prompts?.finish()).then(opened => {
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

import { invoke } from "@tauri-apps/api/core";

/** The target as `ssh_probe` and `ssh_proxy_command_preview` receive it. */
export type SshTargetRequest = { host: string; port: number; username: string; privateKeyPath: string };

/** Sent only with `ssh_probe`; the backend binds it to the challenge. */
export type RouteSpec =
  | { kind: "direct" }
  | { kind: "httpConnect" | "socks5"; host: string; port: number; username?: string; password?: string }
  | { kind: "proxyCommand"; command: string; argv: string[] }
  // Never a secret: the jump login travels only with `ssh_probe_through`.
  | { kind: "jump"; host: string; port: number; username: string; privateKeyPath: string };

/** What the backend reports about a challenge's route. Never carries a secret. */
export type RouteSummary =
  | { kind: "direct" }
  | { kind: "httpConnect" | "socks5"; host: string; port: number; authenticated: boolean }
  | { kind: "proxyCommand"; argv: string[] }
  | { kind: "jump"; host: string; port: number; username: string; fingerprint: string };
export type Stage = "jump" | "target";

/** The jump host login; keyboard-interactive is not offered for the jump host. */
export type JumpCredential =
  | { method: "key"; passphrase?: string }
  | { method: "password"; password: string }
  | { method: "agent" };

export type RouteRead =
  | { ok: false; error: string; focus?: HTMLElement }
  | { ok: true; route: RouteSpec; jumpCredential?: JumpCredential };

type RouteKind = RouteSpec["kind"];
const DEFAULT_PROXY_PORT: Partial<Record<RouteKind, string>> = { httpConnect: "3128", socks5: "1080" };
const SECRET_INPUTS = ["ssh-proxy-password", "ssh-jump-passphrase", "ssh-jump-password"];

/** Static skeleton placed inside `#ssh-fields`; no backend data goes in here. */
export const ROUTE_FIELDS = `
      <div id="ssh-route-section" class="ssh-route"><label>连接路由<select id="ssh-route" name="route"><option value="direct">直连</option><option value="httpConnect">HTTP CONNECT 代理</option><option value="socks5">SOCKS5 代理</option><option value="proxyCommand">ProxyCommand 本地程序</option><option value="jump">跳板主机 ProxyJump，一跳</option></select></label>
      <div id="ssh-proxy-fields" hidden><div class="form-row"><label>代理主机<input id="ssh-proxy-host" maxlength="253" spellcheck="false"/></label><label class="port">代理端口<input id="ssh-proxy-port" type="number" min="1" max="65535"/></label></div>
      <label>代理用户名（可选）<input id="ssh-proxy-username" maxlength="255" spellcheck="false" autocomplete="off"/></label>
      <label>代理密码（可选，须同时填写用户名）<input id="ssh-proxy-password" type="password" autocomplete="off" maxlength="255"/></label>
      <p class="caption">代理密码会随指纹检查一起发送：必须先穿过代理才能看到主机密钥。它只保存在内存中，不会写入磁盘。</p></div>
      <div id="ssh-proxy-command-fields" hidden><label>ProxyCommand<input id="ssh-proxy-command" maxlength="4096" spellcheck="false" autocomplete="off" placeholder="/usr/bin/nc %h %p"/></label>
      <button type="button" id="ssh-proxy-command-preview">预览将执行的参数</button>
      <ol id="ssh-proxy-argv" class="ssh-argv" aria-label="将执行的程序与参数"></ol>
      <label class="ssh-check"><input type="checkbox" id="ssh-proxy-command-confirm" disabled/>我已核对以上程序与参数，允许在核对指纹前运行它</label>
      <p class="caption">不经过 shell；只替换 %h、%p、%r、%%；程序须为绝对路径；核对指纹时就会运行它。修改命令、主机、端口或用户名后须重新预览。</p></div>
      <div id="ssh-jump-fields" hidden><div class="form-row"><label>跳板主机<input id="ssh-jump-host" maxlength="253" spellcheck="false"/></label><label class="port">端口<input id="ssh-jump-port" type="number" value="22" min="1" max="65535"/></label></div>
      <label>跳板主机用户名<input id="ssh-jump-username" maxlength="64" spellcheck="false" autocomplete="off"/></label>
      <label>跳板主机认证方式<select id="ssh-jump-auth"><option value="key">私钥文件</option><option value="password">密码</option><option value="agent">SSH agent</option></select></label>
      <div id="ssh-jump-key-fields"><label>跳板主机私钥路径<input id="ssh-jump-key-path" spellcheck="false" autocomplete="off"/></label>
      <label>跳板主机私钥口令（未加密的私钥留空）<input id="ssh-jump-passphrase" type="password" autocomplete="off" maxlength="1024"/></label></div>
      <label id="ssh-jump-password-row" hidden>跳板主机密码<input id="ssh-jump-password" type="password" autocomplete="off" maxlength="1024"/></label>
      <p class="caption">分两步信任：先核对跳板主机指纹，再核对经跳板主机看到的目标主机指纹。跳板主机的密码或口令只在确认跳板主机指纹后才发送；所有信息都不保存。</p></div></div>`;

/** Step text for the challenge view; empty when the route has no jump host. */
export function routeStep(stage: Stage, route: RouteSummary | undefined): string {
  if (stage === "jump") return "第 1 步，共 2 步：核对跳板主机指纹";
  return route?.kind === "jump" ? "第 2 步，共 2 步：核对目标主机指纹（经跳板主机）" : "";
}

/** How the shown key was reached. Rendered with textContent only. */
export function routeSummary(stage: Stage, route: RouteSummary | undefined): string {
  if (stage === "jump") return "直连跳板主机";
  if (!route) return "直连";
  switch (route.kind) {
    case "direct": return "直连";
    case "httpConnect":
    case "socks5": {
      const label = route.kind === "httpConnect" ? "HTTP 代理" : "SOCKS5 代理";
      return `经 ${label} ${route.host}:${route.port}${route.authenticated ? "，已提供代理认证" : ""}`;
    }
    case "proxyCommand": return `经 ProxyCommand：${(route.argv ?? []).join(" ")}`;
    case "jump": return `经跳板主机 ${route.username}@${route.host}:${route.port}（已确认指纹 ${route.fingerprint}）`;
    default: return "未知路由";
  }
}

/**
 * Binds the route section. `request` must build the target exactly as the probe
 * sends it, so the confirmed ProxyCommand argv is the argv the backend recomputes.
 */
export function createRouteForm(root: HTMLElement, request: () => SshTargetRequest, showError: (message: string) => void) {
  const get = <T extends HTMLElement = HTMLInputElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const kind = get<HTMLSelectElement>("ssh-route");
  const jumpAuth = get<HTMLSelectElement>("ssh-jump-auth");
  const proxyPort = get("ssh-proxy-port");
  const command = get("ssh-proxy-command");
  const previewButton = get<HTMLButtonElement>("ssh-proxy-command-preview");
  const argvList = get<HTMLOListElement>("ssh-proxy-argv");
  const confirm = get("ssh-proxy-command-confirm");
  let proxyPortTyped = false;
  // A preview is valid only for the command and target it was computed for.
  let preview: { key: string; argv: string[] } | undefined;
  let previewRevision = 0;

  const previewKey = (target: SshTargetRequest) =>
    JSON.stringify([command.value, target.host, target.port, target.username]);
  const invalidatePreview = () => {
    previewRevision++;
    preview = undefined;
    argvList.replaceChildren();
    confirm.checked = false;
    confirm.disabled = true;
  };
  const showFields = () => {
    const route = kind.value as RouteKind;
    const proxy = route === "httpConnect" || route === "socks5";
    const jump = route === "jump";
    const auth = jumpAuth.value;
    get("ssh-proxy-fields").hidden = !proxy;
    get("ssh-proxy-command-fields").hidden = route !== "proxyCommand";
    get("ssh-jump-fields").hidden = !jump;
    get("ssh-jump-key-fields").hidden = auth !== "key";
    get("ssh-jump-password-row").hidden = auth !== "password";
    // Hidden fields are never required.
    get("ssh-proxy-host").required = proxyPort.required = proxy;
    command.required = route === "proxyCommand";
    for (const id of ["ssh-jump-host", "ssh-jump-port", "ssh-jump-username"]) get(id).required = jump;
    get("ssh-jump-key-path").required = jump && auth === "key";
    get("ssh-jump-password").required = jump && auth === "password";
  };
  kind.addEventListener("change", () => {
    const port = DEFAULT_PROXY_PORT[kind.value as RouteKind];
    if (port && !proxyPortTyped) proxyPort.value = port;
    invalidatePreview();
    showFields();
  });
  jumpAuth.addEventListener("change", showFields);
  proxyPort.addEventListener("input", () => { proxyPortTyped = true; });
  for (const id of ["ssh-proxy-command", "ssh-host", "ssh-port", "ssh-username"]) {
    for (const event of ["input", "change"]) get(id).addEventListener(event, invalidatePreview);
  }

  previewButton.addEventListener("click", async () => {
    invalidatePreview();
    if (!command.value.trim()) {
      showError("请先填写 ProxyCommand。");
      command.focus();
      return;
    }
    const revision = previewRevision;
    const target = request();
    const key = previewKey(target);
    previewButton.disabled = true;
    try {
      const argv = await invoke<string[]>("ssh_proxy_command_preview", { request: target, command: command.value });
      // Inputs changed while the preview was computed: this argv no longer applies.
      if (revision !== previewRevision || key !== previewKey(request())) return;
      if (!Array.isArray(argv) || argv.length === 0 || argv.some(arg => typeof arg !== "string")) {
        showError("ProxyCommand 预览结果无效，请重新预览。");
        return;
      }
      preview = { key, argv: [...argv] };
      argvList.replaceChildren(...argv.map(arg => {
        const item = document.createElement("li");
        const code = document.createElement("code");
        code.textContent = arg;
        item.append(code);
        return item;
      }));
      confirm.disabled = false;
      showError("");
    } catch (reason) {
      if (revision === previewRevision) showError(typeof reason === "string" ? reason : "无法预览 ProxyCommand，请检查命令。");
    } finally {
      previewButton.disabled = false;
    }
  });

  const takeSecrets = () => {
    const values = Object.fromEntries(SECRET_INPUTS.map(id => [id, get(id).value]));
    for (const id of SECRET_INPUTS) get(id).value = "";
    return values;
  };

  return {
    /** Validates the route; on success returns it and wipes every route secret input. */
    read(): RouteRead {
      const route = kind.value as RouteKind;
      if (route === "httpConnect" || route === "socks5") {
        const username = get("ssh-proxy-username").value.trim();
        if (!username && get("ssh-proxy-password").value) {
          return { ok: false, error: "填写代理密码时必须同时填写代理用户名。", focus: get("ssh-proxy-username") };
        }
        const password = takeSecrets()["ssh-proxy-password"];
        return { ok: true, route: {
          kind: route, host: get("ssh-proxy-host").value.trim(), port: Number(proxyPort.value),
          ...(username ? { username } : {}), ...(password ? { password } : {}),
        } };
      }
      if (route === "proxyCommand") {
        if (!preview || !confirm.checked || preview.key !== previewKey(request())) {
          return { ok: false, error: "请先预览 ProxyCommand 将执行的程序与参数，并勾选确认后再检查指纹。", focus: previewButton };
        }
        takeSecrets();
        return { ok: true, route: { kind: "proxyCommand", command: command.value, argv: [...preview.argv] } };
      }
      if (route === "jump") {
        const auth = jumpAuth.value;
        const secrets = takeSecrets();
        const passphrase = secrets["ssh-jump-passphrase"];
        const jumpCredential: JumpCredential = auth === "password"
          ? { method: "password", password: secrets["ssh-jump-password"] }
          : auth === "agent" ? { method: "agent" }
          : passphrase ? { method: "key", passphrase } : { method: "key" };
        return { ok: true, jumpCredential, route: {
          kind: "jump", host: get("ssh-jump-host").value.trim(), port: Number(get("ssh-jump-port").value),
          username: get("ssh-jump-username").value.trim(),
          privateKeyPath: auth === "key" ? get("ssh-jump-key-path").value : "",
        } };
      }
      takeSecrets();
      return { ok: true, route: { kind: "direct" } };
    },
    clearKeyPaths() {
      get("ssh-jump-key-path").value = "";
    },
    /** Back to a direct route with every field and the preview cleared. */
    reset() {
      for (const id of ["ssh-proxy-host", "ssh-proxy-port", "ssh-proxy-username", "ssh-proxy-command", "ssh-jump-host", "ssh-jump-username", "ssh-jump-key-path", ...SECRET_INPUTS]) {
        get(id).value = "";
      }
      get("ssh-jump-port").value = "22";
      kind.value = "direct";
      jumpAuth.value = "key";
      proxyPortTyped = false;
      previewButton.disabled = false;
      invalidatePreview();
      showFields();
    },
  };
}

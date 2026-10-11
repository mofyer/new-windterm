import { invoke, isTauri } from "@tauri-apps/api/core";

type Challenge = {
  challengeToken: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  expiresInSeconds: number;
};
type VerificationResult = { stdout: number[]; stderr: number[]; exitCode: number };

export type SshTerminalRequest = { challengeToken: string; operationId: string; scopeToken: string; name: string };

// Trust is always explicit. The terminal callback synchronously reserves a tab
// before consuming the one-use challenge; verification remains a separate flow.
export function createSshVerification(openTerminal: (request: SshTerminalRequest) => boolean) {
  const dialog = document.createElement("dialog");
  dialog.id = "ssh-verification-dialog";
  dialog.setAttribute("aria-labelledby", "ssh-verification-title");
  dialog.innerHTML = `
    <div class="dialog-heading"><div><span class="eyebrow">SSH · P0</span><h2 id="ssh-verification-title">验证真实连接</h2></div><button type="button" id="ssh-close" aria-label="关闭 SSH 连接窗口">✕</button></div>
    <p id="ssh-description"></p>
    <p id="ssh-browser-note" hidden>真实 SSH 仅在 Tauri 桌面程序中可用。浏览器不会发起连接。</p>
    <form id="ssh-verification-form" autocomplete="off">
      <fieldset id="ssh-fields"><div class="form-row"><label>主机<input id="ssh-host" name="host" placeholder="127.0.0.1" maxlength="253" required spellcheck="false"/></label><label class="port">端口<input id="ssh-port" name="port" type="number" value="22" min="1" max="65535" required/></label></div>
      <label>SSH 用户名<input id="ssh-username" name="username" maxlength="64" required spellcheck="false"/></label>
      <label>私钥路径<input id="ssh-key-path" name="privateKeyPath" required spellcheck="false"/></label>
      <p class="caption">P0 仅支持未加密的 Ed25519 密钥。输入文件路径，不粘贴私钥；路径不保存，密钥由桌面后端读取。</p></fieldset>
      <div class="dialog-actions"><button type="submit" id="ssh-probe" class="primary">检查主机指纹</button></div>
    </form>
    <section id="ssh-challenge" hidden aria-label="真实主机指纹">
      <div class="ssh-identity"><strong id="ssh-endpoint"></strong><span id="ssh-algorithm"></span><code id="ssh-fingerprint"></code></div>
      <p>请通过可信渠道核对以上指纹。信任仅用于本次连接，不写入 known_hosts。</p>
      <p id="ssh-expiry"></p>
      <div class="dialog-actions"><button type="button" id="ssh-reject">拒绝并关闭</button><button type="button" id="ssh-accept" class="primary">仅本次信任并验证</button></div>
    </section>
    <section id="ssh-result" hidden aria-label="SSH 验证输出"></section>
    <p id="ssh-status" role="status" aria-live="polite"></p>
    <p id="ssh-error" role="alert" aria-live="assertive"></p>
    <div class="dialog-actions"><button type="button" id="ssh-retry" hidden>重新检查</button><button type="button" id="ssh-cancel">取消</button></div>`;
  document.body.append(dialog);
  const get = <T extends HTMLElement>(id: string) => dialog.querySelector<T>(`#${id}`)!;
  const form = get<HTMLFormElement>("ssh-verification-form");
  const fields = get<HTMLFieldSetElement>("ssh-fields");
  const probe = get<HTMLButtonElement>("ssh-probe");
  const accept = get<HTMLButtonElement>("ssh-accept");
  const retry = get<HTMLButtonElement>("ssh-retry");
  const challengeView = get("ssh-challenge");
  const resultView = get("ssh-result");
  const status = get("ssh-status");
  const error = get("ssh-error");
  const desktop = isTauri();
  let purpose: "verification" | "terminal" = "verification";
  let revision = 0;
  let scopeToken: string | undefined;
  let operationId: string | undefined;
  let challenge: Challenge | undefined;
  let expiryTimer: number | undefined;
  let expiresAt = 0;

  const release = () => {
    revision++;
    window.clearTimeout(expiryTimer);
    if (operationId) void invoke("ssh_cancel", { operationId }).catch(() => {});
    if (challenge) void invoke("ssh_reject", { challengeToken: challenge.challengeToken }).catch(() => {});
    operationId = undefined;
    challenge = undefined;
    scopeToken = undefined;
  };
  const clear = () => {
    form.reset();
    get<HTMLInputElement>("ssh-host").value = "";
    get<HTMLInputElement>("ssh-username").value = "";
    get<HTMLInputElement>("ssh-key-path").value = "";
    resultView.replaceChildren();
    for (const id of ["ssh-endpoint", "ssh-algorithm", "ssh-fingerprint", "ssh-expiry"]) get(id).textContent = "";
    error.textContent = status.textContent = "";
  };
  const close = () => {
    release();
    clear();
    dialog.close();
  };
  const resetView = () => {
    form.hidden = false;
    challengeView.hidden = resultView.hidden = retry.hidden = true;
    fields.disabled = probe.disabled = !desktop || !scopeToken;
    accept.disabled = false;
    dialog.removeAttribute("aria-busy");
    get("ssh-cancel").textContent = "取消";
    status.textContent = error.textContent = "";
  };
  const current = (version: number) => dialog.open && revision === version;
  const failed = (reason: unknown) => {
    error.textContent = typeof reason === "string" ? reason : "SSH 验证失败，请重新检查连接信息。";
    status.textContent = "";
    retry.hidden = false;
  };
  const initializeContext = async () => {
    if (!desktop) return;
    const version = ++revision;
    fields.disabled = probe.disabled = true;
    status.textContent = "正在准备桌面验证…";
    dialog.setAttribute("aria-busy", "true");
    try {
      const token = await invoke<string>("ssh_context");
      if (!current(version)) return;
      scopeToken = token;
      fields.disabled = probe.disabled = false;
      status.textContent = "";
      get("ssh-host").focus();
    } catch (reason) {
      if (current(version)) failed(reason);
    } finally {
      if (current(version)) dialog.removeAttribute("aria-busy");
    }
  };
  const expire = () => {
    if (!challenge || operationId) return;
    void invoke("ssh_reject", { challengeToken: challenge.challengeToken }).catch(() => {});
    challenge = undefined;
    accept.disabled = true;
    get("ssh-expiry").textContent = "指纹确认已过期，请重新检查。";
    retry.hidden = false;
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!desktop || !scopeToken || operationId || challenge || !form.reportValidity()) return;
    const version = ++revision;
    const id = crypto.randomUUID();
    operationId = id;
    fields.disabled = probe.disabled = true;
    retry.hidden = true;
    error.textContent = "";
    status.textContent = "正在检查主机指纹…可随时取消。";
    dialog.setAttribute("aria-busy", "true");
    try {
      const response = await invoke<Challenge>("ssh_probe", {
        scopeToken,
        operationId: id,
        request: {
          host: get<HTMLInputElement>("ssh-host").value.trim(),
          port: Number(get<HTMLInputElement>("ssh-port").value),
          username: get<HTMLInputElement>("ssh-username").value.trim(),
          privateKeyPath: get<HTMLInputElement>("ssh-key-path").value,
        },
      });
      if (!current(version)) {
        void invoke("ssh_reject", { challengeToken: response.challengeToken }).catch(() => {});
        return;
      }
      challenge = response;
      expiresAt = Date.now() + response.expiresInSeconds * 1000;
      expiryTimer = window.setTimeout(expire, response.expiresInSeconds * 1000);
      get<HTMLInputElement>("ssh-key-path").value = "";
      form.hidden = true;
      challengeView.hidden = false;
      get("ssh-endpoint").textContent = `${response.host}:${response.port}`;
      get("ssh-algorithm").textContent = response.algorithm;
      get("ssh-fingerprint").textContent = response.fingerprint;
      get("ssh-expiry").textContent = `请在 ${response.expiresInSeconds} 秒内确认，否则需要重新检查。`;
      status.textContent = "尚未认证。核对指纹后再决定是否信任。";
      get("ssh-reject").focus();
    } catch (reason) {
      if (current(version)) failed(reason);
    } finally {
      if (current(version)) {
        operationId = undefined;
        dialog.removeAttribute("aria-busy");
      }
    }
  });

  accept.addEventListener("click", async () => {
    if (!scopeToken || !challenge || operationId || !dialog.open) return;
    if (Date.now() >= expiresAt) { expire(); return; }
    const token = challenge.challengeToken;
    if (purpose === "terminal") {
      const started = openTerminal({
        challengeToken: token, scopeToken, operationId: crypto.randomUUID(),
        name: `${challenge.host}:${challenge.port}`,
      });
      if (!started) {
        error.textContent = "P0 最多同时打开 8 个会话。请先关闭一个会话，再信任并连接。";
        return;
      }
      challenge = undefined; // Ownership moves to the terminal tab, including cancellation.
      close();
      return;
    }
    const version = ++revision;
    const id = crypto.randomUUID();
    operationId = id;
    challenge = undefined; // Consumed once; retries must obtain a new challenge.
    window.clearTimeout(expiryTimer);
    accept.disabled = true;
    status.textContent = "正在认证并执行 fixture-check…可随时取消。";
    dialog.setAttribute("aria-busy", "true");
    try {
      const result = await invoke<VerificationResult>("ssh_accept", { scopeToken, challengeToken: token, operationId: id });
      if (!current(version)) return;
      challengeView.hidden = true;
      resultView.hidden = false;
      const summary = document.createElement("p");
      summary.textContent = `命令已完成 · exit ${result.exitCode}${result.exitCode === 7 ? "（测试夹具预期退出码）" : ""}`;
      resultView.append(summary);
      for (const [name, bytes] of [["stdout", result.stdout], ["stderr", result.stderr]] as const) {
        const heading = document.createElement("h3");
        heading.textContent = `${name} · ${bytes.length} bytes`;
        const output = document.createElement("pre");
        output.textContent = new TextDecoder().decode(Uint8Array.from(bytes)) || "（空）";
        const raw = document.createElement("details");
        const label = document.createElement("summary");
        label.textContent = "原始字节（十六进制）";
        const hex = document.createElement("pre");
        hex.textContent = bytes.map(byte => byte.toString(16).padStart(2, "0")).join(" ") || "（空）";
        raw.append(label, hex);
        resultView.append(heading, output, raw);
      }
      status.textContent = "UTF-8 显示无法解码的字节时使用替换字符；原始字节可展开查看。此次信任未保存。";
      retry.hidden = false;
      get("ssh-cancel").textContent = "关闭";
      get("ssh-cancel").focus();
    } catch (reason) {
      if (current(version)) failed(reason);
    } finally {
      if (current(version)) {
        operationId = undefined;
        dialog.removeAttribute("aria-busy");
      }
    }
  });
  retry.addEventListener("click", () => {
    release();
    clear();
    resetView();
    void initializeContext();
  });
  for (const id of ["ssh-close", "ssh-cancel", "ssh-reject"]) get(id).addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  dialog.addEventListener("close", () => {
    // A queued close event from the previous opening must not clear a new flow.
    if (!dialog.open) { release(); clear(); }
  });
  window.addEventListener("beforeunload", () => { release(); clear(); });
  return {
    open(mode: "verification" | "terminal" = "verification") {
      if (dialog.open) return;
      purpose = mode;
      get("ssh-verification-title").textContent = mode === "terminal" ? "连接 SSH 终端" : "验证真实连接";
      get("ssh-description").textContent = mode === "terminal"
        ? "核对真实主机指纹后，建立交互式远端终端。输入会在服务器实际执行；文件面板与 SFTP 仍为演示。"
        : "连接受控测试服务器，核对主机指纹后执行固定命令 fixture-check。此入口不提供交互终端或 SFTP。";
      accept.textContent = mode === "terminal" ? "仅本次信任并打开终端" : "仅本次信任并验证";
      clear();
      resetView();
      get("ssh-browser-note").hidden = desktop;
      dialog.showModal();
      get("ssh-close").focus();
      void initializeContext();
    },
  };
}

import { invoke, isTauri } from "@tauri-apps/api/core";
import { createAuthPrompts, type AuthPrompts } from "./ssh-kbdint";
import { createRouteForm, ROUTE_FIELDS, routeStep, routeSummary, type JumpCredential, type RouteSummary, type Stage, type SshTargetRequest } from "./ssh-route";

type Trust = "new" | "known" | "changed";
type Challenge = {
  challengeToken: string;
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
  expiresInSeconds: number;
  trust?: Trust;
  savedFingerprint?: string | null;
  // Older backends omit these: a missing stage is "target", a missing route is direct.
  stage?: Stage;
  route?: RouteSummary;
};
type VerificationResult = { stdout: number[]; stderr: number[]; exitCode: number };

/** Sent to the backend only when a confirmed challenge is consumed. */
export type SshCredential =
  | { method: "key"; passphrase?: string }
  | { method: "password"; password: string }
  | { method: "agent" }
  | { method: "keyboardInteractive"; responses: string[] }
  // Answers are typed into a dialog per server round while connecting.
  | { method: "keyboardInteractivePrompted" };
export type SshTerminalRequest = {
  challengeToken: string; operationId: string; scopeToken: string; name: string; credential: SshCredential;
  // Terminal only: forward the local ssh-agent for this one connection. Never saved.
  agentForwarding?: boolean;
};
type Purpose = "verification" | "terminal" | "files";

/** The `onAuth` channel for a credential that asks the user while connecting. */
export function authPromptsFor(credential: SshCredential, operationId: string, label: string): AuthPrompts | undefined {
  return credential.method === "keyboardInteractivePrompted" ? createAuthPrompts(operationId, label) : undefined;
}

// Trust is always explicit. The terminal and file callbacks synchronously reserve
// their surface before consuming the one-use challenge; verification remains separate.
export function createSshVerification(
  openTerminal: (request: SshTerminalRequest) => boolean,
  openFiles: (request: SshTerminalRequest) => boolean,
) {
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
      <label>认证方式<select id="ssh-auth" name="auth"><option value="key">私钥文件</option><option value="password">密码</option><option value="agent">SSH agent</option><option value="keyboardInteractivePrompted">键盘交互（连接时按服务器提示输入）</option><option value="keyboardInteractive">键盘交互（按提示顺序预填）</option></select></label>
      <p id="ssh-kbdint-prompted-note" class="caption" hidden>核对指纹后，服务器的每一轮提示会在单独的对话框中按纯文本显示；答案不预先填写、不保存，每轮须在 120 秒内提交。</p>
      <div id="ssh-key-fields"><label>私钥路径<input id="ssh-key-path" name="privateKeyPath" required spellcheck="false"/></label>
      <label>私钥口令（未加密的私钥留空）<input id="ssh-passphrase" type="password" autocomplete="off" maxlength="1024"/></label></div>
      <label id="ssh-password-row" hidden>密码<input id="ssh-password" type="password" autocomplete="off" maxlength="1024"/></label>
      <div id="ssh-kbdint-fields" hidden><label>第 1 个提示的答案<input id="ssh-kbdint-1" type="password" autocomplete="off" maxlength="1024"/></label>
      <label>第 2 个提示的答案（例如动态验证码，可留空）<input id="ssh-kbdint-2" type="password" autocomplete="off" maxlength="1024"/></label></div>
      <p class="caption">支持 Ed25519/ECDSA 私钥（可带口令）、密码与本机 SSH agent；暂不支持 RSA 私钥。输入文件路径，不粘贴私钥；路径、密码与口令都不保存，仅在核对指纹后发送给桌面后端。</p>
      <div id="ssh-agent-forward-fields" hidden><label class="ssh-check"><input type="checkbox" id="ssh-agent-forward"/>转发本机 ssh-agent（仅对信任的主机）</label>
      <p id="ssh-agent-forward-warning" class="ssh-warning" hidden>开启后，在这次连接期间，远端主机（以及能控制它的任何人）可以让本机 ssh-agent 用其中的全部密钥代你签名，例如登录其他服务器；私钥本身不会离开本机。只对完全信任的主机开启。只对这一次连接有效，不保存。</p></div>${ROUTE_FIELDS}</fieldset>
      <div class="dialog-actions"><button type="submit" id="ssh-probe" class="primary">检查主机指纹</button></div>
    </form>
    <section id="ssh-challenge" hidden aria-label="真实主机指纹">
      <strong id="ssh-route-step" class="ssh-route-step" hidden></strong>
      <div class="ssh-identity"><strong id="ssh-endpoint"></strong><span id="ssh-route-summary"></span><span id="ssh-algorithm"></span><code id="ssh-fingerprint"></code></div>
      <p id="ssh-trust-note"></p>
      <label id="ssh-remember-row" class="ssh-check"><input type="checkbox" id="ssh-remember"/>保存此主机密钥，以后指纹一致时自动信任</label>
      <section id="ssh-changed" class="ssh-changed" hidden aria-label="主机密钥已变化">
        <strong>主机密钥与已保存的记录不一致</strong>
        <span>已保存的指纹</span><code id="ssh-saved-fingerprint"></code>
        <p>可能是服务器重装或密钥轮换，也可能是中间人攻击。连接已阻止；只有在通过可信渠道核实上方的新指纹后，才应替换保存的密钥。</p>
        <label class="ssh-check"><input type="checkbox" id="ssh-replace-confirm"/>我已通过可信渠道核实新指纹</label>
        <button type="button" id="ssh-replace" disabled>替换已保存的密钥</button>
      </section>
      <p id="ssh-expiry"></p>
      <p id="ssh-agent-forward-reminder" class="ssh-warning" hidden>将转发本机 ssh-agent：连接期间，这台主机可以用你的密钥代你签名。</p>
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
  const remember = get<HTMLInputElement>("ssh-remember");
  const authMethod = get<HTMLSelectElement>("ssh-auth");
  const agentForward = get<HTMLInputElement>("ssh-agent-forward");
  agentForward.addEventListener("change", () => { get("ssh-agent-forward-warning").hidden = !agentForward.checked; });
  // Held only between probe and accept/hand-off; cleared with the dialog.
  let credential: SshCredential | undefined;
  // Held only until the jump host key is confirmed; never sent with `ssh_probe`.
  let jumpCredential: JumpCredential | undefined;
  // The terminal's agent-forwarding choice, held like the credential until hand-off.
  let agentForwarding = false;
  const targetRequest = (): SshTargetRequest => ({
    host: get<HTMLInputElement>("ssh-host").value.trim(),
    port: Number(get<HTMLInputElement>("ssh-port").value),
    username: get<HTMLInputElement>("ssh-username").value.trim(),
    // The probe never authenticates; only the key path travels with it.
    privateKeyPath: authMethod.value === "key" ? get<HTMLInputElement>("ssh-key-path").value : "",
  });
  const routeForm = createRouteForm(dialog, targetRequest, message => { error.textContent = message; });
  const stageOf = (value: Challenge): Stage => value.stage === "jump" ? "jump" : "target";
  const showAuthFields = () => {
    const method = authMethod.value;
    get("ssh-key-fields").hidden = method !== "key";
    get("ssh-password-row").hidden = method !== "password";
    get("ssh-kbdint-fields").hidden = method !== "keyboardInteractive";
    get("ssh-kbdint-prompted-note").hidden = method !== "keyboardInteractivePrompted";
    get<HTMLInputElement>("ssh-kbdint-1").required = method === "keyboardInteractive";
    get<HTMLInputElement>("ssh-key-path").required = method === "key";
    get<HTMLInputElement>("ssh-password").required = method === "password";
  };
  authMethod.addEventListener("change", showAuthFields);
  const replace = get<HTMLButtonElement>("ssh-replace");
  const replaceConfirm = get<HTMLInputElement>("ssh-replace-confirm");
  let purpose: Purpose = "verification";
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
    credential = undefined;
    jumpCredential = undefined;
    agentForwarding = false;
  };
  const clear = () => {
    form.reset();
    get<HTMLInputElement>("ssh-host").value = "";
    get<HTMLInputElement>("ssh-username").value = "";
    get<HTMLInputElement>("ssh-key-path").value = "";
    get<HTMLInputElement>("ssh-passphrase").value = "";
    get<HTMLInputElement>("ssh-password").value = "";
    get<HTMLInputElement>("ssh-kbdint-1").value = "";
    get<HTMLInputElement>("ssh-kbdint-2").value = "";
    authMethod.value = "key";
    showAuthFields();
    routeForm.reset();
    resultView.replaceChildren();
    for (const id of ["ssh-endpoint", "ssh-algorithm", "ssh-fingerprint", "ssh-expiry", "ssh-trust-note", "ssh-saved-fingerprint", "ssh-route-step", "ssh-route-summary"]) get(id).textContent = "";
    get("ssh-route-step").hidden = true;
    remember.checked = replaceConfirm.checked = false;
    replace.disabled = true;
    get("ssh-changed").hidden = true;
    agentForward.checked = false;
    get("ssh-agent-forward-warning").hidden = get("ssh-agent-forward-reminder").hidden = true;
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
    jumpCredential = undefined;
    accept.disabled = true;
    get("ssh-expiry").textContent = "指纹确认已过期，请重新检查。";
    retry.hidden = false;
  };

  /** Shows a fresh challenge (target, or the jump host in step 1 of 2). */
  const showChallenge = (response: Challenge) => {
    challenge = response;
    const stage = stageOf(response);
    window.clearTimeout(expiryTimer);
    expiresAt = Date.now() + response.expiresInSeconds * 1000;
    expiryTimer = window.setTimeout(expire, response.expiresInSeconds * 1000);
    get<HTMLInputElement>("ssh-key-path").value = "";
    routeForm.clearKeyPaths();
    form.hidden = true;
    challengeView.hidden = false;
    remember.checked = replaceConfirm.checked = false;
    replace.disabled = true;
    const step = routeStep(stage, response.route);
    get("ssh-route-step").textContent = step;
    get("ssh-route-step").hidden = !step;
    get("ssh-route-summary").textContent = routeSummary(stage, response.route);
    get("ssh-agent-forward-reminder").hidden = !agentForwarding || stage === "jump";
    get("ssh-endpoint").textContent = `${response.host}:${response.port}`;
    get("ssh-algorithm").textContent = response.algorithm;
    get("ssh-fingerprint").textContent = response.fingerprint;
    get("ssh-expiry").textContent = `请在 ${response.expiresInSeconds} 秒内确认，否则需要重新检查。`;
    showTrust(response.trust ?? "new", response.savedFingerprint ?? "");
    if ((response.trust ?? "new") === "known") {
      // Same key as saved trust: continue without asking again.
      status.textContent = stage === "jump" ? "跳板主机指纹与已保存的记录一致，正在检查目标主机指纹…" : "指纹与已保存的记录一致，正在继续…";
      queueMicrotask(() => accept.click());
    } else {
      status.textContent = stage === "jump"
        ? "尚未认证。确认跳板主机指纹后，才会发送跳板主机的登录信息。"
        : "尚未认证。核对指纹后再决定是否信任。";
      get("ssh-reject").focus();
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!desktop || !scopeToken || operationId || challenge || !form.reportValidity()) return;
    // Validated before anything is read or cleared, so a blocked submit keeps the input.
    const routed = routeForm.read();
    if (!routed.ok) {
      status.textContent = "";
      error.textContent = routed.error;
      routed.focus?.focus();
      return;
    }
    const version = ++revision;
    const id = crypto.randomUUID();
    operationId = id;
    const method = authMethod.value;
    const passphrase = get<HTMLInputElement>("ssh-passphrase").value;
    const answers = ["ssh-kbdint-1", "ssh-kbdint-2"].map(id => get<HTMLInputElement>(id).value).filter(Boolean);
    credential = method === "password"
      ? { method: "password", password: get<HTMLInputElement>("ssh-password").value }
      : method === "agent" ? { method: "agent" }
      : method === "keyboardInteractive" ? { method: "keyboardInteractive", responses: answers }
      : method === "keyboardInteractivePrompted" ? { method: "keyboardInteractivePrompted" }
      : passphrase ? { method: "key", passphrase } : { method: "key" };
    jumpCredential = routed.jumpCredential;
    agentForwarding = purpose === "terminal" && agentForward.checked;
    for (const id of ["ssh-passphrase", "ssh-password", "ssh-kbdint-1", "ssh-kbdint-2"]) get<HTMLInputElement>(id).value = "";
    fields.disabled = probe.disabled = true;
    retry.hidden = true;
    error.textContent = "";
    status.textContent = routed.route.kind === "jump" ? "正在检查跳板主机指纹…可随时取消。" : "正在检查主机指纹…可随时取消。";
    dialog.setAttribute("aria-busy", "true");
    try {
      const response = await invoke<Challenge>("ssh_probe", { scopeToken, operationId: id, request: targetRequest(), route: routed.route });
      if (!current(version)) {
        void invoke("ssh_reject", { challengeToken: response.challengeToken }).catch(() => {});
        return;
      }
      showChallenge(response);
    } catch (reason) {
      if (current(version)) failed(reason);
    } finally {
      if (current(version)) {
        operationId = undefined;
        dialog.removeAttribute("aria-busy");
      }
    }
  });

  /** Step 2 of a jump route: consumes the confirmed jump challenge, then shows the target key. */
  const probeThrough = async (token: string) => {
    const version = ++revision;
    const id = crypto.randomUUID();
    operationId = id;
    const login = jumpCredential ?? { method: "key" };
    jumpCredential = undefined;
    challenge = undefined; // Consumed once; a failure restarts from the form.
    window.clearTimeout(expiryTimer);
    accept.disabled = true;
    error.textContent = "";
    status.textContent = "正在登录跳板主机并读取目标主机指纹…可随时取消。";
    dialog.setAttribute("aria-busy", "true");
    try {
      const response = await invoke<Challenge>("ssh_probe_through", { scopeToken, challengeToken: token, operationId: id, credential: login });
      if (!current(version)) {
        void invoke("ssh_reject", { challengeToken: response.challengeToken }).catch(() => {});
        return;
      }
      showChallenge(response);
    } catch (reason) {
      if (current(version)) failed(reason);
    } finally {
      if (current(version)) {
        operationId = undefined;
        dialog.removeAttribute("aria-busy");
      }
    }
  };

  function showTrust(trust: Trust, saved: string) {
    const changed = trust === "changed";
    get("ssh-changed").hidden = !changed;
    get("ssh-remember-row").hidden = trust !== "new";
    get("ssh-saved-fingerprint").textContent = saved;
    accept.disabled = changed;
    if (challenge) challenge.trust = trust;
    get("ssh-trust-note").textContent = {
      new: "首次连接此主机。请通过可信渠道核对以上指纹；未勾选保存时，信任只用于本次连接。",
      known: "该主机密钥已保存，指纹一致。",
      changed: "",
    }[trust];
    accept.textContent = challenge && stageOf(challenge) === "jump"
      ? trust === "known" ? "继续检查目标指纹" : "信任跳板主机并检查目标指纹"
      : trust === "known"
      ? { verification: "验证", terminal: "打开终端", files: "浏览文件" }[purpose]
      : { verification: "仅本次信任并验证", terminal: "仅本次信任并打开终端", files: "仅本次信任并浏览文件" }[purpose];
  }
  replaceConfirm.addEventListener("change", () => { replace.disabled = !replaceConfirm.checked; });
  replace.addEventListener("click", async () => {
    if (!challenge || challenge.trust !== "changed" || !replaceConfirm.checked) return;
    const token = challenge.challengeToken;
    replace.disabled = true;
    error.textContent = "";
    try {
      await invoke("ssh_trust_replace", { challengeToken: token });
      if (challenge?.challengeToken !== token) return;
      showTrust("known", "");
      status.textContent = "已替换保存的主机密钥。确认后继续连接。";
      accept.focus();
    } catch (reason) {
      replace.disabled = !replaceConfirm.checked;
      failed(reason);
    }
  });

  accept.addEventListener("click", async () => {
    if (!scopeToken || !challenge || operationId || !dialog.open) return;
    if (challenge.trust === "changed") return;
    if (Date.now() >= expiresAt) { expire(); return; }
    const token = challenge.challengeToken;
    if (challenge.trust !== "known" && remember.checked) {
      accept.disabled = true;
      try {
        await invoke("ssh_trust_save", { challengeToken: token });
      } catch (reason) {
        accept.disabled = false;
        failed(reason);
        return;
      }
      accept.disabled = false;
      if (challenge?.challengeToken !== token || !dialog.open) return;
      challenge.trust = "known";
    }
    if (stageOf(challenge) === "jump") {
      await probeThrough(token);
      return;
    }
    if (purpose !== "verification") {
      const handoff = {
        challengeToken: token, scopeToken, operationId: crypto.randomUUID(),
        name: `${challenge.host}:${challenge.port}`, credential: credential ?? { method: "key" },
        ...(purpose === "terminal" && agentForwarding ? { agentForwarding: true } : {}),
      };
      const started = purpose === "terminal" ? openTerminal(handoff) : openFiles(handoff);
      if (!started) {
        error.textContent = purpose === "terminal"
          ? "P0 最多同时打开 8 个会话。请先关闭一个会话，再信任并连接。"
          : "已有真实文件浏览正在进行。请先在文件面板断开，再信任并连接。";
        return;
      }
      challenge = undefined; // Ownership moves to the tab or file panel, including cancellation.
      close();
      return;
    }
    const version = ++revision;
    const id = crypto.randomUUID();
    operationId = id;
    const login = credential ?? { method: "key" };
    const prompts = authPromptsFor(login, id, `${challenge.host}:${challenge.port}`);
    challenge = undefined; // Consumed once; retries must obtain a new challenge.
    window.clearTimeout(expiryTimer);
    accept.disabled = true;
    status.textContent = prompts
      ? "正在连接；请在弹出的对话框中回答服务器提示…可随时取消。"
      : "正在认证并执行 fixture-check…可随时取消。";
    dialog.setAttribute("aria-busy", "true");
    try {
      const result = await invoke<VerificationResult>("ssh_accept", { scopeToken, challengeToken: token, operationId: id, credential: login, onAuth: prompts?.channel });
      credential = undefined;
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
      prompts?.finish();
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
    open(mode: Purpose = "verification") {
      if (dialog.open) return;
      purpose = mode;
      get("ssh-verification-title").textContent = { verification: "验证真实连接", terminal: "连接 SSH 终端", files: "只读浏览远端文件" }[mode];
      get("ssh-description").textContent = {
        verification: "连接受控测试服务器，核对主机指纹后执行固定命令 fixture-check。此入口不提供交互终端或 SFTP。",
        terminal: "核对真实主机指纹后，建立交互式远端终端。输入会在服务器实际执行；文件浏览请使用文件面板的只读 SFTP 入口。",
        files: "核对真实主机指纹后，通过 SFTP 只读浏览远端目录、查看属性并预览不超过 64 KiB 的文件。不上传、删除或改名；信任仅在本窗口内存中保留，空闲 5 分钟失效。",
      }[mode];
      accept.textContent = { verification: "仅本次信任并验证", terminal: "仅本次信任并打开终端", files: "仅本次信任并浏览文件" }[mode];
      get("ssh-agent-forward-fields").hidden = mode !== "terminal";
      clear();
      resetView();
      get("ssh-browser-note").hidden = desktop;
      dialog.showModal();
      get("ssh-close").focus();
      void initializeContext();
    },
  };
}

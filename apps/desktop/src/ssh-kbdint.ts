import { Channel, invoke } from "@tauri-apps/api/core";

/** One keyboard-interactive round from the backend. All text came from the server. */
export type AuthPrompt = {
  operationId: string;
  round: number;
  name: string;
  instructions: string;
  prompts: { text: string; echo: boolean }[];
  expiresInSeconds: number;
};
/** The channel passed as `onAuth`; `finish` must run once the command settles. */
export type AuthPrompts = { channel: Channel<AuthPrompt>; finish(): void };

const MAX_ANSWER_BYTES = 1024;
const MAX_FINISHED = 64;
type Entry = { prompt: AuthPrompt; label: string; submitted: boolean };

let dialog: HTMLDialogElement | undefined;
let current: Entry | undefined;
let expiryTimer: number | undefined;
const queue: Entry[] = [];
// Operations that ended or were cancelled; late rounds for them are ignored.
const finished: string[] = [];

/**
 * Creates the answer channel for one operation. Rounds are shown one at a time
 * in a modal dialog; server text is rendered with textContent only.
 */
export function createAuthPrompts(operationId: string, label: string): AuthPrompts {
  const channel = new Channel<AuthPrompt>();
  channel.onmessage = (prompt) => {
    if (prompt?.operationId !== operationId || finished.includes(operationId)) return;
    if (!Array.isArray(prompt.prompts) || prompt.prompts.length === 0) return;
    enqueue({ prompt, label, submitted: false });
  };
  return { channel, finish: () => dismiss(operationId) };
}

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  const element = document.createElement("dialog");
  element.id = "ssh-kbdint-dialog";
  element.setAttribute("aria-labelledby", "ssh-kbdint-title");
  // Static skeleton only; every server string is set with textContent below.
  element.innerHTML = `
    <div class="dialog-heading"><div><span class="eyebrow" id="ssh-kbdint-context"></span><h2 id="ssh-kbdint-title">SSH 键盘交互认证</h2></div></div>
    <p class="caption">名称、说明和提示均由服务器发送，按纯文本显示。答案只发送给这一次连接，不会保存。</p>
    <strong id="ssh-kbdint-name"></strong>
    <p id="ssh-kbdint-instructions"></p>
    <form id="ssh-kbdint-form" autocomplete="off">
      <div id="ssh-kbdint-prompts"></div>
      <p id="ssh-kbdint-expiry" class="caption"></p>
      <p id="ssh-kbdint-status" role="status" aria-live="polite"></p>
      <p id="ssh-kbdint-error" role="alert" aria-live="assertive"></p>
      <div class="dialog-actions"><button type="button" id="ssh-kbdint-cancel">取消连接</button><button type="submit" id="ssh-kbdint-submit" class="primary">提交</button></div>
    </form>`;
  document.body.append(element);
  element.querySelector<HTMLFormElement>("#ssh-kbdint-form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  element.querySelector("#ssh-kbdint-cancel")!.addEventListener("click", cancelCurrent);
  element.addEventListener("cancel", (event) => { event.preventDefault(); cancelCurrent(); });
  dialog = element;
  return element;
}

const part = <T extends HTMLElement = HTMLElement>(id: string) => ensureDialog().querySelector<T>(`#${id}`)!;
const inputs = () => [...part("ssh-kbdint-prompts").querySelectorAll<HTMLInputElement>("input")];

function enqueue(entry: Entry) {
  // The next round of the operation already answered replaces its waiting view.
  if (!current || (current.submitted && current.prompt.operationId === entry.prompt.operationId)) show(entry);
  else queue.push(entry);
}

function show(entry: Entry) {
  window.clearTimeout(expiryTimer);
  current = entry;
  const { prompt } = entry;
  part("ssh-kbdint-context").textContent = `${entry.label} · 第 ${prompt.round} 轮`;
  const name = part("ssh-kbdint-name");
  name.textContent = prompt.name;
  name.hidden = !prompt.name;
  const instructions = part("ssh-kbdint-instructions");
  instructions.textContent = prompt.instructions;
  instructions.hidden = !prompt.instructions;
  const fields = prompt.prompts.map((field, index) => {
    const label = document.createElement("label");
    const text = document.createElement("span");
    text.className = "ssh-kbdint-prompt";
    text.textContent = field.text || `提示 ${index + 1}`;
    const input = document.createElement("input");
    // Secret answers are never displayed; echo answers (such as codes) may be.
    input.type = field.echo ? "text" : "password";
    input.autocomplete = field.echo ? "one-time-code" : "off";
    input.spellcheck = false;
    input.maxLength = MAX_ANSWER_BYTES;
    label.append(text, input);
    return label;
  });
  part("ssh-kbdint-prompts").replaceChildren(...fields);
  part("ssh-kbdint-error").textContent = "";
  part("ssh-kbdint-status").textContent = "";
  part<HTMLButtonElement>("ssh-kbdint-submit").disabled = false;
  const seconds = Math.max(1, Math.floor(prompt.expiresInSeconds));
  part("ssh-kbdint-expiry").textContent = `请在 ${seconds} 秒内提交；超时后连接失败，需要重新核对指纹。`;
  expiryTimer = window.setTimeout(() => {
    if (current !== entry || entry.submitted) return;
    entry.submitted = true;
    clearInputs();
    part<HTMLButtonElement>("ssh-kbdint-submit").disabled = true;
    part("ssh-kbdint-error").textContent = "回答已超时，连接会失败。请关闭后重新连接。";
  }, seconds * 1000);
  const element = ensureDialog();
  if (!element.open) element.showModal();
  inputs()[0]?.focus();
}

function clearInputs() {
  for (const input of inputs()) {
    input.value = "";
    input.disabled = true;
  }
}

async function submit() {
  const entry = current;
  if (!entry || entry.submitted) return;
  const fields = inputs();
  const answers = fields.map(input => input.value);
  if (answers.some(answer => new TextEncoder().encode(answer).length > MAX_ANSWER_BYTES || answer.includes("\0"))) {
    part("ssh-kbdint-error").textContent = "每个答案最多 1024 字节，且不能包含 NUL 字符。";
    return;
  }
  // Sent once: further clicks are ignored until the server's next round.
  entry.submitted = true;
  clearInputs();
  part<HTMLButtonElement>("ssh-kbdint-submit").disabled = true;
  part("ssh-kbdint-error").textContent = "";
  part("ssh-kbdint-status").textContent = "已提交，正在等待服务器响应…";
  window.clearTimeout(expiryTimer);
  try {
    await invoke("ssh_auth_respond", { operationId: entry.prompt.operationId, round: entry.prompt.round, answers });
  } catch (reason) {
    if (current !== entry) return;
    part("ssh-kbdint-status").textContent = "";
    part("ssh-kbdint-error").textContent = typeof reason === "string" ? reason : "提交失败，请取消后重新连接。";
  }
}

function cancelCurrent() {
  const entry = current;
  if (!entry) { dialog?.close(); return; }
  const operationId = entry.prompt.operationId;
  // The owner sees the command fail as cancelled and calls finish().
  void invoke("ssh_cancel", { operationId }).catch(() => {});
  dismiss(operationId);
}

/** Removes every round of an operation; shows the next queued one, if any. */
function dismiss(operationId: string) {
  if (!finished.includes(operationId)) {
    finished.push(operationId);
    if (finished.length > MAX_FINISHED) finished.shift();
  }
  for (let index = queue.length - 1; index >= 0; index--) {
    if (queue[index].prompt.operationId === operationId) queue.splice(index, 1);
  }
  if (current?.prompt.operationId !== operationId) return;
  window.clearTimeout(expiryTimer);
  clearInputs();
  current = undefined;
  const next = queue.shift();
  if (next) show(next);
  else dialog?.close();
}

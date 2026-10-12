// Helpers for the SFTP write prototype (WindTerm F02–F07). The backend
// re-validates everything; these checks only give earlier, clearer feedback.
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_NAME_BYTES = 255;
// Exact backend text for a write on a grant that is still read-only.
export const READ_ONLY_ERROR = "SFTP session is read-only; allow writes first";

export interface TransferProgress { operationId: string; transferred: number; total: number }
export interface Downloaded { path: string; bytes: number }

/** A reason the name cannot be one remote path component, or undefined. */
export function remoteNameError(name: string): string | undefined {
  if (!name) return "名称不能为空。";
  if (name === "." || name === "..") return "名称不能是 . 或 ..。";
  if (name.includes("/")) return "名称不能包含 /。";
  // Matches Rust's char::is_control (Unicode Cc), which the backend refuses.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return "名称不能包含控制字符。";
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return "名称超过 255 字节。";
  return undefined;
}

/** Three octal digits (rwx for owner, group, others) or undefined. */
export function parseMode(text: string): number | undefined {
  return /^[0-7]{3}$/.test(text.trim()) ? Number.parseInt(text.trim(), 8) : undefined;
}

/** Upload headers must be ASCII, so the UTF-8 path travels as hex. */
export function hexUtf8(text: string): string {
  return Array.from(new TextEncoder().encode(text), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A Tauri `Channel`, which serializes to its IPC id string. */
export interface IpcChannel { toJSON(): string }

export interface UploadArgs {
  grantToken: string;
  scopeToken: string;
  operationId: string;
  path: string;
  overwrite: boolean;
  onAuth?: IpcChannel;
  onProgress?: IpcChannel;
}

/** Header contract of `ssh_sftp_upload`; the body is the raw file bytes. */
export function uploadHeaders(args: UploadArgs): Record<string, string> {
  const headers: Record<string, string> = {
    "x-sftp-grant": args.grantToken,
    "x-sftp-scope": args.scopeToken,
    "x-sftp-operation": args.operationId,
    "x-sftp-path": hexUtf8(args.path),
    "x-sftp-overwrite": String(args.overwrite),
  };
  if (args.onAuth) headers["x-sftp-on-auth"] = args.onAuth.toJSON();
  if (args.onProgress) headers["x-sftp-on-progress"] = args.onProgress.toJSON();
  return headers;
}

export interface AskOptions {
  title: string;
  /** Plain text; remote names may appear here and are never parsed as HTML. */
  message: string;
  confirm: string;
  danger?: boolean;
  /** Shows a text field; the dialog resolves with its exact value. */
  input?: { label: string; value: string; validate(value: string): string | undefined; hint?(value: string): string };
}

let dialog: HTMLDialogElement | undefined;
let settle: ((value: string | null) => void) | undefined;

function ensureDialog(): HTMLDialogElement {
  if (dialog) return dialog;
  const element = document.createElement("dialog");
  element.id = "sftp-dialog";
  element.setAttribute("aria-labelledby", "sftp-dialog-title");
  // Static skeleton only; every caller string is set with textContent.
  element.innerHTML = `
    <form method="dialog" id="sftp-dialog-form" autocomplete="off">
      <h2 id="sftp-dialog-title"></h2>
      <p id="sftp-dialog-message"></p>
      <label id="sftp-dialog-field"><span id="sftp-dialog-label"></span><input id="sftp-dialog-input" spellcheck="false" /></label>
      <p id="sftp-dialog-hint" class="caption" aria-live="polite"></p>
      <div class="dialog-actions"><button type="button" id="sftp-dialog-cancel">取消</button><button type="submit" id="sftp-dialog-confirm" class="primary"></button></div>
    </form>`;
  document.body.append(element);
  const input = element.querySelector<HTMLInputElement>("#sftp-dialog-input")!;
  element.querySelector("#sftp-dialog-form")!.addEventListener("submit", event => {
    event.preventDefault();
    const field = !element.querySelector<HTMLElement>("#sftp-dialog-field")!.hidden;
    if (field && element.dataset.invalid === "true") return;
    finish(field ? input.value : "");
  });
  element.querySelector("#sftp-dialog-cancel")!.addEventListener("click", () => finish(null));
  element.addEventListener("cancel", event => { event.preventDefault(); finish(null); });
  dialog = element;
  return element;
}

function finish(value: string | null) {
  const resolve = settle;
  settle = undefined;
  if (dialog?.open) dialog.close();
  resolve?.(value);
}

/** Asks for confirmation (and optionally one value). Resolves null on cancel. */
export function askSftp(options: AskOptions): Promise<string | null> {
  finish(null); // At most one question at a time; an older one is cancelled.
  const element = ensureDialog();
  const part = <T extends HTMLElement = HTMLElement>(id: string) => element.querySelector<T>(`#${id}`)!;
  part("sftp-dialog-title").textContent = options.title;
  part("sftp-dialog-message").textContent = options.message;
  const confirm = part<HTMLButtonElement>("sftp-dialog-confirm");
  confirm.textContent = options.confirm;
  confirm.classList.toggle("danger", Boolean(options.danger));
  const field = part("sftp-dialog-field");
  const input = part<HTMLInputElement>("sftp-dialog-input");
  const hint = part("sftp-dialog-hint");
  field.hidden = !options.input;
  hint.textContent = "";
  element.dataset.invalid = "false";
  input.oninput = null;
  if (options.input) {
    const spec = options.input;
    part("sftp-dialog-label").textContent = spec.label;
    input.value = spec.value;
    const check = () => {
      const problem = spec.validate(input.value);
      element.dataset.invalid = String(Boolean(problem));
      confirm.disabled = Boolean(problem);
      hint.textContent = problem ?? spec.hint?.(input.value) ?? "";
    };
    input.oninput = check;
    check();
  } else {
    confirm.disabled = false;
  }
  return new Promise(resolve => {
    settle = resolve;
    element.showModal();
    (options.input ? input : part("sftp-dialog-cancel")).focus();
  });
}

/** Closes an open question, as if cancelled (disconnect, reload). */
export function dismissSftpDialog() {
  finish(null);
}

import { icon } from "./icons";
import {
  DEFAULT_ENCODING, ENCODINGS, encodingLabel, encodingSupported, isEncodingId, type EncodingId,
} from "./text-encoding";

/**
 * Encoding controls shared by the local launch options, the SSH terminal and the Telnet / Raw TCP
 * dialogs, plus the command palette's "switch the current session's encoding" sheet. Everything is
 * built with DOM APIs from the fixed encoding list; no session, host or terminal text is parsed as
 * HTML.
 */
export interface EncodingField {
  readonly field: HTMLElement;
  readonly select: HTMLSelectElement;
}

/** A select of every encoding; one this WebView cannot decode is listed but disabled. */
export function createEncodingSelect(id: string): HTMLSelectElement {
  const select = document.createElement("select");
  select.id = id;
  for (const info of ENCODINGS) {
    const supported = encodingSupported(info.id);
    const option = new Option(supported ? info.description : `${info.description}（此 WebView 不支持）`, info.id);
    option.disabled = !supported;
    select.add(option);
  }
  select.value = DEFAULT_ENCODING;
  return select;
}

/** Label, select and an explanation, for a connection or launch form. */
export function createEncodingField(prefix: string, hint: string): EncodingField {
  const field = document.createElement("div");
  field.className = "encoding-field";
  const label = document.createElement("label");
  label.htmlFor = `${prefix}-encoding`;
  label.textContent = "字符编码";
  const select = createEncodingSelect(`${prefix}-encoding`);
  const caption = document.createElement("p");
  caption.id = `${prefix}-encoding-hint`;
  caption.className = "caption";
  caption.textContent = hint;
  select.setAttribute("aria-describedby", caption.id);
  label.append(select);
  field.append(label, caption);
  return { field, select };
}

/** The chosen encoding; anything unexpected selects the default rather than a guess. */
export function readEncoding(select: HTMLSelectElement): EncodingId {
  return isEncodingId(select.value) && encodingSupported(select.value) ? select.value : DEFAULT_ENCODING;
}

/** Shown on every encoding choice: what the setting changes and what it does not. */
export const ENCODING_HINT =
  "只决定本应用如何解码收到的字节、如何把输入编成字节，不修改远端或 Shell 的 locale；请让远端程序使用相同编码。无法用所选编码表示的输入整段不发送并提示。默认 UTF-8 与原行为一致；设置只保存在本会话内存中。";

/** Status bar suffix: empty for the default, so UTF-8 sessions look exactly as before. */
export function encodingStatus(id: EncodingId): string {
  return id === DEFAULT_ENCODING ? "" : ` · ${encodingLabel(id)}`;
}

export interface EncodingSwitchTarget {
  readonly name: string;
  readonly encoding: EncodingId;
  /** Applies the choice to the session; false when the session can no longer take it. */
  apply(id: EncodingId): boolean;
}

/** Command palette sheet that changes the encoding of a running session. */
export function createEncodingSwitchDialog(notify: (message: string) => void): { open(target: EncodingSwitchTarget): void } {
  const dialog = document.createElement("dialog");
  dialog.id = "encoding-dialog";
  dialog.setAttribute("aria-labelledby", "encoding-title");
  const form = document.createElement("form");
  form.method = "dialog";
  const heading = document.createElement("div");
  heading.className = "dialog-heading";
  const title = document.createElement("h2");
  title.id = "encoding-title";
  title.textContent = "切换当前会话字符编码";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "icon-button";
  close.id = "encoding-close";
  close.setAttribute("aria-label", "关闭字符编码窗口");
  close.innerHTML = icon("close");
  heading.append(title, close);
  const current = document.createElement("p");
  current.id = "encoding-current";
  const { field, select } = createEncodingField("encoding-switch", "");
  const note = field.querySelector<HTMLElement>(".caption")!;
  note.textContent =
    "只作用于之后收到的输出和之后产生的输入：屏幕与历史中已有内容不重新解码，已排队的输入不重新编码；切换时若前一编码正停在一个字符中间，该字符显示为 �。不修改远端 locale；重新打开本地终端仍使用启动选项中的编码。";
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.id = "encoding-cancel";
  cancel.textContent = "取消";
  const apply = document.createElement("button");
  apply.type = "submit";
  apply.id = "encoding-apply";
  apply.className = "primary";
  apply.textContent = "应用";
  actions.append(cancel, apply);
  form.append(heading, current, field, actions);
  dialog.append(form);
  document.body.append(dialog);

  let target: EncodingSwitchTarget | undefined;
  const dismiss = () => {
    target = undefined;
    dialog.close();
  };
  close.addEventListener("click", dismiss);
  cancel.addEventListener("click", dismiss);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const chosen = target;
    dismiss();
    if (!chosen) return;
    const id = readEncoding(select);
    if (id === chosen.encoding) return;
    notify(chosen.apply(id)
      ? `「${chosen.name}」之后的输出与输入改用 ${encodingLabel(id)}。`
      : `「${chosen.name}」已结束或已关闭，未切换编码。`);
  });
  return {
    open(next: EncodingSwitchTarget) {
      if (dialog.open) return;
      target = next;
      current.textContent = `会话「${next.name}」当前编码：${encodingLabel(next.encoding)}`;
      select.value = next.encoding;
      dialog.showModal();
      select.focus();
    },
  };
}

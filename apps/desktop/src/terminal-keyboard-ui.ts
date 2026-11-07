import {
  DEFAULT_KEYBOARD, changedKeyboardOptions, snapshotKeyboard, type KeyboardOptions,
} from "./terminal-keyboard";

/**
 * "Keyboard and initial modes" controls shared by the local launch options, the SSH terminal and
 * the Telnet / Raw TCP dialogs. Built with DOM APIs from fixed labels; no session or host text is
 * parsed as HTML. Collapsed by default: an untouched field reads back as the defaults.
 */
export interface KeyboardField {
  readonly field: HTMLDetailsElement;
  /** The current choices as a frozen snapshot. */
  read(): KeyboardOptions;
  /** Shows `options` (for example a session's own, when its launch options are edited). */
  set(options: KeyboardOptions): void;
}

type Choice = readonly [value: string, label: string];

const BACKSPACE: readonly Choice[] = [["del", "DEL（0x7F，默认）"], ["bs", "BS（Ctrl+H，0x08）"]];
const DELETE: readonly Choice[] = [["vt220", "ESC [ 3 ~（默认）"], ["del", "DEL（0x7F）"], ["bs", "BS（Ctrl+H，0x08）"]];
const OPTION_META: readonly Choice[] = [["false", "输入键盘布局字符（默认）"], ["true", "作为 Meta，发送 ESC 前缀"]];
const CURSOR_KEYS: readonly Choice[] = [["normal", "常规（默认）"], ["application", "应用"]];

/** Same check as xterm.js 6.0.0, which decides from it whether Option can be Meta. */
const isMac = () => ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(navigator.platform);

function select(id: string, label: string, choices: readonly Choice[]): { label: HTMLLabelElement; select: HTMLSelectElement } {
  const element = document.createElement("label");
  element.htmlFor = id;
  element.textContent = label;
  const control = document.createElement("select");
  control.id = id;
  for (const [value, text] of choices) control.add(new Option(text, value));
  element.append(control);
  return { label: element, select: control };
}

function caption(id: string, text: string): HTMLParagraphElement {
  const element = document.createElement("p");
  element.id = id;
  element.className = "caption";
  element.textContent = text;
  return element;
}

/** Explains what the options change and what they do not. */
export const KEYBOARD_HINT =
  "默认值与原行为一致，只影响本应用发送的按键字节，不修改远端 stty、terminfo 或 Shell 设置。"
  + "退格键选 BS 时，Ctrl+退格改为发送 DEL；带修饰键的删除键仍发送 ESC [ 3 ; n ~。输入法组字期间的按键由输入法处理，不受影响。";
export const MODE_HINT =
  "初始模式只在会话开始时设置本地终端，不向主机发送任何字节；之后以主机发来的切换为准，主机复位（RIS、DECSTR）恢复为常规模式，"
  + "本应用的「硬复位」会恢复此处的初始模式。设置只保存在本会话内存中，本地终端重新打开时沿用。";

export function createKeyboardField(prefix: string): KeyboardField {
  const field = document.createElement("details");
  field.className = "keyboard-field";
  field.id = `${prefix}-keyboard`;
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.textContent = "键盘与初始模式";
  const state = document.createElement("span");
  state.id = `${prefix}-keyboard-state`;
  state.className = "keyboard-state";
  summary.append(title, state);
  const backspace = select(`${prefix}-backspace`, "退格键（Backspace）发送", BACKSPACE);
  const del = select(`${prefix}-delete`, "删除键（Delete）发送", DELETE);
  const option = select(`${prefix}-option-meta`, "macOS Option 键", OPTION_META);
  const cursor = select(`${prefix}-cursor-keys`, "初始光标键模式（DECCKM）", CURSOR_KEYS);
  const grid = document.createElement("div");
  grid.className = "keyboard-grid";
  grid.append(backspace.label, del.label, option.label, cursor.label);
  const keysHint = caption(`${prefix}-keyboard-hint`, KEYBOARD_HINT);
  const optionHint = caption(`${prefix}-option-meta-hint`, "");
  const modeHint = caption(`${prefix}-mode-hint`, MODE_HINT);
  backspace.select.setAttribute("aria-describedby", keysHint.id);
  del.select.setAttribute("aria-describedby", keysHint.id);
  option.select.setAttribute("aria-describedby", optionHint.id);
  cursor.select.setAttribute("aria-describedby", modeHint.id);
  field.append(summary, grid, keysHint, optionHint, modeHint);

  const mac = isMac();
  // Elsewhere xterm.js always treats Alt as Meta (Ctrl+Alt is AltGr on Windows); nothing to choose.
  option.select.disabled = !mac;
  optionHint.textContent = mac
    ? "作为 Meta 后，Option+字母发送 ESC 加该字母（便于 Shell 的 Alt+B/F 等），但不能再用 Option 输入 @ { } | ~ 等布局字符或重音死键。"
    : "仅适用于 macOS。Windows / Linux 上 Alt 始终作为 Meta 发送 ESC 前缀（Windows 的 Ctrl+Alt 为 AltGr）。";

  const read = (): KeyboardOptions => snapshotKeyboard({
    backspace: backspace.select.value as KeyboardOptions["backspace"],
    delete: del.select.value as KeyboardOptions["delete"],
    optionAsMeta: mac && option.select.value === "true",
    cursorKeys: cursor.select.value as KeyboardOptions["cursorKeys"],
  });
  const showState = () => {
    const changed = changedKeyboardOptions(read());
    state.textContent = changed ? `已修改 ${changed} 项` : "默认";
  };
  const set = (options: KeyboardOptions) => {
    const value = snapshotKeyboard(options);
    backspace.select.value = value.backspace;
    del.select.value = value.delete;
    option.select.value = String(value.optionAsMeta);
    cursor.select.value = value.cursorKeys;
    // A session's own non-default choices are shown open, so editing them is not a hidden step.
    field.open = changedKeyboardOptions(value) > 0;
    showState();
  };
  for (const control of [backspace.select, del.select, option.select, cursor.select])
    control.addEventListener("change", showState);
  set(DEFAULT_KEYBOARD);
  return { field, read, set };
}

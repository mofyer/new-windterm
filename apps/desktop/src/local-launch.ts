import { invoke } from "@tauri-apps/api/core";
import { validateStartupCommand, validateStartupCommandEncoding } from "./startup-command";
import { DEFAULT_ENCODING, isEncodingId, type EncodingId } from "./text-encoding";
import { createEncodingField, ENCODING_HINT, readEncoding } from "./session-encoding-ui";

export type EnvironmentVariable = Readonly<{ name: string; value: string }>;
export type LocaleOptions = Readonly<{ mode: "default" | "custom"; variables: readonly EnvironmentVariable[] }>;
export type LaunchOptions = Readonly<{
  cwd: string | null;
  shell: string | null;
  env: readonly EnvironmentVariable[];
  locale: LocaleOptions | null;
  /**
   * Startup command typed into the shell once after it opens (see `startup-command.ts`). Frontend
   * only: it is never part of the `pty_open` arguments ({@link nativeLaunchArguments}).
   */
  command: string | null;
  /**
   * Character encoding of the session's output and input (see `session-encoding.ts`). Frontend
   * only, like `command`: Rust keeps forwarding raw bytes and never receives it.
   */
  encoding: EncodingId;
}>;
/** Exactly the launch fields `pty_open` takes. */
export type NativeLaunchArguments = Readonly<Pick<LaunchOptions, "cwd" | "shell" | "env" | "locale">>;

/** Own every row as well as the arrays, including when reopening an old session. */
export function snapshotLaunchOptions(options?: Partial<LaunchOptions>): LaunchOptions {
  const copy = (rows: readonly EnvironmentVariable[]) => Object.freeze(rows.map(row => Object.freeze({ ...row })));
  return Object.freeze({
    cwd: options?.cwd ?? null,
    shell: options?.shell ?? null,
    env: copy(options?.env ?? []),
    locale: options?.locale ? Object.freeze({ mode: options.locale.mode, variables: copy(options.locale.variables) }) : null,
    command: options?.command || null,
    encoding: isEncodingId(options?.encoding) ? options.encoding : DEFAULT_ENCODING,
  });
}

/** An explicit allow-list, so the startup command (or any later frontend field) never reaches Rust. */
export function nativeLaunchArguments(options: LaunchOptions): NativeLaunchArguments {
  return { cwd: options.cwd, shell: options.shell, env: options.env, locale: options.locale };
}

const localeNames = ["LANG", "LC_ALL", "LC_CTYPE", "LC_COLLATE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME", "LC_ADDRESS", "LC_IDENTIFICATION", "LC_MEASUREMENT", "LC_NAME", "LC_PAPER"];
type ShellChoice = {
  id: string;
  label: string;
  path: string | null;
  available: boolean;
  reason: string | null;
};

/** Owns only the launch form; each session takes a separate immutable snapshot. */
export function createLocalLaunchOptions(
  dialog: HTMLDialogElement,
  native: boolean,
  launch: (options: LaunchOptions) => boolean,
) {
  const cwd = dialog.querySelector<HTMLInputElement>("#local-cwd-input")!;
  // A textarea keeps a pasted line break, so it is reported instead of silently removed.
  const command = dialog.querySelector<HTMLTextAreaElement>("#local-command-input")!;
  const shell = dialog.querySelector<HTMLSelectElement>("#local-shell-select")!;
  const status = dialog.querySelector<HTMLElement>("#local-shell-status")!;
  const missing = dialog.querySelector<HTMLElement>("#local-shell-missing")!;
  const start = dialog.querySelector<HTMLButtonElement>("#local-start")!;
  const envRows = dialog.querySelector<HTMLElement>("#local-env-rows")!;
  const localeRows = dialog.querySelector<HTMLElement>("#local-locale-rows")!;
  const envAdd = dialog.querySelector<HTMLButtonElement>("#local-env-add")!;
  const localeAdd = dialog.querySelector<HTMLButtonElement>("#local-locale-add")!;
  const localeMode = dialog.querySelector<HTMLSelectElement>("#local-locale-mode")!;
  const error = dialog.querySelector<HTMLElement>("#local-options-error")!;
  // Next to the startup command: both decide which bytes reach the shell.
  const { field: encodingField, select: encoding } = createEncodingField(
    "local",
    `${ENCODING_HINT}本地 Shell 的 locale 请在下方 Locale 中另行设置（例如 zh_TW.Big5）。`,
  );
  dialog.querySelector("#local-command-hint")!.after(encodingField);
  let generation = 0;
  let choices: ShellChoice[] = [];
  let discovered = false;

  function updateRows() {
    envAdd.disabled = envRows.children.length >= 64;
    localeAdd.disabled = localeRows.children.length >= localeNames.length;
    dialog.querySelector<HTMLElement>("#local-locale-custom")!.hidden = localeMode.value !== "custom";
    error.textContent = "";
  }
  function addRow(kind: "env" | "locale", entry: EnvironmentVariable = { name: "", value: "" }, focus = true) {
    const container = kind === "env" ? envRows : localeRows;
    if (container.children.length >= (kind === "env" ? 64 : localeNames.length)) return;
    const row = document.createElement("div");
    row.className = "local-variable-row";
    const name = document.createElement(kind === "env" ? "input" : "select");
    name.setAttribute(`data-${kind}-name`, "");
    name.setAttribute("aria-label", kind === "env" ? "环境变量名称" : "Locale 变量名称");
    if (name instanceof HTMLSelectElement) {
      for (const label of localeNames) name.add(new Option(label, label));
      name.value = entry.name || "LANG";
    } else {
      name.type = "text";
      name.autocomplete = "off";
      name.spellcheck = false;
      name.value = entry.name;
      name.placeholder = "变量名称";
    }
    // A textarea preserves literal newlines as well as empty and Unicode values.
    const value = document.createElement("textarea");
    value.rows = 1;
    value.setAttribute(`data-${kind}-value`, "");
    value.setAttribute("aria-label", kind === "env" ? "环境变量值" : "Locale 变量值");
    value.autocomplete = "off";
    value.spellcheck = false;
    value.value = entry.value;
    value.placeholder = "值（可留空）";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute(`data-${kind}-remove`, "");
    remove.textContent = "移除";
    remove.setAttribute("aria-label", kind === "env" ? "移除此环境变量" : "移除此 Locale 变量");
    remove.onclick = () => {
      const next = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      updateRows();
      (next?.querySelector<HTMLElement>("input, select") ?? (kind === "env" ? envAdd : localeAdd)).focus();
    };
    row.append(name, value, remove);
    container.append(row);
    updateRows();
    if (focus) name.focus();
  }
  function readRows(kind: "env" | "locale"): EnvironmentVariable[] {
    return Array.from((kind === "env" ? envRows : localeRows).children, row => ({
      name: row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-${kind}-name]`)!.value,
      value: row.querySelector<HTMLTextAreaElement>(`[data-${kind}-value]`)!.value,
    }));
  }
  function validate(env: EnvironmentVariable[], locale: EnvironmentVariable[]): string | null {
    const encoder = new TextEncoder();
    let bytes = 0;
    for (const [kind, rows] of [["环境变量", env], ["Locale", locale]] as const) {
      const names = new Set<string>();
      for (const row of rows) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.name) || row.name.length > 64) return `${kind}名称须为最多 64 个 ASCII 字符，以字母或下划线开头，仅含字母、数字和下划线。`;
        if (row.value.includes("\0")) return `${kind}值不能包含 NUL 字符。`;
        const size = encoder.encode(row.value).length;
        if (size > 4096) return `${kind}的单个值最多 4096 UTF-8 字节。`;
        if (names.has(row.name)) return `${kind}名称不能重复。`;
        names.add(row.name);
        bytes += row.name.length + size + 2;
      }
    }
    if (env.some(row => row.name === "LANG" || row.name.startsWith("LC_"))) return "请在 Locale 区域设置 LANG 和 LC_* 变量。";
    if (locale.some(row => row.name === "LC_ALL") && locale.some(row => row.name.startsWith("LC_") && row.name !== "LC_ALL")) return "LC_ALL 不能与其他 LC_* 变量同时设置；可以与 LANG 同时设置。";
    if (bytes > 16 * 1024) return "环境变量与 Locale 配置合计最多 16 KiB。";
    // Native validation additionally enforces platform case rules and protected names.
    return null;
  }
  envAdd.onclick = () => addRow("env");
  localeAdd.onclick = () => addRow("locale");
  localeMode.onchange = updateRows;
  dialog.querySelector("#local-form")!.addEventListener("input", () => {
    error.textContent = "";
    command.removeAttribute("aria-invalid");
  });
  // Single line: Return submits the form like a text input, except while an IME composes.
  command.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    command.form?.requestSubmit();
  });

  function addOption(id: string, label: string, unavailable = false) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    option.disabled = unavailable;
    shell.append(option);
  }
  function updateSelection() {
    const selected = choices.find(choice => choice.id === shell.value);
    start.disabled = !native || (discovered && shell.value !== "" && !selected?.available);
    if (!discovered) return;
    status.textContent = shell.value === ""
      ? "使用当前平台的默认 Shell。"
      : selected?.available
        ? `${selected.label} · ${selected.path ?? "启动时验证可执行文件"}`
        : `${selected?.label ?? shell.value} 不可用：${selected?.reason ?? "未发现此 Shell，请选择其他 Shell。"}`;
  }
  function render(selected: string) {
    shell.replaceChildren();
    addOption("", "默认 Shell");
    for (const choice of choices) {
      addOption(choice.id, `${choice.label}${choice.available ? "" : "（不可用）"}`, !choice.available);
    }
    // Keep an earlier session's choice even if discovery no longer returns it.
    if (selected && !choices.some(choice => choice.id === selected)) {
      addOption(selected, `${selected}（${discovered ? "未发现" : "待验证"}）`, discovered);
    }
    shell.value = selected;
    updateSelection();
  }
  async function discover() {
    const request = ++generation;
    const selected = shell.value;
    choices = [];
    discovered = false;
    missing.replaceChildren();
    render(selected);
    status.textContent = native ? "正在查找可用 Shell…" : "Shell 发现仅在桌面程序中可用。";
    if (!native) return;
    try {
      const result = await invoke<ShellChoice[]>("pty_shells");
      if (request !== generation || !dialog.open) return;
      choices = result;
      discovered = true;
      for (const choice of choices.filter(choice => !choice.available)) {
        const item = document.createElement("li");
        item.textContent = `${choice.label}：${choice.reason ?? "未发现可执行文件"}`;
        missing.append(item);
      }
      render(shell.value);
    } catch (error) {
      if (request !== generation || !dialog.open) return;
      choices = [];
      discovered = false;
      status.textContent = `无法获取 Shell 列表：${String(error)}。可继续使用默认 Shell，或关闭后重新打开以重试。`;
      updateSelection();
    }
  }
  shell.addEventListener("change", updateSelection);
  dialog.addEventListener("close", () => {
    // A queued close event from an earlier opening must not cancel a new request.
    if (!dialog.open) generation++;
  });
  dialog.querySelector<HTMLFormElement>("#local-form")!.onsubmit = event => {
    event.preventDefault();
    if (!native || start.disabled) return;
    const chosenEncoding = readEncoding(encoding);
    const commandError = validateStartupCommand(command.value) ?? validateStartupCommandEncoding(command.value, chosenEncoding);
    if (commandError) {
      command.setAttribute("aria-invalid", "true");
      error.textContent = commandError;
      error.focus();
      return;
    }
    const env = readRows("env");
    const variables = localeMode.value === "custom" ? readRows("locale") : [];
    const invalid = validate(env, variables);
    if (invalid) {
      error.textContent = invalid;
      error.focus();
      return;
    }
    // Preserve literal path bytes; only the empty value selects the default.
    if (launch(snapshotLaunchOptions({
      cwd: cwd.value === "" ? null : cwd.value,
      shell: shell.value || null,
      env,
      locale: { mode: localeMode.value === "custom" ? "custom" : "default", variables },
      // Exactly as typed: no trimming, quoting or expansion; empty means no command.
      command: command.value === "" ? null : command.value,
      encoding: chosenEncoding,
    }))) dialog.close();
  };
  if (!native) {
    dialog.querySelector<HTMLElement>("#local-runtime-hint")!.textContent =
      "浏览器演示无法启动本机 shell。请在 Tauri 桌面程序中使用启动选项。";
    start.disabled = true;
  }
  return {
    open(options?: LaunchOptions) {
      if (options) {
        cwd.value = options.cwd ?? "";
        command.value = options.command ?? "";
        command.removeAttribute("aria-invalid");
        encoding.value = options.encoding;
        render(options.shell ?? "");
        envRows.replaceChildren();
        localeRows.replaceChildren();
        for (const row of options.env) addRow("env", row, false);
        for (const row of options.locale?.variables ?? []) addRow("locale", row, false);
        localeMode.value = options.locale?.mode ?? "default";
      }
      updateRows();
      dialog.showModal();
      cwd.focus();
      void discover();
    },
  };
}

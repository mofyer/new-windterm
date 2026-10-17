import { invoke } from "@tauri-apps/api/core";

type LaunchOptions = { cwd: string | null; shell: string | null };
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
  const shell = dialog.querySelector<HTMLSelectElement>("#local-shell-select")!;
  const status = dialog.querySelector<HTMLElement>("#local-shell-status")!;
  const missing = dialog.querySelector<HTMLElement>("#local-shell-missing")!;
  const start = dialog.querySelector<HTMLButtonElement>("#local-start")!;
  let generation = 0;
  let choices: ShellChoice[] = [];
  let discovered = false;

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
    // Preserve literal path bytes; only the empty value selects the default.
    if (launch({ cwd: cwd.value === "" ? null : cwd.value, shell: shell.value || null })) dialog.close();
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
        render(options.shell ?? "");
      }
      dialog.showModal();
      cwd.focus();
      void discover();
    },
  };
}

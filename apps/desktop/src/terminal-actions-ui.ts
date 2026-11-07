import {
  TERMINAL_ACTIONS, actionLabel, actionNormalOnly, runTerminalAction, unavailableReason,
  type ActionResult, type ActionTarget, type TerminalAction,
} from "./terminal-actions";

/**
 * Entry points of the T32 clear and reset actions: one menu button in the terminal tool bar,
 * whose items follow the upstream terminal context menu (clear group, then the reset group), and
 * one command palette entry per action. Both act on the active tab only and share `run`, which
 * checks availability again at the moment of use. Every label is a constant; session names reach
 * the DOM only as text.
 */
export interface ActionSession extends ActionTarget {
  readonly name: string;
}

export interface TerminalActionsHost {
  /** The session the actions apply to: the active tab. */
  active(): ActionSession | undefined;
  /** A short user-facing notice. */
  notify(message: string): void;
  /** Returns keyboard focus to the active terminal. */
  focusTerminal(): void;
}

export interface PaletteCommand {
  readonly name: string;
  readonly action: () => void;
}

export interface TerminalActions {
  /** Runs `action` on the active session, or explains why it cannot. */
  run(action: TerminalAction): void;
  /** Command palette entries, one per action, in menu order. */
  readonly commands: readonly PaletteCommand[];
}

const PALETTE_HINTS: Readonly<Record<TerminalAction, string>> = Object.freeze({
  "clear-scrollback": "当前会话 · 保留屏幕，删除全部回滚历史",
  "clear-screen": "当前会话 · 保留回滚",
  "clear-all": "当前会话 · 屏幕与全部回滚历史",
  "reset-hard": "当前会话 · 恢复初始终端状态",
  "reset-soft": "当前会话 · 保留屏幕与回滚",
  "reset-charset": "当前会话 · 恢复 ASCII 字符集",
});

/** What happened, for the toast; always says that nothing was sent. */
export function actionMessage(action: TerminalAction, name: string, result: ActionResult): string {
  if (result.alternate && actionNormalOnly(action)) {
    return action === "clear-scrollback"
      ? `「${name}」在执行前已切换到备用屏，回滚未清除。`
      : `「${name}」在执行前已切换到备用屏：已擦除全屏程序的当前画面，回滚未清除，程序可能需要重绘。`;
  }
  switch (action) {
    case "clear-scrollback":
      return `已清除「${name}」的全部回滚历史，屏幕保留；只在本地执行，不发送任何数据。`;
    case "clear-screen":
      return `已清除「${name}」的屏幕，回滚保留；只在本地执行，Shell 不会收到通知或重绘提示符。`;
    case "clear-all":
      return `已清除「${name}」的屏幕与全部回滚历史；只在本地执行，Shell 不会收到通知或重绘提示符。`;
    case "reset-hard":
      return `已硬复位「${name}」：模式、字符集、光标与屏幕恢复初始状态，终端内的回滚随之清空；不发送任何数据。`;
    case "reset-soft":
      return `已软复位「${name}」，屏幕与回滚保留；不发送任何数据。`;
    case "reset-charset":
      return `已将「${name}」的字符集重置为 ASCII；不发送任何数据。`;
  }
}

/**
 * macOS-only clear shortcuts (user decision 13, 2026-11-07): Cmd+L clears the screen and
 * Cmd+Shift+L clears screen and scrollback. Ctrl, Option and every other platform are left to the
 * terminal, so Ctrl+L still sends 0x0c; Windows/Linux bindings wait for upstream hands-on checks.
 * Keys typed into an ordinary text field (not xterm's own helper textarea) are never taken.
 */
export function clearShortcut(event: KeyboardEvent, mac: boolean): TerminalAction | undefined {
  if (!mac || !event.metaKey || event.ctrlKey || event.altKey || event.key.toLowerCase() !== "l") return undefined;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest("input, select, textarea:not(.xterm-helper-textarea)")) return undefined;
  return event.shiftKey ? "clear-all" : "clear-screen";
}

export function createTerminalActions(toolbar: HTMLElement, host: TerminalActionsHost): TerminalActions {
  function run(action: TerminalAction) {
    const s = host.active();
    const reason = unavailableReason(s, action);
    if (reason || !s) {
      host.notify(`${actionLabel(action)}不可用：${reason}。`);
      return;
    }
    const name = s.name;
    // Never rejects (terminal-actions.ts); a session closed first gets its own notice.
    void runTerminalAction(s, action).then((result) => {
      host.notify(result.applied ? actionMessage(action, name, result) : `「${name}」已关闭，${actionLabel(action)}未执行。`);
    });
    host.focusTerminal();
  }

  const wrapper = document.createElement("span");
  wrapper.className = "terminal-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.id = "terminal-actions-open";
  button.textContent = "清除与复位";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "terminal-actions-menu");
  const menu = document.createElement("div");
  menu.id = "terminal-actions-menu";
  menu.className = "terminal-actions-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "清除与复位");
  menu.hidden = true;
  const items: HTMLButtonElement[] = [];
  for (const action of TERMINAL_ACTIONS) {
    if (action === "reset-hard") {
      const separator = document.createElement("div");
      separator.setAttribute("role", "separator");
      menu.append(separator);
    }
    const item = document.createElement("button");
    item.type = "button";
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    item.dataset.terminalAction = action;
    item.textContent = actionLabel(action);
    item.addEventListener("click", () => {
      close(false);
      run(action);
    });
    items.push(item);
    menu.append(item);
  }
  wrapper.append(button, menu);
  toolbar.insertBefore(wrapper, toolbar.querySelector("#sample-run"));

  const enabled = () => items.filter((item) => !item.disabled);
  const onOutside = (event: Event) => {
    if (!wrapper.contains(event.target as Node)) close(false);
  };
  function open() {
    const s = host.active();
    for (const item of items) {
      const reason = unavailableReason(s, item.dataset.terminalAction as TerminalAction);
      item.disabled = !!reason;
      if (reason) item.title = reason;
      else item.removeAttribute("title");
    }
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onOutside, true);
    (enabled()[0] ?? button).focus();
  }
  function close(returnFocus: boolean) {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onOutside, true);
    if (returnFocus) button.focus();
  }
  button.addEventListener("click", () => (menu.hidden ? open() : close(true)));
  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && menu.hidden) {
      event.preventDefault();
      open();
    }
  });
  menu.addEventListener("keydown", (event) => {
    const list = enabled();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const move: Record<string, number | undefined> = {
      ArrowDown: (at + 1) % list.length, ArrowUp: (Math.max(at, 0) - 1 + list.length) % list.length,
      Home: 0, End: list.length - 1,
    };
    if (event.key in move && list.length) {
      event.preventDefault();
      list[move[event.key]!]?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(false);
    }
  });

  const commands = TERMINAL_ACTIONS.map((action) => Object.freeze({
    name: `${actionLabel(action)} · ${PALETTE_HINTS[action]}`,
    action: () => run(action),
  }));
  return { run, commands: Object.freeze(commands) };
}

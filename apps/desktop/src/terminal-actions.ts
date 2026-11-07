import type { Terminal } from "@xterm/xterm";
import type { SessionHistory } from "./history-capture";

/**
 * User-triggered clear and reset actions on one workspace terminal (T32; semantics, effects and
 * the ADR argument are in docs/p1/CLEAR_RESET_PLAN.zh-CN.md).
 *
 * Each action is a fixed sequence the application writes to the session's own local xterm with
 * the public `Terminal.write`. It is never sent to the host (no `*_write`), never built from host
 * bytes and never spliced into a host chunk: it is a separate write, queued behind the output the
 * session has already handed to xterm, so it takes effect between two host chunks in stream order.
 * Going through xterm's parser keeps xterm.js the only terminal state: the VT adapters and the
 * history observers see the same sequences a host could send, and no out-of-band `reset()` or
 * `clear()` can leave their shadow state stale. Host RIS and DECSTR are not touched.
 *
 * Every sequence starts with CAN (0x18). If the last host chunk ended inside a control sequence or
 * string, CAN cancels it without running it, so an unfinished DECRQSS is not answered and an
 * unfinished OSC (title, colour, OSC 52 clipboard) does not take effect; the rest of that host
 * sequence, when it arrives, is then shown as text, as on any terminal that receives CAN. Without
 * it the ESC of the action would end such a string as if it were complete. In the ground state CAN
 * does nothing (xterm.js has no handler for it).
 */
export type TerminalAction =
  | "clear-scrollback" | "clear-screen" | "clear-all" | "reset-hard" | "reset-soft" | "reset-charset";

interface ActionSpec {
  /** Name in menus and the command palette (upstream zh-CN terms). */
  readonly label: string;
  readonly sequence: string;
  /** Meaningless or harmful on the alternate screen: not offered there (upstream disables them too). */
  readonly normalOnly: boolean;
  /** The user asked to delete history: the session's cold archive is emptied as well. */
  readonly clearsArchive: boolean;
}

const CAN = "\x18";
const CSI = "\x1b[";

const ACTIONS: Readonly<Record<TerminalAction, ActionSpec>> = Object.freeze({
  // ED 3: the normal buffer's scrollback; the screen, cursor and modes are kept.
  "clear-scrollback": { label: "清除回滚", sequence: `${CAN}${CSI}3J`, normalOnly: true, clearsArchive: true },
  // CUP home + ED 2: what a shell's Ctrl-L sends, without the prompt the shell would redraw.
  "clear-screen": { label: "清屏", sequence: `${CAN}${CSI}H${CSI}2J`, normalOnly: true, clearsArchive: false },
  // CUP home + ED 2 + ED 3: what `clear` sends, without the prompt.
  "clear-all": { label: "全部清除", sequence: `${CAN}${CSI}H${CSI}2J${CSI}3J`, normalOnly: true, clearsArchive: true },
  // RIS, then the two power-on states xterm.js 6.0.0's RIS keeps (DECTCEM shown, LNM reset) are
  // restored in the same write, so no host output can come between. Only the user's own action
  // gets them; a host RIS is parsed unchanged (terminal-regressions-reset.spec.ts).
  "reset-hard": { label: "硬复位", sequence: `${CAN}\x1bc${CSI}?25h${CSI}20l`, normalOnly: false, clearsArchive: false },
  // DECSTR.
  "reset-soft": { label: "软复位", sequence: `${CAN}${CSI}!p`, normalOnly: false, clearsArchive: false },
  // G0–G3 designated as ASCII, then SI invokes G0 into GL.
  "reset-charset": {
    label: "重置字符集", sequence: `${CAN}\x1b(B\x1b)B\x1b*B\x1b+B\x0f`, normalOnly: false, clearsArchive: false,
  },
});

/** Upstream menu order: the clear group, then the reset group. */
export const TERMINAL_ACTIONS: readonly TerminalAction[] = Object.freeze([
  "clear-scrollback", "clear-screen", "clear-all", "reset-hard", "reset-soft", "reset-charset",
]);

export const actionLabel = (action: TerminalAction): string => ACTIONS[action].label;
export const actionClearsArchive = (action: TerminalAction): boolean => ACTIONS[action].clearsArchive;
export const actionNormalOnly = (action: TerminalAction): boolean => ACTIONS[action].normalOnly;

/** The part of a workspace session an action needs. `history` is read when the write completes. */
export interface ActionTarget {
  readonly terminal: Terminal;
  readonly history?: SessionHistory;
  readonly disposed: boolean;
  readonly closing?: boolean;
}

export interface ActionResult {
  /** The sequence was parsed by the session's xterm. False if the session was closed first. */
  readonly applied: boolean;
  /** The terminal was on the alternate screen when the sequence was parsed. */
  readonly alternate: boolean;
  /** Archived lines discarded by a clear of the scrollback; 0 for every other action. */
  readonly clearedLines: number;
}

const onAlternate = (terminal: Terminal) => terminal.buffer.active.type === "alternate";

/** Why `action` cannot run on `target` right now, or undefined if it can. */
export function unavailableReason(target: ActionTarget | undefined, action: TerminalAction): string | undefined {
  if (!target) return "没有打开的会话";
  if (target.disposed || target.closing) return "会话正在关闭";
  if (ACTIONS[action].normalOnly && onAlternate(target.terminal)) return "全屏程序正在使用备用屏，此时不能清屏或清除回滚";
  return undefined;
}

/**
 * Writes the action's sequence to the target's local xterm. Resolves once xterm has parsed it,
 * before the next host chunk is parsed. Callers check {@link unavailableReason} first; output
 * already received but not yet parsed may still switch to the alternate screen, which the result
 * reports (a clear of the scrollback then leaves the archive untouched, since ED 3 did nothing).
 * Never rejects: a write the terminal refuses resolves as not applied.
 */
export function runTerminalAction(target: ActionTarget, action: TerminalAction): Promise<ActionResult> {
  const spec = ACTIONS[action];
  const { terminal } = target;
  const notApplied: ActionResult = Object.freeze({ applied: false, alternate: false, clearedLines: 0 });
  return new Promise((resolve) => {
    try {
      terminal.write(spec.sequence, () => {
        if (target.disposed) {
          resolve(notApplied);
          return;
        }
        const alternate = onAlternate(terminal);
        // Archives whatever earlier output left behind and lets the source note the reset or erase,
        // so a following clear starts behind it: no gap, and no line is archived twice.
        target.history?.capture();
        const clearedLines = spec.clearsArchive && !alternate ? target.history?.clear() ?? 0 : 0;
        terminal.scrollToBottom();
        resolve({ applied: true, alternate, clearedLines });
      });
    } catch {
      // xterm.js refused the write (for example a disposed terminal): nothing was applied.
      resolve(notApplied);
    }
  });
}

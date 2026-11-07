import type { IDisposable, ITerminalAddon, Terminal } from "@xterm/xterm";
import { showHiddenCursor, type CursorRepair } from "./xterm-private";

/**
 * Completes RIS (`ESC c`) for xterm.js 6.0.0: route R1 = E1 + E2, decided by the user on
 * 2026-11-07 (docs/p1/RIS_ADR_EVALUATION.zh-CN.md; E1 judged outside the ADR gates, E2 approved
 * with a guard test). xterm.js's RIS rebuilds the buffers and resets modes, margins, charsets and
 * the parser, but keeps two power-on states that VT100/VT510 and xterm restore:
 *
 * - E1, LNM (`CSI 20 h`): xterm.js stores it in the public option `convertEol`, and RIS restores no
 *   option. Set back to the value the terminal had when this addon was loaded (the session's
 *   initial value; the workspace factory never sets it, so false), through the same option setter
 *   `CSI 20 l` uses.
 * - E2, DECTCEM (`CSI ? 25 l`): `CoreService.isCursorHidden` survives `reset()`. No public API can
 *   clear it inside the parser, so it goes through the single private field in xterm-private.ts;
 *   when that field is unavailable nothing is written and the cursor stays as xterm.js left it.
 *
 * Timing: one `ESC c` handler that returns false. Load the addon right after creating the terminal,
 * before the VT adapters or any other `ESC c` handler: xterm.js runs handlers newest first, so this
 * one is then the last before the built-in RIS (`fullReset`) and runs synchronously at the very
 * parse position where xterm runs RIS, and only then (a newer handler returning true would skip
 * both). Chunk boundaries, an ESC that ends an OSC/DCS/APC/PM/SOS string, C0 or DEL between ESC and
 * `c`, the session encoding and every write path (host chunks, local writes such as T32's hard
 * reset) are therefore xterm's own decision; nothing here scans or rewrites bytes, writes to the
 * terminal, or touches ACKs, the cold archive or the VT adapters. The handler changes state just
 * before `fullReset`, which touches neither value; its full-screen refresh draws the cursor.
 * DECCKM, the keypad and every other mode are left to xterm's RIS (user decision 5: host RIS
 * returns to the normal modes, not the session's initial ones).
 *
 * Not covered: the public `terminal.reset()` (bypasses the parser; production code never calls
 * it) and the full reset xterm.js runs for DECCOLM, which needs `windowOptions.setWinLines` (off).
 * Released with the terminal: `Terminal.dispose()` disposes loaded addons.
 */

/** What one repair did: E1 (`lineFeed`) and E2 (`cursor`). */
export interface RisRepairOutcome {
  /** `restored`: LNM was set and is reset; `unchanged`: already at the initial value; `failed`: the option threw. */
  readonly lineFeed: "restored" | "unchanged" | "failed";
  readonly cursor: CursorRepair;
}

export interface RisRepairOptions {
  /** Diagnostics hook, called inside xterm's parser after each repair; errors are contained. */
  readonly onRepair?: (outcome: RisRepairOutcome) => void;
}

function restoreLineFeed(terminal: Terminal, initial: boolean): RisRepairOutcome["lineFeed"] {
  try {
    if (terminal.options.convertEol === initial) return "unchanged";
    terminal.options.convertEol = initial;
    return "restored";
  } catch {
    // Public, typed API; only a future xterm.js without the option could throw here.
    return "failed";
  }
}

/** The RIS repair as an xterm.js addon; load it first, see the module comment. */
export function risRepair(options: RisRepairOptions = {}): ITerminalAddon {
  let hook: IDisposable | undefined;
  return {
    activate(terminal: Terminal) {
      const initialConvertEol = terminal.options.convertEol === true;
      hook = terminal.parser.registerEscHandler({ final: "c" }, () => {
        const outcome: RisRepairOutcome = Object.freeze({
          lineFeed: restoreLineFeed(terminal, initialConvertEol),
          cursor: showHiddenCursor(terminal),
        });
        try {
          options.onRepair?.(outcome);
        } catch {
          // Counting must never stop xterm's parser (and with it the write callbacks and ACKs).
        }
        return false; // xterm.js still runs its own RIS
      });
    },
    dispose() {
      hook?.dispose();
      hook = undefined;
    },
  };
}

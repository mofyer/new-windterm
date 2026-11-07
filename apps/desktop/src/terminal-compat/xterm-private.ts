import type { Terminal } from "@xterm/xterm";

/**
 * The only place the application touches xterm.js private state (user decision of 2026-11-07,
 * route R1 / E2 in docs/p1/RIS_ADR_EVALUATION.zh-CN.md). Nothing here is public API: xterm.js
 * 6.0.0 has these names, a later version may rename, move or freeze them. Every access is checked
 * at run time; when the field is missing, has another type or ignores the write, nothing is
 * changed and the caller is told, so the terminal keeps the known xterm.js behaviour instead of
 * failing. Every xterm.js upgrade re-checks this file under G-UPGRADE
 * (docs/p0/TERMINAL_CORE_ADR.zh-CN.md); the guard test in terminal-ris-repair.spec.ts fails with a
 * pointer to that gate when the path stops working.
 */

/** The private path written by {@link showHiddenCursor}, for messages and documentation. */
export const CURSOR_HIDDEN_FIELD = "_core.coreService.isCursorHidden";

/**
 * What {@link showHiddenCursor} did: `shown` (DECTCEM was reset and the cursor is visible now),
 * `visible` (it already was; nothing written) or `unavailable` (the private field is missing, not
 * a boolean or not writable; nothing changed, the cursor stays as xterm.js left it).
 */
export type CursorRepair = "shown" | "visible" | "unavailable";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Clears xterm.js 6.0.0's `CoreService.isCursorHidden`, the flag DECSET 25 and DECSTR clear and
 * DECRST 25 sets; the DOM renderer and DECRQM `?25` read it. Never throws. Does not repaint: the
 * caller runs it right before xterm's own RIS, whose full-screen refresh draws the cursor.
 */
export function showHiddenCursor(terminal: Terminal): CursorRepair {
  try {
    const core: unknown = (terminal as unknown as { _core?: unknown })._core;
    const service = isRecord(core) ? core.coreService : undefined;
    if (!isRecord(service) || typeof service.isCursorHidden !== "boolean") return "unavailable";
    if (!service.isCursorHidden) return "visible";
    service.isCursorHidden = false;
    // A setter that ignores the value would leave the cursor hidden: report it like a missing field.
    return service.isCursorHidden === false ? "shown" : "unavailable";
  } catch {
    // A frozen object or a getter-only accessor throws on assignment in strict mode.
    return "unavailable";
  }
}

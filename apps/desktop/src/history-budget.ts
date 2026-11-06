// Terminal history and session budget for the workspace (P1 slice 5, step 1).
//
// xterm.js is the only live terminal state. These numbers bound what each
// workspace xterm keeps; they do not describe a second copy kept anywhere
// else. The plan, the Chrome-only measurements and the decisions still open
// are in docs/p1/HISTORY_BUDGET_PLAN.zh-CN.md. Changing a value here changes
// product behaviour and needs that plan's verification steps.

/**
 * Lines each workspace terminal keeps above its visible rows (xterm
 * `scrollback`). Once exceeded, xterm drops the oldest lines silently; there
 * is no cold archive in production yet. 5,000 is the P0 value and stays the
 * production default until the user decides otherwise (WindTerm 2.7.0
 * defaults to 999,999, see Q06).
 */
export const DEFAULT_SCROLLBACK_LINES = 5000;

/**
 * Workspace sessions (tabs of every kind, demo included) one window holds at
 * once. main.ts currently enforces the same literal; the Rust PTY and
 * Telnet/TCP registries keep their own limit of 8 live sessions each.
 */
export const MAX_WORKSPACE_SESSIONS = 8;

/**
 * Worst-case hot history lines in one window: every tab at the default
 * scrollback. Visible rows and the alternate screen come on top of this.
 */
export const MAX_WINDOW_SCROLLBACK_LINES = DEFAULT_SCROLLBACK_LINES * MAX_WORKSPACE_SESSIONS;

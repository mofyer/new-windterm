// Terminal history and session budget for the workspace (P1 slice 5).
//
// xterm.js is the only live terminal state. The hot numbers bound what each
// workspace xterm keeps; the cold numbers are the budget of the compressed,
// read-only archive derived from it (history-capture.ts), which is not
// terminal state. Since step 6 history-capture.ts enforces the cold budget by
// dropping whole archive blocks, oldest first, and counts the dropped lines for
// the status bar notice.
// The plan, the Chrome-only measurements and the user's decisions are in
// docs/p1/HISTORY_BUDGET_PLAN.zh-CN.md. Changing a value here changes product
// behaviour and needs that plan's verification steps.

/**
 * Lines each workspace terminal keeps above its visible rows (xterm
 * `scrollback`): the hot window, and also the capture window of the cold
 * archive. One output chunk (at most 4,096 B, so at most about 4,096 rows
 * from line feeds) must fit in it, or rows are trimmed before they can be
 * archived and a gap is counted. The user kept 5,000 (decision 1B,
 * 2026-11-07); WindTerm 2.7.0 defaults to 999,999 in total, see
 * HISTORY_TARGET_LINES.
 */
export const DEFAULT_SCROLLBACK_LINES = 5000;

/**
 * Workspace sessions (tabs of every kind, demo included) one window holds at
 * once. main.ts currently enforces the same literal; the Rust PTY and
 * Telnet/TCP registries keep their own limit of 8 sessions each (the PTY
 * count is application-wide and includes closing sessions not yet reaped).
 */
export const MAX_WORKSPACE_SESSIONS = 8;

/**
 * Worst-case hot history lines in one window: every tab at the default
 * scrollback. Visible rows and the alternate screen come on top of this.
 */
export const MAX_WINDOW_SCROLLBACK_LINES = DEFAULT_SCROLLBACK_LINES * MAX_WORKSPACE_SESSIONS;

/**
 * Logical lines of history one session keeps: WindTerm 2.7.0's default
 * `scrollbackLimit` (Q06; user decision 1B). The archive receives every line
 * as it leaves the screen, so it also covers the hot scrollback, and its lines
 * are the session's whole history apart from the screen. Sealed blocks may hold
 * this many lines; past it the oldest whole blocks are dropped. The newest
 * partial block (fewer than ARCHIVE_BLOCK_LINES lines) comes on top.
 */
export const HISTORY_TARGET_LINES = 999_999;

/**
 * Logical lines per compressed cold-archive block. A budget that is exceeded
 * drops whole blocks, oldest first (user decision 3A).
 */
export const ARCHIVE_BLOCK_LINES = 512;

/**
 * Compressed cold-archive bytes one session may hold: past it the session's
 * own oldest blocks are dropped. Tentative (user decision 2A, 2026-11-07): to
 * be revised after native measurement.
 */
export const MAX_SESSION_ARCHIVE_BYTES = 64 * 1024 * 1024;

/**
 * Compressed cold-archive bytes of all sessions together (one window today;
 * summed per application once more windows exist). Tentative (decision 2A).
 * Past it, blocks are dropped tab by tab: exited tabs first (decision 5A),
 * then running ones, each group least recently focused first, every tab
 * oldest block first.
 */
export const MAX_TOTAL_ARCHIVE_BYTES = 256 * 1024 * 1024;

// Read-only history view and search (step 7, history-view.ts). These bound
// what the view itself holds; the history it shows is the archive above.

/**
 * Matches one search keeps. Search walks from the newest line to the oldest,
 * so past this it stops and the newest matches are the ones kept.
 */
export const HISTORY_SEARCH_MAX_MATCHES = 10_000;

/** Lines one copy may take; a larger selection is refused, never cut short. */
export const HISTORY_COPY_MAX_LINES = 50_000;

/**
 * UTF-16 code units of one line the view draws. A longer line is drawn in
 * part (around the current match, if any) and says how long it is; search and
 * copy always use the whole line.
 */
export const HISTORY_VIEW_MAX_CHARS = 2_000;

/** Parsed lines the view keeps for redrawing while scrolling. */
export const HISTORY_VIEW_CACHE_LINES = 2_048;

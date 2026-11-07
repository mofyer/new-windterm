import type { Terminal } from "@xterm/xterm";
import {
  HistoryArchive, type CaptureResult, type DroppedBlock, type HistoryReader,
} from "./terminal-compat/history-archive";
import { xtermHistorySource } from "./terminal-core";
import {
  ARCHIVE_BLOCK_LINES, HISTORY_TARGET_LINES, MAX_SESSION_ARCHIVE_BYTES, MAX_TOTAL_ARCHIVE_BYTES,
} from "./history-budget";
import { responsivenessDiagnostics as diagnostics } from "./responsiveness";

/**
 * Cold-history capture of one native workspace session (P1 slice 5, steps 5 and 6). The archive
 * is derived from the session's xterm through the terminal-core boundary and lives until the tab
 * is closed (an exited tab keeps it); `dispose` releases it with the tab. The read-only history
 * view (step 7, `history-view.ts`) reads it through `reader()`.
 *
 * Budgets (`history-budget.ts`, user decisions 2A, 3A and 5A) are applied whenever a compressed
 * block is added, never in the write callback or the ACK path:
 * 1. the session's own byte budget and line target: its oldest whole blocks are dropped until it
 *    is back within both;
 * 2. the total byte budget of all sessions: whole blocks are dropped tab by tab, exited tabs
 *    before running ones, within each group the least recently focused tab first, each tab's
 *    oldest block first, until the total is back within budget.
 * Only completed blocks are dropped: the newest, not yet sealed lines (fewer than one block per
 * session) and blocks still being compressed are neither counted in bytes nor dropped. Every
 * dropped line is counted per session for the "已丢弃最早 N 行" notice; nothing is dropped silently.
 *
 * The user's 清除回滚 and 全部清除 (T32, `terminal-actions.ts`) also empty the archive through
 * `clear`; a reset or scrollback erase sent by the program keeps what was archived.
 */
export interface SessionHistory {
  /** Archives what the last write scrolled off. Call from the xterm write callback; never throws. */
  capture(): void;
  /**
   * The user cleared the scrollback (T32 清除回滚 / 全部清除): discards every archived line and
   * resets the "已丢弃最早 N 行" count, whose dropped lines belonged to the cleared history. Call
   * after `capture()` in the callback of the local write that erased xterm's scrollback, so the
   * source has already restarted behind the erase. Returns the archived lines discarded; never
   * throws. Resets and erases sent by the program never call this.
   */
  clear(): number;
  /** Oldest lines dropped to stay within budget since the archive started or was last cleared. */
  readonly droppedLines: number;
  /**
   * Read-only access for the history view (step 7); undefined once the archive is released (the
   * tab closed, or capture failed and stopped). The reader cannot capture, drop or clear.
   */
  reader(): HistoryReader | undefined;
  /** Releases the archive and its terminal hooks; idempotent. */
  dispose(): void;
}

/** What the archive asks of its session. Both must be synchronous and must not throw. */
export interface SessionHistoryHooks {
  /** The session has exited, failed or disconnected: its archive is trimmed before running ones. */
  ended(): boolean;
  /** Lines were just dropped from this session's archive; refresh its notice. */
  dropped(): void;
}

interface Limits {
  readonly sessionBytes: number;
  readonly totalBytes: number;
  readonly lines: number;
}

const DEFAULT_LIMITS: Limits = Object.freeze({
  sessionBytes: MAX_SESSION_ARCHIVE_BYTES, totalBytes: MAX_TOTAL_ARCHIVE_BYTES, lines: HISTORY_TARGET_LINES,
});

/**
 * Development builds only: `?p0HistoryBudget=sessionBytes:N,totalBytes:N,lines:N` lowers limits
 * so browser tests reach them quickly; a value can never raise a default. The build replaces
 * `import.meta.env.DEV` with false, so release assets use the defaults and omit this parser.
 */
function developmentLimits(): Limits {
  const value = new URLSearchParams(location.search).get("p0HistoryBudget");
  if (!value) return DEFAULT_LIMITS;
  const result: Record<keyof Limits, number> = { ...DEFAULT_LIMITS };
  for (const pair of value.split(",")) {
    const [key, number = ""] = pair.split(":");
    if (!Object.hasOwn(result, key) || !/^[1-9]\d{0,15}$/.test(number)) continue;
    const name = key as keyof Limits;
    result[name] = Math.min(result[name], Number(number));
  }
  return Object.freeze(result);
}

const limits: Limits = import.meta.env.DEV ? developmentLimits() : DEFAULT_LIMITS;

interface Entry {
  /** Undefined once released. */
  archive: HistoryArchive | undefined;
  hooks: SessionHistoryHooks;
  /** Use clock of the last focus (or creation); smaller means less recently used. */
  used: number;
  droppedLines: number;
  /** Development diagnostics: figures of this archive already in the aggregate. */
  reportedBytes: number;
  reportedUncompressed: number;
}

/** Live archives in creation order (Set order), which breaks ties between equal use clocks. */
const live = new Set<Entry>();
let clock = 0;

/** Drops one whole block of `entry`, oldest first, and counts it. */
function dropOldest(entry: Entry, global?: "ended" | "running"): DroppedBlock | undefined {
  const dropped = entry.archive?.dropOldest();
  if (!dropped) return undefined;
  entry.droppedLines += dropped.lines;
  if (diagnostics) {
    diagnostics.historyTrimmedBlocks++;
    diagnostics.historyTrimmedLines += dropped.lines;
    diagnostics.historyTrimmedBytes += dropped.bytes;
    if (global === "ended") diagnostics.historyTrimmedEndedBlocks++;
    else if (global === "running") diagnostics.historyTrimmedRunningBlocks++;
  }
  return dropped;
}

/**
 * Brings `entry` back within its own byte budget and line target. Both count sealed blocks only
 * (lines of blocks still being compressed included, their unknown bytes not): the newest partial
 * block, fewer than `ARCHIVE_BLOCK_LINES` lines, comes on top and is never dropped.
 */
function enforceSession(entry: Entry): boolean {
  const over = () => {
    const stats = entry.archive!.stats();
    const sealedLines = stats.archivedLines - stats.pendingLines - stats.droppedLines - stats.clearedLines;
    return { bytes: stats.compressedBytes > limits.sessionBytes, lines: sealedLines > limits.lines };
  };
  const first = over();
  if (diagnostics) {
    if (first.bytes) diagnostics.historySessionBudgetExceeded++;
    if (first.lines) diagnostics.historyLineTargetExceeded++;
  }
  let dropped = false;
  for (let now = first; now.bytes || now.lines; now = over()) {
    if (!dropOldest(entry)) break;
    dropped = true;
  }
  return dropped;
}

/** Brings all archives together back within the total budget; returns the entries it trimmed. */
function enforceTotal(): Entry[] {
  let total = 0;
  for (const entry of live) total += entry.archive!.stats().compressedBytes;
  if (total <= limits.totalBytes) return [];
  if (diagnostics) diagnostics.historyTotalBudgetExceeded++;
  // Exited tabs first (decision 5A), then running ones; least recently focused first in each.
  const order = [...live]
    .map((entry) => ({ entry, ended: entry.hooks.ended() }))
    .sort((a, b) => Number(b.ended) - Number(a.ended) || a.entry.used - b.entry.used);
  const trimmed: Entry[] = [];
  for (const { entry, ended } of order) {
    let dropped: DroppedBlock | undefined;
    while (total > limits.totalBytes && (dropped = dropOldest(entry, ended ? "ended" : "running"))) {
      total -= dropped.bytes;
      if (!trimmed.includes(entry)) trimmed.push(entry);
    }
    if (total <= limits.totalBytes) break;
  }
  return trimmed;
}

/** Development diagnostics only: aggregate numbers, never history text, paths or session IDs. */
function syncSizes(entries: Iterable<Entry>) {
  const d = diagnostics!;
  for (const entry of entries) {
    const stats = entry.archive!.stats();
    d.historyCompressedBytes += stats.compressedBytes - entry.reportedBytes;
    entry.reportedBytes = stats.compressedBytes;
    d.historyUncompressedBlocks += stats.uncompressedBlocks - entry.reportedUncompressed;
    entry.reportedUncompressed = stats.uncompressedBlocks;
    d.historyMaxSessionCompressedBytes = Math.max(d.historyMaxSessionCompressedBytes, stats.compressedBytes);
  }
  d.historyMaxTotalCompressedBytes = Math.max(d.historyMaxTotalCompressedBytes, d.historyCompressedBytes);
}

/** Applies every budget after `entry` added a block. Runs in its compression queue. */
function enforce(entry: Entry) {
  const changed = new Set<Entry>(enforceSession(entry) ? [entry] : []);
  for (const trimmed of enforceTotal()) changed.add(trimmed);
  if (diagnostics) syncSizes(new Set([entry, ...changed]));
  for (const trimmed of changed) trimmed.hooks.dropped();
}

/** Development diagnostics only: capture counts and time, never history text. */
function report(result: CaptureResult, started: number) {
  const d = diagnostics!;
  const ms = performance.now() - started;
  d.historyCaptureMs += ms;
  d.historyMaxCaptureMs = Math.max(d.historyMaxCaptureMs, ms);
  d.historyArchivedLines += result.lines;
  if (result.gap) d.historyGaps++;
  if (result.cleared) d.historyClears++;
}

const NO_HOOKS: SessionHistoryHooks = Object.freeze({ ended: () => false, dropped: () => {} });

export function createSessionHistory(terminal: Terminal, hooks: SessionHistoryHooks): SessionHistory {
  const entry: Entry = {
    archive: undefined, hooks, used: ++clock, droppedLines: 0, reportedBytes: 0, reportedUncompressed: 0,
  };
  const onBlock = () => {
    if (!entry.archive) return;
    try {
      enforce(entry);
    } catch {
      // Never let a budget error stop the compression queue of this or another session.
      release();
      if (diagnostics) diagnostics.historyCaptureErrors++;
    }
  };
  entry.archive = new HistoryArchive(xtermHistorySource(terminal), ARCHIVE_BLOCK_LINES, onBlock);
  live.add(entry);
  // "Used" means focused: selecting a tab focuses its terminal.
  const focused = () => { entry.used = ++clock; };
  terminal.element?.addEventListener("focusin", focused);
  if (diagnostics) diagnostics.historyArchives++;
  function release() {
    if (!entry.archive) return;
    terminal.element?.removeEventListener("focusin", focused);
    entry.archive.dispose();
    entry.archive = undefined;
    entry.hooks = NO_HOOKS;
    live.delete(entry);
    if (diagnostics) {
      diagnostics.historyArchives--;
      diagnostics.historyCompressedBytes -= entry.reportedBytes;
      entry.reportedBytes = 0;
    }
  }
  return {
    capture() {
      if (!entry.archive) return;
      const started = diagnostics ? performance.now() : 0;
      try {
        const result = entry.archive.capture();
        if (diagnostics) report(result, started);
      } catch {
        // Never let capture reach xterm's write loop or the ACK path. Stop archiving this
        // session instead of keeping a history with a hole of unknown size.
        release();
        if (diagnostics) diagnostics.historyCaptureErrors++;
      }
    },
    clear() {
      if (!entry.archive) return 0;
      const cleared = entry.archive.clear();
      entry.droppedLines = 0;
      if (diagnostics) {
        diagnostics.historyUserClears++;
        diagnostics.historyUserClearedLines += cleared;
        syncSizes([entry]);
      }
      // Hides the notice if this is the active tab.
      entry.hooks.dropped();
      return cleared;
    },
    get droppedLines() {
      return entry.droppedLines;
    },
    reader: () => entry.archive,
    dispose: release,
  };
}
